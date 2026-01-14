const { parentPort, workerData } = require("worker_threads");
const { sequelize, commonQuery } = require("../../../helpers");
const { 
  ItemMaster, 
  ItemCategory, 
  HSNMaster, 
  TaxGroup, 
  TaxGroupTransaction, 
  Taxes, 
  TaxTypeMaster,
  GodownMaster,
  SerialNumber,
  SeriesTypeMaster, 
  StockTransaction
} = require("../../../models");
const { transformRows } = require("../../../helpers/functions/excelService");
const { Op } = require("sequelize");
const xlsx = require("xlsx");
const fs = require("fs");
const { fixDecimals } = require("../../../helpers/functions/commonFunctions");
const { ENTITIES } = require("../../../helpers/constants");
const { addStock } = require("../../../helpers/functions/inventoryFunctions");
const { fail } = require('../../../helpers/Err');

// Static Unit ID Mapping
const UNIT_ID_MAP = {
  "BAG": 1, "BAL": 2, "BDL": 3, "BKL": 4, "BOU": 5, "BOX": 6, "BTL": 7, "BUN": 8, "CAN": 9, "CBM": 10,
  "CCM": 11, "CMS": 12, "CTN": 13, "DOZ": 14, "DRM": 15, "GGK": 16, "GMS": 17, "GRS": 18, "GYD": 19, "KGS": 20,
  "KLR": 21, "KME": 22, "LTR": 23, "MLT": 24, "MTR": 25, "MTS": 26, "NOS": 27, "OTH": 28, "PAC": 29, "PCS": 30,
  "PRS": 31, "QTL": 32, "ROL": 33, "SET": 34, "SQF": 35, "SQM": 36, "SQY": 37, "TBS": 38, "TGM": 39, "THD": 40,
  "TON": 41, "TUB": 42, "UGS": 43, "UNT": 44, "YDS": 45
};

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

const calculateWithoutTax = (amount, taxRate) => {
  if (!amount || !taxRate) return amount;
  return +(amount / (1 + taxRate / 100)).toFixed(5);
};

