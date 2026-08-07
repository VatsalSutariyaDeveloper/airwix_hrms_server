const { parentPort, workerData } = require("worker_threads");
const { sequelize, commonQuery } = require("../../../helpers");
const {
  Employee,
  LeaveTemplate,
  EmployeeLeaveBalance,
  LeaveTemplateCategory
} = require("../../../models");
const { transformRows } = require("../../../helpers/functions/excelService");
const { Op } = require("sequelize");
const xlsx = require("xlsx");
const fs = require("fs");
const { fail } = require('../../../helpers/Err');
const { requestContext } = require("../../../utils/requestContext");
const LeaveBalanceService = require("../../../services/leaveBalanceService");
const dayjs = require("dayjs");

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
  
  const refDate = dayjs(); // Today for import reference

  try {
    errorFileStream = fs.createWriteStream(errorLogPath);

    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const allRows = xlsx.utils.sheet_to_json(worksheet, { header: 1 });
    let headerRowIndex = 0;
    const HEADER_KEYWORDS = ["employee code", "first name", "name", "code"];

    for (let i = 0; i < Math.min(allRows.length, 20); i++) {
        const rowData = (allRows[i] || []).map(c => String(c || "").trim().toLowerCase());
        const matchCount = HEADER_KEYWORDS.filter(k => rowData.includes(k)).length;
        if (matchCount >= 2) {
            headerRowIndex = i;
            break;
        }
    }

    const rawHeaders = allRows[headerRowIndex] || [];
    const headers = rawHeaders.map(h => String(h || "").trim());
    const originalRows = xlsx.utils.sheet_to_json(worksheet, { range: headerRowIndex });
    
    // Auto-map headers
    const cleanStr = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    let empCodeHeader = headers.find(h => cleanStr(h).includes('code'));
    
    if (isCancelled) fail("IMPORT_CANCELLED");

    const mockStore = {
        userId: workerData.user_id,
        companyId: workerData.company_id,
        branchId: workerData.branch_id,
    };

    transaction = await sequelize.transaction();

    // 1. Fetch ALL LeaveTemplateCategory for the company to identify headers
    const allCategories = await commonQuery.findAllRecords(LeaveTemplateCategory, {
        company_id: workerData.company_id,
        branch_id: workerData.branch_id,
        status: 0
    }, {
        attributes: ['id', 'leave_template_id', 'leave_category_name', 'is_paid', 'is_compoff', 'unused_leave_rule', 'carry_forward_limit'],
        raw: true
    }, transaction);

    // 2. Map headers to categories - exact match preferred, otherwise prep for creation
    const leaveColumns = [];
    headers.forEach((header, index) => {
        const cleanedHeader = cleanStr(header);
        if (!cleanedHeader || cleanedHeader.includes('code') || cleanedHeader.includes('name')) return;

        // Try to find an EXACT matching category by name
        const match = allCategories.find(cat => cleanStr(cat.leave_category_name) === cleanedHeader);
        
        leaveColumns.push({
            header: header,
            index: index,
            categoryName: match ? match.leave_category_name : header,
            canonicalCleanedName: match ? cleanStr(match.leave_category_name) : cleanedHeader,
            categoryData: match || null
        });
    });

    if (leaveColumns.length === 0) {
        fail("No valid leave category columns found in headers. Please check header names.");
    }

    // 3. PRE-FETCH Employees
    const employeeCodes = [...new Set(originalRows.map(r => String(r[empCodeHeader] || '').trim()).filter(Boolean))];
    const employees = await commonQuery.findAllRecords(Employee, {
        employee_code: { [Op.in]: employeeCodes },
        company_id: mockStore.companyId,
        status: { [Op.ne]: 2 }
    }, {
        attributes: ['id', 'employee_code', 'first_name', 'leave_template', 'branch_id', 'joining_date'],
        raw: true
    }, transaction);

    const employeeMap = new Map();
    employees.forEach(emp => {
        employeeMap.set(cleanStr(emp.employee_code), emp);
    });

    const existingBalances = await commonQuery.findAllRecords(EmployeeLeaveBalance, {
        employee_id: { [Op.in]: employees.map(e => e.id) },
        status: 0
    }, {
        attributes: ['id', 'employee_id', 'leave_category_name', 'leave_category_id', 'total_allocated', 'used_leaves', 'year', 'month'],
        raw: true
    }, transaction);

    const balanceMap = new Map();
    existingBalances.forEach(b => {
        // Key: empId:canonicalCategoryName:year[:month]
        const key = `${b.employee_id}:${cleanStr(b.leave_category_name)}:${b.year}:${b.month || 'null'}`;
        balanceMap.set(key, b);
    });

    // 5. Build Template-Category lookup & Fallback Map
    const templateCategoryMap = new Map();
    const categoryFallbackMap = new Map();
    const templateMap = new Map();
    const templateIds = [...new Set(allCategories.map(c => c.leave_template_id))];
    const templates = await commonQuery.findAllRecords(LeaveTemplate, { id: { [Op.in]: templateIds } }, {}, transaction);
    templates.forEach(t => templateMap.set(t.id, t));

    allCategories.forEach(cat => {
        // Map per template
        if (!templateCategoryMap.has(cat.leave_template_id)) {
            templateCategoryMap.set(cat.leave_template_id, new Map());
        }
        templateCategoryMap.get(cat.leave_template_id).set(cleanStr(cat.leave_category_name), cat);

        // Map for company-wide fallback (first match wins)
        const cName = cleanStr(cat.leave_category_name);
        if (!categoryFallbackMap.has(cName)) {
            categoryFallbackMap.set(cName, cat);
        }
    });

    // 0. Ensure a default template exists for the company
    let defaultTemplate = await commonQuery.findOneRecord(LeaveTemplate, { company_id: mockStore.companyId, branch_id: mockStore.branchId, status: 0 }, {}, transaction);
    if (!defaultTemplate) {
        defaultTemplate = await commonQuery.createRecord(LeaveTemplate, {
            template_name: "Default Leave Template",
            company_id: mockStore.companyId,
            branch_id: mockStore.branchId,
            user_id: mockStore.userId,
            status: 0
        }, transaction);
    }

    // 6. PROCESSING LOOP
    let createdCount = 0;
    let updatedCount = 0;
    let errorCount = 0;
    const errorSample = [];
    const MAX_SAMPLE = 10;
    const balancesToCreate = [];
    const balancesToUpdate = [];

    for (let i = 0; i < originalRows.length; i++) {
        if (i % 500 === 0 && i > 0) await new Promise(resolve => setImmediate(resolve));
        if (isCancelled) fail("IMPORT_CANCELLED");

        const record = originalRows[i];
        const rowIndex = i + headerRowIndex + 2;

        try {
            const empCode = String(record[empCodeHeader] || '').trim();
            if (!empCode) continue;

            const employee = employeeMap.get(cleanStr(empCode));
            if (!employee) {
                fail(`Employee with code '${empCode}' not found in system.`);
            }

            const employeeTemplateId = employee.leave_template || null;
            const employeeCategories = employeeTemplateId ? templateCategoryMap.get(employeeTemplateId) : null;

            for (const col of leaveColumns) {
                const countVal = record[col.header];
                
                // 1. If value is '-' or empty, ignore this category for this employee
                if (countVal === undefined || countVal === null || String(countVal).trim() === '' || String(countVal).trim() === '-') {
                    continue;
                }

                // 2. Parse and normalize the count (round to nearest 0.5)
                const rawCount = parseFloat(countVal);
                if (isNaN(rawCount)) {
                    fail(`Invalid numeric value '${countVal}' for category '${col.header}' at row ${rowIndex}`);
                }
                const addedCount = Math.floor(rawCount * 2) / 2;

                // 3. Find or Create the Leave Category in the company
                let categoryData = employeeCategories ? employeeCategories.get(col.canonicalCleanedName) : null;
                
                if (!categoryData) {
                    categoryData = categoryFallbackMap.get(col.canonicalCleanedName);
                }
                
                if (!categoryData) {
                    // Create the category if it doesn't exist in the system at all
                    categoryData = await commonQuery.createRecord(LeaveTemplateCategory, {
                        leave_template_id: employeeTemplateId || defaultTemplate.id,
                        leave_category_name: col.categoryName,
                        unused_leave_rule: 'LAPSE',
                        is_paid: true,
                        is_compoff: col.canonicalCleanedName.includes('compoff'),
                        company_id: mockStore.companyId,
                        branch_id: employee.branch_id || mockStore.branchId,
                        user_id: mockStore.userId,
                        status: 0
                    }, transaction);
                    
                    // Cache for performance in next iterations
                    categoryFallbackMap.set(col.canonicalCleanedName, categoryData);
                    if (employeeTemplateId) {
                        if (!templateCategoryMap.has(employeeTemplateId)) {
                            templateCategoryMap.set(employeeTemplateId, new Map());
                        }
                        templateCategoryMap.get(employeeTemplateId).set(col.canonicalCleanedName, categoryData);
                    }
                }

                // 4. Determine target year/month based on template cycle
                const targetTemplate = employeeTemplateId ? templateMap.get(employeeTemplateId) : defaultTemplate;
                const { end } = LeaveBalanceService.getCycleDates(employee.joining_date, targetTemplate.leave_policy_cycle, refDate, {
                    leave_period_start: targetTemplate.leave_period_start,
                    leave_period_end: targetTemplate.leave_period_end
                });

                const targetYear = end.year();
                const targetMonth = (targetTemplate.leave_policy_cycle === 'MONTHLY' || targetTemplate.leave_policy_cycle === 'QUARTERLY') ? end.month() + 1 : null;

                const balKey = `${employee.id}:${col.canonicalCleanedName}:${targetYear}:${targetMonth || 'null'}`;
                const existing = balanceMap.get(balKey);

                // Excel value = available balance (pending_leaves)
                const availableBalance = addedCount;

                // 5. Update Existing or Create New Balance record
                if (existing) {
                    const used = parseFloat(existing.used_leaves || 0);
                    // Back-calculate total_allocated so that: total_allocated = available_balance + used_leaves
                    const newTotal = Math.floor((availableBalance + used) * 2) / 2;

                    balancesToUpdate.push({ 
                        employee_id: employee.id,
                        leave_template_id: targetTemplate.id,
                        leave_category_id: categoryData.id,
                        year: targetYear,
                        month: targetMonth,
                        leave_category_name: categoryData.leave_category_name,
                        total_allocated: newTotal,
                        pending_leaves: availableBalance,
                        used_leaves: used,
                        is_paid: categoryData.is_paid,
                        is_compoff: categoryData.is_compoff,
                        unused_leave_rule: categoryData.unused_leave_rule,
                        carry_forward_limit: categoryData.carry_forward_limit,
                        company_id: mockStore.companyId,
                        branch_id: employee.branch_id || mockStore.branchId,
                        user_id: mockStore.userId,
                        status: 0,
                        id: existing.id 
                    });
                    updatedCount++;
                } else {
                    // New record: no used leaves yet, so total_allocated = available balance
                    balancesToCreate.push({
                        employee_id: employee.id,
                        leave_template_id: targetTemplate.id,
                        leave_category_id: categoryData.id,
                        year: targetYear,
                        month: targetMonth,
                        leave_category_name: categoryData.leave_category_name,
                        total_allocated: availableBalance,
                        pending_leaves: availableBalance,
                        used_leaves: 0,
                        is_paid: categoryData.is_paid,
                        is_compoff: categoryData.is_compoff,
                        unused_leave_rule: categoryData.unused_leave_rule,
                        carry_forward_limit: categoryData.carry_forward_limit,
                        company_id: mockStore.companyId,
                        branch_id: employee.branch_id || mockStore.branchId,
                        user_id: mockStore.userId,
                        status: 0
                    });
                    createdCount++;
                }
            }
        } catch (rowError) {
            errorCount++;
            if (errorCount <= MAX_SAMPLE) errorSample.push(`Row ${rowIndex}: ${rowError.message}`);
            writeError(errorFileStream, record, rowError.message);
        }
    }

    // PHASE 2: Batch Execute
    if (errorCount > 0) {
        await transaction.rollback();
        parentPort.postMessage({
            status: "SUCCESS",
            result: {
                importErrors: true,
                message: `${errorCount} errors found. No data was imported. Please fix all errors.`,
                errors: errorSample,
                errorCount
            }
        });
        return;
    }

    if (balancesToCreate.length > 0) {
        await commonQuery.bulkCreate(EmployeeLeaveBalance, balancesToCreate, {}, transaction);
    }

    for (const b of balancesToUpdate) {
        await commonQuery.updateRecordById(EmployeeLeaveBalance, b.id, b, transaction);
    }

    await transaction.commit();

    const successMessage = errorCount > 0 
      ? `Leave template import completed with ${errorCount} errors` 
      : `Leave template import completed successfully`;

    parentPort.postMessage({
      status: "SUCCESS",
      result: {
        message: successMessage,
        count: createdCount,
        updated: updatedCount,
        skipped: errorCount,
        summary: {
          created: createdCount,
          updated: updatedCount,
          errors: errorCount
        },
        errors: errorSample // Include error messages
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

const startWorker = async () => {
    const mockStore = {
        userId: workerData.user_id,
        companyId: workerData.company_id,
        branchId: workerData.branch_id,
        is_super_admin: workerData.is_super_admin,
        branch_access: workerData.branch_access,
        ip: "127.0.0.1"
    };

    await requestContext.run(mockStore, async () => {
        await runWorker(mockStore);
    });
};

startWorker().catch(error => {
  parentPort.postMessage({ status: "ERROR", error: error.message });
});
