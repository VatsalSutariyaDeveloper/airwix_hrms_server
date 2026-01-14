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
  SeriesTypeMaster, // Added for Series Config
  StockTransaction  // Added for Bulk Stock
} = require("../../../models");
const { transformRows } = require("../../../helpers/functions/excelService");
const { Op } = require("sequelize");
const xlsx = require("xlsx");
const fs = require("fs");
const { fixDecimals } = require("../../../helpers/functions/commonFunctions");
const { MODULES } = require("../../../helpers/constants");
const { addStock } = require("../../../helpers/functions/inventoryFunctions"); // Keep for variant fallback

// Static Unit ID Mapping
const UNIT_ID_MAP = {
  "BAG": 1, "BAL": 2, "BDL": 3, "BKL": 4, "BOU": 5, "BOX": 6, "BTL": 7, "BUN": 8, "CAN": 9, "CBM": 10,
  "CCM": 11, "CMS": 12, "CTN": 13, "DOZ": 14, "DRM": 15, "GGK": 16, "GMS": 17, "GRS": 18, "GYD": 19, "KGS": 20,
  "KLR": 21, "KME": 22, "LTR": 23, "MLT": 24, "MTR": 25, "MTS": 26, "NOS": 27, "OTH": 28, "PAC": 29, "PCS": 30,
  "PRS": 31, "QTL": 32, "ROL": 33, "SET": 34, "SQF": 35, "SQM": 36, "SQY": 37, "TBS": 38, "TGM": 39, "THD": 40,
  "TON": 41, "TUB": 42, "UGS": 43, "UNT": 44, "YDS": 45
};

// Abort Control
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

