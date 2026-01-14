const commonQuery = require("../commonQuery");
const xlsx = require("xlsx");
const ExcelJS = require('exceljs');
const { Op } = require("sequelize");

// Increased batch size to reduce network round-trips for large files.
const BATCH_SIZE = 5000;

/**
 * Transforms rows based on an Excel header array and an index-based field mapping.
 * @param {Array<Object>} rows - Raw rows from xlsx.utils.sheet_to_json.
 * @param {Array<string>} headers - Array of header strings in order.
 * @param {Object} fieldMapping - e.g., { field1: "item_name", ... }.
 * @returns {Array<Object>} - Transformed rows with new keys.
 */
const transformRows = (rows, headers, fieldMapping) => {
  if (!fieldMapping || Object.keys(fieldMapping).length === 0) {
    return rows;
  }

  const headerToDbMap = {};
  headers.forEach((header, index) => {
    const fieldKey = `field${index + 1}`;
    if (fieldMapping[header.trim()]) {
      headerToDbMap[header.trim()] = fieldMapping[header.trim()];
    }
  });

  return rows.map(row => {
    const newRow = {};
    for (const excelHeader in row) {
      const dbField = headerToDbMap[excelHeader.trim()];
      if (dbField) {
        newRow[dbField] = row[excelHeader];
      }
    }
    return newRow;
  });
};


/**
 * A generic, configurable service to handle data import from an Excel file.
 */
const handleImport = async (config) => {
  console.log("DEBUG_SQL:", process.env.DEBUG_SQL);
  console.time('Total Import Process'); // Start total timer
  const {
    mainModel,
    fileBuffer,
    body,
    uniqueChecks = [],
    requiredFields = [],
    transaction,
    beforeCreate,
    fieldMapping = {},
    masterData = {}, // Accepts pre-fetched master data for lookups
    preParsedRows = null,
  } = config;

  let originalRows;
  let rows;
  let headers;

  console.time('Time for File Parsing');
  if (preParsedRows) {
    originalRows = preParsedRows.originalRows;
    rows = preParsedRows.rows;
    headers = preParsedRows.headers;
  } else {
    const workbook = xlsx.read(fileBuffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    headers = (xlsx.utils.sheet_to_json(worksheet, { header: 1 })[0] || []).map(h => String(h));
    originalRows = xlsx.utils.sheet_to_json(worksheet);
    rows = transformRows(originalRows, headers, fieldMapping);
  }

  const dbToHeaderMap = {};
  if (fieldMapping && Object.keys(fieldMapping).length > 0) {
    headers.forEach((header, index) => {
      const dbField = fieldMapping[header.trim()];
      if (dbField) {
        dbToHeaderMap[dbField] = header.trim();
      }
    });
  }
  console.timeEnd('Time for File Parsing');

  const errorRows = [];
  const commonData = {
    user_id: body.user_id,
    branch_id: body.branch_id,
    company_id: body.company_id,
  };

  console.time('Time for Uniqueness Check');
  const existingValues = {};
  for (const field of uniqueChecks) {
    if (!field) continue;

    const valuesFromExcel = [...new Set(
      rows.map(row => (row[field] || "").toString().trim().toLowerCase()).filter(Boolean)
    )];

    if (valuesFromExcel.length > 0) {
      const dbRecords = await commonQuery.findAllRecords(
        mainModel,
        { company_id: body.company_id, [field]: { [Op.in]: valuesFromExcel } },
        { attributes: [field], raw: true },
        transaction,
        false // requireTenantFields
      );
      existingValues[field] = new Set(dbRecords.map(r => (r[field] || "").toString().toLowerCase()));
    } else {
      existingValues[field] = new Set();
    }
  }
  console.timeEnd('Time for Uniqueness Check');


  const seenValues = {};
  for (const field of uniqueChecks) {
    seenValues[field] = new Set();
  }

  console.time('Time for Row Processing Loop');
  const recordsToCreate = [];
  
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const originalRowData = originalRows[i];
    const rowErrors = [];

    for (const field of requiredFields) {
      if (row[field] === undefined || row[field] === null || String(row[field]).trim() === '') {
        rowErrors.push(`Column mapped to '${dbToHeaderMap[field]}' is required but empty.`);
      }
    }
    
    for (const field of uniqueChecks) {
      const value = (row[field] || "").toString().trim().toLowerCase();
      if (value) {
          if (existingValues[field]?.has(value)) {
            rowErrors.push(`${dbToHeaderMap[field]} '${row[field]}' already exists in the database.`);
          }
          if (seenValues[field]?.has(value)) {
            rowErrors.push(`${dbToHeaderMap[field]} '${row[field]}' is duplicated in this Excel file.`);
          }
          seenValues[field]?.add(value);
      }
    }

    if (rowErrors.length > 0) {
      errorRows.push({ ...originalRowData, 'Error': rowErrors.join('; ') });
    } else {
      let newRecord = { ...row, ...commonData };
      if (typeof beforeCreate === "function") {
        const modified = beforeCreate(newRecord, masterData, transaction);
        if (modified && typeof modified === "object") {
          newRecord = modified;
        } else if (modified === null) {
          errorRows.push({ ...originalRowData, 'Error': 'Record failed validation in beforeCreate hook.' });
          continue;
        }
      }
      recordsToCreate.push(newRecord);
    }
  }
  console.timeEnd('Time for Row Processing Loop');

  console.time('Time for Database Insertion');
  let totalCreatedCount = 0;
  if (recordsToCreate.length > 0) {
    for (let i = 0; i < recordsToCreate.length; i += BATCH_SIZE) {
      const batch = recordsToCreate.slice(i, i + BATCH_SIZE);
      try {
        await commonQuery.bulkCreate(mainModel, batch, {}, transaction);
        totalCreatedCount += batch.length;
      } catch (err) {
        const batchError = { 
          'Error': `A database error occurred in this batch: ${err.message}. Please check the data for rows ${i + 1} to ${i + batch.length}.`
        };
        originalRows.slice(i, i + batch.length).forEach(r => errorRows.push({ ...r, ...batchError }));
      }
    }
  }
  console.timeEnd('Time for Database Insertion');

  console.timeEnd('Total Import Process'); // End total timer

  if (errorRows.length > 0) {
    return { createdCount: 0, errorRows };
  }

  return { createdCount: totalCreatedCount, errorRows: [] };
};

