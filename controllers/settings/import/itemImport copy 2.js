const { parentPort, workerData } = require("worker_threads");
const { sequelize, commonQuery } = require("../../helpers");
const { 
  ItemMaster, 
  ItemCategory, 
  HSNMaster, 
  TaxGroup, 
  TaxGroupTransaction, 
  Taxes, 
  TaxTypeMaster,
  GodownMaster,
  SerialNumber
} = require("../../models");
const { transformRows } = require("../../helpers/functions/excelService");
const { Op } = require("sequelize");
const xlsx = require("xlsx");
const fs = require("fs");
const { generateSeriesNumber, fixDecimals, updateSeriesNumber } = require("../../helpers/functions/commonFunctions");
const { MODULES } = require("../../helpers/constants");
const { addStock } = require("../../helpers/functions/inventoryFunctions");

// --- STATIC UNIT ID MAPPING (Universal Units) ---
const UNIT_ID_MAP = {
  "BAG": 1, "BAL": 2, "BDL": 3, "BKL": 4, "BOU": 5, "BOX": 6, "BTL": 7, "BUN": 8, "CAN": 9, "CBM": 10,
  "CCM": 11, "CMS": 12, "CTN": 13, "DOZ": 14, "DRM": 15, "GGK": 16, "GMS": 17, "GRS": 18, "GYD": 19, "KGS": 20,
  "KLR": 21, "KME": 22, "LTR": 23, "MLT": 24, "MTR": 25, "MTS": 26, "NOS": 27, "OTH": 28, "PAC": 29, "PCS": 30,
  "PRS": 31, "QTL": 32, "ROL": 33, "SET": 34, "SQF": 35, "SQM": 36, "SQY": 37, "TBS": 38, "TGM": 39, "THD": 40,
  "TON": 41, "TUB": 42, "UGS": 43, "UNT": 44, "YDS": 45
};

// --- ABORT CONTROL & CONFIG ---
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

const parseSerials = (serialString) => {
    if (!serialString) return [];
    return String(serialString).split(/,|;/).map(s => s.trim()).filter(Boolean);
};

