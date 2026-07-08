const { parentPort, workerData } = require("worker_threads");
const { sequelize, commonQuery, constants, formatDateTime } = require("../../../helpers");
const {
  Employee,
  AttendanceDay,
  AttendancePunch,
  BranchMaster,
  LeaveTemplate,
  LeaveTemplateCategory,
  EmployeeLeaveBalance,
  LeaveRequest,
  CompanyMaster
} = require("../../../models");
const { Op } = require("sequelize");
const xlsx = require("xlsx");
const fs = require("fs");
const dayjs = require("dayjs");
const customParseFormat = require("dayjs/plugin/customParseFormat");
dayjs.extend(customParseFormat);
const { fail } = require('../../../helpers/Err');
const { requestContext } = require("../../../utils/requestContext");

let isCancelled = false;
let transaction = null;
let errorFileStream = null;

if (parentPort) {
  parentPort.on("message", async (msg) => {
    if (msg.command === "ABORT") {
      isCancelled = true;
      // We don't call rollback here anymore to avoid race conditions with the main loop.
      // The main loop will check isCancelled and the outer catch will handle rollback.
      if (errorFileStream) errorFileStream.end();
      parentPort.postMessage({ status: "CANCELLED" });
      // We give it a moment for the main loop to hit an await and see the flag, 
      // or the outer catch to trigger.
      setTimeout(() => process.exit(0), 1000);
    }
  });
}

const writeError = (stream, row, errorMessage) => {
  const errorRow = { ...row, Error: errorMessage };
  if (stream && stream.writable) stream.write(JSON.stringify(errorRow) + '\n');
};