const runWorker = async () => {
  try { await sequelize.authenticate(); } catch (error) {
    parentPort.postMessage({ status: "ERROR", error: "Database connection failed." });
    process.exit(1);
  }

  const { filePath, errorLogPath, body, user_id, branch_id, company_id } = workerData;
  const { fixNum, fixQty } = await fixDecimals(company_id);
  const isItemUnique = String(body.isItemUnique) === 'true'; 
  
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
    const masterWhere = { company_id, user_id, branch_id, status: 0 }; 

    // --- 2. PRE-SCAN ---
    const categoryNames = new Set();
    const godownNames = new Set();
    const parentItemNames = new Set(); 
    const fileItemNames = new Set(); 
    const fileSeriesCodes = new Set(); 
    const fileDerivedParentNames = new Set(); // Tracks parents identified within this file

    rows.forEach(r => {
      if (r.category) categoryNames.add(String(r.category.toLowerCase()).trim());
      if (r.godown_name) godownNames.add(String(r.godown_name.toLowerCase()).trim());
      const iName = String(r.item_name || '').trim().toLowerCase();
      const suffix = String(r.suffix || '').trim();

      if (iName) {
        fileItemNames.add(iName);
        if (suffix.length > 0) {
            parentItemNames.add(iName); 
            fileDerivedParentNames.add(iName); 
        }
      }
      if (r.series_code) fileSeriesCodes.add(String(r.series_code).trim().toLowerCase());
    });

    // --- 3. FETCH MASTERS ---
    const [categories, taxGroups, godowns, existingParents, dbDuplicateItems, dbDuplicateSeries, existingVariants, variantCounts] = await Promise.all([
      commonQuery.findAllRecords(ItemCategory, { ...masterWhere, category_name: { [Op.in]: Array.from(categoryNames) }}, { attributes: ['id', 'category_name'], raw: true }, transaction),
      commonQuery.findAllRecords(TaxGroup, { ...masterWhere }, {
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
      commonQuery.findAllRecords(GodownMaster, { ...masterWhere, name: { [Op.in]: Array.from(godownNames) }}, { attributes: ['id', 'name'], raw: true }, transaction),
      commonQuery.findAllRecords(ItemMaster, { ...masterWhere, item_name: { [Op.in]: Array.from(parentItemNames) }, is_variants: 1 }, { attributes: ['id', 'item_name', 'series_code'], raw: true }, transaction),
      !isItemUnique ? commonQuery.findAllRecords(ItemMaster, { ...masterWhere, item_name: { [Op.in]: Array.from(fileItemNames) } }, { attributes: ['item_name'], raw: true }, transaction) : Promise.resolve([]),
      !isItemUnique ? commonQuery.findAllRecords(ItemMaster, { ...masterWhere, series_code: { [Op.in]: Array.from(fileSeriesCodes) } }, { attributes: ['series_code'], raw: true }, transaction) : Promise.resolve([]),
      !isItemUnique ? commonQuery.findAllRecords(ItemMaster, { ...masterWhere, is_variants: 2 }, { attributes: ['item_name'], raw: true }, transaction) : Promise.resolve([]),
      commonQuery.findAllRecords(ItemMaster, { ...masterWhere, is_variants: 2 }, {
        attributes: ['parent_item_id', [sequelize.fn('COUNT', sequelize.col('id')), 'variant_count']],
        group: ['parent_item_id'],
        raw: true
      }, transaction)
    ]);

    // --- 4. BUILD MAPS ---
    const masterData = {
      categoryMap: new Map(categories.map(c => [String(c.category_name).trim().toLowerCase(), c.id])),
      godownMap: new Map(godowns.map(g => [String(g.name).trim().toLowerCase(), g.id])),
      parentItemMap: new Map(existingParents.map(p => [String(p.item_name).trim().toLowerCase(), { id: p.id, series_code: p.series_code }])),
      dbVariantNameMap: new Map(existingVariants.map(v => [String(v.item_name).toLowerCase(), true])),
      variantCountMap: new Map(variantCounts.map(vc => [vc.parent_item_id, Number(vc.variant_count)])),
      taxGroupMap: {},
      dbExistingItemMap: new Map(dbDuplicateItems.map(i => [i.item_name.toLowerCase(), true])),
      dbExistingSeriesMap: new Map(dbDuplicateSeries.map(s => [s.series_code.toLowerCase(), true])), 
      fileTrackingItemMap: new Map(),
      fileTrackingCodeMap: new Map(),
      fileTrackingVariantMap: new Map()
    };

    for (const group of taxGroups) {
        const rate = Number(group.group_value);
        const type = group.tax_type?.trim(); 
        if (rate) {
             masterData.taxGroupMap[`${type}_${rate}`] = group.id; 
             if(!masterData.taxGroupMap[`${rate}`]) masterData.taxGroupMap[`${rate}`] = group.id; 
        }
    }
    
    // --- 5. CREATE MISSING CATEGORIES ---
    const newCategorySet = new Set();
    categoryNames.forEach(name => { if(name && !masterData.categoryMap.has(name.toLowerCase())) newCategorySet.add(name); });
    if (newCategorySet.size > 0) {
      const catsToCreate = Array.from(newCategorySet).map(name => ({ category_name: name, ...masterCommonData }));
      const created = await commonQuery.bulkCreate(ItemCategory, catsToCreate, {}, transaction);
      created.forEach(c => masterData.categoryMap.set(c.category_name.toLowerCase(), c.id));
    }

    // --- 7. PROCESSING LOOP ---
    let createdCount = 0;
    let errorCount = 0;
    const errorSample = [];
    const MAX_SAMPLE = 100;
    let lastParentName = ""; 
    
    // Containers
    const itemsToBulkInsert = [];
    const stockMetaList = []; 
    const additionalStockList = [];
    const createdVariantMap = new Map();

    for (let i = 0; i < rows.length; i++) {
      if (i % 500 === 0 && i > 0) await new Promise(resolve => setImmediate(resolve));
      if (isCancelled) fail("IMPORT_CANCELLED");

      const record = rows[i];
      const originalRecord = originalRows[i];
      const rowIndex = i + 2;

      try {
        const itemNameRaw = String(record.item_name || '').trim();
        let workingItemName = itemNameRaw;
        
        if (!workingItemName && record.suffix && lastParentName) workingItemName = lastParentName;
        if (!workingItemName) fail("Item Name is required");
        lastParentName = workingItemName; 
        const workingItemNameLower = workingItemName.toLowerCase();
        
        const suffix = String(record.suffix || '').trim();
        const isVariant = suffix.length > 0;
        let openingStock = record.opening_stock ? Number(fixQty(record.opening_stock)) : 0;
        // --- 3. [VALIDATION] MAIN ITEM STOCK CHECK (MOVED TO TOP) ---
        // Rule: If this is a Main Item (!isVariant) AND it has variants in this file (fileDerivedParentNames)
        // Then it strictly cannot have any Opening Stock.
        if (!isVariant && fileDerivedParentNames.has(workingItemNameLower)) {
             if (openingStock > 0) {
                 fail(`Main Item '${workingItemName}' cannot have Opening Stock because it has variants. Please add stock to the variants instead.`);
             }
        }

        const batchNo = String(record.batch_no || '').trim();

        // --- 4. SETTINGS & CONFLICT VALIDATION ---
        const isParentReference = !isVariant && fileDerivedParentNames.has(workingItemNameLower);

        // [VALIDATION] Parent cannot be Batch Wise if its variants have batches
        if (isParentReference && batchNo) {
            fail("Conflict: Main Item cannot be Batch Wise because its variants are configured with batches.");
        }

        const rawSerialNo = record.serial_no;
        const serialCodes = rawSerialNo
            ? rawSerialNo
                .split(',')
                .map(s => s.trim())
                .filter(Boolean)
                .map(s => s.toUpperCase())
            : [];

        if (batchNo && serialCodes.length > 0) fail("Cannot enable both Batch Wise and Serial Number Wise.");

        // --- 5. DUPLICATE BATCH CHECK ---
        if (!this.batchTrackingSet) this.batchTrackingSet = new Set();
        if (batchNo) {
            const uniqueBatchKey = `${workingItemNameLower}|${suffix.toLowerCase()}|${batchNo.toLowerCase()}`;
            if (this.batchTrackingSet.has(uniqueBatchKey)) {
                fail(`Duplicate Batch Number '${batchNo}' for this item.`);
            }
            this.batchTrackingSet.add(uniqueBatchKey);
        }
        
        // --- DUPLICATE CHECKS (Smart Batch Handling) ---
        let isDuplicateItem = false;
        let isDuplicateVariant = false;

        if (!isVariant) {
            if (masterData.fileTrackingItemMap.has(workingItemNameLower)) {
                if (batchNo) {
                    isDuplicateItem = true; // ✅ Allow duplicate for batch addition
                } else {
                    fail("Duplicate Item Name inside file");
                }
            } else {
                if (!isItemUnique && masterData.dbExistingItemMap.has(workingItemNameLower)) {
                     fail("Item Name already exists in system");
                }
                masterData.fileTrackingItemMap.set(workingItemNameLower, rowIndex);
            }
        } else {
            const variantName = `${workingItemName}-${suffix}`;
            const variantNameLower = variantName.toLowerCase();

            if (masterData.fileTrackingVariantMap.has(variantNameLower)) {
                if (batchNo) {
                    isDuplicateVariant = true; // ✅ Allow duplicate for batch addition
                } else {
                    fail(`Duplicate Variant Name '${variantName}' inside file`);
                }
            } else {
                if (!isItemUnique && masterData.dbVariantNameMap.has(variantNameLower)) {
                    fail(`Variant Name '${variantName}' already exists in system`);
                }
                masterData.fileTrackingVariantMap.set(variantNameLower, rowIndex);
            }
        }

        // --- SERIES CODE CHECK ---
        // Skip check if we already know it's a duplicate Item/Variant (same item = same code)
        if (!isDuplicateItem && !isDuplicateVariant) {
            const codeRaw = String(record.series_code || '').trim().toLowerCase();
            if (codeRaw) {
                 if (masterData.fileTrackingCodeMap.has(codeRaw)) fail(`Duplicate Item Code '${record.series_code}' inside file`);
                 if (!isItemUnique && masterData.dbExistingSeriesMap.has(codeRaw)) fail(`Item Code '${record.series_code}' already exists in system`);
                 masterData.fileTrackingCodeMap.set(codeRaw, rowIndex);
            }
        }

        if (batchNo && serialCodes.length > 0) fail("Cannot enable both Batch Wise and Serial Number Wise.");

        // --- DATA RESOLUTION ---
        const categoryId = masterData.categoryMap.get(String(record.category || record.category_name || '').trim().toLowerCase()) || null;
        const hsnRaw = String(record.hsn_code || '').trim();
        if (!hsnRaw) fail("HSN Code is required.");
        if (!/^\d{4,8}$/.test(hsnRaw)) fail(`HSN Code '${hsnRaw}' is invalid. 4-8 digits required.`);

        const pUnitRaw = String(record.primary_unit || '').trim().toUpperCase();
        const sUnitRaw = String(record.alternate_unit || '').trim().toUpperCase();
        const unitId = UNIT_ID_MAP[pUnitRaw]; 
        const alternateUnitId = sUnitRaw ? UNIT_ID_MAP[sUnitRaw] : unitId;
        if (!unitId) fail(`Unit '${pUnitRaw}' is invalid.`);

        const godownId = masterData.godownMap.get(String(record.godown_id || record.godown_name || '').trim().toLowerCase()) || 1;

        const rateStr = String(record.tax_rate || "").replace("%", "").trim();
        const rate = parseFloat(rateStr);
        let intraTaxId = null, interTaxId = null;
        if (!isNaN(rate)) {
             intraTaxId = masterData.taxGroupMap[`Intra_${rate}`] || masterData.taxGroupMap[`${rate}`] || null;
             interTaxId = masterData.taxGroupMap[`Inter_${rate}`] || masterData.taxGroupMap[`${rate}`] || null;
        }
        if (!intraTaxId) fail(`Tax Rate ${rate}% not found in system.`);
        const purchaseInclTax = String(record.purchase_rate_tax_type || 'No').toLowerCase() === 'yes' ? 1 : 2;
        const saleInclTax = String(record.sale_rate_tax_type || 'No').toLowerCase() === 'yes' ? 1 : 2;
        const purchaseRateInput = fixNum(record.purchase_rate || 0);
        const purchaseRateWithout = purchaseInclTax === 1 ? calculateWithoutTax(purchaseRateInput, rate) : purchaseRateInput;
        const saleRateInput = fixNum(record.sale_rate || 0);
        const saleRateWithout = saleInclTax === 1 ? calculateWithoutTax(saleRateInput, rate) : saleRateInput;

        // Series & Barcode
        let seriesCode = record.series_code;
        let barcode = record.barcode;
        if (!barcode) barcode = null;

        const maintainStock = String(record.maintain_stock || 'Yes').toLowerCase() === "yes" ? 1 : 2;
        
        if (!isVariant) {
            // >>> STANDARD / PARENT ITEM
            
            if (isDuplicateItem) {
                // Check if this item was created Linearly (Parent) or needs to wait for Bulk
                const existingParent = masterData.parentItemMap.get(workingItemNameLower);

                if (existingParent && existingParent.id) {
                     // CASE: Linear Parent (Already exists in DB/Transaction) -> Add Stock Immediately
                     if (maintainStock === 1 && openingStock > 0) {
                         const batch = batchNo ? batchNo : null;
                         const stockTrn = await addStock({
                            transaction,
                            item_id: existingParent.id,
                            item_unit: unitId,
                            item_amount: purchaseRateInput,
                            item_convert_amount: purchaseRateInput,
                            ref_id: existingParent.id,
                            ref_entity_id: ENTITIES.ITEM_MASTER.ID,
                            item_qty: openingStock,
                            stock_flag: 1, 
                            godown_id: godownId,
                            batch_no: batch,
                            commonData
                        });
                        // ... serials if needed ...
                     }
                } else {
                     // CASE: Bulk Item (Not yet created) -> Queue extra batch for later
                    additionalStockList.push({
                        itemName: workingItemName.toLowerCase(), // Key to find ID later
                        hasStock: (maintainStock === 1 && openingStock > 0),
                        openingStock, unitId, godownId, purchaseRateInput, batchWise, serialNoWise,
                        batchNo: record.batch_no, seriesCode, rowIndex, originalRecord
                    });
                }
            } 
            else {
                const itemPayload = {
                    ...masterCommonData,
                    item_name: workingItemName,
                    series_code: seriesCode,
                    barcode: barcode,
                    item_category_id: categoryId,
                    hsn_code: hsnRaw,
                    primary_unit: unitId,
                    alternate_unit: alternateUnitId,
                    purchase_quantity: fixQty(record.purchase_quantity || 1),
                    alternate_unit_quantity: fixQty(record.alternate_unit_quantity || 1),
                    purchase_rate: purchaseRateInput,
                    purchase_rate_without_tax: purchaseRateWithout,
                    sale_rate: saleRateInput,
                    sale_rate_without_tax: saleRateWithout,
                    purchase_rate_tax_type: purchaseInclTax,
                    sale_rate_tax_type: saleInclTax,
                    intra_tax_group_id: intraTaxId,
                    inter_tax_group_id: interTaxId,
                    tax_rate: rate,
                    description: record.description,
                    is_variants: 2, 
                    maintain_stock: maintainStock,
                    batch_wise: batchNo ? 1 : 0,
                    serial_number_wise: serialCodes.length > 0 ? 1 : 0,
                    godown_id: godownId,
                    opening_stock: openingStock,
                    opening_stock_valuation: openingStock * purchaseRateWithout,
                    current_stock: maintainStock === 1 ? openingStock : 0, 
                    status: 0
                };

                const isParentReference = fileDerivedParentNames.has(workingItemNameLower);

                if (isParentReference) {
                    const newItem = await commonQuery.createRecord(ItemMaster, itemPayload, transaction);
                    masterData.parentItemMap.set(workingItemNameLower, { id: newItem.id, series_code: seriesCode });
                    masterData.variantCountMap.set(newItem.id, 0);

                    if (maintainStock === 1 && openingStock > 0) {
                         const batch = batchNo ? batchNo : null;
                         const stockTrn = await addStock({
                            transaction,
                            item_id: newItem.id,
                            item_unit: unitId,
                            item_amount: purchaseRateInput,
                            item_convert_amount: purchaseRateInput,
                            ref_id: newItem.id,
                            ref_entity_id: ENTITIES.ITEM_MASTER.ID,
                            item_qty: openingStock,
                            stock_flag: 1, 
                            godown_id: godownId,
                            batch_no: batch,
                            commonData
                        });
                        
                        if (serialCodes.length > 0) {
                            const intQty = Math.floor(openingStock);
                            if (serialCodes.length !== intQty) {
                                fail(`Serial count mismatch. Item qty = ${intQty}, serial codes provided = ${serialCodes.length}`);
                            }

                            const uniqueSerials = new Set(serialCodes);
                            if (uniqueSerials.size !== serialCodes.length) {
                                fail("Duplicate serial numbers found in series code");
                            }

                            const serialList = serialCodes.map((serial) => ({
                                item_id: newItem.id,
                                serial_no: serial,
                                status: 0,
                                in_entity_id: ENTITIES.ITEM_MASTER.ID,
                                in_ref_id: newItem.id,
                                stock_trn_id: stockTrn.id,
                                godown_id: godownId,
                                ...commonData
                            }));

                            await SerialNumber.bulkCreate(serialList, { transaction });
                        }
                    }
                    createdCount++;
                } else {
                    // BULK INSERT
                    itemsToBulkInsert.push(itemPayload);
                    stockMetaList.push({
                        hasStock: (maintainStock === 1 && openingStock > 0),
                        openingStock, unitId, godownId, purchaseRateInput,
                        batchNo, seriesCode, serialCodes, rowIndex, originalRecord
                    });
                    createdCount++;
                }
            }

        } else {
            // >>> VARIANT ITEM
            let parentData = masterData.parentItemMap.get(workingItemNameLower);

            // Fallback: Create Shell Parent if missing
            if (!parentData) {
                const shellParent = await commonQuery.createRecord(
                    ItemMaster,
                    {
                      ...masterCommonData,
                      item_name: workingItemName,
                      series_code: seriesCode,
                      item_category_id: categoryId,
                      hsn_code: hsnRaw, 
                      primary_unit: unitId,
                      is_variants: 1,
                      status: 0,
                      maintain_stock: 2
                    },
                    transaction
                );
                parentData = { id: shellParent.id, series_code: seriesCode };
                masterData.parentItemMap.set(workingItemNameLower, parentData);
                masterData.variantCountMap.set(parentData.id, 0);
            }

            let variantSeries = seriesCode;

            if (isDuplicateVariant) {
                const variantName = `${workingItemName}-${suffix}`;
                const variantNameLower = variantName.toLowerCase();
                const existingId = createdVariantMap.get(variantNameLower);

                if (existingId && maintainStock === 1 && openingStock > 0) {
                     const batch = batchNo ? batchNo : null;
                     await addStock({
                        transaction,
                        item_id: existingId,
                        item_unit: unitId,
                        item_amount: purchaseRateInput,
                        item_convert_amount: purchaseRateInput,
                        ref_id: existingId,
                        ref_entity_id: ENTITIES.ITEM_MASTER.ID,
                        item_qty: openingStock,
                        stock_flag: 1, 
                        godown_id: godownId,
                        batch_no: batch,
                        commonData
                    });
                }
            } else {
                // ✅ NEW VARIANT
                const variantName = `${workingItemName} - ${suffix}`;
                const newVariant = await commonQuery.createRecord(
                  ItemMaster,
                  {
                    ...masterCommonData,
                    item_name: variantName,
                    series_code: variantSeries,
                    barcode: barcode,
                    item_category_id: categoryId,
                    hsn_code: hsnRaw,
                    primary_unit: unitId,
                    alternate_unit: alternateUnitId,
                    purchase_quantity: fixQty(record.purchase_quantity || 1),
                    alternate_unit_quantity: fixQty(record.alternate_unit_quantity || 1),
                    purchase_rate: purchaseRateInput,
                    purchase_rate_without_tax: purchaseRateWithout,
                    sale_rate: saleRateInput,
                    sale_rate_without_tax: saleRateWithout,
                    purchase_rate_tax_type: purchaseInclTax, 
                    sale_rate_tax_type: saleInclTax, 
                    intra_tax_group_id: intraTaxId,
                    inter_tax_group_id: interTaxId,
                    tax_rate: rate,
                    description: record.description,
                    is_variants: 2,
                    parent_item_id: parentData.id,
                    maintain_stock: maintainStock,
                    batch_wise: batchNo ? 1 : 0,
                    serial_number_wise: serialCodes.length > 0 ? 1 : 0,
                    godown_id: godownId,
                    opening_stock: openingStock,
                    opening_stock_valuation: openingStock * purchaseRateWithout,
                    current_stock: 0, 
                    status: 0
                  }, 
                  transaction
                );
                
                // Track ID for future duplicates
                const vNameKey = `${workingItemName}-${suffix}`.toLowerCase();
                createdVariantMap.set(vNameKey, newVariant.id);

                if (maintainStock === 1 && openingStock > 0) {
                     const batch = batchNo ? batchNo : null;
                     const stockTrn = await addStock({
                        transaction,
                        item_id: newVariant.id,
                        item_unit: unitId,
                        item_amount: purchaseRateInput,
                        item_convert_amount: purchaseRateInput,
                        ref_id: newVariant.id,
                        ref_entity_id: ENTITIES.ITEM_MASTER.ID,
                        item_qty: openingStock,
                        stock_flag: 1, 
                        godown_id: godownId,
                        batch_no: batch,
                        commonData
                    });

                    if (serialCodes.length > 0) {
                        const intQty = Math.floor(openingStock);

                        if (serialCodes.length !== intQty) {
                            fail(`Serial count mismatch. Item qty = ${intQty}, serial codes provided = ${serialCodes.length}`);
                        }

                        const uniqueSerials = new Set(serialCodes);
                        if (uniqueSerials.size !== serialCodes.length) {
                            fail("Duplicate serial numbers found in series code");
                        }

                        const serialList = serialCodes.map((serial) => ({
                            item_id: newVariant.id,
                            serial_no: serial,
                            status: 0,
                            in_entity_id: ENTITIES.ITEM_MASTER.ID,
                            in_ref_id: newVariant.id,
                            stock_trn_id: stockTrn.id,
                            godown_id: godownId,
                            ...commonData
                        }));

                        await SerialNumber.bulkCreate(serialList, { transaction });
                    }
                }
                createdCount++;
            }
        }

      } catch (rowError) {
        errorCount++;
        if (errorCount <= MAX_SAMPLE) errorSample.push(`Row ${rowIndex}: ${rowError.message}`);
        writeError(errorFileStream, originalRecord, rowError.message);
      }
    }

    // --- 8. EXECUTE BULK ---
    if (itemsToBulkInsert.length > 0) {
        const createdItems = await ItemMaster.bulkCreate(itemsToBulkInsert, { transaction, returning: true });
        
        // Map Name -> ID for additional batches
        const itemNameToIdMap = new Map();
        createdItems.forEach(item => {
            if (item.item_name) itemNameToIdMap.set(item.item_name.toLowerCase(), item.id);
        });

        const stockTransactionsToBulk = [];

        // 8a. Primary Batches
        for (let k = 0; k < createdItems.length; k++) {
            const item = createdItems[k];
            const meta = stockMetaList[k];

            if (meta.hasStock) {
                const batch = meta.batchNo ? meta.batchNo : null;
                
                stockTransactionsToBulk.push({
                    item_id: item.id,
                    item_unit: meta.unitId,
                    item_qty: meta.openingStock,
                    item_amount: meta.purchaseRateInput,
                    item_convert_amount: meta.purchaseRateInput,
                    stock_flag: 1, 
                    godown_id: meta.godownId,
                    ref_id: item.id,
                    ref_entity_id: ENTITIES.ITEM_MASTER.ID,
                    batch_no: batch,
                    party_id: 0,
                    user_id: user_id,
                    company_id: company_id,
                    branch_id: branch_id || 1,
                    transaction_date: new Date(),
                    _meta: meta 
                });
            }
        }

        // 8b. Additional Batches (Duplicate Rows)
        for (const meta of additionalStockList) {
             const itemId = itemNameToIdMap.get(meta.itemName);
             if (itemId && meta.hasStock) {
                 const batch = meta.batchNo ? meta.batchNo : null;
                 stockTransactionsToBulk.push({
                    item_id: itemId,
                    item_unit: meta.unitId,
                    item_qty: meta.openingStock,
                    item_amount: meta.purchaseRateInput,
                    item_convert_amount: meta.purchaseRateInput,
                    stock_flag: 1, 
                    godown_id: meta.godownId,
                    ref_id: itemId,
                    ref_entity_id: ENTITIES.ITEM_MASTER.ID,
                    batch_no: batch,
                    party_id: 0,
                    user_id: user_id,
                    company_id: company_id,
                    branch_id: branch_id || 1,
                    transaction_date: new Date(),
                    _meta: meta 
                });
             }
        }

        // 8c. Create Stocks & Serials
        if (stockTransactionsToBulk.length > 0) {
            const createdStocks = await StockTransaction.bulkCreate(stockTransactionsToBulk, { transaction, returning: true });

            for (let s = 0; s < createdStocks.length; s++) {
                const stockTrn = createdStocks[s];
                const meta = stockTransactionsToBulk[s]._meta;

                try {
                    if (meta.serialCodes?.length > 0) {
                        const intQty = Math.floor(meta.openingStock);

                        if (meta.serialCodes.length !== intQty) {
                            throw new Error(`Serial count mismatch. Item qty = ${intQty}, serial codes provided = ${meta.serialCodes.length}`);
                        }

                        const uniqueSerials = new Set(meta.serialCodes);
                        if (uniqueSerials.size !== meta.serialCodes.length) {
                            throw new Error("Duplicate serial numbers found in series code");
                        }

                        const serialList = meta.serialCodes.map((serial) => ({
                            item_id: stockTrn.item_id,
                            serial_no: serial,
                            status: 0,
                            in_entity_id: ENTITIES.ITEM_MASTER.ID,
                            in_ref_id: stockTrn.item_id,
                            stock_trn_id: stockTrn.id,
                            godown_id: meta.godownId,
                            user_id, company_id, branch_id
                        }));

                        await SerialNumber.bulkCreate(serialList, { transaction });
                    }
                } catch (err) {
                    errorCount++;
                    if (errorCount <= MAX_SAMPLE) {
                        errorSample.push(`Row ${meta.rowIndex}: ${err.message}`);
                    }
                    writeError(errorFileStream, meta.originalRecord, err.message);

                    await StockTransaction.destroy({
                        where: { id: stockTrn.id },
                        transaction
                    });
                }
            }
        }
    }

    // --- 9. FINALIZE ---
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