const runWorker = async () => {
  try { await sequelize.authenticate(); } catch (error) {
    parentPort.postMessage({ status: "ERROR", error: "Database connection failed." });
    process.exit(1);
  }

  const { filePath, errorLogPath, body, user_id, branch_id, company_id } = workerData;
  const format = await fixDecimals(company_id);
  const isItemUnique = String(body.isItemUnique) === 'true'; 
  
  let fieldMapping = {};
  try { fieldMapping = JSON.parse(body.field_mapping || "{}"); } catch (e) {}
  
  const commonData = { user_id, branch_id, company_id };

  try {
    errorFileStream = fs.createWriteStream(errorLogPath);

    // 1. Read & Transform File
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const rawHeaders = (xlsx.utils.sheet_to_json(worksheet, { header: 1 })[0] || []);
    const headers = rawHeaders.map(h => String(h).trim());
    const originalRows = xlsx.utils.sheet_to_json(worksheet); 
    const rows = transformRows(originalRows, headers, fieldMapping);

    if (isCancelled) throw new Error("IMPORT_CANCELLED");

    transaction = await sequelize.transaction();
    const commonWhere = { company_id, status: 0 };

    // 2. Pre-scan for Masters
    const categoryNames = new Set();
    // const hsnCodes = new Set(); // REMOVED: No longer need to collect HSNs for DB lookup
    const godownNames = new Set();
    const parentItemNames = new Set(); 
    const fileItemNames = new Set(); 
    const fileSeriesCodes = new Set(); 

    rows.forEach(r => {
      const cat = r.category || r.category_name; 
      const godown = r.godown_id || r.godown_name; 
      
      if (cat) categoryNames.add(String(cat).trim());
      // if (r.hsn_code) hsnCodes.add(String(r.hsn_code).trim()); // REMOVED
      if (godown) godownNames.add(String(godown).trim());
      
      const iName = String(r.item_name || '').trim().toLowerCase();
      if (iName) {
        parentItemNames.add(iName);
        fileItemNames.add(iName);
      }
      if (r.series_code) fileSeriesCodes.add(String(r.series_code).trim().toLowerCase());
    });

    // 3. Fetch Existing Masters (REMOVED HSN QUERY FROM PROMISE)
    const [categories, taxGroups, godowns, existingParents, dbDuplicateItems, dbDuplicateSeries] = await Promise.all([
      // 1. Categories
      commonQuery.findAllRecords(ItemCategory, { ...commonWhere, category_name: { [Op.in]: Array.from(categoryNames) }}, { attributes: ['id', 'category_name'], raw: true }, transaction),
      
      // 2. Tax Groups (Shifted up)
      commonQuery.findAllRecords(TaxGroup, { ...commonWhere }, {
        attributes: [ 'id', 'group_value', [sequelize.col('transactions.taxes.taxType.tax_type'), 'tax_type'] ],
        include: [{
          model: TaxGroupTransaction, as: "transactions", where: { status: 0 }, required: true, attributes: [],
          include: [{
            model: Taxes, as: "taxes", where: { status: 0 }, required: true, attributes: [],
            include: [{ model: TaxTypeMaster, as: "taxType", required: true, attributes: [] }]
          }]
        }],
        group: [ 'TaxGroup.id', 'TaxGroup.group_value', 'transactions.taxes.taxType.tax_type' ],
        raw: true,
      }, transaction, false),
      
      // 3. Godowns
      commonQuery.findAllRecords(GodownMaster, { ...commonWhere, name: { [Op.in]: Array.from(godownNames) }}, { attributes: ['id', 'name'], raw: true }, transaction),
      
      // 4. Existing Parents
      commonQuery.findAllRecords(ItemMaster, { company_id, item_name: { [Op.in]: Array.from(parentItemNames) }, is_variants: 1 }, { attributes: ['id', 'item_name', 'series_code'], raw: true }, transaction),
      
      // 5. DB Duplicate Items (by Name)
      !isItemUnique ? commonQuery.findAllRecords(ItemMaster, { company_id, item_name: { [Op.in]: Array.from(fileItemNames) } }, { attributes: ['item_name'], raw: true }, transaction) : Promise.resolve([]),
      
      // 6. DB Duplicate Codes (by Item Code/Series Code)
      !isItemUnique ? commonQuery.findAllRecords(ItemMaster, { company_id, series_code: { [Op.in]: Array.from(fileSeriesCodes) } }, { attributes: ['series_code'], raw: true }, transaction) : Promise.resolve([])
    ]);

    // 4. Build Maps
    const masterData = {
      categoryMap: new Map(categories.map(c => [String(c.category_name).trim().toLowerCase(), c.id])),
      // hsnMap: ... REMOVED
      godownMap: new Map(godowns.map(g => [String(g.name).trim().toLowerCase(), g.id])),
      parentItemMap: new Map(existingParents.map(p => [String(p.item_name).trim().toLowerCase(), { id: p.id, series_code: p.series_code }])),
      taxGroupMap: {},
      dbExistingItemMap: new Map(dbDuplicateItems.map(i => [i.item_name.toLowerCase(), true])),
      dbExistingSeriesMap: new Map(dbDuplicateSeries.map(s => [s.series_code.toLowerCase(), true])), 
      fileTrackingItemMap: new Map(),
      fileTrackingCodeMap: new Map(),
      variantCountMap: new Map()
    };

    // Tax Map Builder
    for (const group of taxGroups) {
        const rate = Number(group.group_value);
        const type = group.tax_type?.trim(); 
        if (rate) {
             masterData.taxGroupMap[`${type}_${rate}`] = group.id; 
             if(!masterData.taxGroupMap[`${rate}`]) masterData.taxGroupMap[`${rate}`] = group.id; 
        }
    }

    // 5. Create Missing Categories Only
    const newCategorySet = new Set();
    categoryNames.forEach(name => { if(name && !masterData.categoryMap.has(name.toLowerCase())) newCategorySet.add(name); });

    if (newCategorySet.size > 0) {
      const catsToCreate = Array.from(newCategorySet).map(name => ({ category_name: name, ...commonData }));
      const created = await commonQuery.bulkCreate(ItemCategory, catsToCreate, {}, transaction);
      created.forEach(c => masterData.categoryMap.set(c.category_name.toLowerCase(), c.id));
    }

    // 6. Process Rows
    let createdCount = 0;
    let errorCount = 0;
    const errorSample = [];
    const MAX_SAMPLE = 10;
    let lastParentName = ""; 

    for (let i = 0; i < rows.length; i++) {
      if (i % 20 === 0) await new Promise(resolve => setImmediate(resolve));
      if (isCancelled) throw new Error("IMPORT_CANCELLED");

      const record = rows[i];
      const originalRecord = originalRows[i];
      const rowIndex = i + 2;

      try {
        // --- A. Validation & Duplicate Checks ---
        const itemNameRaw = String(record.item_name || '').trim();
        const itemNameLower = itemNameRaw.toLowerCase();
        
        let workingItemName = itemNameRaw;
        if (!workingItemName && record.suffix && lastParentName) {
            workingItemName = lastParentName;
        }
        if (!workingItemName) throw new Error("Item Name is required");
        
        lastParentName = workingItemName; 
        const workingItemNameLower = workingItemName.toLowerCase();

        const isVariant = !!record.suffix;
        
        // --- DUPLICATE CHECK LOGIC ---
        if (!isVariant) {
            // 1. Name Check
            if (masterData.fileTrackingItemMap.has(workingItemNameLower)) throw new Error("Duplicate Item Name inside file");
            if (!isItemUnique && masterData.dbExistingItemMap.has(workingItemNameLower)) throw new Error("Item Name already exists in system");
            masterData.fileTrackingItemMap.set(workingItemNameLower, rowIndex);

            // 2. Code Check
            const codeRaw = String(record.series_code || '').trim().toLowerCase();
            if (codeRaw) {
                 if (masterData.fileTrackingCodeMap.has(codeRaw)) throw new Error(`Duplicate Item Code '${record.series_code}' inside file`);
                 if (!isItemUnique && masterData.dbExistingSeriesMap.has(codeRaw)) throw new Error(`Item Code '${record.series_code}' already exists in system`);
                 masterData.fileTrackingCodeMap.set(codeRaw, rowIndex);
            }
        }

        // --- B. Resolve IDs ---
        const categoryId = masterData.categoryMap.get(String(record.category || record.category_name || '').trim().toLowerCase()) || null;

        // --- UPDATED HSN LOGIC (Direct String + Regex Validation) ---
        const hsnRaw = String(record.hsn_code || '').trim();
        
        if (!hsnRaw) throw new Error("HSN Code is required.");
        
        // Validation: HSN must be 4 to 8 digits (Standard GST format)
        const hsnRegex = /^\d{4,8}$/;
        if (!hsnRegex.test(hsnRaw)) {
             throw new Error(`HSN Code '${hsnRaw}' is invalid. It must contain only 4 to 8 digits.`);
        }

        // --- STRICT UNIT CHECK (Using Static Map) ---
        const pUnitRaw = String(record.primary_unit || '').trim().toUpperCase();
        const sUnitRaw = String(record.alternate_unit || '').trim().toUpperCase();

        const unitId = UNIT_ID_MAP[pUnitRaw]; 
        const alternateUnitId = sUnitRaw ? UNIT_ID_MAP[sUnitRaw] : unitId;

        if (!unitId) throw new Error(`Unit '${pUnitRaw}' is invalid. Please use standard UQC codes.`);
        if (sUnitRaw && !alternateUnitId) throw new Error(`Alternate Unit '${sUnitRaw}' is invalid.`);

        const godownId = masterData.godownMap.get(String(record.godown_id || record.godown_name || '').trim().toLowerCase()) || 1;

        // --- Tax & Price Logic ---
        const rateStr = String(record.tax_rate || "").replace("%", "").trim();
        const rate = parseFloat(rateStr);
        let intraTaxId = null, interTaxId = null;
        if (!isNaN(rate)) {
             intraTaxId = masterData.taxGroupMap[`Intra_${rate}`] || masterData.taxGroupMap[`${rate}`] || null;
             interTaxId = masterData.taxGroupMap[`Inter_${rate}`] || masterData.taxGroupMap[`${rate}`] || null;
        }
        if (!intraTaxId) throw new Error(`Tax Rate ${rate}% not found in system.`);

        // --- UPDATED PRICE INCLUSION LOGIC (Yes=1, No=2) ---
        const purchaseInclTax = String(record.purchase_rate_tax_type || 'No').toLowerCase() === 'yes' ? 1 : 2;
        const saleInclTax = String(record.sale_rate_tax_type || 'No').toLowerCase() === 'yes' ? 1 : 2;

        // --- C. Creation Logic ---
        const suffix = String(record.suffix || '').trim();
        let itemId = 0;
        const taxFlag = String(record.tax_flag || 'Exclude').toLowerCase() === "include" ? 2 : 1;
        const maintainStock = String(record.maintain_stock || 'Yes').toLowerCase() === "yes" ? 1 : 2;
        const batchWise = String(record.batch_wise || 'No').toLowerCase() === "yes" ? 1 : 2;
        const serialNoWise = String(record.serial_number_wise || 'No').toLowerCase() === "yes" ? 1 : 2;

        if (!suffix) {
            // SCENARIO 1: PARENT
            if (masterData.parentItemMap.has(workingItemNameLower)) {
                itemId = masterData.parentItemMap.get(workingItemNameLower).id;
            } else {
                let parentSeries = await generateSeriesNumber(0, company_id, transaction, ItemMaster, "series_code", 5, MODULES.ITEM_MASTER.ID);
                await updateSeriesNumber(0, company_id, transaction, MODULES.ITEM_MASTER.ID);

                const newParent = await commonQuery.createRecord(
                    ItemMaster,
                    {
                      ...commonData,
                      item_name: workingItemName,
                      series_code: parentSeries,
                      item_code: record.series_code, 
                      barcode: record.barcode,
                      item_category_id: categoryId,
                      
                      hsn_code: hsnRaw, // Saving direct string
                      
                      primary_unit: unitId,
                      alternate_unit: alternateUnitId,
                      purchase_quantity: format(record.purchase_quantity || 1),
                      alternate_unit_quantity: format(record.alternate_unit_quantity || 1),
                      purchase_rate: format(record.purchase_rate || 0),
                      sale_rate: format(record.sale_rate || 0),
                      
                      purchase_rate_tax_type: purchaseInclTax, // Saving inclusion flag
                      sale_rate_tax_type: saleInclTax,         // Saving inclusion flag
                      
                      intra_tax_group_id: intraTaxId,
                      inter_tax_group_id: interTaxId,
                      tax_flag: taxFlag,
                      description: record.description,
                      is_variants: 1, 
                      maintain_stock: maintainStock,
                      batch_wise: batchWise,
                      serial_number_wise: serialNoWise,
                      opening_stock: record.opening_stock ? format(record.opening_stock) : 0, 
                      current_stock: 0,
                      status: 0
                  }, 
                  transaction
                );

                itemId = newParent.id;
                masterData.parentItemMap.set(workingItemNameLower, { id: itemId, series_code: parentSeries });
                createdCount++;
            }
        } else {
            // SCENARIO 2: VARIANT
            let parentData = masterData.parentItemMap.get(workingItemNameLower);

            if (!parentData) {
                let parentSeries = await generateSeriesNumber(0, company_id, transaction, ItemMaster, "series_code", 5, MODULES.ITEM_MASTER.ID);
                await updateSeriesNumber(0, company_id, transaction, MODULES.ITEM_MASTER.ID);

                const shellParent = await commonQuery.createRecord(
                    ItemMaster,
                    {
                      ...commonData,
                      item_name: workingItemName,
                      series_code: parentSeries,
                      item_category_id: categoryId,
                      hsn_code: hsnRaw, // Direct String
                      primary_unit: unitId,
                      is_variants: 1,
                      status: 0,
                      maintain_stock: 2
                  },
                  transaction
                );
                
                parentData = { id: shellParent.id, series_code: parentSeries };
                masterData.parentItemMap.set(workingItemNameLower, parentData);
            }

            let variantSeries = record.series_code;
            if (!variantSeries) {
                if (!masterData.variantCountMap.has(workingItemNameLower)) masterData.variantCountMap.set(workingItemNameLower, 0);
                const nextCount = masterData.variantCountMap.get(workingItemNameLower) + 1;
                masterData.variantCountMap.set(workingItemNameLower, nextCount);
                variantSeries = `${parentData.series_code}-V${nextCount}`;
            }

            const variantName = `${workingItemName} - ${suffix}`;
            
            const newVariant = await commonQuery.createRecord(
              ItemMaster,
              {
                ...commonData,
                item_name: variantName,
                series_code: variantSeries,
                item_code: record.series_code,
                barcode: record.barcode,
                item_category_id: categoryId,
                hsn_code: hsnRaw, // Direct String
                primary_unit: unitId,
                alternate_unit: alternateUnitId,
                purchase_quantity: format(record.purchase_quantity || 1),
                alternate_unit_quantity: format(record.alternate_unit_quantity || 1),
                purchase_rate: format(record.purchase_rate || 0),
                sale_rate: format(record.sale_rate || 0),
                
                purchase_rate_tax_type: purchaseInclTax, // Saving inclusion flag
                sale_rate_tax_type: saleInclTax,         // Saving inclusion flag
                
                intra_tax_group_id: intraTaxId,
                inter_tax_group_id: interTaxId,
                tax_flag: taxFlag,
                description: record.description,
                is_variants: 2,
                parent_item_id: parentData.id,
                maintain_stock: maintainStock,
                batch_wise: batchWise,
                serial_number_wise: serialNoWise,
                opening_stock: record.opening_stock ? format(record.opening_stock) : 0,
                current_stock: 0,
                status: 0
              }, 
              transaction
            );

            itemId = newVariant.id;
            createdCount++;
        }

        // --- D. Stock & Serial Logic ---
        const qty = parseFloat(record.opening_stock || 0);
        
        if (qty > 0 && itemId && maintainStock === 1) {
            const stockTrn = await addStock({
                transaction,
                item_id: itemId,
                item_unit: unitId,
                item_amount: format(record.purchase_rate || 0),
                item_convert_amount: format(record.purchase_rate || 0),
                ref_id: itemId,
                ref_module_id: MODULES.ITEM_MASTER.ID,
                item_qty: qty,
                stock_flag: 1, 
                godown_id: godownId,
                batch_no: record.batch_no || null,
                commonData
            });

            if (record.serial_no && serialNoWise === 1) {
              let serialList = [];
              const isAutoSerial = String(record.auto_generate_serial_no || 'No').toLowerCase() === 'yes';
              const intQty = Math.floor(qty);

              if (isAutoSerial) {
                  const baseStr = `${record.series_code}-${Date.now()}`;
                  for(let k=0; k < intQty; k++) {
                      serialList.push(`${baseStr}-${k+1}`);
                  }
              } else {
                  if (!record.serial_no) throw new Error("Serial Numbers are required when 'Serial No Wise' is Yes.");
                  serialList = parseSerials(record.serial_no);
                  if (serialList.length !== intQty) throw new Error(`Mismatch: Serial No count (${serialList.length}) does not match Opening Stock (${intQty}).`);
              }

              if (serialList.length > 0) {
                  const serialPayload = serialList.map(sn => ({
                      item_id: itemId,
                      serial_no: sn,
                      status: 0,
                      in_module_id: MODULES.ITEM_MASTER.ID,
                      in_ref_id: itemId,
                      stock_trn_id: stockTrn.id,
                      godown_id: godownId,
                      ...commonData
                  }));
                  await SerialNumber.bulkCreate(serialPayload, { transaction });
              }
          }
        }

      } catch (rowError) {
        errorCount++;
        if (errorCount <= MAX_SAMPLE) errorSample.push(`Row ${rowIndex}: ${rowError.message}`);
        writeError(errorFileStream, originalRecord, rowError.message);
      }
    }

    // 7. Finalize
    if (errorFileStream) errorFileStream.end();

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
            result: { success: true, message: `${createdCount} items processed successfully.`, count: createdCount, errorCount, errors: errorSample }
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