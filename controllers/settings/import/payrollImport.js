const { parentPort, workerData } = require("worker_threads");
const { sequelize, commonQuery, constants } = require("../../../helpers");
const { Employee, Payslip, BranchMaster } = require("../../../models");
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
      if (errorFileStream) errorFileStream.end();
      parentPort.postMessage({ status: "CANCELLED" });
      setTimeout(() => process.exit(0), 1000);
    }
  });
}

const writeError = (stream, row, errorMessage) => {
  const errorRow = { ...row, Error: errorMessage };
  if (stream && stream.writable) stream.write(JSON.stringify(errorRow) + '\n');
};

const normalize = (val) => String(val || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const runWorker = async () => {
  try { await sequelize.authenticate(); } catch (error) {
    parentPort.postMessage({ status: "ERROR", error: "Database connection failed." });
    process.exit(1);
  }

  const { filePath, errorLogPath, body } = workerData;
  const mockStore = {
    userId: workerData.user_id,
    companyId: workerData.company_id,
    branch_id: workerData.branch_id,
    user_id: workerData.user_id,
    company_id: workerData.company_id,
    ip: "127.0.0.1"
  };

  try {
    errorFileStream = fs.createWriteStream(errorLogPath);
    const workbook = xlsx.readFile(filePath);
    
    let worksheet = null;
    let sheetName = "";
    let rawRows = [];
    let headerRowIndex = -1;

    // Mapping of fields to expected column names/aliases
    const COLUMN_MAPPING = {
        staff_id: ["staffid", "employeeid", "employeecode", "code", "id", "empcode", "employee code"],
        employee_name: ["name", "employeename", "employee name", "emp name", "full name", "employee", "staff name"],
        month: ["month", "mth"],
        year: ["year", "yr"],
        // Attendance
        pd_days: ["pd", "paid days", "paiddays", "pay day", "payday", "payable days"],
        al_days: ["al", "annual leave", "annualleave", "pl", "paid leave", "paidleave"],
        cl_days: ["cl", "casual leave", "casualleave"],
        od_days: ["od", "on duty", "onduty"],
        sl_days: ["sl", "short leave", "shortleave", "cof", "compoff", "compoff leave", "compoffleave"],
        ph_days: ["ph", "public holiday", "publicholiday", "holidays"],
        wo_days: ["wo", "weekly off", "weeklyoff"],
        wp_days: ["wp"],
        absent_days: ["absent", "a", "absent days", "absentdays"],
        present_days: ["work day", "workday", "present", "present days", "presentdays"],
        total_days: ["total days", "totaldays", "month day", "monthday", "month days", "days"],
        // Fixed
        fixed_basic_da: ["fixed basic da", "fixedbasicda", "basic+da", "basic da", "basic&da", "basic", "fixed basic"],
        fixed_hra: ["fixed hra", "fixedhra", "hra", "fixed hra"],
        fixed_conv: ["fixed conv", "fixedconv", "conv", "conveyance", "transport", "fixed conv"],
        fixed_misc: ["fixed misc", "fixedmisc", "misc", "allowance", "medical", "food", "special", "lta", "arrears"],
        fixed_ot_rate: ["fixed ot rate", "fixedotrate", "ot rate"],
        fixed_gross: ["fixed gross", "fixedgross", "total monthly gross", "monthly gross", "gross", "fixed gross", "ctc"],
        // Paid
        paid_basic_da: ["paid basic da", "paidbasicda", "earned basic", "basic", "earned basic da"],
        paid_hra: ["paid hra", "paidhra", "earned hra", "hra"],
        paid_conv: ["paid conv", "paidconv", "conveyance", "transport"],
        paid_misc: ["paid misc", "paidmisc", "medical", "food", "special", "lta", "arrears", "other allowance"],
        paid_ot_pay: ["paid ot pay", "paidotpay", "ot pay", "ot amount", "overtime"],
        paid_incentive: ["paid incentive", "paidincentive", "incentive/bonus", "incentive", "bonus", "insentive"],
        paid_gross: ["paid gross", "paidgross", "gross earning", "grossearning", "total earning", "earned gross", "gross", "total earned"],
        // Deductions
        deduct_pf: ["pf", "provident fund", "epf"],
        deduct_pt: ["pt", "professional tax"],
        deduct_advance: ["advance", "loan"],
        deduct_esic: ["esic", "esi"],
        deduct_lwf: ["lwf", "labour welfare fund"],
        deduct_misc: ["misc deduct", "miscdeduct", "other deduction", "others", "fine", "food"],
        total_deduction: ["total deduction", "totaldeduction", "total deductions", "total deductions"],
        // Net
        net_salary: ["net salary", "netsalary", "payable", "total payable", "net payable", "take home", "net pay", "netpay"],
        // Other
        lunch_count: ["lunch", "lunch count", "lunchcount"]
    };

    const headerMap = {};

    for (const name of workbook.SheetNames) {
        const ws = workbook.Sheets[name];
        const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });
        
        for (let i = 1; i < Math.min(rows.length, 15); i++) { // Increase check range
            const row = rows[i];
            if (Array.isArray(row)) {
                const normalizedRow = row.map(cell => normalize(cell));
                const sIdIdx = normalizedRow.findIndex(v => {
                    if (!v) return false;
                    const isStaffIdMatch = COLUMN_MAPPING.staff_id.some(alias => v === alias || v.includes(alias));
                    const isCombinedMatch = (v.includes("staff") && v.includes("id")) || (v.includes("employee") && (v.includes("id") || v.includes("code")));
                    return isStaffIdMatch || isCombinedMatch || v === "id";
                });

                if (sIdIdx !== -1) {
                    worksheet = ws;
                    sheetName = name;
                    rawRows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
                    headerRowIndex = i;
                    
                    // Identify Boundaries to distinguish groups
                    const grossAliases = COLUMN_MAPPING.paid_gross.map(a => normalize(a));
                    const totalDeductAliases = COLUMN_MAPPING.total_deduction.map(a => normalize(a));
                    const netAliases = COLUMN_MAPPING.net_salary.map(a => normalize(a));
                    const basicAliases = ["basic", "basicda", "basic+da", "fixedbasic"].map(a => normalize(a));

                    const grossIdx = normalizedRow.findIndex(v => grossAliases.includes(v));
                    const totalDeductIdx = normalizedRow.findIndex(v => totalDeductAliases.includes(v));
                    const netIdx = normalizedRow.findIndex(v => netAliases.includes(v));
                    const firstEarningIdx = normalizedRow.findIndex(v => basicAliases.includes(v));

                    // Mapping for statutory (Employee Side)
                    const STAT_MAPPING = {
                        pf: ["pf", "epf", "providentfund"],
                        esi: ["esi", "esic"],
                        pt: ["pt", "professionaltax"],
                        lwf: ["lwf", "labourwelfarefund"]
                    };

                    // Mapping for Employer Components
                    const EMPLOYER_MAPPING = {
                        er_pf: ["employer pf", "er pf", "erpf", "employer epf"],
                        er_esi: ["employer esi", "er esi", "eresi", "employer esic"],
                        er_lwf: ["employer lwf", "er lwf", "erlwf"],
                        edli: ["edli"]
                    };

                    // Build field to index map for major totals
                    Object.keys(COLUMN_MAPPING).forEach(field => {
                        let indices = [];
                        const aliases = COLUMN_MAPPING[field].map(a => normalize(a));
                        normalizedRow.forEach((v, idx) => {
                            if (aliases.includes(v)) indices.push(idx);
                        });
                        
                        if (indices.length > 0) {
                            headerMap[field] = indices[0]; // Take first for major tags
                        }
                    });

                    // Identify Dynamic Earnings (Everything between firstEarning and Gross)
                    headerMap.dynamic_earnings = [];
                    if (firstEarningIdx !== -1 && grossIdx !== -1) {
                        for (let idx = firstEarningIdx; idx < grossIdx; idx++) {
                            const val = normalizedRow[idx];
                            if (val && !COLUMN_MAPPING.pd_days.includes(val) && val !== 'monthday') {
                                headerMap.dynamic_earnings.push({ index: idx, name: row[idx] });
                            }
                        }
                    }

                    // Identify Statutory Components (Subset of deductions or specific columns)
                    headerMap.statutory = [];
                    const statutoryIndices = new Set();
                    
                    // Normalize all statutory aliases for reliable matching
                    const normalizedStatMapping = {};
                    Object.keys(STAT_MAPPING).forEach(key => {
                        normalizedStatMapping[key] = STAT_MAPPING[key].map(a => normalize(a));
                    });
                    const allStatutoryAliases = Object.values(normalizedStatMapping).flat();

                    Object.keys(normalizedStatMapping).forEach(key => {
                        const aliases = normalizedStatMapping[key];
                        // Find ALL indices for this statutory component
                        normalizedRow.forEach((v, idx) => {
                            if (v && aliases.some(alias => v === alias || v.includes(alias))) {
                                headerMap.statutory.push({ index: idx, name: row[idx], key: key });
                                statutoryIndices.add(idx);
                            }
                        });
                    });

                    // Identify Dynamic Deductions (Everything between Gross and Total Deduction)
                    headerMap.dynamic_deductions = [];
                    if (grossIdx !== -1 && totalDeductIdx !== -1) {
                        for (let idx = grossIdx + 1; idx < totalDeductIdx; idx++) {
                            const val = normalizedRow[idx];
                            // Exclude if index is already marked as statutory OR if value matches ANY statutory alias
                            const isStatutory = statutoryIndices.has(idx) || allStatutoryAliases.some(alias => val === alias || val.includes(alias));
                            if (val && !isStatutory) {
                                headerMap.dynamic_deductions.push({ index: idx, name: row[idx] });
                            }
                        }
                    }

                    // Identify Employer Components
                    headerMap.employer = [];
                    Object.keys(EMPLOYER_MAPPING).forEach(key => {
                        const aliases = EMPLOYER_MAPPING[key];
                        // Scan all columns for employer components
                        normalizedRow.forEach((v, idx) => {
                            if (v && aliases.some(alias => v.includes(alias))) {
                                headerMap.employer.push({ index: idx, name: row[idx], key: key });
                            }
                        });
                    });

                    // Identify dynamic leaves
                    headerMap.dynamic_leaves = [];
                    normalizedRow.forEach((v, idx) => {
                        if (!v) return;
                        // Avoid columns already mapped to major fields (month, year, staff_id, gross, net, days)
                        const majorFields = ['month', 'year', 'staff_id', 'paid_gross', 'total_deduction', 'net_salary', 'fixed_gross', 'total_days', 'pd_days', 'wo_days', 'ph_days'];
                        const isMajor = majorFields.some(f => {
                           const mapped = headerMap[f];
                           return Array.isArray(mapped) ? mapped.includes(idx) : mapped === idx;
                        });
                        
                        if (!isMajor && (v.includes('leave') || v.includes('lv') || v === 'cl' || v === 'sl' || v === 'al' || v === 'pl' || v === 'el' || v === 'cof' || v === 'sl')) {
                            headerMap.dynamic_leaves.push({ index: idx, name: row[idx] });
                        }
                    });
                    break;
                }
            }
        }
        if (worksheet) break;
    }

    if (!worksheet) {
        fail("Could not find a valid Payroll sheet (missing 'Staff ID' or 'Employee Code' header).");
    }

    if (isCancelled) fail("IMPORT_CANCELLED");

    transaction = await sequelize.transaction();

    // Fetch employees for lookup
    const employeesList = await Employee.findAll({
        where: { company_id: mockStore.companyId, status: { [Op.ne]: 2 } },
        attributes: ['id', 'employee_code'],
        transaction,
        raw: true
    });

    const employeeCodeMap = new Map();
    employeesList.forEach(emp => {
      if (emp.employee_code) {
        employeeCodeMap.set(normalize(emp.employee_code), emp.id);
      }
    });

    const payslipPayloads = [];
    let createdCount = 0;
    let errorCount = 0;
    const errorSample = [];
    const MAX_SAMPLE = 15;

    // 1. First Pass: Strict Validation - Check if all employees exist & no duplicates in file
    const validationErrors = [];
    const seenCodesInFile = new Map(); // Track code -> first seen row index

    for (let i = headerRowIndex + 1; i < rawRows.length; i++) {
        const row = rawRows[i];
        if (!row || row.length === 0) continue;
        
        const staffIdVal = String(row[headerMap.staff_id] || '').trim();
        if (!staffIdVal || staffIdVal.toLowerCase() === 'total' || staffIdVal.toLowerCase() === 'sr.no' || staffIdVal.toLowerCase() === 'emp.code') continue;

        const normalizedCode = normalize(staffIdVal);
        const empName = row[headerMap.employee_name] || "N/A";

        // Check for duplicates within the Excel file itself
        if (seenCodesInFile.has(normalizedCode)) {
            const firstSeenRow = seenCodesInFile.get(normalizedCode);
            validationErrors.push(`Row ${i + 1}: Duplicate Employee Code '${staffIdVal}' found. (Already present in Row ${firstSeenRow})`);
            continue; // Skip existence check for duplicates to avoid redundant errors
        }
        seenCodesInFile.set(normalizedCode, i + 1);

        // Check if employee exists in system
        const employeeId = employeeCodeMap.get(normalizedCode);
        if (!employeeId) {
            validationErrors.push(`Row ${i + 1}: Employee name: ${empName}, Code: ${staffIdVal} does not exist in the system.`);
        }
    }

    if (validationErrors.length > 0) {
        if (transaction && !transaction.finished) await transaction.rollback();
        parentPort.postMessage({
            status: "SUCCESS",
            result: {
                importErrors: true,
                message: "Import failed: Some employees in the Excel file do not exist in the system. Please register them first.",
                errors: validationErrors,
                errorCount: validationErrors.length
            }
        });
        return;
    }

    // 2. Second Pass: Generate Payloads
    const parseNum = (valOrIdx, row) => {
        if (valOrIdx === undefined || valOrIdx === null) return 0;
        
        // If it's an array of indices, sum them up from the row
        if (Array.isArray(valOrIdx)) {
            return valOrIdx.reduce((sum, idx) => {
                const val = row[idx];
                if (val === null || val === undefined || val === '') return sum;
                const n = parseFloat(String(val).replace(/,/g, ''));
                return sum + (isNaN(n) ? 0 : n);
            }, 0);
        }
        
        // Single value handling
        const rawVal = row[valOrIdx];
        if (rawVal === null || rawVal === undefined || rawVal === '') return 0;
        const n = parseFloat(String(rawVal).replace(/,/g, ''));
        return isNaN(n) ? 0 : n;
    };

    for (let i = headerRowIndex + 1; i < rawRows.length; i++) {
        const row = rawRows[i];
        if (!row || row.length === 0) continue;
        
        const staffIdVal = String(row[headerMap.staff_id] || '').trim();
        if (!staffIdVal || staffIdVal.toLowerCase() === 'total' || staffIdVal.toLowerCase() === 'sr.no' || staffIdVal.toLowerCase() === 'emp.code') continue;

        const employeeId = employeeCodeMap.get(normalize(staffIdVal));
        if (!employeeId) continue;
        
        // employeeId is guaranteed to exist due to first pass

        // PRIORITY: Use UI-selected month/year if provided, fallback to Excel only if UI selection is missing
        const uiMonth = parseInt(body.month);
        const uiYear = parseInt(body.year);
        
        let excelMonth = row[headerMap.month] ? parseInt(row[headerMap.month]) : NaN;
        let excelYear = row[headerMap.year] ? parseInt(row[headerMap.year]) : NaN;

        // Final month/year selection: UI > Excel (if valid 1-12) > Current Date
        const month = (!isNaN(uiMonth) && uiMonth >= 1 && uiMonth <= 12) ? uiMonth :
                      (!isNaN(excelMonth) && excelMonth >= 1 && excelMonth <= 12) ? excelMonth : 
                      (new Date().getMonth() + 1);
                      
        const year = (!isNaN(uiYear) && uiYear > 2000) ? uiYear :
                     (!isNaN(excelYear) && excelYear > 2000) ? excelYear : 
                     (new Date().getFullYear());

        // Build Dynamic Components
        const earning_details = (headerMap.dynamic_earnings || []).reduce((acc, comp) => {
            const val = parseNum(comp.index, row);
            if (val !== 0) acc[comp.name] = val;
            return acc;
        }, {});

        const deduction_details = (headerMap.dynamic_deductions || []).reduce((acc, comp) => {
            const val = parseNum(comp.index, row);
            if (val !== 0) acc[comp.name] = val;
            return acc;
        }, {});

        const statutory_details = (headerMap.statutory || []).reduce((acc, comp) => {
            const val = parseNum(comp.index, row);
            if (val !== 0) acc[comp.name] = val;
            return acc;
        }, {});

        const employer_details = (headerMap.employer || []).reduce((acc, comp) => {
            const val = parseNum(comp.index, row);
            if (val !== 0) acc[comp.name] = val;
            return acc;
        }, {});

        const breakdown = { 
            earnings: Object.entries(earning_details).map(([name, val]) => ({ name, amount: val })),
            deductions: Object.entries(deduction_details).map(([name, val]) => ({ name, amount: val })),
            statutory: statutory_details,
            employer: employer_details
        };

        const payload = {
            employee_id: employeeId,
            month: month,
            year: year,
            company_id: mockStore.companyId,
            user_id: mockStore.userId,
            branch_id: mockStore.branch_id || 0,
            status: 1, // Finalized

            // Attendance
            pd_days: parseNum(headerMap.pd_days, row),
            ph_days: parseNum(headerMap.ph_days, row),
            wo_days: parseNum(headerMap.wo_days, row),
            wp_days: parseNum(headerMap.absent_days, row), 
            absent_days: parseNum(headerMap.absent_days, row),
            present_days: parseNum(headerMap.present_days, row), 
            total_days: parseNum(headerMap.total_days, row),
            lunch_count: parseNum(headerMap.lunch_count, row),
            leave_details: (headerMap.dynamic_leaves || []).reduce((acc, lv) => {
                const val = parseNum(lv.index, row);
                if (val > 0) acc[lv.name] = val;
                return acc;
            }, {}),

            // Dynamic JSON Components
            earning_details,
            deduction_details,
            statutory_details,
            employer_details,

            // Summary Totals
            fixed_gross: parseNum(headerMap.fixed_gross, row),
            paid_gross: parseNum(headerMap.paid_gross, row),
            total_deduction: parseNum(headerMap.total_deduction, row),
            net_salary: parseNum(headerMap.net_salary, row),
            
            break_down: breakdown
        };

        payslipPayloads.push(payload);
    }
    if (payslipPayloads.length > 0) {
        // Bulk Create with update on duplicate
        await Payslip.bulkCreate(payslipPayloads, {
            updateOnDuplicate: [
                'pd_days', 'ph_days', 'wo_days', 'wp_days', 'absent_days', 'present_days', 'total_days', 'lunch_count', 'leave_details',
                'earning_details', 'deduction_details', 'statutory_details', 'employer_details',
                'fixed_gross', 'paid_gross', 'total_deduction', 'net_salary', 'status', 'break_down'
            ],
            transaction
        });
        createdCount = payslipPayloads.length;
    }

    await transaction.commit();

    parentPort.postMessage({
      status: "SUCCESS",
      result: {
        message: `Payroll import completed successfully. Processed ${payslipPayloads.length} payslips.`,
        count: createdCount,
        skipped: errorCount,
        errors: errorSample
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
    const { user_id, branch_id, company_id } = workerData;
    const mockStore = {
        userId: user_id,
        companyId: company_id,
        branchId: branch_id,
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