const getNestedValue = (obj, path) => {
  if (!path) return undefined;
  const flatValue = obj[path];
  if (flatValue !== undefined) return flatValue;
  return path.split('.').reduce((acc, part) => acc && acc[part], obj);
};

const handleExport = async (config) => {
  const { model, queryOptions, mappers, commonData } = config;
  const records = await commonQuery.findAllRecords(model, { ...queryOptions.where, ...commonData }, { ...queryOptions, raw: true });
  if (!records || records.length === 0) {
    throw new Error("No records found to export.");
  }

  const formattedData = records.map(record => {
    const row = {};
    for (const mapper of mappers) {
      const rawValue = getNestedValue(record, mapper.key);
      row[mapper.header] = mapper.formatter ? mapper.formatter(rawValue, record) : (rawValue ?? '');
    }
    return row;
  });

  const worksheet = xlsx.utils.json_to_sheet(formattedData);
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, "Sheet1");
  const excelBuffer = xlsx.write(workbook, { bookType: 'xlsx', type: 'buffer' });

  return { excelBuffer, jsonData: formattedData };
};

const streamExport = async (config, res) => {
  const { model, queryOptions, mappers, sheetName = 'Sheet1', commonData } = config;

  console.time('Total Export Time');
  const fileName = `${sheetName.toLowerCase()}_export_${Date.now()}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res });
  const worksheet = workbook.addWorksheet(sheetName);
  worksheet.columns = mappers.map(m => ({ header: m.header, key: m.key, width: 25 }));

  const BATCH_SIZE_EXPORT = 10000;
  let lastId = 0; // We start from the beginning
  let hasMore = true;
  let batchNum = 1;

  console.log(`Starting seek-method export with batch size ${BATCH_SIZE_EXPORT}...`);

  while (hasMore) {
    console.time(`Batch ${batchNum}`);
    
    // Build the dynamic WHERE clause for the seek method
   const currentWhere = {
      ...queryOptions.where,
      ...commonData,
      id: { [Op.gt]: lastId },
    };
    const currentOptions = {
      ...queryOptions,
      raw: true,
      limit: BATCH_SIZE_EXPORT,
      order: [['id', 'ASC']],
    };

    // ✅ REPLACED: Using commonQuery.findAllRecords
    const records = await commonQuery.findAllRecords(
      model,
      currentWhere,
      currentOptions,
    );

    if (records && records.length > 0) {
      for (const record of records) {
        const rowData = {};
        mappers.forEach(mapper => {
          const value = getNestedValue(record, mapper.key);
          rowData[mapper.key] = mapper.formatter ? mapper.formatter(value, record) : value;
        });
        worksheet.addRow(rowData).commit();
      }
      
      // Update the lastId to the ID of the last record in the current batch
      lastId = records[records.length - 1].id;

      // If we got less than a full batch, this is the end
      if (records.length < BATCH_SIZE_EXPORT) {
        hasMore = false;
      }
    } else {
      // No more records found, we are done
      hasMore = false;
    }
    console.timeEnd(`Batch ${batchNum}`);
    batchNum++;
  }

  await worksheet.commit();
  await workbook.commit();
  console.timeEnd('Total Export Time');
};

module.exports = { 
    transformRows,
    handleImport, 
    handleExport,
    streamExport
};

