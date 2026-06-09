const { parentPort, workerData } = require("worker_threads");
const { sequelize, commonQuery, constants, formatDateTime } = require("../../../helpers");
const {
  Employee,
  BranchMaster,
  AttendanceDay,
  AttendancePunch,
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
const attendanceController = require("../../attendance/attendanceController");
const attendanceHelper = require("../../../helpers/attendanceHelper");

let isCancelled = false;
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

    const workbook = xlsx.readFile(filePath);
    
    let worksheet = null;
    let rawRows = [];
    let headerRowIndex = -1;
    let staffIdIdx = -1;
    let staffNameIdx = -1;
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
                    rawRows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
                    headerRowIndex = i;
                    staffIdIdx = sIdIdx;
                    
                    staffNameIdx = normalizedRow.findIndex(v => v === "staffname" || v === "name" || v === "employeename" || v === "empname");
                    
                    // Discover all IN and OUT columns dynamically and keep their left-to-right order
                    punchColumns = [];
                    for (let colIdx = 0; colIdx < row.length; colIdx++) {
                        const cellVal = row[colIdx];
                        if (cellVal) {
                            if (isInTimeHeader(cellVal)) {
                                punchColumns.push({ colIdx, label: cellVal, type: 'IN' });
                            } else if (isOutTimeHeader(cellVal)) {
                                punchColumns.push({ colIdx, label: cellVal, type: 'OUT' });
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
        return await commonQuery.findAllRecords(BranchMaster, branchWhere, { raw: true }, null, { company_id: true });
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
        attributes: ['id', 'employee_code', 'first_name', 'branch_id', 'shift_template', 'company_id'],
        raw: true
      }, null, { company_id: true });
    });

    const employeeCodeMap = new Map();
    const employeeNameMap = new Map();
    const employeeDataMap = new Map();
    employeesList.forEach(emp => {
      if (emp.employee_code) {
        const normCode = normalize(emp.employee_code);
        employeeCodeMap.set(normCode, emp.id);
      }
      if (emp.first_name) {
        const normName = normalize(emp.first_name);
        employeeNameMap.set(normName, emp.id);
      }
      employeeDataMap.set(emp.id, { branch_id: emp.branch_id, company_id: emp.company_id || mockStore.companyId, shift_template: emp.shift_template });
    });
    
    // --- Step 1: Pre-validate Employee Existence ---
    const seenCodes = new Set();
    const validationErrors = [];
    const codesInSheet = new Set();

    for (let i = headerRowIndex + 1; i < rawRows.length; i++) {
        const row = rawRows[i];
        if (!row) continue;
        const staffIdVal = String(row[staffIdIdx] || '').trim();
        const staffNameVal = staffNameIdx !== -1 ? String(row[staffNameIdx] || '').trim() : '';
        if (staffIdVal && staffIdVal.toLowerCase() !== 'total' && staffIdVal.toLowerCase() !== 'employee id' && staffIdVal.toLowerCase() !== 'staff id') {
            const normCode = normalize(staffIdVal);
            const normName = normalize(staffNameVal);
            
            if (!seenCodes.has(normCode)) {
                seenCodes.add(normCode);
                
                let employeeId = employeeCodeMap.get(normCode);
                if (!employeeId && normName) {
                    employeeId = employeeNameMap.get(normName);
                }

                if (!employeeId) {
                    validationErrors.push(`Row ${i + 1}: Employee code '${staffIdVal}' (Name: ${staffNameVal || 'N/A'}) does not exist in the system.`);
                } else {
                    codesInSheet.add(employeeId);
                }
            }
        }
    }

    if (validationErrors.length > 0) {
        parentPort.postMessage({
            status: "SUCCESS",
            result: {
                importErrors: true,
                message: "Import failed: Some employees in the Excel file do not exist in the system.",
                errors: validationErrors,
                errorCount: validationErrors.length
            }
        });
        return;
    }

    // --- Step 2: Process each row sequentially using updateAttendanceDay controller API logic ---
    let createdCount = 0;
    let updatedCount = 0;
    const rowErrors = [];

    for (let i = headerRowIndex + 1; i < rawRows.length; i++) {
        const row = rawRows[i];
        if (!row) continue;

        const staffIdVal = String(row[staffIdIdx] || '').trim();
        const staffNameVal = staffNameIdx !== -1 ? String(row[staffNameIdx] || '').trim() : '';
        if (staffIdVal && staffIdVal.toLowerCase() !== 'total' && staffIdVal.toLowerCase() !== 'employee id' && staffIdVal.toLowerCase() !== 'staff id') {
            const normCode = normalize(staffIdVal);
            const normName = normalize(staffNameVal);
            
            let employeeId = employeeCodeMap.get(normCode);
            if (!employeeId && normName) {
                employeeId = employeeNameMap.get(normName);
            }

            if (!employeeId) continue;

            const employeeCachedData = employeeDataMap.get(employeeId);

            try {
                // Extract punches from Excel columns in sequential (left-to-right) order
                const employeePunches = [];
                let lastParsedTime = null;
                let dayOffset = 0;

                punchColumns.forEach(col => {
                    const val = row[col.colIdx];
                    if (val && String(val).trim() !== '-' && String(val).trim() !== '') {
                        let time = parseTime(val, attendanceDate);
                        if (time) {
                            let currentDt = dayjs(time).add(dayOffset, 'day');
                            if (lastParsedTime) {
                                let lastDt = dayjs(lastParsedTime);
                                if (currentDt.isBefore(lastDt) && lastDt.diff(currentDt, 'minute') > 30) {
                                    // Midnight crossing detected (e.g. 06:00 PM followed by 12:28 AM)
                                    dayOffset += 1;
                                    currentDt = currentDt.add(1, 'day');
                                } else if (!currentDt.isAfter(lastDt)) {
                                    // Slight overlap or identical punch time: force sequence order by adding 1 second
                                    currentDt = lastDt.add(1, 'second');
                                }
                            }
                            time = currentDt.toDate();
                            lastParsedTime = time;

                            employeePunches.push({
                                id: null,
                                punch_type: col.type,
                                punch_time: dayjs(time).format("YYYY-MM-DD HH:mm:ss")
                            });
                        }
                    }
                });

                // Sort punches globally chronologically (guaranteed to match sequence due to monotonic sequence dates/seconds)
                const sortedRowPunches = employeePunches.sort((a, b) => dayjs(a.punch_time).valueOf() - dayjs(b.punch_time).valueOf());

                // Get first_in and last_out
                const firstIn = sortedRowPunches.find(p => p.punch_type === 'IN')?.punch_time || null;
                const lastOut = [...sortedRowPunches].reverse().find(p => p.punch_type === 'OUT')?.punch_time || null;

                // Check if employee is on approved leave
                const approvedLeave = await requestContext.run(mockStore, async () => {
                    return await commonQuery.findOneRecord(LeaveRequest, {
                        employee_id: employeeId,
                        request_type: 'DEBIT',
                        approval_status: constants.LEAVE_APPROVAL_STATUS.APPROVED,
                        start_date: { [Op.lte]: attendanceDate },
                        end_date: { [Op.gte]: attendanceDate },
                        is_encashment: false,
                        status: 0
                    }, {}, null, false, {});
                });

                // In the future, if you want punches to automatically cancel approved leaves, comment out this block:
                if (approvedLeave && sortedRowPunches.length > 0) {
                    throw new Error("Employee is on approved leave");
                }

                // If there are punches, update the attendance day via controller logic.
                if (sortedRowPunches.length > 0) {
                    const reqBody = {
                        attendance_date: attendanceDate,
                        branch_id: employeeCachedData?.branch_id || mockStore.branchId,
                        employee_id: employeeId,
                        first_in: firstIn,
                        last_out: lastOut,
                        punches: sortedRowPunches,
                        shift_id: employeeCachedData?.shift_template || null,
                        status: 0
                    };

                    console.log(`[DailyAttendanceImport] Row ${i + 1} - Mapped update-day API Payload:`, JSON.stringify(reqBody, null, 2));

                    const req = {
                        body: reqBody,
                        user: {
                            id: mockStore.userId,
                            company_id: employeeCachedData?.company_id || mockStore.companyId,
                            branch_id: employeeCachedData?.branch_id || mockStore.branchId,
                            access: "attendance"
                        },
                        ip: "127.0.0.1"
                    };

                    const res = {
                        json: (data) => {
                            if (data && data.success === false) {
                                throw new Error(data.message || JSON.stringify(data.errors || data.code));
                            }
                            return data;
                        },
                        status: function (code) {
                            return this;
                        },
                        success: function (code, data) {
                            return this.json({ success: true, code, data });
                        },
                        error: function (code, errors) {
                            return this.json({ success: false, code, errors });
                        },
                        ok: function (data) {
                            return this.json({ success: true, data });
                        }
                    };

                    await attendanceController.updateAttendanceDay(req, res);
                } else {
                    // Delete existing attendance day and its punches so the helper can recreate the correct record for holiday/leave/weekoff.
                    await requestContext.run(mockStore, async () => {
                        const existingDay = await commonQuery.findOneRecord(AttendanceDay, {
                            employee_id: employeeId,
                            attendance_date: attendanceDate
                        }, {}, null, false, {});

                        if (existingDay) {
                            await commonQuery.hardDeleteRecords(AttendancePunch, {
                                day_id: existingDay.id
                            }, null, {});

                            await commonQuery.hardDeleteRecords(AttendanceDay, {
                                id: existingDay.id
                            }, null, {});
                        }
                    });

                    await attendanceHelper.bulkSyncAttendanceDays([employeeId], attendanceDate, {
                        user_id: workerData.user_id,
                        company_id: employeeCachedData?.company_id || mockStore.companyId,
                        branch_id: employeeCachedData?.branch_id || mockStore.branchId
                    });
                }
                createdCount++; // Increment successful count

            } catch (err) {
                console.error(`Error processing row ${i + 1} for employee code ${staffIdVal}:`, err.message);
                rowErrors.push(`Row ${i + 1} - Employee ${staffIdVal} (${staffNameVal || 'N/A'}): ${err.message}`);
            }
        }
    }

    if (rowErrors.length > 0) {
        parentPort.postMessage({
            status: "SUCCESS",
            result: {
                importErrors: true,
                message: "Import failed: One or more punch/policy errors occurred during the import process.",
                errors: rowErrors,
                errorCount: rowErrors.length
            }
        });
        return;
    }

    parentPort.postMessage({
      status: "SUCCESS",
      result: {
        message: `Daily Attendance import completed. Created/Updated ${createdCount + updatedCount} attendance day records for target date ${attendanceDate}.`,
        count: createdCount,
        updated: updatedCount,
        skipped: 0,
        summary: { created: createdCount, updated: updatedCount, errors: 0 },
        errors: []
      }
    });

  } catch (error) {
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