const generateBatchNo = (itemCode) => `BATCH-${itemCode}-${Date.now()}`;

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
  const masterCommonData = { company_id }; 

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
    const masterWhere = { company_id, user_id, branch_id, status: 0 }; 

    // 2. Pre-scan for Masters
    const categoryNames = new Set();
    const godownNames = new Set();
    const parentItemNames = new Set(); 
    const fileItemNames = new Set(); 
    const fileSeriesCodes = new Set(); 
    const itemNames = new Set();
    const seriesCodes = new Set();

    const fileDerivedParentNames = new Set(); 

    rows.forEach(r => {
      if (r.category) categoryNames.add(String(r.category.toLowerCase()).trim());
      if (r.godown_name) godownNames.add(String(r.godown_name.toLowerCase()).trim());
      const iName = String(r.item_name || '').trim().toLowerCase();
      const suffix = String(r.suffix || '').trim();

      if (iName) {
        fileItemNames.add(iName);
        // ✅ If this row has a suffix, the Item Name is a Parent
        if (suffix.length > 0) {
            parentItemNames.add(iName); 
            fileDerivedParentNames.add(iName); // <--- Mark this name as a Parent
        }
      }
      if (r.series_code) fileSeriesCodes.add(String(r.series_code).trim().toLowerCase());
    });

    // 3. Fetch Existing Masters
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

    // 4. Build Maps
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

    // 5. Create Missing Categories
    const newCategorySet = new Set();
    categoryNames.forEach(name => { if(name && !masterData.categoryMap.has(name.toLowerCase())) newCategorySet.add(name); });
    if (newCategorySet.size > 0) {
      const catsToCreate = Array.from(newCategorySet).map(name => ({ category_name: name, ...masterCommonData }));
      const created = await commonQuery.bulkCreate(ItemCategory, catsToCreate, {}, transaction);
      created.forEach(c => masterData.categoryMap.set(c.category_name.toLowerCase(), c.id));
    }

    // 6. Fast In-Memory Series Generator Setup
    let seriesConfig = null;
    let nextSeriesValue = 0;
    let seriesUpdated = false;

    const seriesType = await commonQuery.findOneRecord(
        SeriesTypeMaster,
        { series_module_id: MODULES.ITEM_MASTER.ID, is_default: 1, company_id: company_id, status: 0 },
        { raw: true },
        transaction
    );

    if (seriesType) {
        nextSeriesValue = parseInt(seriesType.start_series || 0, 10);
        seriesConfig = {
            format: seriesType.series_format,
            prefix: seriesType.format_value || "",
            suffix: seriesType.end_format_value || "",
            width: 3 
        };
    }

    const generateNextSeriesCode = () => {
        seriesUpdated = true;
        if (!seriesConfig) return `AUTO-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        nextSeriesValue++; 
        const numStr = String(nextSeriesValue).padStart(seriesConfig.width, "0");
        switch (seriesConfig.format) {
            case 2: return `${seriesConfig.prefix}${numStr}`;
            case 3: return `${numStr}${seriesConfig.suffix}`;
            case 4: return `${seriesConfig.prefix}${numStr}${seriesConfig.suffix}`;
            default: return numStr; 
        }
    };

    // 7. Process Rows (Hybrid: Bulk Prep for Standard, Linear for Variants)
    let createdCount = 0;
    let errorCount = 0;
    const errorSample = [];
    const MAX_SAMPLE = 10;
    let lastParentName = ""; 
    
    // Bulk Containers
    const itemsToBulkInsert = [];
    const stockMetaList = []; 
    const serialsToBulkInsert = [];

    for (let i = 0; i < rows.length; i++) {
      if (i % 500 === 0 && i > 0) await new Promise(resolve => setImmediate(resolve));
      if (isCancelled) throw new Error("IMPORT_CANCELLED");

      const record = rows[i];
      const originalRecord = originalRows[i];
      const rowIndex = i + 2;

      try {
        // --- Validation ---
        const itemNameRaw = String(record.item_name || '').trim();
        let workingItemName = itemNameRaw;
        if (!workingItemName && record.suffix && lastParentName) workingItemName = lastParentName;
        if (!workingItemName) throw new Error("Item Name is required");
        lastParentName = workingItemName; 
        const workingItemNameLower = workingItemName.toLowerCase();
        // const isVariant = !!record.suffix;
        const suffix = String(record.suffix || '').trim();
        console.log("record:", record);
        console.log("Processing Row:", rowIndex, "Item Name:", workingItemName, "Suffix:", suffix);
        const isVariant = suffix.length > 0;
// return false;
        // --- Check Duplicates ---
        if (!isVariant) {
            // SCENARIO: Parent Item
            // If this name appeared before in this file, it's a duplicate Parent.
            if (masterData.fileTrackingItemMap.has(workingItemNameLower)) {
                throw new Error("Duplicate Item Name inside file");
            }
            // If not unique in DB, check existing
            if (!isItemUnique && masterData.dbExistingItemMap.has(workingItemNameLower)) {
                throw new Error("Item Name already exists in system");
            }
            masterData.fileTrackingItemMap.set(workingItemNameLower, rowIndex);
        } else {
            // SCENARIO: Variant Item (Bypass Parent Validation)
            
            // ✅ FIX 2: Store as "ItemName-VariantName"
            const variantName = `${workingItemName}-${suffix}`;
            const variantNameLower = variantName.toLowerCase();

            if (masterData.fileTrackingVariantMap.has(variantNameLower)) {
                throw new Error(`Duplicate Variant Name '${variantName}' inside file`);
            }
            if (!isItemUnique && masterData.dbVariantNameMap.has(variantNameLower)) {
                throw new Error(`Variant Name '${variantName}' already exists in system`);
            }
            masterData.fileTrackingVariantMap.set(variantNameLower, rowIndex);
        }

        const codeRaw = String(record.series_code || '').trim().toLowerCase();
        // Skip check if auto or empty
        const isAuto = !codeRaw || codeRaw === '' || codeRaw === 'auto' || codeRaw === 'auto_generate';
        if (codeRaw && !isAuto) {
             if (masterData.fileTrackingCodeMap.has(codeRaw)) throw new Error(`Duplicate Item Code '${record.series_code}' inside file`);
             if (!isItemUnique && masterData.dbExistingSeriesMap.has(codeRaw)) throw new Error(`Item Code '${record.series_code}' already exists in system`);
             masterData.fileTrackingCodeMap.set(codeRaw, rowIndex);
        }

        const batchWise = String(record.batch_wise || 'No').toLowerCase() === "yes" ? 1 : 2;
        const serialNoWise = String(record.serial_number_wise || 'No').toLowerCase() === "yes" ? 1 : 2;
        if (batchWise === 1 && serialNoWise === 1) throw new Error("Cannot enable both Batch Wise and Serial Number Wise.");

        // --- Data Resolution ---
        const categoryId = masterData.categoryMap.get(String(record.category || record.category_name || '').trim().toLowerCase()) || null;
        const hsnRaw = String(record.hsn_code || '').trim();
        if (!hsnRaw) throw new Error("HSN Code is required.");
        if (!/^\d{4,8}$/.test(hsnRaw)) throw new Error(`HSN Code '${hsnRaw}' is invalid. 4-8 digits required.`);

        const pUnitRaw = String(record.primary_unit || '').trim().toUpperCase();
        const sUnitRaw = String(record.alternate_unit || '').trim().toUpperCase();
        const unitId = UNIT_ID_MAP[pUnitRaw]; 
        const alternateUnitId = sUnitRaw ? UNIT_ID_MAP[sUnitRaw] : unitId;
        if (!unitId) throw new Error(`Unit '${pUnitRaw}' is invalid.`);

        const godownId = masterData.godownMap.get(String(record.godown_id || record.godown_name || '').trim().toLowerCase()) || 1;

        const rateStr = String(record.tax_rate || "").replace("%", "").trim();
        const rate = parseFloat(rateStr);
        let intraTaxId = null, interTaxId = null;
        if (!isNaN(rate)) {
             intraTaxId = masterData.taxGroupMap[`Intra_${rate}`] || masterData.taxGroupMap[`${rate}`] || null;
             interTaxId = masterData.taxGroupMap[`Inter_${rate}`] || masterData.taxGroupMap[`${rate}`] || null;
        }
        if (!intraTaxId) throw new Error(`Tax Rate ${rate}% not found in system.`);

        const purchaseInclTax = String(record.purchase_rate_tax_type || 'No').toLowerCase() === 'yes' ? 1 : 2;
        const saleInclTax = String(record.sale_rate_tax_type || 'No').toLowerCase() === 'yes' ? 1 : 2;
        const purchaseRateInput = format(record.purchase_rate || 0);
        const purchaseRateWithout = purchaseInclTax === 1 ? calculateWithoutTax(purchaseRateInput, rate) : purchaseRateInput;
        const saleRateInput = format(record.sale_rate || 0);
        const saleRateWithout = saleInclTax === 1 ? calculateWithoutTax(saleRateInput, rate) : saleRateInput;

        // Series & Barcode (Generated In-Memory)
        let seriesCode = record.series_code;
        if (isAuto) {seriesCode = generateNextSeriesCode();}

        let barcode = record.barcode;
        if (!barcode || String(barcode).toLowerCase() === 'auto') barcode = `BC-${Date.now()}-${Math.floor(Math.random() * 100000) + i}`;

        const maintainStock = String(record.maintain_stock || 'Yes').toLowerCase() === "yes" ? 1 : 2;
        const openingStock = record.opening_stock ? format(record.opening_stock) : 0;

        // --- BRANCH: Standard Item (Bulk) vs Variant (Linear) ---
        
        if (!isVariant) {
            // SCENARIO 1, 2, 4, 5: Standard Item -> Prepare for Bulk Insert
            const itemPayload = {
                ...masterCommonData,
                item_name: workingItemName,
                series_code: seriesCode,
                barcode: barcode,
                item_category_id: categoryId,
                hsn_code: hsnRaw,
                primary_unit: unitId,
                alternate_unit: alternateUnitId,
                purchase_quantity: format(record.purchase_quantity || 1),
                alternate_unit_quantity: format(record.alternate_unit_quantity || 1),
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
                batch_wise: batchWise,
                serial_number_wise: serialNoWise,
                opening_stock: openingStock,
                current_stock: maintainStock === 1 ? openingStock : 0, 
                status: 0
            };

           // ✅ CRITICAL FIX: Check if this item is a Parent to variants in this file
            const isParentReference = fileDerivedParentNames.has(workingItemNameLower);

            if (isParentReference) {
                // 🛑 FORCE IMMEDIATE INSERT (Do not use Bulk Queue)
                // This ensures the parent exists with the CORRECT series code before the variant row processes.
                const newItem = await commonQuery.createRecord(ItemMaster, itemPayload, transaction);
                
                // Update the Map immediately so the next row (Variant) finds it
                masterData.parentItemMap.set(workingItemNameLower, { id: newItem.id, series_code: seriesCode });
                masterData.variantCountMap.set(newItem.id, 0);

                // Handle Stock for Parent Immediately
                if (maintainStock === 1 && openingStock > 0) {
                     const batchNo = batchWise === 1 ? (record.batch_no || generateBatchNo(seriesCode)) : null;
                     const stockTrn = await addStock({
                        transaction,
                        item_id: newItem.id,
                        item_unit: unitId,
                        item_amount: purchaseRateInput,
                        item_convert_amount: purchaseRateInput,
                        ref_id: newItem.id,
                        ref_module_id: MODULES.ITEM_MASTER.ID,
                        item_qty: openingStock,
                        stock_flag: 1, 
                        godown_id: godownId,
                        batch_no: batchNo,
                        commonData
                    });
                    // Handle Serials for Parent Immediately
                    if (serialNoWise === 1) {
                        const serialList = [];
                        const intQty = Math.floor(openingStock);
                        const baseStr = `${seriesCode}-${Date.now()}`;
                        for(let k=0; k < intQty; k++) {
                             serialList.push({
                                  item_id: newItem.id,
                                  serial_no: `${baseStr}-${k+1}`,
                                  status: 0,
                                  in_module_id: MODULES.ITEM_MASTER.ID,
                                  in_ref_id: newItem.id,
                                  stock_trn_id: stockTrn.id,
                                  godown_id: godownId,
                                  ...commonData
                              });
                        }
                        if(serialList.length) await SerialNumber.bulkCreate(serialList, { transaction });
                    }
                }
                createdCount++;
            } else {
                // 🟢 STANDALONE ITEM -> SAFE TO BULK INSERT
                itemsToBulkInsert.push(itemPayload);
                
                stockMetaList.push({
                    hasStock: (maintainStock === 1 && openingStock > 0),
                    openingStock, unitId, godownId, purchaseRateInput, batchWise, serialNoWise,
                    batchNo: record.batch_no, seriesCode
                });
                createdCount++;
            }

        } else {
            // SCENARIO 3, 6: Variant -> Process Linearly (Safe Path)
            let parentData = masterData.parentItemMap.get(workingItemNameLower);

            // If parent not found (might be created in bulk batch above, or missing), we must handle it.
            // NOTE: If parent was in bulk list, we don't have ID yet. This is a limitation of mixing bulk/linear.
            // Fallback: If parent missing, create Shell Parent immediately.
            if (!parentData) {
                const parentSeries = generateNextSeriesCode();
                const shellParent = await commonQuery.createRecord(
                    ItemMaster,
                    {
                      ...masterCommonData,
                      item_name: workingItemName,
                      series_code: parentSeries,
                      item_category_id: categoryId,
                      hsn_code: hsnRaw, 
                      primary_unit: unitId,
                      is_variants: 1,
                      status: 0,
                      maintain_stock: 2
                    },
                    transaction
                );
                parentData = { id: shellParent.id, series_code: parentSeries };
                masterData.parentItemMap.set(workingItemNameLower, parentData);
                if (!masterData.variantCountMap.has(parentData.id)) masterData.variantCountMap.set(parentData.id, 0);
            }

            // Variant Series Logic
            let variantSeries = seriesCode;
            if (isAuto) {
                const currentCount = masterData.variantCountMap.get(parentData.id) || 0;
                const nextCount = currentCount + 1;
                masterData.variantCountMap.set(parentData.id, nextCount);
                variantSeries = `${parentData.series_code}-V${nextCount}`;
            }

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
                purchase_quantity: format(record.purchase_quantity || 1),
                alternate_unit_quantity: format(record.alternate_unit_quantity || 1),
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
                batch_wise: batchWise,
                serial_number_wise: serialNoWise,
                opening_stock: openingStock,
                current_stock: 0, // Will be updated by addStock
                status: 0
              }, 
              transaction
            );

            // Variant Stock (Linear)
            if (maintainStock === 1 && openingStock > 0) {
                 const batchNo = batchWise === 1 ? (record.batch_no || generateBatchNo(variantSeries)) : null;
                 const stockTrn = await addStock({
                    transaction,
                    item_id: newVariant.id,
                    item_unit: unitId,
                    item_amount: purchaseRateInput,
                    item_convert_amount: purchaseRateInput,
                    ref_id: newVariant.id,
                    ref_module_id: MODULES.ITEM_MASTER.ID,
                    item_qty: openingStock,
                    stock_flag: 1, 
                    godown_id: godownId,
                    batch_no: batchNo,
                    commonData
                });

                if (serialNoWise === 1) {
                    const serialList = [];
                    const intQty = Math.floor(openingStock);
                    const baseStr = `${variantSeries}-${Date.now()}`;
                    for(let k=0; k < intQty; k++) {
                         serialList.push({
                              item_id: newVariant.id,
                              serial_no: `${baseStr}-${k+1}`,
                              status: 0,
                              in_module_id: MODULES.ITEM_MASTER.ID,
                              in_ref_id: newVariant.id,
                              stock_trn_id: stockTrn.id,
                              godown_id: godownId,
                              ...commonData
                          });
                    }
                    if(serialList.length) await SerialNumber.bulkCreate(serialList, { transaction });
                }
            }
            createdCount++;
        }

      } catch (rowError) {
        errorCount++;
        if (errorCount <= MAX_SAMPLE) errorSample.push(`Row ${rowIndex}: ${rowError.message}`);
        writeError(errorFileStream, originalRecord, rowError.message);
      }
    }

    // 8. Execute Bulk Operations (For Standard Items)
    if (itemsToBulkInsert.length > 0) {
        // Bulk Create Items
        const createdItems = await ItemMaster.bulkCreate(itemsToBulkInsert, { transaction, returning: true });
        
        // Prepare Stock Payload
        const stockTransactionsToBulk = [];
        const serialsToLink = [];

        // Match Items with Meta
        for (let k = 0; k < createdItems.length; k++) {
            const item = createdItems[k];
            const meta = stockMetaList[k]; // Index matches bulk array

            if (meta.hasStock) {
                const batchNo = meta.batchWise === 1 ? (meta.batchNo || `BATCH-${meta.seriesCode}-${Date.now()}`) : null;
                
                stockTransactionsToBulk.push({
                    item_id: item.id,
                    item_unit: meta.unitId,
                    item_qty: meta.openingStock,
                    item_amount: meta.purchaseRateInput,
                    item_convert_amount: meta.purchaseRateInput,
                    stock_flag: 1, 
                    godown_id: meta.godownId,
                    ref_id: item.id,
                    ref_module_id: MODULES.ITEM_MASTER.ID,
                    batch_no: batchNo,
                    party_id: 0,
                    user_id: user_id,
                    company_id: company_id,
                    branch_id: branch_id || 1,
                    transaction_date: new Date(),
                    // Internal Tracking
                    _meta: meta 
                });
            }
        }

        // Bulk Create Stock
        if (stockTransactionsToBulk.length > 0) {
            const createdStocks = await StockTransaction.bulkCreate(stockTransactionsToBulk, { transaction, returning: true });

            // Prepare Serials (Now that we have Stock IDs)
            for (let s = 0; s < createdStocks.length; s++) {
                const stockTrn = createdStocks[s];
                const meta = stockTransactionsToBulk[s]._meta;

                if (meta.serialNoWise === 1) {
                    const intQty = Math.floor(meta.openingStock);
                    const baseStr = `${meta.seriesCode}-${Date.now()}`;
                    for(let z=0; z < intQty; z++) {
                        serialsToBulkInsert.push({
                            item_id: stockTrn.item_id,
                            serial_no: `${baseStr}-${z+1}`,
                            status: 0,
                            in_module_id: MODULES.ITEM_MASTER.ID,
                            in_ref_id: stockTrn.item_id,
                            stock_trn_id: stockTrn.id,
                            godown_id: meta.godownId,
                            user_id, company_id, branch_id
                        });
                    }
                }
            }

            // Bulk Create Serials
            if (serialsToBulkInsert.length > 0) {
                await SerialNumber.bulkCreate(serialsToBulkInsert, { transaction });
            }
        }
    }

    // 9. Finalize
    if (errorFileStream) errorFileStream.end();

    const tooManyErrors = errorCount > (rows.length * 0.5) && rows.length > 10;
    if (tooManyErrors) {
        await transaction.rollback();
        parentPort.postMessage({
            status: "SUCCESS",
            result: { importErrors: true, errors: errorSample, errorCount, message: "Too many errors. Import rolled back." }
        });
    } else {
        // Update Series Master ONCE
        if (seriesUpdated && seriesType) {
            await commonQuery.updateRecordById(
                SeriesTypeMaster,
                { id: seriesType.id }, 
                { start_series: nextSeriesValue }, 
                transaction
            );
        }

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