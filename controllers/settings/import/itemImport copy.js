const {
  ItemMaster,
  ItemTypeMaster,
  ItemCategory,
  ItemUnitMaster,
  HSNMaster,
  TaxGroup,
  TaxGroupTransaction,
  TaxTypeMaster,
  Taxes,
} = require("../../../models");
const {
  sequelize,
  commonQuery,
  handleError, // We might not need this if we throw
  getCompanySetting,
  // handleImport, // We are replacing this
} = require("../../../helpers");
const { transformRows } = require("../../../helpers/functions/excelService");
const { Op } = require("sequelize");
const xlsx = require("xlsx");

// --- Helper function for writing to the stream ---
const writeError = (stream, row, errorMessage) => {
  row.Error = errorMessage;
  try {
    // Write the row as a JSON string with a newline
    stream.write(JSON.stringify(row) + '\n');
  } catch (e) {
    console.error("Failed to write to error stream", e);
  }
};

// --- Helper function for row validation ---
const validateRow = (record, requiredFields, rowIndex) => {
  const errors = [];
  for (const field of requiredFields) {
    if (record[field] === null || record[field] === undefined || String(record[field]).trim() === "") {
      errors.push(`${field.replace(/_/g, ' ')} is required.`);
    }
  }
  return errors;
};


