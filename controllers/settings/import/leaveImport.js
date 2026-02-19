const { parentPort, workerData } = require("worker_threads");
const { sequelize, commonQuery } = require("../../../helpers");
const {
  Employee,
  EmployeeLeaveBalance,
  LeaveTemplateCategory
} = require("../../../models");
const { transformRows } = require("../../../helpers/functions/excelService");
const { Op } = require("sequelize");
const xlsx = require("xlsx");
const fs = require("fs");
const { fail } = require('../../../helpers/Err');
const { requestContext } = require("../../../utils/requestContext");

let isCancelled = false;
let transaction = null;
let errorFileStream = null;

if (parentPort) {
  parentPort.on("message", async (msg) => {
    if (msg.command === "ABORT") {
      isCancelled = true;
      if (transaction && !transaction.finished) {
        try { await transaction.rollback(); } catch (e) { }
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

  const { filePath, errorLogPath, body } = workerData;
  

  let fieldMapping = {};
  try { fieldMapping = JSON.parse(body.field_mapping || "{}"); } catch (e) { }

  const currentYear = new Date().getFullYear();

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
    const employeeCodes = new Set();
    const leaveCategories = new Set();

    rows.forEach(r => {
      if (r['Employee Code'] || r.employee_code) {
        const empCode = String(r['Employee Code'] || r.employee_code).trim();
        if (empCode) employeeCodes.add(empCode);
      }

      // Extract leave categories from numbered columns
      Object.keys(r).forEach(key => {
        if (key.toLowerCase().startsWith('leave category') || key.toLowerCase().startsWith('leave_category')) {
          const category = String(r[key] || '').trim();
          if (category) leaveCategories.add(category);
        }
      });
    });

    const mockStore = {
      userId: workerData.user_id,
      companyId: workerData.company_id,
      branchId: workerData.branch_id,
    };
    
    // Run the query within the context
    const employees = await requestContext.run(mockStore, async () => {
      return await commonQuery.findAllRecords(Employee, {
        employee_code: { [Op.in]: Array.from(employeeCodes) }
      }, {
        attributes: ['id', 'employee_code', 'first_name', 'leave_template'],
        raw: true
      }, transaction);
    });

    // Fetch leave template categories for all employees
    const leaveTemplateIds = [...new Set(employees.map(emp => emp.leave_template).filter(id => id > 0))];
    const categoryMap = new Map();
    
    if (leaveTemplateIds.length > 0) {
      const categories = await requestContext.run(mockStore, async () => {
        return await commonQuery.findAllRecords(LeaveTemplateCategory, {
          leave_template_id: { [Op.in]: leaveTemplateIds },
          status: 0
        }, {
          attributes: ['id', 'leave_template_id', 'name'],
          raw: true
        }, transaction);
      });
      
      // Build category map: template_id + category_name -> category_id
      categories.forEach(cat => {
        const key = `${cat.leave_template_id}:${cat.name.toLowerCase()}`;
        categoryMap.set(key, cat.id);
      });
    }

    // --- 4. BUILD MAPS ---
    const masterData = {
      employeeMap: new Map(),
      employeeCodeMap: new Map(),
      categoryMap: categoryMap
    };

    // Build employee maps
    employees.forEach(emp => {
      masterData.employeeMap.set(emp.id, emp);
      if (emp.employee_code) {
        masterData.employeeCodeMap.set(String(emp.employee_code).trim().toLowerCase(), emp.id);
      }
    });

    // --- 5. PROCESSING LOOP ---
    let createdCount = 0;
    let updatedCount = 0;
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
        // --- VALIDATION ---
        const employeeCode = String(record['Employee Code'] || record.employee_code || '').trim();

        if (!employeeCode) {
          fail("Employee Code is required");
        }

        const employeeId = masterData.employeeCodeMap.get(employeeCode.toLowerCase());

        if (!employeeId) {
          fail(`Employee not found: ${employeeCode}`);
        }
        // Extract leave categories and counts from numbered columns
        const leaveData = [];
        let categoryIndex = 1;

        while (true) {
          const categoryKey = `Leave Category${categoryIndex}`;
          const countKey = `Leave Count${categoryIndex}`;
          const altCategoryKey = `leave category${categoryIndex}`;
          const altCountKey = `leave count${categoryIndex}`;

          const category = String(record[categoryKey] || record[altCategoryKey] || '').trim();
          const count = record[countKey] || record[altCountKey];

          if (!category) break; // Stop when no more categories found

          if (!category) {
            fail(`Leave Category ${categoryIndex} cannot be empty`);
          }

          if (count === null || count === undefined || count === '') {
            fail(`Leave Count ${categoryIndex} cannot be empty for category '${category}'`);
          }

          const leaveCount = parseFloat(count);
          if (isNaN(leaveCount) || leaveCount < 0) {
            fail(`Invalid Leave Count ${categoryIndex}: '${count}' for category '${category}'`);
          }

          leaveData.push({ category: category, count: leaveCount });
          categoryIndex++;
        }

        if (leaveData.length === 0) {
          fail("At least one leave category and count is required");
        }
        // Process each leave category for this employee
        for (const { category, count } of leaveData) {

          let existingBalance = null;
          try {
            existingBalance = await requestContext.run(mockStore, async () => {
              return await commonQuery.findOneRecord(EmployeeLeaveBalance, {
                employee_id: employeeId,
                leave_category_name: category,
                year: currentYear,
                company_id: mockStore.companyId,
                branch_id: mockStore.branchId,
                user_id: mockStore.userId,
                status: { [Op.ne]: 2 }
              }, {
                attributes: ['id', 'total_allocated']
              }, transaction);
            });
          } catch (dbError) {
            console.error(`Database error for employee ${employeeId}, category ${category}:`, dbError);
            throw dbError;
          }

          if (existingBalance) {
            // Update existing record
            let update = null;
            try {
              update = await requestContext.run(mockStore, async () => {
                return await commonQuery.updateRecordById(EmployeeLeaveBalance, existingBalance.id, {
                  total_allocated: count,
                  company_id: mockStore.companyId,
                  branch_id: mockStore.branchId,
                  user_id: mockStore.userId
                }, transaction);
              });
            } catch (updateError) {
              console.error(`Update error for employee ${employeeId}, category ${category}:`, updateError);
              throw updateError;
            }
            updatedCount++;
          } else {
            // Create new record
            let create = null;
            try {
              create = await requestContext.run(mockStore, async () => {
                return await commonQuery.bulkCreate(EmployeeLeaveBalance, [{
                  employee_id: employeeId,
                  year: currentYear,
                  leave_category_name: category,
                  total_allocated: count,
                  company_id: mockStore.companyId,
                  branch_id: mockStore.branchId,
                  user_id: mockStore.userId
                }], {}, transaction);
              });
            } catch (createError) {
              console.error(`Create error for employee ${employeeId}, category ${category}:`, createError);
              throw createError;
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


    await transaction.commit();

    parentPort.postMessage({
      status: "SUCCESS",
      result: {
        message: `Leave template import completed successfully`,
        count: createdCount,
        updated: updatedCount,
        skipped: errorCount,
        summary: {
          created: createdCount,
          updated: updatedCount,
          errors: errorCount
        }
      }
    });

  } catch (error) {
    if (transaction && !transaction.finished) {
      try { await transaction.rollback(); } catch (e) { }
    }
    parentPort.postMessage({ status: "ERROR", error: error.message });
  } finally {
    if (errorFileStream) errorFileStream.end();
  }
};

runWorker().catch(error => {
  parentPort.postMessage({ status: "ERROR", error: error.message });
});







