const { parentPort, workerData } = require("worker_threads");
const { sequelize, commonQuery } = require("../../../helpers");
const { 
  PartiesMaster, 
  PartiesAddress, 
  PartiesBank, 
  CountryMaster, 
  StateMaster, 
  CurrencyMaster 
} = require("../../../models");
const { transformRows } = require("../../../helpers/functions/excelService");
const { Op } = require("sequelize");
const xlsx = require("xlsx");
const fs = require("fs");
const { fixDecimals } = require("../../../helpers/functions/commonFunctions");
const { fail } = require('../../../helpers/Err');

// Static Maps for Enums
const PARTY_TYPE_MAP = { "CUSTOMER": 1, "VENDOR": 2, "BOTH": 3 };
const BALANCE_TYPE_MAP = { "CREDIT": 1, "DEBIT": 2 };
const REG_TYPE_MAP = { "REGISTER": 1, "UNREGISTER": 2 };
const ADDRESS_TYPE_MAP = { "BILLING": 0, "SHIPPING": 1 };
const BOOL_MAP = { "YES": 1, "NO": 0 };

let isCancelled = false;
let transaction = null;
let errorFileStream = null;

if (parentPort) {
  parentPort.on("message", async (msg) => {
    if (msg.command === "ABORT") {
      isCancelled = true;
      if (transaction && !transaction.finished) {
        try { await transaction.rollback(); } catch (e) {}
      }
      if (errorFileStream) errorFileStream.end();
      parentPort.postMessage({ status: "CANCELLED" });
      process.exit(0);
    }
  });
}

const writeError = (stream, row, errorMessage) => {
  const errorRow = { ...row, Error: errorMessage };
  if (stream.writable) stream.write(JSON.stringify(errorRow) + '\n');
};