// FIX 1: Added 'errorFileStream' to the signature
exports.itemImport = async (req, transaction, errorFileStream) => {
  const ENTITY = "Item Import";
  try {
    console.time('Controller Total Time');
    if (!req.file) {
      return { validationError: true, errors: ["Excel file is required."] };
    }

    const { user_id, branch_id, company_id } = req.body;
    const commonData = { user_id, branch_id, company_id }; // For creation
    const fieldMapping = JSON.parse(req.body.field_mapping || "{}");

    // --- 🚨 WARNING: This is still a memory bottleneck! ---
    // If the file is 500MB, this line will crash.
    // For now, we are fixing the *error reporting* bottleneck.
    console.time('Controller: File Read and Pre-scan');
    const workbook = xlsx.read(req.file.buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const headers = (xlsx.utils.sheet_to_json(worksheet, { header: 1 })[0] || []).map(h => String(h));
    const originalRows = xlsx.utils.sheet_to_json(worksheet);
    const rows = transformRows(originalRows, headers, fieldMapping);
    
    const itemTypeNames = new Set();
    const categoryNames = new Set();
    const hsnCodes = new Set();
    const unitNames = new Set();
    const existingItemNames = new Set();
    const existingSeriesCodes = new Set();

    for (const record of rows) {
      if(record.item_type) itemTypeNames.add(String(record.item_type).trim());
      if(record.category) categoryNames.add(String(record.category).trim());
      if(record.hsn_code) hsnCodes.add(String(record.hsn_code).trim());
      if(record.primary_unit) unitNames.add(String(record.primary_unit).trim());
      if(record.alternate_unit) unitNames.add(String(record.alternate_unit).trim());
      // For duplicate checking
      if(record.item_name) existingItemNames.add(String(record.item_name).trim().toLowerCase());
      if(record.series_code) existingSeriesCodes.add(String(record.series_code).trim().toLowerCase());
    }
    console.timeEnd('Controller: File Read and Pre-scan');
    
    // ====================================================================
    // STEP 1: EFFICIENTLY PRE-FETCH ONLY RELEVANT MASTER DATA
    // ====================================================================
    console.time('Controller: Master Data Fetch');
    const masterData = {};
    const commonWhere = { company_id, status: 0 }; // Removed user_id/branch_id for masters as they are company-wide

    const [itemTypes, categories, hsnResults, units, taxGroups, duplicateItems, duplicateSeries] = await Promise.all([
      // ... (Your master data queries are great, no change)
      commonQuery.findAllRecords(ItemTypeMaster, { ...commonWhere, item_type_name: { [Op.in]: Array.from(itemTypeNames) }}, { attributes: ['id', 'item_type_name'], raw: true }, transaction),
      commonQuery.findAllRecords(ItemCategory, { ...commonWhere, category_name: { [Op.in]: Array.from(categoryNames) }}, { attributes: ['id', 'category_name'], raw: true }, transaction),
      commonQuery.findAllRecords(HSNMaster, { ...commonWhere, hsn_code: { [Op.in]: Array.from(hsnCodes) }}, { attributes: ['id', 'hsn_code'], raw: true }, transaction),
      commonQuery.findAllRecords(ItemUnitMaster, { ...commonWhere, unit_name: { [Op.in]: Array.from(unitNames) }}, { attributes: ['id', 'unit_name'], raw: true }, transaction),
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
      // Pre-fetch duplicates
      commonQuery.findAllRecords(ItemMaster, { company_id, item_name: { [Op.in]: Array.from(existingItemNames) } }, { attributes: ['item_name'], raw: true }, transaction),
      commonQuery.findAllRecords(ItemMaster, { company_id, series_code: { [Op.in]: Array.from(existingSeriesCodes) } }, { attributes: ['series_code'], raw: true }, transaction)
    ]);

    masterData.itemTypeMap = new Map(itemTypes.map(it => [String(it.item_type_name).trim().toLowerCase(), it.id]));
    masterData.categoryMap = new Map(categories.map(cat => [String(cat.category_name).trim().toLowerCase(), cat.id]));
    masterData.hsnMap = new Map(hsnResults.map(hsn => [String(hsn.hsn_code).trim().toLowerCase(), hsn.id]));
    masterData.unitMap = new Map(units.map(u => [String(u.unit_name).trim().toLowerCase(), u.id]));
    
    masterData.taxGroupMap = {};
    for (const group of taxGroups) {
        const rate = Number(group.group_value);
        const type = group.tax_type?.trim();
        if (rate && type) {
            masterData.taxGroupMap[`${type}_${rate}`] = group.id;
        }
    }
    // Add pre-fetched duplicates to maps for fast lookup
    masterData.duplicateItemMap = new Map(duplicateItems.map(i => [i.item_name.toLowerCase(), true]));
    masterData.duplicateSeriesMap = new Map(duplicateSeries.map(s => [s.series_code.toLowerCase(), true]));
    
    console.timeEnd('Controller: Master Data Fetch');
    
    // ====================================================================
    // STEP 2: FIND & BULK-CREATE NEW MASTERS (Unchanged)
    // ====================================================================
    console.time('Controller: New Master Creation');
    
    const newCategorySet = new Set();
    const newItemTypeSet = new Set();
    const newHsnSet = new Set();

    itemTypeNames.forEach(name => { if(name && !masterData.itemTypeMap.has(name.toLowerCase())) newItemTypeSet.add(name); });
    categoryNames.forEach(name => { if(name && !masterData.categoryMap.has(name.toLowerCase())) newCategorySet.add(name); });
    hsnCodes.forEach(code => { if(code && !masterData.hsnMap.has(code.toLowerCase())) newHsnSet.add(code); });

    const commonDataForMasters = { user_id, branch_id, company_id };

    if (newItemTypeSet.size > 0) {
      const typesToCreate = Array.from(newItemTypeSet).map(name => ({ item_type_name: name, ...commonDataForMasters }));
      const createdTypes = await commonQuery.bulkCreate(ItemTypeMaster, typesToCreate, {}, transaction);
      createdTypes.forEach(t => masterData.itemTypeMap.set(t.item_type_name.toLowerCase(), t.id));
    }
    if (newCategorySet.size > 0) {
      const categoriesToCreate = Array.from(newCategorySet).map(name => ({ category_name: name, ...commonDataForMasters }));
      const createdCategories = await commonQuery.bulkCreate(ItemCategory, categoriesToCreate, {}, transaction);
      createdCategories.forEach(c => masterData.categoryMap.set(c.category_name.toLowerCase(), c.id));
    }
    if (newHsnSet.size > 0) {
      const hsnsToCreate = Array.from(newHsnSet).map(code => ({ hsn_code: code, ...commonDataForMasters }));
      const createdHsns = await commonQuery.bulkCreate(HSNMaster, hsnsToCreate, {}, transaction);
      createdHsns.forEach(h => masterData.hsnMap.set(h.hsn_code.toLowerCase(), h.id));
    }
    
    const createdCategoriesList = Array.from(newCategorySet);
    const createdItemTypesList = Array.from(newItemTypeSet);
    console.timeEnd('Controller: New Master Creation');

    // ====================================================================
    // STEP 3: FIX: REPLACE 'handleImport' WITH STREAMING LOOP
    // ====================================================================
    console.time('Controller: Row Processing');

    const {tax_calculation_from} = await getCompanySetting(company_id);
    const dynamicFields = (tax_calculation_from === "Item") ? ["tax_rate"] : [];
    const requiredFields = ["item_name", "item_type", "hsn_code", "tax_flag", "maintain_stock", ...dynamicFields];

    // Your synchronous 'beforeCreate' logic (this is perfect)
    const beforeCreate = (record, masters) => {
      record.item_type_id = masters.itemTypeMap.get(String(record.item_type || '').trim().toLowerCase());
      record.item_category_id = masters.categoryMap.get(String(record.category || '').trim().toLowerCase());
      record.hsn_code_id = masters.hsnMap.get(String(record.hsn_code || '').trim().toLowerCase());
      record.primary_unit = masters.unitMap.get(String(record.primary_unit || '').trim().toLowerCase());
      record.alternate_unit = masters.unitMap.get(String(record.alternate_unit || '').trim().toLowerCase());
      const rate = parseFloat(String(record.tax_rate || "").replace("%", "").trim());
      if (!isNaN(rate)) {
          record.intra_tax_group_id = masters.taxGroupMap[`Intra_${rate}`] || null;
          record.inter_tax_group_id = masters.taxGroupMap[`Inter_${rate}`] || null;
      }
      const openingStock = parseFloat(record.opening_stock || 0);
      record.opening_stock = isNaN(openingStock) ? 0 : openingStock;
      record.current_stock = record.opening_stock;
      record.tax_flag = String(record.tax_flag || '').trim().toLowerCase() === "exclude" ? 1 : 2;
      record.maintain_stock = String(record.maintain_stock || '').trim().toLowerCase() === "yes" ? 1 : 2;
      record.batch_wise = String(record.batch_wise || '').trim().toLowerCase() === "yes" ? 1 : 2;
      return record;
    };
    
    let createdCount = 0;
    let errorCount = 0;
    const errorSample = [];
    const MAX_SAMPLE_SIZE = 10;
    
    // --- This is the new loop that replaces handleImport ---
    for (let i = 0; i < rows.length; i++) {
      const record = rows[i];
      const originalRecord = originalRows[i]; // For error reporting
      const rowIndex = i + 2; // Excel row number (1-based + header)
      
      try {
        // 1. Basic Validation
        const validationErrors = validateRow(record, requiredFields, rowIndex);
        
        // 2. Duplicate Check
        const itemNameLower = String(record.item_name || '').trim().toLowerCase();
        if (masterData.duplicateItemMap.has(itemNameLower)) {
          validationErrors.push("Item name already exists.");
        }
        if (record.series_code) {
          const seriesCodeLower = String(record.series_code).trim().toLowerCase();
          if (masterData.duplicateSeriesMap.has(seriesCodeLower)) {
            validationErrors.push("Series code already exists.");
          }
        }
        
        if (validationErrors.length > 0) {
          errorCount++;
          const errorMessage = validationErrors.join(' ');
          if (errorCount <= MAX_SAMPLE_SIZE) errorSample.push(`Row ${rowIndex}: ${errorMessage}`);
          writeError(errorFileStream, originalRecord, errorMessage);
          continue; // Skip to next row
        }

        // 3. Transform data (fast, synchronous)
        let transformedRecord = beforeCreate(record, masterData);
        
        // 4. Add common data
        transformedRecord = { ...transformedRecord, ...commonData };
        
        // 5. Create record
        await ItemMaster.create(transformedRecord, { transaction });
        
        // 6. Add to duplicate maps to prevent duplicates *within the same file*
        masterData.duplicateItemMap.set(itemNameLower, true);
        if (record.series_code) {
          masterData.duplicateSeriesMap.set(String(record.series_code).trim().toLowerCase(), true);
        }
        
        createdCount++;

      } catch (dbErr) {
        // Handle database or other unexpected errors
        errorCount++;
        const errorMessage = dbErr.message || "An unexpected error occurred.";
        if (errorCount <= MAX_SAMPLE_SIZE) errorSample.push(`Row ${rowIndex}: ${errorMessage}`);
        writeError(errorFileStream, originalRecord, errorMessage);
      }
    }
    // --- End of new loop ---
    
    console.timeEnd('Controller: Row Processing');

    if (errorCount > 0) {
      // FIX 3: Return import error data object
      if (errorCount > MAX_SAMPLE_SIZE) {
        errorSample.push(`...and ${errorCount - MAX_SAMPLE_SIZE} more errors.`);
      }
      return { 
        importErrors: true, 
        errors: errorSample, // The small sample
        errorCount: errorCount,
      };
    }

    const summary = {};
    if (createdCategoriesList.length > 0) {
      summary.newCategories = createdCategoriesList;
    }
    if (createdItemTypesList.length > 0) {
      summary.newItemTypes = createdItemTypesList;
    }
    
    console.timeEnd('Controller Total Time');
    
    // FIX 4: Return success data object
    return {
      success: true,
      message: `${createdCount} items imported successfully.`,
      count: createdCount,
      ...(Object.keys(summary).length > 0 && { summary }),
    };

  } catch (err) {
    console.log(err);
    // FIX 5: Throw the error to be caught by the main controller
    throw err;
  }
};