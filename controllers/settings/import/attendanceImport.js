const { parentPort, workerData } = require("worker_threads");
const { sequelize, commonQuery, constants } = require("../../../helpers");
const {
  Employee,
  AttendanceDay,
  AttendancePunch,
  BranchMaster,
  LeaveTemplate,
  LeaveTemplateCategory,
  EmployeeLeaveBalance,
  LeaveRequest
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
    'COF': { name: 'Compoff Leave', isPaid: true, isCompoff: true },
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
        "YYYY-MM-DD HH:mm:ss", 
        "YYYY-MM-DD HH:mm", 
        "YYYY-MM-DD h:mm A", 
        "YYYY-MM-DD hh:mm A",
        "YYYY-MM-DD h:mm:ss A",
        "YYYY-MM-DD hh:mm:ss A"
    ];

    // Try parsing with the attached date
    const parsed = dayjs(`${dateStr} ${timeStr}`, formats);
    if (parsed.isValid()) return parsed.toDate();

    // Fallback for time formats without leading date if needed
    const timeOnlyFormats = ["HH:mm:ss", "HH:mm", "h:mm A", "hh:mm A"];
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
    // Add snake_case too for direct access safety
    user_id: workerData.user_id,
    company_id: workerData.company_id,
    branch_id: workerData.branch_id,
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

    // Year detection
    const currentYear = new Date().getFullYear();
    let sheetYear = currentYear;

    // Check sheet name and file path first
    const pathMatch = (sheetName + filePath).match(/(\d{4})/);
    if (pathMatch) {
        const yr = parseInt(pathMatch[1]);
        if (yr > 2000 && yr < 2100) sheetYear = yr;
    }

    // Scan first 10 rows for a potential year if sheet name didn't have a valid one
    for (let i = 0; i < Math.min(formattedRows.length, 10); i++) {
        const row = formattedRows[i];
        if (!row) continue;
        const yearMatch = row.find(cell => {
            const val = parseInt(cell);
            return val > 2000 && val < 2100;
        });
        if (yearMatch) {
            sheetYear = parseInt(yearMatch);
            break;
        }
    }

    const startIdx = daysIdx !== -1 ? daysIdx + 1 : 0;
    for (let i = startIdx; i < formattedHeaders.length; i++) {
        const h = String(formattedHeaders[i] || '').trim();
        if (h.match(/^\d{1,2}-[a-zA-Z]+/)) {
            dateHeaders.push(i);
            dateMapping[i] = h;
        }
    }

    if (dateHeaders.length === 0) {
        fail(`Could not find any date columns (e.g., '1-Jan') in sheet '${sheetName}'.`);
    }

    if (isCancelled) fail("IMPORT_CANCELLED");

    transaction = await sequelize.transaction();

    // Fetch branches for mapping
    const branches = await requestContext.run(mockStore, async () => {
        return await commonQuery.findAllRecords(BranchMaster, {
            company_id: mockStore.companyId,
            status: { [Op.ne]: 2 }
        }, { raw: true }, transaction);
    });

    const branchNameMap = new Map();
    branches.forEach(b => {
        branchNameMap.set(normalize(b.branch_name), b.id);
    });

    // Fetch employees for lookup
    const employeesList = await requestContext.run(mockStore, async () => {
      return await commonQuery.findAllRecords(Employee, {
        company_id: mockStore.companyId,
        status: { [Op.ne]: 2 }
      }, {
        attributes: ['id', 'employee_code', 'first_name', 'branch_id'],
        raw: true
      }, transaction);
    });

    const employeeCodeMap = new Map();
    const employeeDataMap = new Map();
    employeesList.forEach(emp => {
      if (emp.employee_code) {
        const normCode = normalize(emp.employee_code);
        employeeCodeMap.set(normCode, emp.id);
        employeeDataMap.set(emp.id, { branch_id: emp.branch_id });
      }
    });
    
    // Fetch Leave Categories for the company
    const categoryRecords = await LeaveTemplateCategory.findAll({
        where: { company_id: mockStore.companyId, status: { [Op.ne]: 2 } },
        transaction,
        raw: true
    });
    const categoryMap = new Map();
    categoryRecords.forEach(c => {
        categoryMap.set(c.leave_category_name.toLowerCase(), c.id);
    });
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

    // 2. Determine date range
    let minDate = null;
    let maxDate = null;
    for (const colIdx of dateHeaders) {
        const dateStr = dateMapping[colIdx];
        const fullDateStr = `${dateStr}-${sheetYear}`.replace(/\s+/g, '-');
        const mDate = dayjs(fullDateStr, ["DD-MMM-YYYY", "D-MMM-YYYY", "DD-MMMM-YYYY", "D-MMMM-YYYY"]);
        if (mDate.isValid()) {
            const d = mDate.format("YYYY-MM-DD");
            if (!minDate || d < minDate) minDate = d;
            if (!maxDate || d > maxDate) maxDate = d;
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
            attributes: ['employee_id', 'leave_category_id'],
            transaction,
            raw: true
        });
        balances.forEach(b => {
            balanceCache.add(`${b.employee_id}_${b.leave_category_id}_${sheetYear}`);
        });
    }

    // 4. Pre-process Dates to avoid repeated parsing
    const parsedDatesMap = new Map();
    for (const colIdx of dateHeaders) {
        const dateStr = dateMapping[colIdx];
        const fullDateStr = `${dateStr}-${sheetYear}`.replace(/\s+/g, '-');
        const mDate = dayjs(fullDateStr, ["DD-MMM-YYYY", "D-MMM-YYYY", "DD-MMMM-YYYY", "D-MMMM-YYYY"]);
        if (mDate.isValid()) {
            parsedDatesMap.set(colIdx, {
                obj: mDate,
                formatted: mDate.format("YYYY-MM-DD"),
                year: mDate.year()
            });
        }
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
        }
    }

    if (validationErrors.length > 0) {
        if (transaction && !transaction.finished) await transaction.rollback();
        parentPort.postMessage({
            status: "SUCCESS",
            result: {
                importErrors: true,
                message: "Import failed: Some employees in the Excel file do not exist in the system or are duplicated.",
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

    // --- Optimization Step: Ensure All Leave Templates/Categories/Balances Exist ---
    // Ensure Default Template
    let defaultTemplate = await LeaveTemplate.findOne({
        where: { company_id: mockStore.companyId, status: 0 },
        transaction,
        order: [['id', 'ASC']]
    });
    if (!defaultTemplate) {
        defaultTemplate = await LeaveTemplate.create({
            template_name: 'Default Leave Template',
            leave_policy_cycle: 'CALENDAR_YEAR',
            accrual_type: 'UPFRONT',
            status: 0,
            company_id: mockStore.companyId,
            branch_id: mockStore.branchId,
            user_id: mockStore.userId
        }, { transaction });
    }

    // Ensure fixed categories from LEAVE_MAPPING + "Unpaid Leave"
    const categoriesToEnsure = [...new Set(Object.values(LEAVE_MAPPING).map(m => m.name)), "Unpaid Leave"];
    for (const catName of categoriesToEnsure) {
        const normName = catName.toLowerCase();
        if (!categoryMap.has(normName)) {
            const mapping = Object.values(LEAVE_MAPPING).find(m => m.name === catName) || { name: 'Unpaid Leave', isPaid: false, isCompoff: false };
            const newCat = await LeaveTemplateCategory.create({
                leave_template_id: defaultTemplate.id,
                leave_category_name: mapping.name,
                is_paid: mapping.isPaid,
                is_compoff: mapping.isCompoff,
                company_id: mockStore.companyId,
                branch_id: mockStore.branchId,
                user_id: mockStore.userId
            }, { transaction });
            categoryMap.set(normName, newCat.id);
        }
    }

    // Ensure Balances for ALL employees processed and ALL mentioned categories
    const allProcessedEmpIds = Array.from(employeeCodeMap.values());
    const allCategoryIds = Array.from(categoryMap.values());
    const balancesToCreate = [];
    for (const empId of allProcessedEmpIds) {
        for (const [catName, catId] of categoryMap.entries()) {
            const balKey = `${empId}_${catId}_${sheetYear}`;
            if (!balanceCache.has(balKey)) {
                const mapping = Object.values(LEAVE_MAPPING).find(m => m.name.toLowerCase() === catName) || { name: 'Unpaid Leave', isPaid: false, isCompoff: false };
                balancesToCreate.push({
                    employee_id: empId,
                    leave_category_id: catId,
                    leave_category_name: mapping.name,
                    year: sheetYear,
                    total_allocated: 0,
                    used_leaves: 0,
                    pending_leaves: 0,
                    is_paid: mapping.isPaid,
                    is_compoff: mapping.isCompoff,
                    company_id: mockStore.companyId,
                    branch_id: mockStore.branchId,
                    user_id: mockStore.userId
                });
                balanceCache.add(balKey);
            }
        }
    }
    if (balancesToCreate.length > 0) {
        await EmployeeLeaveBalance.bulkCreate(balancesToCreate, { transaction, ignoreDuplicates: true });
    }
    // -------------------------------------------------------------------------------
    // -----------------------------------------------

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

                    const s_base = s.split('/')[0];
                    const mapping = LEAVE_MAPPING[s_base];

                    if (mapping) {
                        if (mapping.markPresent) {
                             status = 0; // PRESENT
                        } else {
                             status = s.includes('/2') ? 1 : 6;
                        }

                        if (status === 1 || mapping.markPresent) {
                            leaveSession = 1; // Default
                            if (firstIn && lastOut) {
                                const inHr = dayjs(firstIn).hour();
                                const outHr = dayjs(lastOut).hour();
                                if (inHr >= 12) leaveSession = 1; // Worked afternoon, leave was morning (Session 1)
                                else if (outHr <= 15) leaveSession = 2; // Worked morning, leave was afternoon (Session 2)
                            }
                        }

                        leaveCategoryId = categoryMap.get(mapping.name.toLowerCase());
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
                        leaveCategoryId = categoryMap.get("unpaid leave");
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
                    const isShortLeave = (mapping && mapping.markPresent && leaveCategoryId);
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
                            company_id: mockStore.companyId,
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
                        first_in: dbFirstIn ? dayjs(dbFirstIn).format("HH:mm:ss") : null,
                        last_out: dbLastOut ? dayjs(dbLastOut).format("HH:mm:ss") : null,
                        is_locked: true,
                        note: importedNote,
                        leave_category_id: leaveCategoryId,
                        leave_session: leaveSession,
                        user_id: mockStore.userId,
                        company_id: mockStore.companyId,
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

runWorker().catch(error => {
  parentPort.postMessage({ status: "ERROR", error: error.message });
});
