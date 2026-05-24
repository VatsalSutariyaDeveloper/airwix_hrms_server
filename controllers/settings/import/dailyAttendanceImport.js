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
const { rebuildAttendanceDay } = require("../../../helpers/attendanceHelper");

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

const isInTimeHeader = (header) => {
    const h = normalize(header);
    return h.startsWith("intime") || 
           h.startsWith("punchin") || 
           h === "in" || 
           h.startsWith("timein") || 
           h.startsWith("firstin") || 
           h.startsWith("arrival") || 
           h.startsWith("firstintime");
};

const isOutTimeHeader = (header) => {
    const h = normalize(header);
    return h.startsWith("outtime") || 
           h.startsWith("punchout") || 
           h === "out" || 
           h.startsWith("timeout") || 
           h.startsWith("lastout") || 
           h.startsWith("departure") || 
           h.startsWith("lastouttime");
};

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
    if (!timeVal || timeVal === 0 || timeVal === '0' || String(timeVal).trim() === 'OD' || String(timeVal).trim() === '-') return null;
    
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

    timeStr = timeStr.replace(/([0-9])([AP]M)/i, '$1 $2');

    const formats = [
        "YYYY-MM-DD h:mm:ss A",
        "YYYY-MM-DD hh:mm:ss A",
        "YYYY-MM-DD h:mm A", 
        "YYYY-MM-DD hh:mm A",
        "YYYY-MM-DD HH:mm:ss", 
        "YYYY-MM-DD HH:mm"
    ];

    const parsed = dayjs(`${dateStr} ${timeStr}`, formats);
    if (parsed.isValid()) return parsed.toDate();

    const timeOnlyFormats = ["h:mm:ss A", "hh:mm:ss A", "h:mm A", "hh:mm A", "HH:mm:ss", "HH:mm"];
    const parsedTime = dayjs(timeStr, timeOnlyFormats);
    if (parsedTime.isValid()) {
        return dayjs(dateStr).hour(parsedTime.hour()).minute(parsedTime.minute()).second(parsedTime.second()).toDate();
    }
    
    return null;
};