const normalize = (val) => String(val || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const LEAVE_MAPPING = {
    'PL': { name: 'Paid Leave', isPaid: true, isCompoff: false },
    'CL': { name: 'Casual Leave', isPaid: true, isCompoff: false },
    'COF': { name: 'Comp-Off Leave', isPaid: true, isCompoff: true },
    'SOL': { name: 'Short Leave', isPaid: true, isCompoff: false, markPresent: true },
    'LV': { name: 'Leave', isPaid: true, isCompoff: false },
    'L': { name: 'Leave', isPaid: true, isCompoff: false },
    'UL': { name: 'Unpaid Leave', isPaid: false, isCompoff: false },
};

const parseWH = (val) => {
    if (!val || val === 0 || val === '0') return 0;
    if (typeof val === 'number') return Math.round(val * 60);
    if (typeof val === 'string') {
        if (val.includes(':')) {
            const parts = val.split(':').map(Number);
            if (parts.length >= 2) {
                return (parts[0] || 0) * 60 + (parts[1] || 0);
            }
        }
        const num = parseFloat(val);
        if (!isNaN(num)) return Math.round(num * 60);
    }
    return 0;
};

const parseTime = (timeVal, dateStr) => {
    if (!timeVal || timeVal === 0 || timeVal === '0' || String(timeVal).trim() === 'OD') return null;
    
    let timeStr = "";
    if (typeof timeVal === 'number') {
        const timeFraction = timeVal % 1;
        const totalSeconds = Math.round(timeFraction * 86400);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        timeStr = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    } else {
        timeStr = String(timeVal).trim();
    }

    if (!timeStr || timeStr === '0' || timeStr === '') return null;

    // Normalize spacing for AM/PM (e.g., "9:57AM" -> "9:57 AM")
    timeStr = timeStr.replace(/([0-9])([AP]M)/i, '$1 $2');

    const formats = [
        "YYYY-MM-DD h:mm:ss A",
        "YYYY-MM-DD hh:mm:ss A",
        "YYYY-MM-DD h:mm A", 
        "YYYY-MM-DD hh:mm A",
        "YYYY-MM-DD HH:mm:ss", 
        "YYYY-MM-DD HH:mm"
    ];

    // Try parsing with the attached date
    const parsed = dayjs(`${dateStr} ${timeStr}`, formats);
    if (parsed.isValid()) return parsed.toDate();

    // Fallback for time formats without leading date if needed
    const timeOnlyFormats = ["h:mm:ss A", "hh:mm:ss A", "h:mm A", "hh:mm A", "HH:mm:ss", "HH:mm"];
    const parsedTime = dayjs(timeStr, timeOnlyFormats);
    if (parsedTime.isValid()) {
        return dayjs(dateStr).hour(parsedTime.hour()).minute(parsedTime.minute()).second(parsedTime.second()).toDate();
    }
    
    return null;
};

const getEmployeeTypeDetails = (branchStr, codeStr) => {
    const s = String(branchStr || '').toLowerCase();
    const c = String(codeStr || '').toLowerCase();
    
    let employee_type = 1; // Default to Staff
    let worker_type = null;

    if (s.includes('staff') || s.includes('Staff')) {
        employee_type = 1;
    } else if (s.includes('worker') || c.includes('Worker')) {
        employee_type = 2;
        // Check for on-role/off-role
        if (s.includes('on-role') || s.includes('on role') || c.includes('on-Role') || c.includes('on Role')) {
            worker_type = 1; 
        } else if (s.includes('off-role') || s.includes('off role') || c.includes('off-Role') || c.includes('off Role')) {
            worker_type = 2; 
        }
    } else if (s.includes('contractor') || s.includes('Contractor')) {
        employee_type = 3; // Contractor
    }
    
    return { employee_type, worker_type };
};

const runWorker = async () => {
  try { await sequelize.authenticate(); } catch (error) {
    parentPort.postMessage({ status: "ERROR", error: "Database connection failed." });
    process.exit(1);
  }

  const { filePath, errorLogPath, body } = workerData;
  const mockStore = {
    userId: workerData.user_id,
    companyId: workerData.company_id,
    branchId: workerData.branch_id,
    is_super_admin: workerData.is_super_admin,
    branch_access: workerData.branch_access,
    // Add snake_case too for direct access safety
    user_id: workerData.user_id,
    company_id: workerData.company_id,
    branch_id: workerData.branch_id,
    is_super_admin: workerData.is_super_admin,
    branch_access: workerData.branch_access,
    ip: "127.0.0.1"
  };

  try {
    errorFileStream = fs.createWriteStream(errorLogPath);

    const workbook = xlsx.readFile(filePath);
    
    let worksheet = null;
    let sheetName = "";
    let rawRows = [];
    let headerRowIndex = -1;
    let staffIdIdx = -1;
    let staffNameIdx = -1;
    let branchIdx = -1;
    let daysIdx = -1;

    for (const name of workbook.SheetNames) {
        const ws = workbook.Sheets[name];
        const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });
        
        for (let i = 0; i < Math.min(rows.length, 50); i++) {
            const row = rows[i];
            if (Array.isArray(row)) {
                const normalizedRow = row.map(cell => normalize(cell));
                const sIdIdx = normalizedRow.findIndex(v => v === "staffid" || v === "employeeid" || v === "employeecode");
                const sNameIdx = normalizedRow.findIndex(v => v === "staffname" || v === "name" || v === "employeename");
                const bIdx = normalizedRow.findIndex(v => v === "branch" || v === "stafftype" || v === "type");
                const dIdx = normalizedRow.findIndex(v => v === "days" || v.includes("days"));

                if (sIdIdx !== -1) {
                    worksheet = ws;
                    sheetName = name;
                    rawRows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
                    headerRowIndex = i;
                    staffIdIdx = sIdIdx;
                    staffNameIdx = sNameIdx;
                    branchIdx = bIdx;
                    daysIdx = dIdx !== -1 ? dIdx : normalizedRow.findIndex(v => v.includes("days"));
                    break;
                }
            }
        }
        if (worksheet) break;
    }

    if (!worksheet) {
        fail("Could not find a valid Attendance Muster Roll sheet (missing 'Staff ID' header).");
    }

    const formattedRows = xlsx.utils.sheet_to_json(worksheet, { header: 1, defval: null, raw: false });
    const formattedHeaders = formattedRows[headerRowIndex];
    
    const dateHeaders = []; 
    const dateMapping = {}; 

    // Month/Year from body (Required)
    const providedMonth = parseInt(body.month);
    const providedYear = parseInt(body.year);

    if (isNaN(providedMonth) || isNaN(providedYear)) {
        fail("Month and Year are required for Attendance Import.");
    }

    const sheetYear = providedYear;
    const monthName = formatDateTime(new Date(providedYear, providedMonth - 1, 1), "MMM");

    const startIdx = daysIdx !== -1 ? daysIdx + 1 : 0;
    for (let i = startIdx; i < formattedHeaders.length; i++) {
        const h = String(formattedHeaders[i] || '').trim();
        // Match any header starting with a number (e.g., 1, 01, 1-Jan, etc.)
        if (h.match(/^\d{1,2}/)) {
            dateHeaders.push(i);
            dateMapping[i] = h;
        }
    }

    if (dateHeaders.length === 0) {
        fail(`Could not find any date columns starting with a number in sheet '${sheetName}'.`);
    }

    if (isCancelled) fail("IMPORT_CANCELLED");

    transaction = await sequelize.transaction();

    const normalizeCompanyAccess = (access) => {
        if (Array.isArray(access)) return access.map(String);
        if (typeof access === "string") return access.split(",").map((id) => id.trim()).filter(Boolean);
        return [];
    };
    let companyAccessList = [];
    if (workerData.is_super_admin) {
        let orgId = workerData.organization_id;
        if (!orgId && workerData.company_id) {
            const currentCompany = await CompanyMaster.findOne({
                where: { id: workerData.company_id },
                attributes: ['organization_id'],
                transaction,
                raw: true
            });
            if (currentCompany) {
                orgId = currentCompany.organization_id;
            }
        }

        if (orgId) {
            const orgCompanies = await CompanyMaster.findAll({
                where: { organization_id: orgId, status: { [Op.ne]: 2 } },
                attributes: ['id'],
                transaction,
                raw: true
            });
            companyAccessList = orgCompanies.map(c => String(c.id));
        }
    } else {
        companyAccessList = normalizeCompanyAccess(workerData.company_access || "");
    }
    if (workerData.company_id && !companyAccessList.includes(String(workerData.company_id))) {
        companyAccessList.push(String(workerData.company_id));
    }

    // Fetch branches for mapping
    const branches = await requestContext.run(mockStore, async () => {
        const branchWhere = { status: { [Op.ne]: 2 } };
        if (companyAccessList.length > 0) {
            branchWhere.company_id = { [Op.in]: companyAccessList.map(Number) };
        } else {
            branchWhere.company_id = mockStore.companyId;
        }
        return await commonQuery.findAllRecords(BranchMaster, branchWhere, { raw: true }, transaction, { company_id: true });
    });

    const branchNameMap = new Map();
    branches.forEach(b => {
        branchNameMap.set(normalize(b.branch_name), b.id);
    });

    // Fetch employees for lookup
    const employeesList = await requestContext.run(mockStore, async () => {
      const empWhere = { status: { [Op.ne]: 2 } };
      if (companyAccessList.length > 0) {
          empWhere.company_id = { [Op.in]: companyAccessList.map(Number) };
      } else {
          empWhere.company_id = mockStore.companyId;
      }
      return await commonQuery.findAllRecords(Employee, empWhere, {
        attributes: ['id', 'employee_code', 'first_name', 'branch_id', 'leave_template', 'company_id'],
        raw: true
      }, transaction, { company_id: true });
    });

    const employeeCodeMap = new Map();
    const employeeDataMap = new Map();
    employeesList.forEach(emp => {
      if (emp.employee_code) {
        const normCode = normalize(emp.employee_code);
        employeeCodeMap.set(normCode, emp.id);
        employeeDataMap.set(emp.id, { 
          branch_id: emp.branch_id, 
          leave_template: emp.leave_template,
          company_id: emp.company_id 
        });
      }
    });
    
    const employeeBalancesMap = new Map();
    const getEmployeeCategory = (empId, categoryName) => {
        const normName = String(categoryName || '').toLowerCase().trim();
        const key = `${empId}_${normName}`;
        return employeeBalancesMap.get(key) || null;
    };
    const balanceCache = new Set();

    // --- Optimization: Pre-fetch Existing Attendance Records ---
    // 1. Get all employee codes from the Excel to build a list of potential IDs
    const codesInSheet = new Set();
    for (let i = headerRowIndex + 1; i < rawRows.length; i++) {
        const row = rawRows[i];
        if (!row) continue;
        const sId = String(row[staffIdIdx] || '').trim();
        if (sId && sId.toLowerCase() !== 'total') {
            codesInSheet.add(normalize(sId));
        }
    }

    const empIdList = [];
    codesInSheet.forEach(code => {
        const id = employeeCodeMap.get(code);
        if (id) empIdList.push(id);
    });

    // 2. Pre-process Dates and determine date range
    const parsedDatesMap = new Map();
    let minDate = null;
    let maxDate = null;

    for (const colIdx of dateHeaders) {
        const dateStrRaw = dateMapping[colIdx];
        const dayMatch = dateStrRaw.match(/^(\d{1,2})/);
        if (dayMatch) {
            const dayNum = dayMatch[1];
            const fullDateStr = `${dayNum}-${monthName}-${sheetYear}`;
            const mDate = dayjs(fullDateStr, "D-MMM-YYYY");
            
            if (mDate.isValid()) {
                const formattedDate = mDate.format("YYYY-MM-DD");
                parsedDatesMap.set(colIdx, {
                    obj: mDate,
                    formatted: formattedDate,
                    year: mDate.year()
                });

                if (!minDate || formattedDate < minDate) minDate = formattedDate;
                if (!maxDate || formattedDate > maxDate) maxDate = formattedDate;
            }
        }
    }

    // 3. Fetch all existing days for this range/employees in one go
    const existingDaysMap = new Map();
    if (empIdList.length > 0 && minDate && maxDate) {
        const existingData = await AttendanceDay.findAll({
            where: {
                employee_id: { [Op.in]: empIdList },
                attendance_date: { [Op.between]: [minDate, maxDate] }
            },
            attributes: ['id', 'employee_id', 'attendance_date', 'status', 'leave_category_id'],
            transaction,
            raw: true
        });
        existingData.forEach(d => {
            const dateStr = dayjs(d.attendance_date).format("YYYY-MM-DD");
            const dKey = `${d.employee_id}_${dateStr}`;
            existingDaysMap.set(dKey, d);
        });

        // Pre-fetch balances for the current year to avoid redundant queries in loop
        const balances = await EmployeeLeaveBalance.findAll({
            where: {
                employee_id: { [Op.in]: empIdList },
                year: sheetYear,
                status: 0
            },
            attributes: ['employee_id', 'leave_category_id', 'leave_category_name'],
            transaction,
            raw: true
        });
        balances.forEach(b => {
            balanceCache.add(`${b.employee_id}_${b.leave_category_id}_${sheetYear}`);
            const normName = String(b.leave_category_name || '').toLowerCase().trim();
            const key = `${b.employee_id}_${normName}`;
            employeeBalancesMap.set(key, b.leave_category_id);
        });
    }
    // ----------------------------------------------------------

    const createdCountRef = { val: 0 };
    const updatedCountRef = { val: 0 };
    const leaveIncrementMap = new Map();
    let employeeCreatedCount = 0;
    let errorCount = 0;
    const errorSample = [];
    const MAX_SAMPLE = 10;

    // --- Optimization: Collect all payloads for batch processing ---
    const dayPayloads = [];
    const punchesToCreate = [];
    const dayIdsToClearPunches = [];
    const leaveRequestPayloads = [];
    // ----------------------------------------------------------------

    // --- First Pass: Pre-Validation for Duplicates & Existence ---
    const seenCodes = new Map();
    const validationErrors = [];

    for (let i = headerRowIndex + 1; i < rawRows.length; i++) {
        const row = rawRows[i];
        if (!row) continue;
        const staffIdVal = String(row[staffIdIdx] || '').trim();
        if (staffIdVal && staffIdVal.toLowerCase() !== 'total' && staffIdVal.toLowerCase() !== 'employee id' && staffIdVal.toLowerCase() !== 'staff id') {
            const normCode = normalize(staffIdVal);
            
            // Duplicate Check
            const staffNameVal = staffNameIdx !== -1 ? String(row[staffNameIdx] || '').trim() : "N/A";
            if (seenCodes.has(normCode)) {
                validationErrors.push(`Row ${i + 1}: Duplicate employee code '${staffIdVal}' (Name: ${staffNameVal}) - already found at row ${seenCodes.get(normCode)}`);
            } else {
                seenCodes.set(normCode, i + 1);
                
                // Existence Check
                if (!employeeCodeMap.has(normCode)) {
                    validationErrors.push(`Row ${i + 1}: Employee code '${staffIdVal}' (Name: ${staffNameVal}) does not exist in the system.`);
                }
            }

            const employeeId = employeeCodeMap.get(normCode);

            // Gather all Leave Categories referenced by this employee's row(s)
            const group = {};
            const firstLabel = normalize(row[daysIdx]);
            if (firstLabel) group[firstLabel] = row;

            let j = i + 1;
            while (j < rawRows.length) {
                const nextRow = rawRows[j];
                if (!nextRow) break;
                
                const nextStaffId = String(nextRow[staffIdIdx] || '').trim();
                if (nextStaffId && normalize(nextStaffId) !== normCode) break; 

                const label = normalize(nextRow[daysIdx]);
                const labelMap = {
                    'attendance': 'attendance', 'attendence': 'attendance', 'p': 'attendance',
                    'hd': 'attendance', 'a': 'attendance', 'wo': 'attendance', 'hl': 'attendance', 'l': 'attendance',
                    'in': 'in', 'inpunch': 'in', 'punchin': 'in', 'arrival': 'in', 'timein': 'in',
                    'out': 'out', 'outpunch': 'out', 'punchout': 'out', 'departure': 'out', 'timeout': 'out',
                    'wh': 'wh', 'workhours': 'wh', 'workinghours': 'wh', 'duration': 'wh',
                    'ot': 'ot', 'overtime': 'ot',
                    'f': 'f', 'fine': 'f'
                };
                
                const mappedLabel = labelMap[label];
                if (mappedLabel) {
                    group[mappedLabel] = nextRow;
                    j++;
                } else {
                    break;
                }
            }

            const attendanceRow = group['attendance'];
            const employeeCategories = new Set();
            if (attendanceRow) {
                for (const colIdx of dateHeaders) {
                    const statusChar = String(attendanceRow[colIdx] || '').trim();
                    if (statusChar) {
                        const s = statusChar.toUpperCase();
                        const parts = s.split('/');
                        const s_base = parts[0].trim();

                        const nonLeaveCodes = new Set(['P', 'A', 'HD', 'OD', 'PH', 'H', 'HL', 'R', 'WO', 'W']);
                        if (s === 'P/2') {
                            employeeCategories.add('Unpaid Leave');
                        } else if (!nonLeaveCodes.has(s_base)) {
                            const mapping = LEAVE_MAPPING[s_base];
                            if (mapping) {
                                employeeCategories.add(mapping.name);
                            } else {
                                employeeCategories.add(s_base);
                            }
                        }
                    }
                }
            }

            // Verify categories for this employee immediately if they exist in system
            if (employeeId) {
                employeeCategories.forEach(catName => {
                    const catId = getEmployeeCategory(employeeId, catName);
                    if (!catId) {
                        validationErrors.push(`Row ${i + 1}: Leave Category '${catName}' referenced for Employee code '${staffIdVal}' (Name: ${staffNameVal}) does not exist in the system.`);
                    }
                });
            }

            i = j - 1;
        }
    }

    if (validationErrors.length > 0) {
        if (transaction && !transaction.finished) await transaction.rollback();
        parentPort.postMessage({
            status: "SUCCESS",
            result: {
                importErrors: true,
                message: "Import failed: Validation errors found.",
                errors: validationErrors,
                errorCount: validationErrors.length
            }
        });
        return;
    }

    /* // Commented out auto-creation of missing employees as per user request
    const missingEmployees = [];
    const seenCodesInBatch = new Set();
    for (let i = headerRowIndex + 1; i < rawRows.length; i++) {
        const row = rawRows[i];
        if (!row) continue;
        const staffIdVal = String(row[staffIdIdx] || '').trim();
        if (!staffIdVal || staffIdVal.toLowerCase() === 'total') continue;
        
        const normCode = normalize(staffIdVal);
        if (!employeeCodeMap.has(normCode) && !seenCodesInBatch.has(normCode)) {
            const staffNameVal = String(row[staffNameIdx] || '').trim();
            const branchVal = branchIdx !== -1 ? String(row[branchIdx] || '').trim() : '';
            const { employee_type, worker_type } = getEmployeeTypeDetails(branchVal, staffIdVal);
            let targetBranchId = branchNameMap.get(normalize(branchVal)) || mockStore.branchId;

            missingEmployees.push({
                first_name: staffNameVal || staffIdVal,
                employee_code: staffIdVal,
                employee_type: employee_type,
                worker_type: worker_type,
                branch_id: targetBranchId,
                company_id: mockStore.companyId,
                user_id: mockStore.userId,
                status: 0,
                custom_fields: {}
            });
            seenCodesInBatch.add(normCode);
        }
    }

    if (missingEmployees.length > 0) {
        const newEmps = await Employee.bulkCreate(missingEmployees, { transaction, returning: true });
        newEmps.forEach(emp => {
            const normCode = normalize(emp.employee_code);
            employeeCodeMap.set(normCode, emp.id);
            employeeDataMap.set(emp.id, { branch_id: emp.branch_id });
            employeeCreatedCount++;
        });
    }
    */



    for (let i = headerRowIndex + 1; i < rawRows.length; i++) {
        const row = rawRows[i];
        if (!row) continue;

        const staffIdVal = String(row[staffIdIdx] || '').trim();
        if (staffIdVal && staffIdVal.toLowerCase() !== 'total') {
            const normCode = normalize(staffIdVal);
            // FETCH EMPLOYEE (Guaranteed to exist due to first pass)
            let employeeId = employeeCodeMap.get(normCode);
            const employeeCachedData = employeeDataMap.get(employeeId);
            const staffNameVal = String(row[staffNameIdx] || '').trim();

            const group = {};
            const firstLabel = normalize(row[daysIdx]);
            if (firstLabel) group[firstLabel] = row;

            let j = i + 1;
            while (j < rawRows.length) {
                const nextRow = rawRows[j];
                if (!nextRow) break;
                
                const nextStaffId = String(nextRow[staffIdIdx] || '').trim();
                if (nextStaffId && normalize(nextStaffId) !== normCode) break; 

                const label = normalize(nextRow[daysIdx]);
                const labelMap = {
                    'attendance': 'attendance', 'attendence': 'attendance', 'p': 'attendance',
                    'hd': 'attendance', 'a': 'attendance', 'wo': 'attendance', 'hl': 'attendance', 'l': 'attendance',
                    'in': 'in', 'inpunch': 'in', 'punchin': 'in', 'arrival': 'in', 'timein': 'in',
                    'out': 'out', 'outpunch': 'out', 'punchout': 'out', 'departure': 'out', 'timeout': 'out',
                    'wh': 'wh', 'workhours': 'wh', 'workinghours': 'wh', 'duration': 'wh',
                    'ot': 'ot', 'overtime': 'ot',
                    'f': 'f', 'fine': 'f'
                };
                
                const mappedLabel = labelMap[label];
                if (mappedLabel) {
                    group[mappedLabel] = nextRow;
                    j++;
                } else {
                    break;
                }
            }

            const attendanceRow = group['attendance'];
            const inRow = group['in'];
            const outRow = group['out'];
            const whRow = group['wh'];
            const otRow = group['ot'];
            const fineRow = group['f'] || group['fine'];

            for (const colIdx of dateHeaders) {
                if (isCancelled) fail("IMPORT_CANCELLED");
                try {
                    const dateInfo = parsedDatesMap.get(colIdx);
                    if (!dateInfo) continue;

                    const attendanceDate = dateInfo.formatted;
                    const year = dateInfo.year;

                    const statusChar = attendanceRow ? String(attendanceRow[colIdx] || '').trim() : '';
                    const inVal = inRow ? inRow[colIdx] : null;
                    const outVal = outRow ? outRow[colIdx] : null;
                    const whVal = whRow ? whRow[colIdx] : null;
                    const otVal = otRow ? otRow[colIdx] : null;
                    const fineVal = fineRow ? fineRow[colIdx] : null;

                    if (!statusChar && !inVal && !outVal && !whVal) continue;

                    const firstIn = parseTime(inVal, attendanceDate);
                    const lastOut = parseTime(outVal, attendanceDate);

                    let status = 5; 
                    const s = statusChar.toUpperCase();
                    let importedNote = null;
                    let leaveCategoryId = null;
                    let leaveSession = null;

                    const parts = s.split('/');
                    const s_base = parts[0].trim();
                    const isHalfDay = parts.length > 1 && parts[1].trim() === '2';

                    let mapping = LEAVE_MAPPING[s_base];
                    let leaveCatName = null;
                    let markPresent = false;

                    if (mapping) {
                        leaveCatName = mapping.name;
                        markPresent = !!mapping.markPresent;
                    } else if (s !== 'P/2') {
                        const targetKey = `${employeeId}_${s_base.toLowerCase().trim()}`;
                        if (employeeBalancesMap.has(targetKey)) {
                            leaveCatName = s_base;
                            if (s_base.toLowerCase().includes('short')) {
                                markPresent = true;
                            }
                        }
                    }

                    if (leaveCatName) {
                        if (markPresent) {
                             status = 0; // PRESENT
                        } else {
                             status = isHalfDay ? 1 : 6;
                        }

                        if (status === 1 || markPresent) {
                            leaveSession = 1; // Default
                            if (firstIn && lastOut) {
                                const inHr = dayjs(firstIn).hour();
                                const outHr = dayjs(lastOut).hour();
                                if (inHr >= 12) leaveSession = 1; // Worked afternoon, leave was morning (Session 1)
                                else if (outHr <= 15) leaveSession = 2; // Worked morning, leave was afternoon (Session 2)
                            }
                        }

                        leaveCategoryId = getEmployeeCategory(employeeId, leaveCatName);
                        importedNote = `Imported: ${statusChar}`;
                    } else if (s === 'HD') {
                        status = 1;
                        leaveSession = 1; // Default
                        if (firstIn && lastOut) {
                            const inHr = dayjs(firstIn).hour();
                            const outHr = dayjs(lastOut).hour();
                            if (inHr >= 12) leaveSession = 1;
                            else if (outHr <= 15) leaveSession = 2;
                        }
                    } else if (s === 'OD') {
                         status = 12; // OD
                    } else if (s === 'OD/2') {
                         status = 13; // HALF_OD
                    } else if (s === 'P/2') {
                        status = 1; // HALF_DAY
                        leaveSession = 1; // Default
                        if (firstIn && lastOut) {
                            const inHr = dayjs(firstIn).hour();
                            const outHr = dayjs(lastOut).hour();
                            if (inHr >= 12) leaveSession = 1;
                            else if (outHr <= 15) leaveSession = 2;
                        }
                        leaveCategoryId = getEmployeeCategory(employeeId, "unpaid leave");
                        importedNote = `Imported: ${statusChar}`;
                    } else if (s === 'P') {
                        status = 0; // PRESENT
                    } else if (s === 'A') {
                        status = 5; // ABSENT
                    } else if (['PH', 'H', 'HL'].includes(s)) {
                        status = 4; // HOLIDAY
                    } else if (['R', 'WO', 'W'].includes(s)) {
                        status = 3; // WEEKLY_OFF
                    } else {
                        status = (inVal || outVal) ? 0 : 5;
                    }

                    const workedMinutes = parseWH(whVal);
                    const overtimeMinutes = parseWH(otVal);
                    const fineMinutes = parseWH(fineVal);
                    
                    let overtimeData = null;
                    if (overtimeMinutes > 0) {
                        overtimeData = {
                            late_ot: { minutes: overtimeMinutes, rate: 1, amount: 0 }
                        };
                    }

                    let fineData = null;
                    if (fineMinutes > 0) {
                        fineData = {
                            late_entry: { minutes: fineMinutes, rate: 1, amount: 0 }
                        };
                    }
                    

                    let dbFirstIn = firstIn;
                    let dbLastOut = lastOut;
                    let effectiveWorkedMinutes = workedMinutes;

                    if (firstIn && lastOut) {
                        let diff = dayjs(lastOut).diff(dayjs(firstIn), 'minute');
                        if (diff < 0) {
                            // Night shift: if OUT is before IN, add 1 day to OUT
                            dbLastOut = dayjs(lastOut).add(1, 'day').toDate();
                            diff = dayjs(dbLastOut).diff(dayjs(firstIn), 'minute');
                        }
                        // Auto calculate duration from punches
                    if (diff > 0) {
                            effectiveWorkedMinutes = diff;
                        }
                    }

                    const existingDay = existingDaysMap.get(`${employeeId}_${attendanceDate}`);
                    const dayId = existingDay ? existingDay.id : null;

                    // Support leave balance increment sync
                    const isShortLeave = leaveCategoryId && (
                        (mapping && mapping.markPresent) || 
                        (leaveCatName && leaveCatName.toLowerCase().includes('short'))
                    );
                    const isFullLeave = (status === 6);
                    const isHalfLeave = (status === 1 && leaveCategoryId);
                    
                    const newDays = (isFullLeave || isShortLeave) ? 1.0 : (isHalfLeave ? 0.5 : 0);

                    let oldDays = 0;
                    if (existingDay && existingDay.leave_category_id) {
                         // If it was status 6 (Leave) or status 0 with a category (Short Leave), it's 1.0
                         if (existingDay.status === 6 || existingDay.status === 0) oldDays = 1.0;
                         else oldDays = 0.5; // Half Day
                    }

                    if (leaveCategoryId) {
                         const balKey = `${employeeId}_${leaveCategoryId}_${year}`;
                         const diffUsage = newDays - ((existingDay && existingDay.leave_category_id === leaveCategoryId) ? oldDays : 0);
                         if (diffUsage !== 0) {
                              leaveIncrementMap.set(balKey, (leaveIncrementMap.get(balKey) || 0) + diffUsage);
                         }
                    }
                    // Handle case where it WAS a leave but now it's not OR category changed
                    if (existingDay && existingDay.leave_category_id && existingDay.leave_category_id !== leaveCategoryId) {
                         const oldBalKey = `${employeeId}_${existingDay.leave_category_id}_${year}`;
                         leaveIncrementMap.set(oldBalKey, (leaveIncrementMap.get(oldBalKey) || 0) - oldDays);
                    }

                    if (newDays > 0 && leaveCategoryId) {
                        leaveRequestPayloads.push({
                            employee_id: employeeId,
                            leave_category_id: leaveCategoryId,
                            start_date: attendanceDate,
                            end_date: attendanceDate,
                            total_days: newDays,
                            reason: "Auto-generated from Attendance Import",
                            approval_status: constants.LEAVE_APPROVAL_STATUS.APPROVED,
                            approved_by: mockStore.userId,
                            company_id: employeeCachedData?.company_id || mockStore.companyId,
                            branch_id: mockStore.branchId || (branchIdx !== -1 ? branchNameMap.get(normalize(row[branchIdx])) : null),
                            user_id: mockStore.userId,
                            status: 0
                        });
                    }
                    
                    const payload = {
                        employee_id: employeeId,
                        attendance_date: attendanceDate,
                        status: status,
                        worked_minutes: effectiveWorkedMinutes,
                        overtime_minutes: overtimeMinutes,
                        fine_amount: 0,
                        overtime_data: overtimeData,
                        fine_data: fineData,
                        first_in: dbFirstIn ? formatDateTime(dbFirstIn, "HH:mm:ss") : null,
                        last_out: dbLastOut ? formatDateTime(dbLastOut, "HH:mm:ss") : null,
                        is_locked: true,
                        note: importedNote,
                        leave_category_id: leaveCategoryId,
                        leave_session: leaveSession,
                        user_id: mockStore.userId,
                        company_id: employeeCachedData?.company_id || mockStore.companyId,
                        branch_id: employeeCachedData?.branch_id || mockStore.branchId,
                    };

                    if (dayId) {
                        payload.id = dayId;
                        updatedCountRef.val++;
                    } else {
                        createdCountRef.val++;
                    }

                    dayPayloads.push(payload);

                    if (dbFirstIn || dbLastOut) {
                        // We will handle punches in a second pass after dayIds are guaranteed
                        // For now, if dayId exists, we can queue it for punch clearing
                        if (dayId) dayIdsToClearPunches.push(dayId);
                        
                        // We'll link these to the specific day later if they are new
                        // To keep it simple and fast, we'll use the existingDayMap lookup
                        // but do it after the bulk upsert ensures all IDs exist.
                        punchesToCreate.push({
                            empDateKey: `${employeeId}_${attendanceDate}`,
                            punches: [
                                dbFirstIn ? { type: 'IN', time: dbFirstIn } : null,
                                dbLastOut ? { type: 'OUT', time: dbLastOut } : null
                            ].filter(Boolean)
                        });
                    }
                } catch (dateError) {
                    console.error(`Error row date ${staffIdVal}:`, dateError);
                    throw dateError; 
                }
            }
            i = j - 1; 
        }
    }

    // --- Optimization Part 2: Execute Batch Operations ---
    if (dayPayloads.length > 0) {
        // 1. Bulk Upsert AttendanceDay
        // updateOnDuplicate only works if we know the IDs or have a unique constraint
        // Since we have a Map of existing IDs, we can use bulkCreate with updateOnDuplicate
        await requestContext.run(mockStore, async () => {
            await AttendanceDay.bulkCreate(dayPayloads, {
                updateOnDuplicate: [
                    'status', 'worked_minutes', 'overtime_minutes', 'fine_amount', 
                    'overtime_data', 'fine_data', 'first_in', 'last_out', 'note',
                    'leave_category_id', 'leave_session'
                ],
                transaction
            });
        });

        // 2. Fetch all IDs for newly created/updated days so we can link punches
        // CRITICAL: We must include ALL employees that were processed, especially new ones
        const processedEmpIds = [...new Set(dayPayloads.map(p => p.employee_id))];
        
        const allDaysInRange = await AttendanceDay.findAll({
            where: {
                employee_id: { [Op.in]: processedEmpIds },
                attendance_date: { [Op.between]: [minDate, maxDate] }
            },
            attributes: ['id', 'employee_id', 'attendance_date', 'branch_id'],
            transaction,
            raw: true
        });

        const finalDayIdMap = new Map();
        const dayBranchMap = new Map();
        allDaysInRange.forEach(d => {
            const dateStr = dayjs(d.attendance_date).format("YYYY-MM-DD");
            const dKey = `${d.employee_id}_${dateStr}`;
            finalDayIdMap.set(dKey, d.id);
            dayBranchMap.set(d.id, d.branch_id);
        });

        // 3. Bulk Clear Punches for all days we are touching
        const allTouchedDayIds = Array.from(finalDayIdMap.values());
        if (allTouchedDayIds.length > 0) {
            await AttendancePunch.destroy({
                where: { day_id: { [Op.in]: allTouchedDayIds } },
                transaction
            });
        }

        // 4. Bulk Create Punches
        const finalPunches = [];
        punchesToCreate.forEach(group => {
            const dId = finalDayIdMap.get(group.empDateKey);
            if (dId) {
                const empId = group.empDateKey.split('_')[0];
                group.punches.forEach(p => {
                    finalPunches.push({
                        employee_id: parseInt(empId),
                        day_id: dId,
                        punch_time: p.time,
                        punch_type: p.type,
                        user_id: mockStore.userId,
                        company_id: mockStore.companyId,
                        branch_id: dayBranchMap.get(dId) || mockStore.branchId,
                        status: 0
                    });
                });
            }
        });

        if (finalPunches.length > 0) {
            await AttendancePunch.bulkCreate(finalPunches, { transaction });
        }
    }
    // 5. Update Leave Balances
    if (leaveIncrementMap.size > 0) {
        for (const [balKey, amount] of leaveIncrementMap.entries()) {
            if (amount === 0) continue;
            const [empId, catId, yr] = balKey.split('_');
            await EmployeeLeaveBalance.update({
                used_leaves: sequelize.literal(`used_leaves + ${amount}`),
                pending_leaves: sequelize.literal(`pending_leaves - ${amount}`)
            }, {
                where: {
                    employee_id: empId,
                    leave_category_id: catId,
                    year: yr,
                    status: 0
                },
                transaction
            });
        }
    }
    
    // 6. Bulk Create Leave Requests (Maintain History)
    if (leaveRequestPayloads.length > 0) {
        // Clear existing auto-requests for the touched date range to prevent duplicates
        const processedEmpIdsForLeave = [...new Set(leaveRequestPayloads.map(p => p.employee_id))];
        await LeaveRequest.destroy({
            where: {
                employee_id: { [Op.in]: processedEmpIdsForLeave },
                start_date: { [Op.between]: [minDate, maxDate] },
                reason: "Auto-generated from Attendance Import"
            },
            transaction
        });

        await LeaveRequest.bulkCreate(leaveRequestPayloads, { transaction });
    }
    // -----------------------------------------------------

    await transaction.commit();

    parentPort.postMessage({
      status: "SUCCESS",
      result: {
        message: `Attendance import completed. Created ${employeeCreatedCount} new employees and ${createdCountRef.val + updatedCountRef.val} attendance records.`,
        count: createdCountRef.val,
        updated: updatedCountRef.val,
        employeeCreated: employeeCreatedCount,
        skipped: errorCount,
        summary: { created: createdCountRef.val, updated: updatedCountRef.val, employeeCreated: employeeCreatedCount, errors: errorCount },
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
    const mockStore = {
        userId: workerData.user_id,
        companyId: workerData.company_id,
        branchId: workerData.branch_id,
        ip: "127.0.0.1"
    };

    await requestContext.run(mockStore, async () => {
        await runWorker();
    });
};

startWorker().catch(error => {
  parentPort.postMessage({ status: "ERROR", error: error.message });
});
