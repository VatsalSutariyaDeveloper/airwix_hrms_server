const { parentPort, workerData } = require("worker_threads");
const { sequelize, commonQuery } = require("../../../helpers");
const { Employee, User } = require("../../../models");
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

  const { filePath, errorLogPath, company_id } = workerData;

  try {
    errorFileStream = fs.createWriteStream(errorLogPath);

    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const allRows = xlsx.utils.sheet_to_json(worksheet, { header: 1 });
    let headerRowIndex = 0;
    const HEADER_KEYWORDS = ["employee code", "supervisor code", "manager code"];

    for (let i = 0; i < Math.min(allRows.length, 20); i++) {
        const rowData = (allRows[i] || []).map(c => String(c || "").trim().toLowerCase());
        const matchCount = HEADER_KEYWORDS.filter(k => rowData.includes(k) || rowData.some(cell => cell.includes(k))).length;
        if (matchCount >= 1) {
            headerRowIndex = i;
            break;
        }
    }

    const rawHeaders = allRows[headerRowIndex] || [];
    const headers = rawHeaders.map(h => String(h || "").trim());
    const originalRows = xlsx.utils.sheet_to_json(worksheet, { range: headerRowIndex });
    
    const cleanStr = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');

    // Map columns
    const empCodeHeader = headers.find(h => cleanStr(h) === 'employeecode' || cleanStr(h) === 'code');
    const supCodeHeader = headers.find(h => cleanStr(h) === 'attendancesupervisorcode' || cleanStr(h).includes('supervisorcode'));
    const mgrCodeHeader = headers.find(h => cleanStr(h) === 'reportingmanagercode' || cleanStr(h).includes('managercode'));

    if (!empCodeHeader) {
        fail("Invalid template columns. Could not find 'Employee Code' header column.");
    }

    if (isCancelled) fail("IMPORT_CANCELLED");

    transaction = await sequelize.transaction();

    // 1. Gather all unique codes (Employees, Supervisors, Managers) to query DB once
    const allCodesSet = new Set();
    originalRows.forEach(row => {
        const empCode = row[empCodeHeader] ? String(row[empCodeHeader]).trim() : null;
        const supCode = supCodeHeader && row[supCodeHeader] ? String(row[supCodeHeader]).trim() : null;
        const mgrCode = mgrCodeHeader && row[mgrCodeHeader] ? String(row[mgrCodeHeader]).trim() : null;
        if (empCode) allCodesSet.add(empCode);
        if (supCode) allCodesSet.add(supCode);
        if (mgrCode) allCodesSet.add(mgrCode);
    });

    const uniqueCodes = Array.from(allCodesSet);

    // 2. Fetch all matching employees with their linked user profiles
    const employees = await commonQuery.findAllRecords(Employee, {
        employee_code: { [Op.in]: uniqueCodes },
        company_id,
        status: { [Op.ne]: 2 } // Not deleted
    }, {
        attributes: ['id', 'employee_code', 'first_name', 'user_id', 'is_attendance_supervisor', 'is_reporting_manager'],
        include: [
            {
                model: User,
                as: "linked_user",
                attributes: ['id']
            }
        ],
        raw: false
    }, transaction);

    const employeeMap = new Map();
    employees.forEach(emp => {
        const plainEmp = emp.get({ plain: true });
        employeeMap.set(String(plainEmp.employee_code).trim().toLowerCase(), plainEmp);
    });

    let createdCount = 0;
    let updatedCount = 0;
    let errorCount = 0;
    const errorSample = [];
    const MAX_SAMPLE = 15;

    // Operations to batch execute
    const updatesToRun = [];

    // Processing loop
    for (let i = 0; i < originalRows.length; i++) {
        if (i % 500 === 0 && i > 0) await new Promise(resolve => setImmediate(resolve));
        if (isCancelled) fail("IMPORT_CANCELLED");

        const record = originalRows[i];
        const rowIndex = i + headerRowIndex + 2;

        try {
            const empCode = record[empCodeHeader] ? String(record[empCodeHeader]).trim() : null;
            if (!empCode) continue;

            const employee = employeeMap.get(empCode.toLowerCase());
            if (!employee) {
                fail(`Employee with code '${empCode}' not found in system.`);
            }

            let supervisorUserId = null;
            const supCode = supCodeHeader && record[supCodeHeader] ? String(record[supCodeHeader]).trim() : null;
            
            let managerUserId = null;
            const mgrCode = mgrCodeHeader && record[mgrCodeHeader] ? String(record[mgrCodeHeader]).trim() : null;

            if (supCode && mgrCode && supCode !== '-' && mgrCode !== '-' && supCode !== '' && mgrCode !== '' && supCode.toLowerCase() === mgrCode.toLowerCase()) {
                fail("Same person cannot be assigned as both Attendance Supervisor and Reporting Manager on this employee.");
            }

            if (supCode && supCode !== '-' && supCode !== '') {
                const supervisor = employeeMap.get(supCode.toLowerCase());
                if (!supervisor) {
                    fail(`Supervisor with code '${supCode}' not found in system.`);
                }
                if (!supervisor.is_attendance_supervisor) {
                    fail(`Supervisor employee '${supervisor.first_name}' (Code: ${supCode}) is not registered as an Attendance Supervisor in the system. First enable this role in their profile.`);
                }
                if (!supervisor.linked_user || !supervisor.linked_user.id) {
                    fail(`Supervisor employee '${supervisor.first_name}' (Code: ${supCode}) does not have a linked system user account.`);
                }
                supervisorUserId = supervisor.linked_user.id;
            }

            if (mgrCode && mgrCode !== '-' && mgrCode !== '') {
                const manager = employeeMap.get(mgrCode.toLowerCase());
                if (!manager) {
                    fail(`Reporting Manager with code '${mgrCode}' not found in system.`);
                }
                if (!manager.is_reporting_manager) {
                    fail(`Reporting Manager employee '${manager.first_name}' (Code: ${mgrCode}) is not registered as a Reporting Manager in the system. First enable this role in their profile.`);
                }
                if (!manager.linked_user || !manager.linked_user.id) {
                    fail(`Reporting Manager employee '${manager.first_name}' (Code: ${mgrCode}) does not have a linked system user account.`);
                }
                managerUserId = manager.linked_user.id;
            }

            updatesToRun.push({
                employeeId: employee.id,
                attendance_supervisor: supervisorUserId,
                reporting_manager: managerUserId
            });
            updatedCount++;

        } catch (rowError) {
            errorCount++;
            if (errorCount <= MAX_SAMPLE) {
                errorSample.push(`Row ${rowIndex}: ${rowError.message}`);
            }
            writeError(errorFileStream, record, rowError.message);
        }
    }

    if (errorCount > 0) {
        await transaction.rollback();
        parentPort.postMessage({
            status: "SUCCESS",
            result: {
                importErrors: true,
                message: `${errorCount} validation errors found. No records were updated.`,
                errors: errorSample,
                errorCount
            }
        });
        return;
    }

    // Phase 2: Execute updates in Sequelize transaction
    for (const item of updatesToRun) {
        await commonQuery.updateRecordById(Employee, { id: item.employeeId }, {
            attendance_supervisor: item.attendance_supervisor,
            reporting_manager: item.reporting_manager
        }, transaction);
    }

    await transaction.commit();

    parentPort.postMessage({
        status: "SUCCESS",
        result: {
            success: true,
            message: `Hierarchy assignments updated successfully. ${updatedCount} employees mapped.`,
            count: updatedCount,
            errorCount: 0,
            errors: []
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
        await runWorker();
    });
};

startWorker().catch(error => {
  parentPort.postMessage({ status: "ERROR", error: error.message });
});