const runWorker = async () => {
  try { await sequelize.authenticate(); } catch (error) {
    parentPort.postMessage({ status: "ERROR", error: "Database connection failed." });
    process.exit(1);
  }

  const { filePath, errorLogPath, body, user_id, branch_id, company_id } = workerData;
  const { fixNum } = await fixDecimals(company_id);
  
  let fieldMapping = {};
  try { fieldMapping = JSON.parse(body.field_mapping || "{}"); } catch (e) {}
  
  const commonData = { user_id, branch_id, company_id };
  const masterCommonData = { company_id }; 

  try {
    errorFileStream = fs.createWriteStream(errorLogPath);

    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const rawHeaders = (xlsx.utils.sheet_to_json(worksheet, { header: 1 })[0] || []);
    const headers = rawHeaders.map(h => String(h).trim());
    const originalRows = xlsx.utils.sheet_to_json(worksheet); 
    const rows = transformRows(originalRows, headers, fieldMapping);

    if (isCancelled) fail("IMPORT_CANCELLED");

    transaction = await sequelize.transaction();

    // --- 2. PRE-SCAN ---
    const countryNames = new Set();
    const stateNames = new Set();
    const currencyCodes = new Set();
    const fileSeriesCodes = new Set(); 
    const filePartyNames = new Set();
    const fileAccountNumbers = new Set(); 

    rows.forEach(r => {
      if (r.country) countryNames.add(String(r.country).trim().toLowerCase());
      if (r.address_country) countryNames.add(String(r.address_country).trim().toLowerCase());
      if (r.state) stateNames.add(String(r.state).trim().toLowerCase());
      if (r.currency) currencyCodes.add(String(r.currency).trim().toLowerCase());
      if (r.series_code) fileSeriesCodes.add(String(r.series_code).trim().toLowerCase());
      if (r.party_name) filePartyNames.add(String(r.party_name).trim()); // Keep original case for DB query
      if (r.account_number) fileAccountNumbers.add(String(r.account_number).trim());
    });

    // --- 3. FETCH MASTERS ---
    const masterWhere = { status: 0 };
    const companyWhere = { company_id, user_id, branch_id, status: 0 }; 

    // Note: Fetching Party Name using Op.iLike or specific collation if possible, 
    // but here we fetch duplicates by checking if name matches in array (using standard Op.in)
    const [countries, states, currencies, existingPartiesByCode, existingPartiesByName, existingBanks] = await Promise.all([
      commonQuery.findAllRecords(CountryMaster, { ...masterWhere, country_name: { [Op.in]: Array.from(countryNames) } }, { attributes: ['id', 'country_name'], raw: true }, transaction, false),
      commonQuery.findAllRecords(StateMaster, { ...masterWhere, state_name: { [Op.in]: Array.from(stateNames) } }, { attributes: ['id', 'state_name'], raw: true }, transaction, false),
      commonQuery.findAllRecords(CurrencyMaster, { ...masterWhere, currency_code: { [Op.in]: Array.from(currencyCodes) } }, { attributes: ['id', 'currency_code'], raw: true }, transaction, false),
      // Check existing by Code
      commonQuery.findAllRecords(PartiesMaster, { ...companyWhere, series_code: { [Op.in]: Array.from(fileSeriesCodes) } }, { attributes: ['series_code'], raw: true }, transaction),
      // Check existing by Name (This will return matches found in DB)
      commonQuery.findAllRecords(PartiesMaster, { ...companyWhere, party_name: { [Op.in]: Array.from(filePartyNames) } }, { attributes: ['party_name'], raw: true }, transaction),
      // Check existing bank accounts 
      commonQuery.findAllRecords(PartiesBank, { ...companyWhere, account_number: { [Op.in]: Array.from(fileAccountNumbers) } }, { attributes: ['account_number'], raw: true }, transaction)
    ]);

    // --- 4. BUILD MAPS ---
    const masterData = {
      countryMap: new Map(countries.map(c => [String(c.country_name).trim().toLowerCase(), c.id])),
      stateMap: new Map(states.map(s => [String(s.state_name).trim().toLowerCase(), s.id])),
      currencyMap: new Map(currencies.map(c => [String(c.currency_code).trim().toLowerCase(), c.id])),
      
      dbExistingSeriesMap: new Set(existingPartiesByCode.map(l => String(l.series_code).trim().toLowerCase())),
      // Normalize DB names to lowercase for comparison
      dbExistingNameMap: new Set(existingPartiesByName.map(l => String(l.party_name).trim().toLowerCase())),
      dbExistingBankMap: new Set(existingBanks.map(b => String(b.account_number).trim())),
      
      // Tracking for current file processing
      fileTrackingPartiesMap: new Map(), // Key: RowKey -> ID
      fileProcessedPartyNames: new Set(), // To check duplicates within file
      fileProcessedBanks: new Set(), // To check duplicates within file
      partyAddressStats: new Map(), // To validate address counts
    };

    // --- 5. PROCESSING LOOP ---
    let createdCount = 0;
    let errorCount = 0;
    const errorSample = [];
    const MAX_SAMPLE = 100;

    for (let i = 0; i < rows.length; i++) {
      if (i % 500 === 0 && i > 0) await new Promise(resolve => setImmediate(resolve));
      if (isCancelled) fail("IMPORT_CANCELLED");

      const record = rows[i];
      const originalRecord = originalRows[i];
      const rowIndex = i + 2;

      try {
        // --- A. VALIDATION & MAPPING ---
        const seriesCode = String(record.series_code || '').trim();
        const partyName = String(record.party_name || '').trim();

        // VALIDATION: Party Name Required
        if (!partyName) fail("Party Name is required");

        const seriesCodeLower = seriesCode.toLowerCase();
        const partyNameLower = partyName.toLowerCase();
        
        // Determine Grouping Key (Use Series Code if exists, else Name)
        const rowKey = seriesCode ? seriesCodeLower : partyNameLower;

        // Initialize stats if not seen
        if (!masterData.partyAddressStats.has(rowKey)) {
            masterData.partyAddressStats.set(rowKey, { billingCount: 0, shippingDefaultCount: 0 });
        }
        const currentStats = masterData.partyAddressStats.get(rowKey);

        // --- B. CHECK IF PARTY EXISTS (In File or In DB) ---
        let partyId = masterData.fileTrackingPartiesMap.get(rowKey);
        let isNewParty = false;

        // If not processed in this file yet, we attempt to Create
        if (!partyId) {
            
            // VALIDATION: Series Code Unique (if provided)
            if (seriesCode && masterData.dbExistingSeriesMap.has(seriesCodeLower)) {
               fail(`Series Code '${seriesCode}' already exists in the system.`);
            }

            // VALIDATION: Party Name Unique (DB Check)
            if (masterData.dbExistingNameMap.has(partyNameLower)) {
               fail(`Party Name '${partyName}' already exists in the system.`);
            }

            // VALIDATION: Party Name Unique (File Check)
            if (masterData.fileProcessedPartyNames.has(partyNameLower)) {
               fail(`Duplicate Party Name '${partyName}' found in file (names must be unique).`);
            }

            // --- C. PREPARE PARTY MASTER DATA ---
            const partyTypeRaw = String(record.party_type || "Customer").toUpperCase();
            const partyType = PARTY_TYPE_MAP[partyTypeRaw] || 1; 

            const balTypeRaw = String(record.balance_type || "Debit").toUpperCase();
            const balanceType = BALANCE_TYPE_MAP[balTypeRaw] || 2; 

            const regTypeRaw = String(record.registration_type || "Unregister").toUpperCase();
            const regType = REG_TYPE_MAP[regTypeRaw] || 2; 

            const countryId = masterData.countryMap.get(String(record.country || '').trim().toLowerCase()) || null;
            const currencyId = masterData.currencyMap.get(String(record.currency || '').trim().toLowerCase()) || null;
            
            let opening = fixNum(record.opening_balance || 0);
            if (balanceType == 1) opening = -Math.abs(opening); 
            else if (balanceType == 2) opening = Math.abs(opening);

            const newParty = await commonQuery.createRecord(PartiesMaster, {
                ...masterCommonData,
                series_id: 0, 
                series_code: seriesCode, 
                party_name: partyName,
                owner_name: record.owner_name,
                party_type: partyType,
                balance_type: balanceType,
                opening_balance: opening,
                current_balance: opening,
                credit_limit: fixNum(record.credit_limit || 0),
                registration_type: regType,
                tax_type: record.tax_type, 
                tax_no: record.tax_no,
                registration_no: record.registration_no,
                email: record.email,
                mobile_no: record.mobile_no,
                country_id: countryId,
                currency_id: currencyId,
                status: 0,
                ...commonData
            }, transaction);

            partyId = newParty.id;
            masterData.fileTrackingPartiesMap.set(rowKey, partyId);
            masterData.fileProcessedPartyNames.add(partyNameLower);
            isNewParty = true;
            createdCount++;
        }

        // --- Address Validation & Creation ---
        const addr1 = record.address_line_1 ? String(record.address_line_1).trim() : '';
        const addr2 = record.address_line_2 ? String(record.address_line_2).trim() : '';
        if (addr1 || addr2) {
            const addrTypeRaw = String(record.address_type || "Billing").toUpperCase();
            const addrType = ADDRESS_TYPE_MAP[addrTypeRaw] !== undefined ? ADDRESS_TYPE_MAP[addrTypeRaw] : 0;
            
            const isDefaultRaw = String(record.is_default_address || "No").toUpperCase();
            const isDefault = BOOL_MAP[isDefaultRaw] !== undefined ? BOOL_MAP[isDefaultRaw] : 0;

            // VALIDATION: Single Billing Address
            if (addrType === 0) { 
                if (currentStats.billingCount > 0) {
                    fail(`Party '${partyName}' can only have one Billing Address.`);
                }
                currentStats.billingCount++;
            }

            // VALIDATION: Single Default Shipping Address
            if (addrType === 1 && isDefault === 1) { 
                if (currentStats.shippingDefaultCount > 0) {
                    fail(`Party '${partyName}' can only have one Default Shipping Address.`);
                }
                currentStats.shippingDefaultCount++;
            }

            const addrStateId = masterData.stateMap.get(String(record.state || '').trim().toLowerCase()) || null;
            const addrCountryId = masterData.countryMap.get(String(record.address_country || '').trim().toLowerCase()) || null;

            await PartiesAddress.create({
                party_id: partyId,
                address: addr1,
                address2: addr2,
                city: record.city,
                state_id: addrStateId,
                country_id: addrCountryId,
                pincode: String(record.pincode || ''),
                is_default: isDefault,
                address_type: addrType,
                status: 0,
                ...commonData
            }, { transaction });
        }

        // --- Bank Validation & Creation ---
        if (record.bank_name && record.account_number) {
            const accountNumber = String(record.account_number).trim();

            // VALIDATION: Unique Account Number
            if (masterData.dbExistingBankMap.has(accountNumber)) {
                fail(`Bank Account '${accountNumber}' already exists in system.`);
            }
            if (masterData.fileProcessedBanks.has(accountNumber)) {
                fail(`Duplicate Bank Account '${accountNumber}' found in this file.`);
            }

            await PartiesBank.create({
                party_id: partyId,
                bank_name: record.bank_name,
                branch_name: record.bank_branch,
                account_holder_name: record.account_holder || partyName,
                account_number: accountNumber,
                routing_number: String(record.ifsc_code || ''),
                status: 0,
                ...commonData
            }, { transaction });

            masterData.fileProcessedBanks.add(accountNumber);
        }

      } catch (rowError) {
        errorCount++;
        if (errorCount <= MAX_SAMPLE) errorSample.push(`Row ${rowIndex}: ${rowError.message}`);
        writeError(errorFileStream, originalRecord, rowError.message);
      }
    }

    // --- 6. FINALIZE ---
    if (errorFileStream) errorFileStream.end();

    // 🔴 IMPORTANT FIX: If no records created AND there are errors, ensure we return FAILURE structure
    if (createdCount === 0 && errorCount > 0) {
        await transaction.rollback();
        
        // This format mimics what your `responseFormatter` or controller expects for a validation error
        parentPort.postMessage({
            status: "SUCCESS", // We send 'SUCCESS' to the controller, but the payload has the error flag
            result: { 
                importErrors: true, // This flag tells the controller to return 400 or treat as error
                errors: errorSample, 
                errorCount: errorCount, 
                message: `${errorCount} errors found. No parties were imported.` 
            }
        });
        return;
    }

    // Normal logic for partial success or full success
    const tooManyErrors = errorCount > (rows.length * 0.5) && rows.length > 10;
    if (tooManyErrors) {
        await transaction.rollback();
        parentPort.postMessage({
            status: "SUCCESS",
            result: { importErrors: true, errors: errorSample, errorCount, message: "Too many errors. Import rolled back." }
        });
    } else {
        await transaction.commit();
        parentPort.postMessage({
            status: "SUCCESS",
            result: { success: true, message: `${createdCount} parties processed successfully.`, count: createdCount, errorCount, errors: errorSample }
        });
    }

  } catch (err) {
    if (transaction && !transaction.finished) await transaction.rollback();
    if (errorFileStream) errorFileStream.end();
    if (err.message === "IMPORT_CANCELLED") {
        parentPort.postMessage({ status: "CANCELLED" });
    } else {
        parentPort.postMessage({ status: "ERROR", error: err.message });
    }
  }
};

runWorker();