const mapStatus = (statusStr) => {
    if (!statusStr) return null;
    const s = String(statusStr).trim().toUpperCase();
    
    if (s === 'P' || s === 'PRESENT') return 0;
    if (s === 'HD' || s === 'HALF DAY' || s === 'HALFDAY') return 1;
    if (s === 'R' || s === 'WO' || s === 'WEEKLY OFF' || s === 'WEEKLYOFF') return 3;
    if (s === 'PH' || s === 'H' || s === 'HL' || s === 'HOLIDAY') return 4;
    if (s === 'A' || s === 'ABSENT') return 5;
    if (s === 'L' || s === 'LEAVE') return 6;
    if (s === 'OD' || s === 'OUT DUTY' || s === 'OUTDUTY') return 12;
    if (s === 'OD/2' || s === 'HALF OUT DUTY' || s === 'HALFOUTDUTY') return 13;
    
    if (s.includes('HALF DAY /') || s.includes('HD/')) {
        return 1;
    }
    
    return null;
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
    user_id: workerData.user_id,
    company_id: workerData.company_id,
    branch_id: workerData.branch_id,
    is_super_admin: workerData.is_super_admin,
    branch_access: workerData.branch_access,
    ip: "127.0.0.1"
  };

  try {
    errorFileStream = fs.createWriteStream(errorLogPath);

    const providedDate = body.date || body.attendance_date;
    if (!providedDate) {
        fail("Attendance Date is required for Daily Attendance Import.");
    }
    const targetDateObj = dayjs(providedDate);
    if (!targetDateObj.isValid()) {
        fail("Invalid Attendance Date format. Must be a valid date (e.g. YYYY-MM-DD).");
    }
    const attendanceDate = targetDateObj.format("YYYY-MM-DD");
    const sheetYear = targetDateObj.year();

    const workbook = xlsx.readFile(filePath);
    
    let worksheet = null;
    let sheetName = "";
    let rawRows = [];
    let headerRowIndex = -1;
    let staffIdIdx = -1;
    let staffNameIdx = -1;
    let statusIdx = -1;
    let punchColumns = [];

    for (const name of workbook.SheetNames) {
        const ws = workbook.Sheets[name];
        const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });
        
        for (let i = 0; i < Math.min(rows.length, 50); i++) {
            const row = rows[i];
            if (Array.isArray(row)) {
                const normalizedRow = row.map(cell => cell ? normalize(cell) : '');
                
                const sIdIdx = normalizedRow.findIndex(v => v === "staffid" || v === "employeeid" || v === "employeecode" || v === "empcode" || v === "code" || v === "id");
                
                if (sIdIdx !== -1) {
                    worksheet = ws;
                    sheetName = name;
                    rawRows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
                    headerRowIndex = i;
                    staffIdIdx = sIdIdx;
                    
                    staffNameIdx = normalizedRow.findIndex(v => v === "staffname" || v === "name" || v === "employeename" || v === "empname");
                    statusIdx = -1; // Ignore Status from Excel sheet, dynamically calculate using rebuildAttendanceDay
                    
                    // Discover all IN and OUT columns dynamically and keep their left-to-right order
                    punchColumns = [];
                    for (let colIdx = 0; colIdx < row.length; colIdx++) {
                        const cellVal = row[colIdx];
                        if (cellVal) {
                            if (isInTimeHeader(cellVal)) {
                                punchColumns.push({ colIdx, type: 'IN' });
                            } else if (isOutTimeHeader(cellVal)) {
                                punchColumns.push({ colIdx, type: 'OUT' });
                            }
                        }
                    }
                    punchColumns.sort((a, b) => a.colIdx - b.colIdx);
                    break;
                }
            }
        }
        if (worksheet) break;
    }

    if (!worksheet) {
        fail("Could not find a valid Daily Attendance sheet (missing 'Employee Code' or 'Staff ID' header).");
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
    const codesInSheet = new Set();
    for (let i = headerRowIndex + 1; i < rawRows.length; i++) {
        const row = rawRows[i];
        if (!row) continue;
        const sId = String(row[staffIdIdx] || '').trim();
        if (sId && sId.toLowerCase() !== 'total' && sId.toLowerCase() !== 'employee id' && sId.toLowerCase() !== 'staff id') {
            codesInSheet.add(normalize(sId));
        }
    }

    const empIdList = [];
    codesInSheet.forEach(code => {
        const id = employeeCodeMap.get(code);
        if (id) empIdList.push(id);
    });

    const existingDaysMap = new Map();
    if (empIdList.length > 0) {
        const existingData = await AttendanceDay.findAll({
            where: {
                employee_id: { [Op.in]: empIdList },
                attendance_date: attendanceDate
            },
            attributes: ['id', 'employee_id', 'attendance_date', 'status', 'leave_category_id'],
            transaction,
            raw: true
        });
        existingData.forEach(d => {
            existingDaysMap.set(d.employee_id, d);
        });

        // Pre-fetch balances for the current year
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

    const createdCountRef = { val: 0 };
    const updatedCountRef = { val: 0 };
    const leaveIncrementMap = new Map();
    let errorCount = 0;
    const errorSample = [];

    let dayPayloads = [];
    const punchesToCreate = [];
    const leaveRequestPayloads = [];

    // --- First Pass: Pre-Validation for Existence ---
    const seenCodes = new Set();
    const validationErrors = [];
    for (let i = headerRowIndex + 1; i < rawRows.length; i++) {
        const row = rawRows[i];
        if (!row) continue;
        const staffIdVal = String(row[staffIdIdx] || '').trim();
        if (staffIdVal && staffIdVal.toLowerCase() !== 'total' && staffIdVal.toLowerCase() !== 'employee id' && staffIdVal.toLowerCase() !== 'staff id') {
            const normCode = normalize(staffIdVal);
            
            if (!seenCodes.has(normCode)) {
                seenCodes.add(normCode);
                
                // Existence Check
                const staffNameVal = staffNameIdx !== -1 ? String(row[staffNameIdx] || '').trim() : "N/A";
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

    // Ensure Default Template
    let defaultTemplate = await LeaveTemplate.findOne({
        where: { company_id: mockStore.companyId, branch_id: mockStore.branchId, status: 0 },
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

    // Ensure fixed categories from LEAVE_MAPPING
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

    // Ensure Balances
    const allProcessedEmpIds = Array.from(employeeCodeMap.values());
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

    // --- Second Pass: Process Rows ---
    const dayPayloadsMap = new Map();
    const employeeLeaveInfoMap = new Map();

    for (let i = headerRowIndex + 1; i < rawRows.length; i++) {
        const row = rawRows[i];
        if (!row) continue;

        const staffIdVal = String(row[staffIdIdx] || '').trim();
        if (staffIdVal && staffIdVal.toLowerCase() !== 'total' && staffIdVal.toLowerCase() !== 'employee id' && staffIdVal.toLowerCase() !== 'staff id') {
            const normCode = normalize(staffIdVal);
            let employeeId = employeeCodeMap.get(normCode);
            const employeeCachedData = employeeDataMap.get(employeeId);

            // Collect all punches from this row dynamically in left-to-right order
            const rowPunches = [];
            let lastParsedTime = null;
            
            punchColumns.forEach(col => {
                const val = row[col.colIdx];
                let time = parseTime(val, attendanceDate);
                if (time) {
                    // Smart AM/PM correction: If this punch is chronologically before the previous one in the same row,
                    // and it's currently an AM time (hour < 12), try adding 12 hours (AM to PM) to see if it makes it chronological.
                    if (lastParsedTime) {
                        if (dayjs(time).isBefore(dayjs(lastParsedTime))) {
                            const hour = dayjs(time).hour();
                            if (hour < 12) {
                                const adjustedTime = dayjs(time).add(12, 'hour').toDate();
                                if (dayjs(adjustedTime).isAfter(dayjs(lastParsedTime))) {
                                    time = adjustedTime;
                                    console.log(`[SmartCorrection] Adjusted AM to PM for Employee ${employeeId} at column index ${col.colIdx}: ${val} -> ${dayjs(time).format('hh:mm A')}`);
                                }
                            }
                        }
                    }
                    rowPunches.push({ type: col.type, time });
                    lastParsedTime = time;
                }
            });

            let dbFirstIn = null;
            let dbLastOut = null;

            rowPunches.forEach(p => {
                if (p.type === 'IN') {
                    if (!dbFirstIn || p.time < dbFirstIn) {
                        dbFirstIn = p.time;
                    }
                } else if (p.type === 'OUT') {
                    if (!dbLastOut || p.time > dbLastOut) {
                        dbLastOut = p.time;
                    }
                }
            });

            let status = (dbFirstIn || dbLastOut) ? 0 : 5; // Default: PRESENT if punches exist, ABSENT if not
            let importedNote = `Imported Daily Attendance`;
            let leaveCategoryId = null;
            let leaveSession = null;

            if (statusIdx !== -1 && row[statusIdx]) {
                const statusStr = String(row[statusIdx]).trim();
                const mappedStatus = mapStatus(statusStr);
                
                if (mappedStatus !== null) {
                    status = mappedStatus;
                    if (status === 1) leaveSession = 1;
                }
                
                const upperStatus = statusStr.toUpperCase();
                let foundLeaveCat = null;
                
                const s_base = upperStatus.split('/')[0].split(' ')[0];
                const mapping = LEAVE_MAPPING[s_base];
                if (mapping) {
                    status = s_base.includes('/2') ? 1 : 6;
                    if (mapping.markPresent) status = 0;
                    foundLeaveCat = mapping.name;
                    leaveSession = 1;
                } else {
                    const normStatus = statusStr.toLowerCase();
                    for (const catName of categoryMap.keys()) {
                        if (normStatus.includes(catName)) {
                            foundLeaveCat = catName;
                            status = normStatus.includes('half') ? 1 : 6;
                            leaveSession = 1;
                            break;
                        }
                    }
                }
                
                if (foundLeaveCat) {
                    leaveCategoryId = categoryMap.get(foundLeaveCat.toLowerCase());
                    importedNote = `Imported Leave: ${statusStr}`;
                }
            }

            let effectiveWorkedMinutes = 0;

            if (dbFirstIn && dbLastOut) {
                let diff = dayjs(dbLastOut).diff(dayjs(dbFirstIn), 'minute');
                if (diff < 0) {
                    dbLastOut = dayjs(dbLastOut).add(1, 'day').toDate();
                    diff = dayjs(dbLastOut).diff(dayjs(dbFirstIn), 'minute');
                }
                if (diff > 0) {
                    effectiveWorkedMinutes = diff;
                }
            }

            const existingDay = existingDaysMap.get(employeeId);
            const dayId = existingDay ? existingDay.id : null;

            // Track leave info if it is specified in this row
            if (leaveCategoryId) {
                const isShortLeave = (leaveCategoryId && status === 0);
                const isFullLeave = (status === 6);
                const isHalfLeave = (status === 1 && leaveCategoryId);
                const currentNewDays = (isFullLeave || isShortLeave) ? 1.0 : (isHalfLeave ? 0.5 : 0);

                const existingLeave = employeeLeaveInfoMap.get(employeeId);
                if (!existingLeave || currentNewDays > existingLeave.newDays) {
                    employeeLeaveInfoMap.set(employeeId, {
                        leaveCategoryId,
                        leaveSession,
                        newDays: currentNewDays,
                        status,
                        importedNote
                    });
                }
            }

            // Aggregate into dayPayloadsMap
            const existingPayload = dayPayloadsMap.get(employeeId);
            if (existingPayload) {
                if (status === 0 || existingPayload.status === 0) {
                    existingPayload.status = 0;
                } else if (status === 1 || existingPayload.status === 1) {
                    existingPayload.status = 1;
                } else if (status !== null) {
                    existingPayload.status = status;
                }

                existingPayload.worked_minutes = (existingPayload.worked_minutes || 0) + (effectiveWorkedMinutes || 0);

                if (dbFirstIn) {
                    if (!existingPayload.dbFirstInDate || dbFirstIn < existingPayload.dbFirstInDate) {
                        existingPayload.dbFirstInDate = dbFirstIn;
                        existingPayload.first_in = formatDateTime(dbFirstIn, "HH:mm:ss");
                    }
                }
                if (dbLastOut) {
                    if (!existingPayload.dbLastOutDate || dbLastOut > existingPayload.dbLastOutDate) {
                        existingPayload.dbLastOutDate = dbLastOut;
                        existingPayload.last_out = formatDateTime(dbLastOut, "HH:mm:ss");
                    }
                }

                if (importedNote && existingPayload.note && !existingPayload.note.includes(importedNote)) {
                    existingPayload.note += `; ${importedNote}`;
                }
            } else {
                const payload = {
                    employee_id: employeeId,
                    attendance_date: attendanceDate,
                    status: status,
                    worked_minutes: effectiveWorkedMinutes,
                    overtime_minutes: 0,
                    fine_amount: 0,
                    overtime_data: null,
                    fine_data: null,
                    first_in: dbFirstIn ? formatDateTime(dbFirstIn, "HH:mm:ss") : null,
                    last_out: dbLastOut ? formatDateTime(dbLastOut, "HH:mm:ss") : null,
                    is_locked: false,
                    note: importedNote,
                    leave_category_id: null,
                    leave_session: null,
                    user_id: mockStore.userId,
                    company_id: mockStore.companyId,
                    branch_id: employeeCachedData?.branch_id || mockStore.branchId,
                    dbFirstInDate: dbFirstIn,
                    dbLastOutDate: dbLastOut
                };

                if (dayId) {
                    payload.id = dayId;
                    updatedCountRef.val++;
                } else {
                    createdCountRef.val++;
                }

                dayPayloadsMap.set(employeeId, payload);
            }

            if (rowPunches.length > 0) {
                punchesToCreate.push({
                    employeeId: employeeId,
                    punches: rowPunches
                });
            }
        }
    }

    // Apply aggregated leave info and run leave calculations
    for (const [employeeId, payload] of dayPayloadsMap.entries()) {
        const leaveInfo = employeeLeaveInfoMap.get(employeeId);
        
        let leaveCategoryId = null;
        let leaveSession = null;
        let newDays = 0;
        let status = payload.status;
        let importedNote = payload.note;

        if (leaveInfo) {
            leaveCategoryId = leaveInfo.leaveCategoryId;
            leaveSession = leaveInfo.leaveSession;
            status = leaveInfo.status;
            importedNote = leaveInfo.importedNote;
            newDays = leaveInfo.newDays;

            payload.leave_category_id = leaveCategoryId;
            payload.leave_session = leaveSession;
            payload.status = status;
            payload.note = importedNote;
        }

        const employeeCachedData = employeeDataMap.get(employeeId);
        const existingDay = existingDaysMap.get(employeeId);
        let oldDays = 0;
        if (existingDay && existingDay.leave_category_id) {
             if (existingDay.status === 6 || existingDay.status === 0) oldDays = 1.0;
             else oldDays = 0.5;
        }

        if (leaveCategoryId) {
             const balKey = `${employeeId}_${leaveCategoryId}_${sheetYear}`;
             const diffUsage = newDays - ((existingDay && existingDay.leave_category_id === leaveCategoryId) ? oldDays : 0);
             if (diffUsage !== 0) {
                  leaveIncrementMap.set(balKey, (leaveIncrementMap.get(balKey) || 0) + diffUsage);
             }
        }
        if (existingDay && existingDay.leave_category_id && existingDay.leave_category_id !== leaveCategoryId) {
             const oldBalKey = `${employeeId}_${existingDay.leave_category_id}_${sheetYear}`;
             leaveIncrementMap.set(oldBalKey, (leaveIncrementMap.get(oldBalKey) || 0) - oldDays);
        }

        if (newDays > 0 && leaveCategoryId) {
            leaveRequestPayloads.push({
                employee_id: employeeId,
                leave_category_id: leaveCategoryId,
                start_date: attendanceDate,
                end_date: attendanceDate,
                total_days: newDays,
                reason: "Auto-generated from Daily Attendance Import",
                approval_status: constants.LEAVE_APPROVAL_STATUS.APPROVED,
                approved_by: mockStore.userId,
                company_id: mockStore.companyId,
                branch_id: employeeCachedData?.branch_id || mockStore.branchId,
                user_id: mockStore.userId,
                status: 0
            });
        }
    }

    dayPayloads = Array.from(dayPayloadsMap.values()).map(p => {
        delete p.dbFirstInDate;
        delete p.dbLastOutDate;
        return p;
    });

    // --- Optimization Part 2: Execute Batch Operations ---
    if (dayPayloads.length > 0) {
        await requestContext.run(mockStore, async () => {
            await AttendanceDay.bulkCreate(dayPayloads, {
                updateOnDuplicate: [
                    'status', 'worked_minutes', 'overtime_minutes', 'fine_amount', 
                    'overtime_data', 'fine_data', 'first_in', 'last_out', 'note',
                    'leave_category_id', 'leave_session', 'is_locked'
                ],
                transaction
            });
        });

        const allDaysInRange = await AttendanceDay.findAll({
            where: {
                employee_id: { [Op.in]: empIdList },
                attendance_date: attendanceDate
            },
            attributes: ['id', 'employee_id', 'attendance_date', 'branch_id'],
            transaction,
            raw: true
        });

        const finalDayIdMap = new Map();
        const dayBranchMap = new Map();
        allDaysInRange.forEach(d => {
            finalDayIdMap.set(d.employee_id, d.id);
            dayBranchMap.set(d.id, d.branch_id);
        });

        const allTouchedDayIds = Array.from(finalDayIdMap.values());
        if (allTouchedDayIds.length > 0) {
            await AttendancePunch.destroy({
                where: { day_id: { [Op.in]: allTouchedDayIds } },
                transaction
            });
        }

        const finalPunches = [];
        const seenPunchesKey = new Set();
        punchesToCreate.forEach(group => {
            const dId = finalDayIdMap.get(group.employeeId);
            if (dId) {
                group.punches.forEach(p => {
                    const punchTimeStr = p.time instanceof Date ? p.time.toISOString() : String(p.time);
                    const punchKey = `${group.employeeId}_${punchTimeStr}_${p.type}`;
                    if (!seenPunchesKey.has(punchKey)) {
                        seenPunchesKey.add(punchKey);
                        finalPunches.push({
                            employee_id: group.employeeId,
                            day_id: dId,
                            punch_time: p.time,
                            punch_type: p.type,
                            user_id: mockStore.userId,
                            company_id: mockStore.companyId,
                            branch_id: dayBranchMap.get(dId) || mockStore.branchId,
                            status: 0
                        });
                    }
                });
            }
        });

        if (finalPunches.length > 0) {
            await AttendancePunch.bulkCreate(finalPunches, { transaction });
        }
    }

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
    
    if (leaveRequestPayloads.length > 0) {
        await LeaveRequest.destroy({
            where: {
                employee_id: { [Op.in]: empIdList },
                start_date: attendanceDate,
                reason: "Auto-generated from Daily Attendance Import"
            },
            transaction
        });

        await LeaveRequest.bulkCreate(leaveRequestPayloads, { transaction });
    }

    // --- Auto-calculate worked hours, overtime, late entry using shift and templates ---
    for (const empId of empIdList) {
        const employeeCachedData = employeeDataMap.get(empId);
        await rebuildAttendanceDay(empId, attendanceDate, {
            user_id: mockStore.userId,
            company_id: mockStore.companyId,
            branch_id: employeeCachedData?.branch_id || mockStore.branchId,
            forceRebuild: true
        }, transaction);
    }

    // Bulk update all processed AttendanceDay records to is_locked: true to prevent device punch overwrites
    if (empIdList.length > 0) {
        await AttendanceDay.update({ is_locked: true }, {
            where: {
                employee_id: { [Op.in]: empIdList },
                attendance_date: attendanceDate
            },
            transaction
        });
    }

    await transaction.commit();

    parentPort.postMessage({
      status: "SUCCESS",
      result: {
        message: `Daily Attendance import completed. Created/Updated ${createdCountRef.val + updatedCountRef.val} attendance day records for target date ${attendanceDate}.`,
        count: createdCountRef.val,
        updated: updatedCountRef.val,
        skipped: errorCount,
        summary: { created: createdCountRef.val, updated: updatedCountRef.val, errors: errorCount },
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
