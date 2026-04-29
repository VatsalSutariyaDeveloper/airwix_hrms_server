const { Op } = require("sequelize");
const { AttendanceDay, AttendancePunch, Employee, AttendanceTemplate, HolidayTransaction, EmployeeShift, WeeklyOffTemplateDay, LeaveRequest, ShiftTemplate, EmployeeSalaryTemplate, EmployeeHoliday, EmployeeWeeklyOff, ShiftBreak, EmployeeAttendanceTemplate, LeaveTemplateCategory, WeeklyOffTemplate, OutDutyRequest, DeviceMaster, CanteenAttendance, CompanyMaster } = require("../models");
const commonQuery = require("./commonQuery");
const { Err } = require("./Err");
const dayjs = require("dayjs");
const { constants } = require("./constants");
const { calculateWorkingAndOffDays, getPunchAllowedWhere } = require("./functions/commonFunctions");
const { getCompanySetting } = require("./cache");
// LeaveBalanceService is required lazily inside functions to avoid circular dependencies with attendanceHelper
// const LeaveBalanceService = require("../services/leaveBalanceService");
const notificationService = require("../services/notificationService");

/**
 * Helper to parse time/datetime
 * If input is "2026-01-27 09:00:00", it uses that directly.
 * If input is "09:00:00", it prepends the provided baseDate.
 */
const parseDateTime = (timeStr, baseDate) => {
  if (!timeStr) return null;
  if (timeStr instanceof Date) return timeStr;

  // Check if it's already a full date-time string (contains '-' or 'T')
  if (typeof timeStr === 'string' && (timeStr.includes("-") || timeStr.includes("T") || timeStr.includes("/"))) {
    return dayjs(timeStr).toDate();
  }
  return dayjs(`${baseDate} ${timeStr}`).toDate();
};

/**
 * Find the best matching shift template for a given branch and time.
 * If multiple shifts exist in the branch, we find the one closest to the punch time.
 */
async function findMatchingShift(branchId, companyId, punchTime, transaction) {
    if (!branchId) return null;
    const shifts = await commonQuery.findAllRecords(ShiftTemplate, {
        branch_id: branchId,
        company_id: companyId,
        status: 0
    }, {}, transaction, {});

    if (!shifts || shifts.length === 0) return null;
    if (shifts.length === 1) {
        console.log(`[ShiftMatch] Found single shift: ${shifts[0].shift_name}`);
        return shifts[0];
    }

    const now = dayjs(punchTime);
    const todayStr = now.format("YYYY-MM-DD");
    let bestMatch = null;
    let minDiff = 24 * 60; // Max distance in minutes (24 hours)

    for (const shift of shifts) {
        // Normalize shift start time to today
        const start = dayjs(`${todayStr} ${shift.start_time}`);
        
        // Calculate distance for today, yesterday (night shifts), and tomorrow (just in case)
        const dToday = Math.abs(now.diff(start, 'minute'));
        const dYest = Math.abs(now.diff(start.subtract(1, 'day'), 'minute'));
        const dTomm = Math.abs(now.diff(start.add(1, 'day'), 'minute'));
        
        const minD = Math.min(dToday, dYest, dTomm);
        if (minD < minDiff) {
            minDiff = minD;
            bestMatch = shift;
        }
    }

    console.log(`[ShiftMatch] Multiple shifts found. Best match: ${bestMatch ? bestMatch.shift_name : 'NONE'}`);
    return bestMatch;
}

/**
 * Get or Create Attendance Day
 * Ensures robust finding/creating of the day record.
 */
async function getOrCreateAttendanceDay(employeeId, date, meta = {}, transaction = null) {
  // 0. Fetch employee to get correct company/branch if not provided in meta
  const employee = meta.employee || await commonQuery.findOneRecord(Employee, employeeId, {
    attributes: ['id', 'company_id', 'branch_id']
  }, transaction, false, {}); // Skip tenant check to fetch basic info if needed

  const allowedCompanyIds = meta.allowedCompanyIds || [meta.company_id || (employee ? employee.company_id : undefined)];
  const existingDay = await commonQuery.findOneRecord(AttendanceDay, {
    employee_id: employeeId,
    attendance_date: date,
    company_id: { [Op.in]: allowedCompanyIds.filter(id => id !== undefined) },
  }, {}, transaction, false, {});

  if (existingDay) {
    console.log(`[DayLookup] Found existing day record: ${existingDay.id} for date ${date}`);
    return existingDay;
  }

  const payload = {
    employee_id: employeeId,
    attendance_date: date,
    status: 5, // Default ABSENT
    user_id: meta.user_id || 0,
    company_id: meta.company_id || (employee ? employee.company_id : 0),
    branch_id: meta.branch_id || (employee ? employee.branch_id : 0),
  };

  console.log(`[DayLookup] Creating new day record for date ${date} with status 5...`);
  return await commonQuery.createRecord(AttendanceDay, payload, transaction);
}

async function punch(employeeId, meta, transaction = null) {
  const baseDate = dayjs().format("YYYY-MM-DD");
  const now = meta.punch_time ? parseDateTime(meta.punch_time, baseDate) : new Date();
  const today = dayjs(now).format("YYYY-MM-DD");
  let targetDayDate = today;

  // 1️⃣.0 Fetch Employee with Attendance Template (Needed for rules)
  const punchWhere = await getPunchAllowedWhere(meta.company_id, meta.branch_id);
  const employee = await commonQuery.findOneRecord(Employee, { id: employeeId, ...punchWhere }, {
    include: [
      { model: EmployeeAttendanceTemplate, where: { status: 0 }, as: "employeeAttendanceTemplate", required: false },
      { model: AttendanceTemplate, as: "attendanceTemplate", required: false }
    ],
  }, transaction, false, {});

  console.log(`[Punch] Employee Lookup Result:`, employee ? { id: employee.id, company_id: employee.company_id, branch_id: employee.branch_id } : 'NULL');

  if (!employee) throw new Error("Employee not found");

  // --- CROSS-COMPANY CONTEXT SWITCH ---
  // Store device info for auditing if needed.
  // [User Request] Store device company ID in records instead of employee home company.
  meta.device_company_id = meta.company_id; 
  // meta.company_id = employee.company_id; // STOP overwriting with employee company

  // Update: We'll use punchWhere.company_id for lookups across the allowed scope.
  // We must extract the raw IDs from the Sequelize [Op.in] object to avoid "[object Object]" errors in the SQL.
  let allowedCompanyIds = [];
  if (punchWhere.company_id) {
    if (typeof punchWhere.company_id === 'object' && punchWhere.company_id[Op.in]) {
      allowedCompanyIds = punchWhere.company_id[Op.in];
    } else if (Array.isArray(punchWhere.company_id)) {
      allowedCompanyIds = punchWhere.company_id;
    } else {
      allowedCompanyIds = [punchWhere.company_id];
    }
  }
  meta.allowedCompanyIds = allowedCompanyIds;

  console.log(`[Punch] Meta Branch ID: ${meta.branch_id} | Employee Home Branch: ${employee.branch_id}`);
  console.log(`[Punch] Allowed Companies:`, allowedCompanyIds);
  console.log(`[Punch] Employee Access Branches:`, employee.access_branches);

  // --- BRANCH ACCESS CHECK ---
  const settings = await getCompanySetting(meta.device_company_id);
  const company_punch_config = settings.company_punch_config === true || settings.company_punch_config === "true";
  const company_branch_punch_config = settings.company_branch_punch_config === true || settings.company_branch_punch_config === "true";

  if (company_punch_config) {
    // 🚀 ORGANIZATION WIDE: Check if device company belongs to the same organization
    const empCompany = await commonQuery.findOneRecord(CompanyMaster, { id: employee.company_id }, { attributes: ["organization_id"] }, null, false, {});
    const devCompany = await commonQuery.findOneRecord(CompanyMaster, { id: meta.device_company_id }, { attributes: ["organization_id"] }, null, false, {});

    if (!empCompany || !devCompany || empCompany.organization_id !== devCompany.organization_id) {
      console.log(`[Punch] Organization Mismatch: Emp Org ${empCompany?.organization_id}, Dev Org ${devCompany?.organization_id}`);
      throw new Error("Not allowed to punch in this organization");
    }
  } else if (company_branch_punch_config) {
    // 🚀 COMPANY WIDE: Must match company, but can be any branch
    if (parseInt(meta.device_company_id) !== parseInt(employee.company_id)) {
      console.log(`[Punch] Company Mismatch: Emp Co ${employee.company_id}, Dev Co ${meta.device_company_id}`);
      throw new Error("Not allowed to punch at this company");
    }
  } else {
    // 🚀 RESTRICTED: Must match company AND branch (if access_branches is set)
    if (parseInt(meta.device_company_id) !== parseInt(employee.company_id)) {
      throw new Error("Not allowed to punch at this company");
    }

    if (meta.branch_id && employee.access_branches && Array.isArray(employee.access_branches) && employee.access_branches.length > 0) {
      const allowedBranches = employee.access_branches.map(b => parseInt(b));
      if (!allowedBranches.includes(parseInt(meta.branch_id))) {
        console.log(`[Punch] Access Denied for branch ${meta.branch_id}`);
        throw new Error("Not allowed to punch at this branch");
      }
    } else if (meta.branch_id && employee.branch_id && parseInt(meta.branch_id) !== parseInt(employee.branch_id)) {
      console.log(`[Punch] Branch Mismatch: Emp Br ${employee.branch_id}, Dev Br ${meta.branch_id}`);
      throw new Error("Not allowed to punch at this branch");
    }
  }
  const template = employee.employeeAttendanceTemplate || employee.attendanceTemplate;
 
  // --- CANTEEN ATTENDANCE LOGIC ---
  let isCanteenPunch = false;
  if (meta.device_id) {
    const device = await commonQuery.findOneRecord(DeviceMaster, { id: meta.device_id }, {}, transaction, false, {});
    if (device && device.device_type === 1) { // 1: Canteen
      isCanteenPunch = true;
    }
  }

  // Also check if the user performing the sync/punch has canteen access
  if (meta.access === 'canteen') {
    isCanteenPunch = true;
  }

  if (isCanteenPunch) {
    // [User Request] Ensure only one canteen attendance per day
    const existingCanteen = await commonQuery.findOneRecord(CanteenAttendance, {
      employee_id: employeeId,
      date: targetDayDate,
      status: 0
    }, {}, transaction, false, {});

    if (existingCanteen) {
      throw new Err("Canteen attendance already marked for today");
    }

    await commonQuery.createRecord(CanteenAttendance, {
      employee_id: employeeId,
      date: targetDayDate,
      status: 0, // PRESENT
      company_id: meta.company_id || employee.company_id,
      branch_id: meta.branch_id || employee.branch_id,
      user_id: meta.user_id || 0,
      face_descriptor: meta.face_descriptor || null
    }, transaction);
    return { punchType: 'CanteenPunch', punchTime: now, punchId: 'N/A', targetDayDate };
  }

  console.log(`[Punch] Looking for last punch in company: ${meta.company_id || employee.company_id}`);
  console.log(`[Punch] Proceeding to lastPunchGlobal query...`);
  const lastPunchGlobal = await commonQuery.findOneRecord(AttendancePunch, {
    employee_id: employeeId,
    punch_time: { [Op.lt]: now }, // 🚀 Only look for punches BEFORE this one
    company_id: { [Op.in]: allowedCompanyIds }, // Search across allowed companies
    status: 0,
  }, {
    order: [["punch_time", "DESC"]],
  }, transaction, true, {});

  console.log(`[Punch] Last Punch Found:`, lastPunchGlobal ? { id: lastPunchGlobal.id, type: lastPunchGlobal.punch_type, time: lastPunchGlobal.punch_time } : 'NONE');

  let hoursSinceLast = 999;
  if (lastPunchGlobal) {
    hoursSinceLast = Math.abs(dayjs(now).diff(dayjs(lastPunchGlobal.punch_time), "hour", true));
  }

  // 1️⃣.2 Determine punch type (IN / OUT) dynamically
  let punchType = meta.punch_type;
  let lastInDay = null; // Store for date alignment
  if (!punchType) {
    if (lastPunchGlobal && lastPunchGlobal.punch_type === "IN") {
      // 🚀 Fetch the day record of the last IN to align the cutoff with the actual shift
      // [FIX] Search for the day record across all allowed companies to support cross-company pairing.
      lastInDay = await commonQuery.findOneRecord(AttendanceDay, {
        id: lastPunchGlobal.day_id,
        company_id: { [Op.in]: allowedCompanyIds }
      }, { attributes: ['id', 'attendance_date', 'shift_id'] }, transaction, false, {});
      // 🚀 Rule: Calculate cutoff based on the FIRST "IN" of this logical day
      const firstIn = await commonQuery.findOneRecord(AttendancePunch, {
        day_id: lastPunchGlobal.day_id,
        punch_type: "IN",
        status: 0
      }, { order: [["punch_time", "ASC"]] }, transaction, true, {});

      const startTime = firstIn ? firstIn.punch_time : lastPunchGlobal.punch_time;
      const lastInDate = dayjs(startTime).format("YYYY-MM-DD");
      const currentDate = dayjs(now).format("YYYY-MM-DD");

      let cutoffTime = dayjs(startTime).add(24, "hour");

      // ✅ If punch is on a different date and max_overtime_mins > 0, treat as new IN for the new date
      if (lastInDate !== currentDate && template && template.max_overtime_mins > 0) {
        punchType = "IN";
      } else {
        if (lastInDay && lastInDay.shift_id) {
          const lastShift = await commonQuery.findOneRecord(ShiftTemplate, lastInDay.shift_id, {
            attributes: ['id', 'start_time', 'end_time', 'is_night_shift']
          }, transaction, false, {});
          if (lastShift) {
            let shiftEnd = dayjs(`${lastInDay.attendance_date} ${lastShift.end_time}`);

            if (lastShift.is_night_shift || lastShift.end_time < lastShift.start_time) {
              shiftEnd = shiftEnd.add(1, 'day');
            }

            if (template && template.max_overtime_mins > 0) {
              const otCutoff = shiftEnd.add(template.max_overtime_mins, 'minute');
              if (dayjs(now).isBefore(otCutoff)) {
                cutoffTime = otCutoff;
              } else {
                cutoffTime = dayjs(startTime).add(24, "hour");
              }
            }
          }
        }

        // Toggle decision
        if (dayjs(now).isBefore(cutoffTime)) {
          punchType = "OUT";
          console.log(`[Punch] Toggle Decision: OUT (Before cutoff ${cutoffTime.format('HH:mm')})`);
        } else {
          punchType = "IN";
          console.log(`[Punch] Toggle Decision: IN (After cutoff ${cutoffTime.format('HH:mm')})`);
        }
      }
    } else {
      punchType = "IN";
      console.log(`[Punch] Defaulting to IN (No last punch or last was OUT)`);
    } 
  } 

  // 0️⃣.A Determine Target Day (For IN, it's 'today'. For OUT, it's the IN's day)
  targetDayDate = today;
  if (punchType === "OUT" && lastPunchGlobal) {
    if (!lastInDay) {
      lastInDay = await commonQuery.findOneRecord(AttendanceDay, {
        id: lastPunchGlobal.day_id,
        company_id: { [Op.in]: allowedCompanyIds }
      }, {}, transaction, false, {});
    }
    
    if (lastInDay) {
      targetDayDate = dayjs(lastInDay.attendance_date).format("YYYY-MM-DD");
    }
  }

  console.log(`[Result] Final Type: ${punchType} | Assigned Date: ${targetDayDate}`);
  console.log(`--- [DEBUG END] ---\n`);

  // 0️⃣.B Ensure AttendanceDay Exists (Required for day_id)
  const attendanceDay = await getOrCreateAttendanceDay(employeeId, targetDayDate, { ...meta, employee }, transaction);
  const dayId = attendanceDay.id;

  // 0️⃣.D Check if an active Approved Leave exists for this day
  const approvedLeave = await commonQuery.findOneRecord(LeaveRequest, {
    employee_id: employeeId,
    request_type: "DEBIT",
    approval_status: constants.LEAVE_APPROVAL_STATUS.APPROVED,
    start_date: { [Op.lte]: targetDayDate },
    end_date: { [Op.gte]: targetDayDate },
    is_encashment: false,
    status: 0
  }, {}, transaction, false, {});

  if (approvedLeave) {
    // Determine if it's a half-day leave (allow punches for half-day leaves)
    let isHalfDay = false;
    if (approvedLeave.start_date === targetDayDate && approvedLeave.start_session !== 0) {
      isHalfDay = true;
    } else if (approvedLeave.end_date === targetDayDate && approvedLeave.end_session !== 0) {
      isHalfDay = true;
    } else if (parseFloat(approvedLeave.total_days) < 1 && approvedLeave.start_date === approvedLeave.end_date) {
      isHalfDay = true;
    }

    if (!isHalfDay) {
      throw new Err(`You have an approved leave on this date. Please cancel the leave first before punching attendance.`);
    }
  }

  // 0️⃣.E Check for Approved Out Duty
  const approvedOutDuty = await commonQuery.findOneRecord(OutDutyRequest, {
    employee_id: employeeId,
    approval_status: constants.OUT_DUTY_STATUS.APPROVED,
    start_date: { [Op.lte]: targetDayDate },
    end_date: { [Op.gte]: targetDayDate },
    status: 0
  }, {}, transaction);

  let isHalfDayOutDuty = false;
  if (approvedOutDuty) {
    if (approvedOutDuty.start_date === targetDayDate && approvedOutDuty.start_session !== 0) {
      isHalfDayOutDuty = true;
    } else if (approvedOutDuty.end_date === targetDayDate && approvedOutDuty.end_session !== 0) {
      isHalfDayOutDuty = true;
    } else if (parseFloat(approvedOutDuty.total_days) < 1 && approvedOutDuty.start_date === approvedOutDuty.end_date) {
      isHalfDayOutDuty = true;
    }
  }

  // 1️⃣ Check Holiday & Weekly Off Policy
  const { isHoliday, isWeeklyOff } = await getDayOffInfo(employee, targetDayDate, transaction);
  if (template && template.holiday_policy === "BLOCK_ATTENDANCE") {
    if (isHoliday || isWeeklyOff) {
      throw new Err(`Attendance is blocked on ${isHoliday ? 'Holidays' : 'Weekly Offs'} (Strict Policy)`);
    }
  }

  // 1️⃣.2️⃣ MULTIPLE PUNCH RESTRICTION
  // [MOD] Bypass multiple punch restriction if there is an approved half-day out-duty request
  if (punchType === "IN" && template && !template.allow_multiple_punches && !isHalfDayOutDuty) {
    // Find the last IN (Globally)
    const lastIn = (lastPunchGlobal?.punch_type === "IN")
      ? lastPunchGlobal
      : await commonQuery.findOneRecord(AttendancePunch, {
        employee_id: employeeId, punch_type: "IN", status: 0
      }, { order: [["punch_time", "DESC"]] }, transaction, true, {});

    if (lastIn) {
      const hoursSinceLastIn = Math.abs(dayjs(now).diff(dayjs(lastIn.punch_time), "hour", true));
      if (hoursSinceLastIn < 24 && dayjs(lastIn.punch_time).format("YYYY-MM-DD") === targetDayDate) {
        const hasOut = await commonQuery.findOneRecord(AttendancePunch, {
          employee_id: employeeId, 
          punch_type: "OUT", 
          day_id: lastIn.day_id, 
          company_id: meta.company_id,
          status: 0
        }, {}, transaction, true, {});
        if (hasOut) {
          throw new Err("Already Punched");
        }
      }
    }
  }

  // 1️⃣.5️⃣ Fetch Shift
  const dayOfWeek = dayjs(targetDayDate).day();

  const empShift = await commonQuery.findOneRecord(EmployeeShift, {
    employee_id: employeeId,
    day_of_week: dayOfWeek,
    status: 0,
  }, {}, transaction);

  let shift = null;

  // Use explicitly provided shift id if available (e.g. from manual punch UI)
  if (meta.shift_id) {
    shift = await commonQuery.findOneRecord(ShiftTemplate, meta.shift_id, {}, transaction);
  }

  // Dynamic lookup ONLY if branch is selected AND it is different from employee's base branch
  if (!shift && meta.branch_id && parseInt(meta.branch_id) !== parseInt(employee.branch_id)) {
    shift = await findMatchingShift(meta.branch_id, meta.company_id || employee.company_id, now, transaction);
  }

  if (!shift) {
    if (empShift) {
      shift = await commonQuery.findOneRecord(ShiftTemplate, empShift.shift_id, {}, transaction);
    } else if (employee.shift_template) {
      shift = await commonQuery.findOneRecord(ShiftTemplate, employee.shift_template, {}, transaction);
    }
  }

  // Final validation for branch-specific shifts if missing
  // If the employee is punching in a branch that they don't have a specific shift for,
  // it will fall back to their system default shift (fetched above).

  // Store resolved shift_id in AttendanceDay if it matches the current day
  if (shift && attendanceDay && attendanceDay.shift_id !== shift.id) {
    await commonQuery.updateRecordById(AttendanceDay, dayId, { 
      shift_id: shift.id,
      branch_id: meta.branch_id || attendanceDay.branch_id  
    }, transaction, true, {});
    
    attendanceDay.shift_id = shift.id;
    attendanceDay.branch_id = meta.branch_id || attendanceDay.branch_id;
  }

  // 🛑 Removed BLOCK PUNCH check to allow punches without assigned shift (Treat as Overtime)


  if (shift) {
    const todayStr = dayjs(now).format("YYYY-MM-DD");
    // --- PUNCH IN RESTRICTION ---
    if (punchType === "IN" && (shift.punch_in === 1 || shift.punch_in === true)) {
      let earliestAllowed = null;

      if (shift.first_possible_punch_in) {
        earliestAllowed = dayjs(`${todayStr} ${shift.first_possible_punch_in}`);
        // Edge case: if first_possible is late at night for an early morning shift, it might need to be yesterday
        // But usually it's same day or relative to shift start.
      } else if (shift.punch_in_time) {
        const [h, m] = shift.punch_in_time.split(":");
        const limitMinutes = parseInt(h) * 60 + parseInt(m);
        earliestAllowed = dayjs(`${todayStr} ${shift.start_time}`).subtract(limitMinutes, "minute");
      }

      if (earliestAllowed && dayjs(now).isBefore(earliestAllowed)) {
        throw new Err(`Punch IN not allowed before ${earliestAllowed.format("hh:mm A")}`);
      }
    }

    // --- PUNCH OUT RESTRICTION ---
    if (punchType === "OUT" && (shift.punch_out === 1 || shift.punch_out === true)) {
      let latestAllowed = null;

      if (shift.last_possible_punch_out) {
        latestAllowed = dayjs(`${todayStr} ${shift.last_possible_punch_out}`);

        // Handle night shift/next day for absolute time
        let sEnd = dayjs(`${todayStr} ${shift.end_time}`);
        if (shift.is_night_shift || shift.end_time < shift.start_time) {
          sEnd = sEnd.add(1, "day");
        }

        // If last_possible is "08:00 AM" and shift end is "06:00 AM" (next day), 
        // they are likely on the same logical "next day".
        if (latestAllowed.isBefore(dayjs(`${todayStr} ${shift.start_time}`))) {
          latestAllowed = latestAllowed.add(1, "day");
        }
      } else if (shift.punch_out_time) {
        const [h, m] = shift.punch_out_time.split(":");
        const limitMinutes = parseInt(h) * 60 + parseInt(m);
        let sEnd = dayjs(`${todayStr} ${shift.end_time}`);
        if (shift.is_night_shift || shift.end_time < shift.start_time) {
          sEnd = sEnd.add(1, "day");
        }
        latestAllowed = sEnd.add(limitMinutes, "minute");
      }

      if (latestAllowed && dayjs(now).isAfter(latestAllowed)) {
        throw new Err(`Punch OUT not allowed after ${latestAllowed.format("hh:mm A")}`);
      }
    }
  }

  // 2️⃣ Determine punch type logic was already handled above to facilitate restriction check
  // So we skip the redundant search for lastPunch here

  // 5️⃣ Validation: Minimum 2 minutes gap between any consecutive punches
  if (lastPunchGlobal && !meta.bypassGapCheck) {
    const minutesSinceLastPunch = Math.abs(dayjs(now).diff(dayjs(lastPunchGlobal.punch_time), "minute", true));
    if (minutesSinceLastPunch < 2) {
      throw new Err("Please wait 2 minutes for next punch");
    }
  }

  // 4️⃣ Save raw punch
  // Remove id from meta to avoid conflicts with auto-increment and local IDs from offline sync
  const { id: _, ...cleanMeta } = meta;
  
  console.log(`[Punch] Creating AttendancePunch record...`);
  console.log(`[Punch] Payload for createRecord:`, {
    employee_id: employeeId,
    day_id: dayId,
    punch_type: punchType,
    punch_time: now,
    device_id: cleanMeta.device_id,
    company_id: cleanMeta.company_id,
    branch_id: cleanMeta.branch_id
  });

  const newPunch = await commonQuery.createRecord(AttendancePunch, {
    employee_id: employeeId,
    day_id: dayId,
    punch_type: punchType,
    punch_time: now,
    ...cleanMeta,
  }, transaction, {});

  // 4.1 Send Notification
  try {
    const { User: UserModel } = require("../models");
    const targetUser = await commonQuery.findOneRecord(UserModel, { employee_id: employeeId }, {}, transaction);
    
    if (targetUser) {
      await notificationService.createNotification({
        user_id: targetUser.id,
        title: punchType === "IN" ? "Punch In Success" : "Punch Out Success",
        message: `Successfully punched ${punchType.toLowerCase()} at ${dayjs(now).format('hh:mm A')}.`,
        type: "ATTENDANCE",
        reference_id: newPunch.id,
        status_code: 0,
        company_id: employee.company_id,
        branch_id: employee.branch_id
      }, transaction);
    }
  } catch (err) {
    console.error("Punch Notification Error:", err.message);
  }

  // 5️⃣ Recalculate day attendance
  if (!meta.skipRebuild) {
    await rebuildAttendanceDay(employeeId, targetDayDate, { ...meta, forceRebuild: true, shift_id: shift ? shift.id : null }, transaction);
  }

  return { punchType, punchTime: now, punchId: newPunch.id, targetDayDate };
}

async function rebuildAttendanceDay(employeeId, date, meta = {}, transaction = null) {
  const LeaveBalanceService = require("../services/leaveBalanceService");

  // 1. Fetch Employee and Templates early for configuration
  const employee = meta.employee || await commonQuery.findOneRecord(Employee, employeeId, {
    include: [
      { model: EmployeeAttendanceTemplate, where: { status: 0 }, as: "employeeAttendanceTemplate", required: false },
      { model: AttendanceTemplate, as: "attendanceTemplate", required: false }
    ],
  }, transaction, false, {});
  if (!employee) return;
  const template = employee.employeeAttendanceTemplate || employee.attendanceTemplate;

  const dayOfWeek = meta.dayOfWeek !== undefined ? meta.dayOfWeek : dayjs(date).day();
  const dayOfMonth = dayjs(date).date();
  const weekNo = meta.weekNo !== undefined ? meta.weekNo : Math.ceil(dayOfMonth / 7);

  // 2. Fetch assigned Shift early to determine unit wage divisors
  const empShift = (meta.preFetchedEmpShifts)
    ? meta.preFetchedEmpShifts.find(s => s.day_of_week === dayOfWeek)
    : await commonQuery.findOneRecord(EmployeeShift, {
      employee_id: employeeId,
      day_of_week: dayOfWeek,
      status: 0,
    }, {}, transaction, false, {});

  const shiftInclude = [{ model: ShiftBreak, as: "ShiftBreaks" }];
  let shift = null;

  const getShift = async (sId) => {
    if (meta.preFetchedShiftTemplates && meta.preFetchedShiftTemplates.has(sId)) {
      return meta.preFetchedShiftTemplates.get(sId);
    }
    return await commonQuery.findOneRecord(ShiftTemplate, sId, { include: shiftInclude }, transaction, false, {});
  };

  if (meta.shift_id) {
    shift = await getShift(meta.shift_id);
  }
  if (!shift && empShift) {
    if (empShift.shift_id) {
      shift = await getShift(empShift.shift_id);
    } else {
      shift = empShift; // Manual shift in EmployeeShift
    }
  }
  if (!shift && employee.shift_template) {
    shift = await getShift(employee.shift_template);
  }

  // Determine working hours divisor (from Shift or default 8)
  let unitWorkingHours = 8;
  if (shift) {
    if (parseFloat(shift.total_payable_hours) > 0) {
      unitWorkingHours = parseFloat(shift.total_payable_hours) / 60;
    } else if (shift.min_full_day_minutes > 0) {
      unitWorkingHours = shift.min_full_day_minutes / 60;
    }
  }

  // 3. --- Fetch Wages for Rate Calculation (OT, Fines, etc.) ---
  let hourlyWage = 0;
  let dailyWage = 0;
  let ctcMonthly = 0;
  let monthDays = 30;

  const employeeSalaryTemplate = await commonQuery.findOneRecord(
    EmployeeSalaryTemplate,
    {
      employee_id: employeeId,
      status: 0,
    },
    { attributes: ['ctc_monthly', 'lwp_calculation_basis', 'salary_type', 'daily_rate', 'hourly_rate'] },
    transaction, false, {}
  );

  if (employeeSalaryTemplate) {
    const salaryType = employeeSalaryTemplate.salary_type || "Monthly";
    ctcMonthly = parseFloat(employeeSalaryTemplate.ctc_monthly || 0);

    if (salaryType === "Daily") {
      dailyWage = parseFloat(employeeSalaryTemplate.daily_rate || 0);
      hourlyWage = dailyWage / unitWorkingHours;
    } else if (salaryType === "Hourly") {
      hourlyWage = parseFloat(employeeSalaryTemplate.hourly_rate || 0);
      dailyWage = hourlyWage * unitWorkingHours;
    } else {
      // Monthly (Default)
      if (employeeSalaryTemplate.lwp_calculation_basis === 'DAYS_IN_MONTH') {
        const d = dayjs(date);
        monthDays = d.daysInMonth();
      } else if (employeeSalaryTemplate.lwp_calculation_basis === 'WORKING_DAYS') {
        // [MOD] Calculate real working days using the same logic as employeeController
        if (employee.weekly_off_template) {
          const weeklyOffTemplate = await commonQuery.findOneRecord(
            WeeklyOffTemplate,
            employee.weekly_off_template,
            { include: [{ model: WeeklyOffTemplateDay, as: "days" }] },
            transaction, false, {}
          );

          if (weeklyOffTemplate) {
            const result = calculateWorkingAndOffDays(weeklyOffTemplate.days, new Date(date));
            monthDays = result.working_days;
          }
        }
        if (!monthDays || monthDays <= 0) monthDays = 26;
      } else if (employeeSalaryTemplate.lwp_calculation_basis === 'FIXED_30_DAYS') {
        monthDays = 30;
      }

      if (monthDays > 0) {
        dailyWage = ctcMonthly / monthDays;
        hourlyWage = dailyWage / unitWorkingHours;
      }
    }
  }

  // Helper to map multiplier to ID
  const getRateIdAndAmount = (type, value, minutes, dailyWage, hourlyWage) => {
    let amount = 0;
    let rateId = 5; // Default 1x Salary
    let forcedStatus = null;
    let rate = 0; // Per Hour or Per Day amount

    const t = (type !== undefined && type !== null) ? String(type) : '5';
    const v = parseFloat(value || 0);

    const hw = parseFloat(hourlyWage || 0);
    const dw = parseFloat(dailyWage || 0);
    const mins = parseFloat(minutes || 0);

    if (t === '1' || t === 'FIXED' || t === 'FIXED_AMOUNT') {
      amount = v;
      rateId = 1;
      rate = v;
    } else if (t === '2' || t === 'FIXED_PER_HOUR') {
      amount = (mins / 60) * v;
      rateId = 2;
      rate = v;
    } else if (t === '3' || t === 'HALF_DAY') {
      amount = dw * 0.5;
      rateId = 3;
      rate = dw * 0.5;
      forcedStatus = 1;
    } else if (t === '4' || t === 'FULL_DAY') {
      amount = dw;
      rateId = 4;
      rate = dw;
      forcedStatus = 5; // Absent
    } else if (t === '5' || t === '1X_SALARY') {
      amount = (mins / 60) * hw * 1;
      rateId = 5;
      rate = hw * 1;
    } else if (t === '6' || t === '1_5X_SALARY') {
      amount = (mins / 60) * hw * 1.5;
      rateId = 6;
      rate = hw * 1.5;
    } else if (t === '7' || t === '2X_SALARY') {
      amount = (mins / 60) * hw * 2.0;
      rateId = 7;
      rate = hw * 2.0;
    } else if (t === '8' || t === '3X_SALARY') {
      amount = (mins / 60) * hw * 3.0;
      rateId = 8;
      rate = hw * 3.0;
    } else {
      // Fallback for custom multipliers or legacy strings
      const multiplier = !isNaN(parseFloat(t)) ? parseFloat(t) : v;
      amount = (mins / 60) * hw * (multiplier || 1);
      rate = hw * (multiplier || 1);
      if (multiplier === 1) rateId = 5;
      else if (multiplier === 1.5) rateId = 6;
      else if (multiplier === 2) rateId = 7;
      else if (multiplier === 3) rateId = 8;
      else rateId = 2;
    }

    return {
      amount: parseFloat(amount.toFixed(2)),
      rate: parseFloat(rate.toFixed(2)),
      rateId,
      forcedStatus
    };
  };

  const getMatchingRule = (mins, rules) => {
    if (!rules || !Array.isArray(rules)) return null;
    return rules.find(r => mins >= r.from_mins && mins <= r.to_mins);
  };

  const allowedCompanyIds = meta.allowedCompanyIds || [meta.company_id || (employee ? employee.company_id : undefined)];
  const cleanAllowedCompanyIds = allowedCompanyIds.filter(id => id !== undefined);

  // 4. --- Attendance Processing Logic ---
  if (meta.onlyCreateNonWorking && meta.skipIfPunchesExist) {
    const exists = await AttendanceDay.count({ 
      where: { 
        employee_id: employeeId, 
        attendance_date: date, 
        company_id: { [Op.in]: cleanAllowedCompanyIds },
        status: { [Op.ne]: 2 } 
      }, 
      transaction 
    });
    if (exists > 0) return;
  }

  // 0️⃣.A Check if record is locked
  const existingDay = meta.existingDay || await commonQuery.findOneRecord(AttendanceDay, {
    employee_id: employeeId,
    attendance_date: date,
    company_id: { [Op.in]: cleanAllowedCompanyIds },
  }, {}, transaction, false, {});

  if (existingDay && existingDay.is_locked) {
    console.log(`[Attendance] Day ${date} for emp ${employeeId} is locked. Skipping rebuild.`);
    return;
  }

  // Find all punches
  const allDayPunches = meta.preFetchedPunches || await commonQuery.findAllRecords(AttendancePunch, {
    employee_id: employeeId,
    [Op.or]: [
      existingDay ? { day_id: existingDay.id } : null,
      {
        day_id: null,
        company_id: { [Op.in]: allowedCompanyIds.filter(id => id !== undefined) },
        punch_time: {
          [Op.between]: [`${date} 00:00:00`, `${date} 23:59:59`],
        }
      }
    ].filter(Boolean),
    company_id: { [Op.in]: allowedCompanyIds.filter(id => id !== undefined) },
    status: 0,
  }, {
    order: [["punch_time", "ASC"]],
  }, transaction, {});

  const inPunches = allDayPunches.filter(p => p.punch_type === "IN");
  const hasPunches = allDayPunches.length > 0;

  const approvedLeave = (meta.preFetchedLeave !== undefined) ? meta.preFetchedLeave : await commonQuery.findOneRecord(LeaveRequest, {
    employee_id: employeeId,
    approval_status: constants.LEAVE_APPROVAL_STATUS.APPROVED,
    start_date: { [Op.lte]: date },
    end_date: { [Op.gte]: date },
    is_encashment: false,
    status: 0
  }, {}, transaction, false, {});

  const approvedOutDuty = (meta.preFetchedOutDuty !== undefined) ? meta.preFetchedOutDuty : await commonQuery.findOneRecord(OutDutyRequest, {
    employee_id: employeeId,
    approval_status: constants.OUT_DUTY_STATUS.APPROVED,
    start_date: { [Op.lte]: date },
    end_date: { [Op.gte]: date },
    status: 0
  }, {}, transaction, false, {});

  // --- OUT DUTY PROCESSING ---
  let isOutDutyHalfDay = false;
  let isOutDutyFullDay = false;

  if (approvedOutDuty) {
    if (approvedOutDuty.start_date === date && approvedOutDuty.start_session !== 0) {
      isOutDutyHalfDay = true;
    } else if (approvedOutDuty.end_date === date && approvedOutDuty.end_session !== 0) {
      isOutDutyHalfDay = true;
    } else if (parseFloat(approvedOutDuty.total_days) < 1 && approvedOutDuty.start_date === approvedOutDuty.end_date) {
      isOutDutyHalfDay = true;
    } else {
      isOutDutyFullDay = true;
    }

    if (!hasPunches) {
      const odPayload = {
        employee_id: employeeId,
        attendance_date: date,
        status: isOutDutyHalfDay ? 13 : 12, // 13: HALF_OUT_DUTY, 12: OUT_DUTY
        shift_id: null,
        user_id: meta.user_id || 0,
        branch_id: meta.branch_id || employee.branch_id,
        company_id: meta.company_id || employee.company_id,
        note: ""
      };

      const existingDayRecord = await commonQuery.findOneRecord(AttendanceDay, {
          employee_id: employeeId,
          attendance_date: date,
      }, {}, transaction, false, {});

      if (existingDayRecord) {
          await commonQuery.updateRecordById(AttendanceDay, existingDayRecord.id, odPayload, transaction, false, {});
      } else {
        await commonQuery.createRecord(AttendanceDay, odPayload, transaction);
      }
      return;
    } else {
      // If they have punches while out duty
      if (isOutDutyFullDay) {
        meta.forcedStatus = 12; // OUT_DUTY
        meta.skipFineCalculation = true;
        meta.skipOvertimeCalculation = true;
      } else {
        meta.forcedStatus = 13; // HALF_OUT_DUTY
        // For half day out duty, we WANT to calculate fine and OT
        meta.skipFineCalculation = false;
        meta.skipOvertimeCalculation = false;
      }
    }
  }

  // --- LEAVE PROCESSING ---
  if (approvedLeave) {
    const category = await commonQuery.findOneRecord(LeaveTemplateCategory, approvedLeave.leave_category_id, {}, transaction, false, {});
    const rules = (category && category.automation_rules) ? JSON.parse(category.automation_rules) : {};

    // Determine if today is a half day based on sessions
    let isHalfDay = false;
    let currentSession = 0;
    if (approvedLeave.start_date === date && approvedLeave.start_session !== 0) {
      isHalfDay = true;
      currentSession = approvedLeave.start_session;
    } else if (approvedLeave.end_date === date && approvedLeave.end_session !== 0) {
      isHalfDay = true;
      currentSession = approvedLeave.end_session;
    } else if (parseFloat(approvedLeave.total_days) < 1 && approvedLeave.start_date === approvedLeave.end_date) {
      isHalfDay = true;
      currentSession = 1; // Default to Session 1 if unknown but < 1 day
    }

    // Auto Attendance Status Mapping
    let finalStatus = isHalfDay ? 1 : 6; // 1: Half Day, 6: Leave
    const overrideStatus = rules.auto_attendance_status;
    if (overrideStatus && overrideStatus !== 'default') {
      finalStatus = parseInt(overrideStatus);
    }

    // Store session in meta for shift adjustment later
    if (isHalfDay) {
        meta.leave_is_half_day = true;
        meta.leave_session = currentSession;
    }


    const isSpecialStatus = overrideStatus !== undefined && overrideStatus !== null && overrideStatus !== 'default';
    const isWorkingForced = meta.forcedStatus !== undefined && [0, 1, 12, 13].includes(Number(meta.forcedStatus));

    if ((hasPunches || isWorkingForced) && !isSpecialStatus) {
      if (isHalfDay) {
        // [MOD] If worked on a half-day leave day, preserve the leave (Status 1: Half Day) 
        // and do not cancel the leave request.
        meta.forcedStatus = 1; 
        meta.leave_category_id = approvedLeave.leave_category_id;
        meta.leave_session = (approvedLeave.start_date === date) ? approvedLeave.start_session : approvedLeave.end_session;
        // meta.overrideAutomationNote = "System: Half-Day attendance on half-day leave";
      } else {
        // Standard (Full Day): Refund/Cancel leave if employee punches in OR is manually marked as Present
        // syncLeaveRecord now handles both auto-generated and manual (single/multi-day) requests centrally.
        await LeaveBalanceService.syncLeaveRecord(employeeId, date, approvedLeave.leave_category_id, 0, transaction);
      }
    } else if (isSpecialStatus && (hasPunches || isWorkingForced)) {
      // Rule Triggered: Force status but CONTINUE to calculate worked hours
      meta.forcedStatus = finalStatus;
      meta.leave_category_id = approvedLeave.leave_category_id;
      meta.leave_session = approvedLeave.leave_session;
      // meta.overrideAutomationNote = `System: Marked via ${category.leave_category_name}`;
    } else if (!hasPunches && !isWorkingForced) {
      // Apply Leave or Custom Attendance Status (No Punches and No manual override)
      const leavePayload = {
        employee_id: employeeId,
        attendance_date: date,
        status: finalStatus,
        shift_id: null,
        leave_category_id: approvedLeave.leave_category_id,
        leave_session: approvedLeave.leave_session,
        user_id: meta.user_id || 0,
        branch_id: meta.branch_id || employee.branch_id,
        company_id: meta.company_id || employee.company_id,
        note: ""
        // note: isSpecialStatus ? `System: Marked via ${category.leave_category_name}` : null
      };

      const existingDayRecord = await commonQuery.findOneRecord(AttendanceDay, {
        employee_id: employeeId,
        attendance_date: date,
      }, {}, transaction, false, {});

      if (existingDayRecord) {
        await syncAttendanceToLeaveBalance(employeeId, existingDayRecord, leavePayload, transaction);
        await commonQuery.updateRecordById(AttendanceDay, existingDayRecord.id, leavePayload, transaction, false, {});
      } else {
        await syncAttendanceToLeaveBalance(employeeId, null, leavePayload, transaction);
        await commonQuery.createRecord(AttendanceDay, leavePayload, transaction);
      }
      return;
    }
  }

  // 1️⃣ Check if it's a Holiday
  let isHoliday = false;
  let holidayDetails = (meta.preFetchedHoliday !== undefined) ? meta.preFetchedHoliday : null;

  if (holidayDetails === null && employee.holiday_template && !meta.preFetchedHoliday) {
    holidayDetails = await commonQuery.findOneRecord(HolidayTransaction, {
      template_id: employee.holiday_template,
      date: date,
      status: 0,
    }, {}, transaction, false, {});
  }
  if (holidayDetails) isHoliday = true;

  // 2️⃣ Check if it's a Weekly Off
  let isWeeklyOff = false;
  if (meta.preFetchedWeeklyOffs) {
    const weeklyOff = meta.preFetchedWeeklyOffs.find(wo =>
      wo.day_of_week === dayOfWeek &&
      (wo.week_no === 0 || wo.week_no === weekNo) &&
      wo.is_off
    );
    if (weeklyOff) isWeeklyOff = true;
  } else if (employee.weekly_off_template) {
    const weeklyOff = await commonQuery.findOneRecord(WeeklyOffTemplateDay, {
      template_id: employee.weekly_off_template,
      day_of_week: dayOfWeek,
      [Op.or]: [{ week_no: 0 }, { week_no: weekNo }],
      is_off: true,
      status: 0,
    }, {}, transaction, false, {});
    if (weeklyOff) isWeeklyOff = true;
  }

  console.log(`[Rebuild] Pairing punches for logical day ${date}. Multiple Punches: ${template?.allow_multiple_punches}`);
  let punches = [];
  if (template && !template.allow_multiple_punches && inPunches.length > 0) {
    // Only FIRST in and LAST out
    const firstIn = inPunches[0];
    punches.push(firstIn);

    // Find last out from the pre-fetched list
    const lastOut = [...allDayPunches].reverse().find(p =>
      p.punch_type === "OUT" &&
      dayjs(p.punch_time).isAfter(dayjs(firstIn.punch_time))
    );
    if (lastOut) punches.push(lastOut);
  } else {
  // Process pairs of IN-OUT from the pre-fetched list (Robust Pairing)
  let inP = null;
  for (let i = 0; i < allDayPunches.length; i++) {
    const p = allDayPunches[i];
    const pType = String(p.punch_type || "").toUpperCase();
    if (pType === "IN") {
      inP = p; // Start/Restart a block with the latest IN
    } else if (pType === "OUT" && inP) {
      punches.push(inP);
      punches.push(p);
      inP = null; // Block completed
    }
  }
  // If an IN is left without an OUT, it might be an open shift.
  // We add it anyway so 'Incomplete' or 'Currently Working' logic works later.
  if (inP) {
    punches.push(inP);
  }
}
  console.log(`[Rebuild] Paired Punches:`, punches.map(p => `${p.punch_type}@${dayjs(p.punch_time).format('HH:mm')}`));

  // Ensure unique and sorted
  punches = punches.filter((v, i, a) => a.findIndex(t => t.id === v.id) === i)
    .sort((a, b) => dayjs(a.punch_time).valueOf() - dayjs(b.punch_time).valueOf());

  // Handle No Punches Case
  if (punches.length === 0) {
    let emptyStatus = null;
    if (isWeeklyOff) emptyStatus = 3;
    else if (isHoliday) emptyStatus = 4;

    const existingDay = await commonQuery.findOneRecord(AttendanceDay, {
      employee_id: employeeId,
      attendance_date: date,
    }, { attributes: ['id', 'status', 'worked_minutes', 'fine_minutes', 'overtime_minutes', 'total_break_minutes', 'overtime_amount', 'fine_amount', 'overtime_data', 'fine_data', 'first_in', 'last_out', 'leave_category_id', 'leave_session', 'note'] }, transaction, false, {});

    // [FIX] Priority for status: forcedStatus > manualStatus (from existingDay) > defaults
    // This ensures manual overrides from the controller are respected during rebuild.
    if (meta.forcedStatus !== undefined && meta.forcedStatus !== null) {
      emptyStatus = Number(meta.forcedStatus);
    } else if (existingDay) {
      emptyStatus = existingDay.status;
    }

    // Auto-absent policy check
    if (emptyStatus === null) {
      if (template?.auto_mark_absent) {
        const buffer = parseInt(template.auto_absent_buffer_days || 0);
        const markDate = dayjs(date).startOf('day');
        const today = dayjs().startOf('day');
        const now = dayjs();

        if (markDate.isBefore(today.subtract(buffer, 'day'))) {
          emptyStatus = 5;
        } else if (shift && shift.end_time) {
          let shiftEnd = dayjs(`${date} ${shift.end_time}`);
          if (shift.is_night_shift || shift.end_time < shift.start_time) {
            shiftEnd = shiftEnd.add(1, "day");
          }
          if (now.isAfter(shiftEnd)) {
            emptyStatus = 5;
          }
        }
      }
    }

    if (emptyStatus === null) {
      // If no status determined and no punches, this day is "Not Marked".
      // If a record exists, we remove it to keep it "unmarked".
      if (existingDay) {
        console.log(`[Rebuild] No status and no punches. Deleting existing day record ${existingDay.id}`);
        await commonQuery.hardDeleteRecords(AttendanceDay, existingDay.id, transaction);
      }
      return;
    }

    // [MOD] If onlyCreateNonWorking is set, skip creating status 5 (ABSENT)
    if (meta.onlyCreateNonWorking && emptyStatus === 5) {
      return;
    }

    // [MOD] Calculate worked minutes for Track In/Out OFF case or preserve existing
    let finalNoPunchMinutes = 0;
    if (template && !template.track_in_out && [0, 1, 12, 13].includes(emptyStatus)) {
      if (emptyStatus === 0 || emptyStatus === 12) finalNoPunchMinutes = shift?.min_full_day_minutes || 480;
      else if (emptyStatus === 1 || emptyStatus === 13) finalNoPunchMinutes = shift?.min_half_day_minutes || 240;
    } else if (existingDay && existingDay.status === emptyStatus) {
      finalNoPunchMinutes = existingDay.worked_minutes || 0;
    }

    const payload = {
      employee_id: employeeId,
      attendance_date: date,
      status: emptyStatus,
      shift_id: (isWeeklyOff || isHoliday) ? null : (shift ? shift.id : null),
      user_id: meta.user_id || 0,
      branch_id: meta.branch_id || employee.branch_id,
      company_id: meta.company_id || employee.company_id,
      first_in: existingDay?.first_in || null,
      last_out: existingDay?.last_out || null,
      worked_minutes: finalNoPunchMinutes,
      overtime_minutes: (existingDay && existingDay.status === emptyStatus) ? (existingDay.overtime_minutes || 0) : 0,
      fine_minutes: (existingDay && existingDay.status === emptyStatus) ? (existingDay.fine_minutes || 0) : 0,
      total_break_minutes: (existingDay && existingDay.status === emptyStatus) ? (existingDay.total_break_minutes || 0) : 0,
      overtime_amount: (existingDay && existingDay.status === emptyStatus) ? (existingDay.overtime_amount || 0) : 0,
      fine_amount: (existingDay && existingDay.status === emptyStatus) ? (existingDay.fine_amount || 0) : 0,
      overtime_data: (existingDay && existingDay.status === emptyStatus) ? (existingDay.overtime_data || null) : null,
      fine_data: (existingDay && existingDay.status === emptyStatus) ? (existingDay.fine_data || null) : null,
      leave_category_id: null,
      leave_session: null,
      note: "",
      // note: emptyStatus === 4 ? `System: Holiday restored (${holidayDetails?.name || dayjs(date).format('dddd')})` : (emptyStatus === 3 ? `System: Weekly Off restored (${dayjs(date).format('dddd')})` : (existingDay?.note || null))
      // note: (function (note, emptyStatus) {
      //   // If we are now PRESENT/HALF_DAY, ignore negative auto reasons (e.g. from downgrade prevention)
      //   if ([0, 1, 12, 13].includes(emptyStatus) && note) {
      //     if (typeof note === 'string' && (note.startsWith("System:") || note.startsWith("Auto Absent:") || note.startsWith("Incomplete:"))) {
      //       note = null;
      //     }
      //   }
      //   return note;
      // })(existingDay?.note, emptyStatus)
    };

    if (existingDay) {
      // If manually adjusting status, incorporate the category/session from meta or preserve existing
      if ([1, 6].includes(emptyStatus)) {
        payload.leave_category_id = meta.leave_category_id || existingDay.leave_category_id;
        payload.leave_session = meta.leave_session || existingDay.leave_session;
      }

      await syncAttendanceToLeaveBalance(employeeId, existingDay, payload, transaction);
      await commonQuery.updateRecordById(AttendanceDay, existingDay.id, payload, transaction, false, { company_id: true });
    } else {
      // For NEW records, if status is 1 or 6, take category from meta
      if ([1, 6].includes(emptyStatus)) {
        payload.leave_category_id = meta.leave_category_id;
        payload.leave_session = meta.leave_session;
      }
      await syncAttendanceToLeaveBalance(employeeId, null, payload, transaction);
      await commonQuery.createRecord(AttendanceDay, payload, transaction);
    }
    return;
  }

  // --- REFACTORED WORKED TIME & BREAK CALCULATION ---
  const firstIn = allDayPunches.find(p => String(p.punch_type || "").toUpperCase() === "IN");
  const lastOut = [...allDayPunches].reverse().find(p => String(p.punch_type || "").toUpperCase() === "OUT");

  let shiftWorkedMins = 0;
  let earlyOTMins = 0;
  let lateOTMins = 0;
  let totalBreakMinutes = 0;
  let actualGapsMins = 0;
  let scheduledBreaksMins = 0;

  let shiftStart = null;
  let shiftEnd = null;

  if (shift) {
    shiftStart = dayjs(`${date} ${shift.start_time}`);
    shiftEnd = dayjs(`${date} ${shift.end_time}`);
    if (shift.is_night_shift || shift.end_time < shift.start_time) shiftEnd = shiftEnd.add(1, "day");

    // [User Request] Handle Half-Day Sessions (Shift adjustment for Leaves)
    if (meta.leave_is_half_day && meta.leave_session) {
      const duration = shiftEnd.diff(shiftStart, 'minute');
      const halfDuration = Math.round(duration / 2);

      if (meta.leave_session == 1) { // Session 1 Leave (First Half) -> Expected Work is Second Half
        shiftStart = shiftStart.add(halfDuration, 'minute');
        console.log(`[Rebuild] Adjusting shift for Session 1 Leave. New Start: ${shiftStart.format('HH:mm')}`);
      } else if (meta.leave_session == 2) { // Session 2 Leave (Second Half) -> Expected Work is First Half
        shiftEnd = shiftEnd.subtract(halfDuration, 'minute');
        console.log(`[Rebuild] Adjusting shift for Session 2 Leave. New End: ${shiftEnd.format('HH:mm')}`);
      }
    }

    // Also handle Out Duty Sessions if it's a half-day
    if (isOutDutyHalfDay && approvedOutDuty) {
      const odSession = (approvedOutDuty.start_date === date) ? approvedOutDuty.start_session : approvedOutDuty.end_session;
      const duration = shiftEnd.diff(shiftStart, 'minute');
      const halfDuration = Math.round(duration / 2);

      if (odSession == 1) { // Session 1 Out Duty -> Expected Work (in office) is Second Half
        shiftStart = shiftStart.add(halfDuration, 'minute');
        console.log(`[Rebuild] Adjusting shift for Session 1 Out Duty. New Start: ${shiftStart.format('HH:mm')}`);
      } else if (odSession == 2) { // Session 2 Out Duty -> Expected Work (in office) is First Half
        shiftEnd = shiftEnd.subtract(halfDuration, 'minute');
        console.log(`[Rebuild] Adjusting shift for Session 2 Out Duty. New End: ${shiftEnd.format('HH:mm')}`);
      }
    }
  }

  // 1. Calculate Gross Minutes in each region (Shift, Early OT, Late OT)
  for (let i = 0; i < punches.length - 1; i++) {
    if (String(punches[i].punch_type || "").toUpperCase() === "IN" && String(punches[i + 1].punch_type || "").toUpperCase() === "OUT") {
      const pS = dayjs(punches[i].punch_time);
      const pE = dayjs(punches[i + 1].punch_time);

      if (shift) {
        if ((meta.isHoliday || meta.isWeeklyOff) && !meta.isHolidayCompOff) {
          // When it's a holiday or weekly off (ALLOW_NORMAL + BLOCK), all work time should be treated as overtime
          const sessionMinutes = pE.diff(pS, "minute");
          lateOTMins += sessionMinutes;
        } else {
          // Normal shift logic (used for COMP_OFF holidays and regular days)
          // Shift Part
          const sOverlapStart = dayjs(Math.max(pS.valueOf(), shiftStart.valueOf()));
          const sOverlapEnd = dayjs(Math.min(pE.valueOf(), shiftEnd.valueOf()));
          if (sOverlapEnd.isAfter(sOverlapStart)) {
            shiftWorkedMins += sOverlapEnd.diff(sOverlapStart, "minute");
          }

          // Early OT Part (Before Shift Start)
          if (pS.isBefore(shiftStart)) {
            const eOverlapEnd = dayjs(Math.min(pE.valueOf(), shiftStart.valueOf()));
            if (eOverlapEnd.isAfter(pS)) {
              earlyOTMins += eOverlapEnd.diff(pS, "minute");
            }
          }

          // Late OT Part (After Shift End)
          if (pE.isAfter(shiftEnd)) {
            const lOverlapStart = dayjs(Math.max(pS.valueOf(), shiftEnd.valueOf()));
            if (pE.isAfter(lOverlapStart)) {
              const lateOvertimeMins = pE.diff(lOverlapStart, "minute");
              lateOTMins += lateOvertimeMins;
            }
          }
        }
      } else {
        // No Shift - All work time should be stored as overtime
        const sessionMinutes = pE.diff(pS, "minute");
        if ((meta.isHoliday || meta.isWeeklyOff) && !meta.isHolidayCompOff) {
          // When it's a holiday or weekly off (ALLOW_NORMAL + BLOCK), all work time goes to overtime
          lateOTMins += sessionMinutes;
        } else {
          // No shift assigned on regular day OR ALLOW_NORMAL holiday without shift - treat as overtime
          lateOTMins += sessionMinutes;
        }
      }
    }
  }

  // 2. Identify Actual Gaps (Break time between punch pairs)
  const gapRecords = [];
  for (let i = 0; i < punches.length - 1; i++) {
    if (punches[i].punch_type === "OUT" && punches[i + 1].punch_type === "IN") {
      const gS = dayjs(punches[i].punch_time);
      const gE = dayjs(punches[i + 1].punch_time);
      const duration = Math.round(gE.diff(gS, "minute", true));
      actualGapsMins += duration;
      gapRecords.push({ start: gS, end: gE, duration: duration, excludedMins: 0 });
    }
  }

  // 3. Identify Scheduled Breaks (Unpaid intervals defined in shift) and Categorize
  let fineableScheduledBreaksMins = 0;
  if (shift && shift.ShiftBreaks && Array.isArray(shift.ShiftBreaks) && firstIn && lastOut) {
    const pIn = dayjs(firstIn.punch_time);
    const pOut = dayjs(lastOut.punch_time);

    for (const sb of shift.ShiftBreaks) {
      if (sb.status !== 2 && sb.start_time && sb.end_time) {
        let bStart = dayjs(`${date} ${sb.start_time}`);
        let bEnd = dayjs(`${date} ${sb.end_time}`);
        if (bEnd.isBefore(bStart)) bEnd = bEnd.add(1, 'day');

        // 🌙 Night Shift Edge Case: Adjust break window for overnight shifts
        if (bStart.isBefore(pIn.subtract(6, 'hour'))) {
          bStart = bStart.add(1, 'day');
          bEnd = bEnd.add(1, 'day');
        }

        const intersectStart = dayjs(Math.max(bStart.valueOf(), pIn.valueOf()));
        const intersectEnd = dayjs(Math.min(bEnd.valueOf(), pOut.valueOf()));

        if (intersectEnd.isAfter(intersectStart)) {
          const sbMins = intersectEnd.diff(intersectStart, "minute");
          const category = (sb.category || "").toLowerCase();
          const isShiftBreak = category.includes("shift break");
          const isPaidCasual = category.includes("casual break") && sb.pay_type === "Paid";
          const isExcludedFromFine = isShiftBreak || isPaidCasual;

          let coveredByGap = 0;
          for (const gap of gapRecords) {
            const overlapS = dayjs(Math.max(gap.start.valueOf(), intersectStart.valueOf()));
            const overlapE = dayjs(Math.min(gap.end.valueOf(), intersectEnd.valueOf()));
            if (overlapE.isAfter(overlapS)) {
              const overlapMins = overlapE.diff(overlapS, "minute");
              coveredByGap += overlapMins;
              if (isExcludedFromFine) {
                gap.excludedMins += overlapMins;
              }
            }
          }

          if (sb.pay_type === "Unpaid" && sb.break_type === "Intervals") {
            const remnant = Math.max(0, Math.round(sbMins - coveredByGap));
            scheduledBreaksMins += remnant;
            if (!isExcludedFromFine) {
              fineableScheduledBreaksMins += remnant;
            }
          }
        }
      }
    }
  }

  totalBreakMinutes = actualGapsMins + scheduledBreaksMins;

  // Calculate fineable break minutes (Actual gaps minus excluded overlaps + non-excluded remnants)
  let fineableActualGapsMins = 0;
  for (const gap of gapRecords) {
    fineableActualGapsMins += Math.max(0, gap.duration - gap.excludedMins);
  }
  let fineableBreakMinutes = fineableActualGapsMins + fineableScheduledBreaksMins;

  // 4. Final Break Deduction Logic (Fines/Deductions use fineableBreakMinutes)
  let breakToDeduct = fineableBreakMinutes;
  if (template) {
    if (template.break_rules && template.break_rules.length > 0) {
      const rule = template.break_rules.find(r => fineableBreakMinutes >= r.from_mins && fineableBreakMinutes <= r.to_mins);
      if (rule) breakToDeduct = Math.max(0, fineableBreakMinutes - (parseFloat(rule.value) || 0));
    } else if (template.paid_break_duration_mins > 0) {
      breakToDeduct = Math.max(0, fineableBreakMinutes - template.paid_break_duration_mins);
    }
  }

  let totalSpanMinutes = 0;
  // Total Span calculation (Total duration of all IN-OUT pairs)
  for (let i = 0; i < punches.length - 1; i++) {
    if (String(punches[i].punch_type || "").toUpperCase() === "IN" && String(punches[i + 1].punch_type || "").toUpperCase() === "OUT") {
      totalSpanMinutes += dayjs(punches[i + 1].punch_time).diff(dayjs(punches[i].punch_time), "minute");
    }
  }
  // [MOD] Deduct unpaid shift breaks (Scheduled Breaks) that occurred while employee was punched in.
  // totalSpanMinutes already excludes gaps between pairs, so we only subtract "stayed punched-in" break portion.
  let breakDeduction = Math.max(0, scheduledBreaksMins);
  if (template && template.paid_break_duration_mins > 0) {
    breakDeduction = Math.max(0, breakDeduction - template.paid_break_duration_mins);
  }
  let finalWorkedMinutes = Math.max(0, totalSpanMinutes - breakDeduction);

  // When it's a holiday or weekly off (ALLOW_NORMAL + BLOCK), set worked minutes to 0 so all time goes to overtime
  // For COMP_OFF: keep finalWorkedMinutes (all time → worked_minutes)
  if ((meta.isHoliday || meta.isWeeklyOff) && !meta.isHolidayCompOff) {
    finalWorkedMinutes = 0;
  }

  // [MOD] breakdownMinutes subtraction from finalWorkedMinutes reflects net working time (Total In-Out - Gaps - Unpaid Breaks)

  // --- REFACTORED OVERTIME LOGIC ---
  let rawEarlyOT = earlyOTMins;
  let rawLateOT = lateOTMins;

  if (meta.skipOvertimeCalculation) {
    rawEarlyOT = 0;
    rawLateOT = 0;
  }

  const isNonWorkingDay = (meta.isHoliday || meta.isWeeklyOff) && !meta.isHolidayCompOff;

  if (template && shift && !isNonWorkingDay) {
    // 1. Honor individual OT toggles (only when shift exists and not holiday)
    if (!template.early_overtime_allowed) rawEarlyOT = 0;
    if (!template.overtime_allowed) rawLateOT = 0;

    // 2. Apply Min Threshold (Mins) to each session/part
    // Only count as OT if that specific session exceeds the threshold
    const minThreshold = template.min_overtime_mins || 0;
    if (rawEarlyOT < minThreshold) rawEarlyOT = 0;
    if (rawLateOT < minThreshold) rawLateOT = 0;
  }

  let overtimeMinutes = rawEarlyOT + rawLateOT;

  // If breaks took away more than regular shift work, deduct remainder from OT
  if (breakToDeduct > shiftWorkedMins) {
    const remainingBreak = breakToDeduct - shiftWorkedMins;
    overtimeMinutes = Math.max(0, overtimeMinutes - remainingBreak);
    // Also re-adjust raw parts proportionally for correct rule application later?
    // For now, simple subtraction from total is handled below in final splits.
  }

  // Regular worked minutes = Total Net - Post-break OT
  let regularWorkedMinutes = Math.max(0, finalWorkedMinutes - overtimeMinutes);

  // ✅ Check if work is completely outside shift hours - set flag to skip fine calculation
  if (shift && shiftWorkedMins === 0 && template) {
    // Always skip fine calculation when work is completely outside shift hours
    meta.skipFineCalculation = true;
  }

  // 4. Overtime Trimming (Optional, if not included in total)
  let expectedShiftWorkMinutes = 0;
  if (shift) {
    const shiftStart = dayjs(`${date} ${shift.start_time}`);
    let shiftEnd = dayjs(`${date} ${shift.end_time}`);
    if (shift.is_night_shift || shift.end_time < shift.start_time) shiftEnd = shiftEnd.add(1, "day");

    let netMins = shiftEnd.diff(shiftStart, "minute");
    // Deduct unpaid breaks from shift duration to get net expected work
    if (shift.ShiftBreaks && Array.isArray(shift.ShiftBreaks)) {
      for (const sb of shift.ShiftBreaks) {
        if (sb.pay_type === "Unpaid") {
          const bS = dayjs(`${date} ${sb.start_time}`);
          let bE = dayjs(`${date} ${sb.end_time}`);
          if (bE.isBefore(bS)) bE = bE.add(1, "day");
          netMins -= Math.max(0, bE.diff(bS, "minute"));
        }
      }
    }
    expectedShiftWorkMinutes = netMins;
  }

  // [MOD] Limit worked minutes to shift duration
  if (shift && expectedShiftWorkMinutes > 0) {
    finalWorkedMinutes = Math.min(finalWorkedMinutes, expectedShiftWorkMinutes);
  }
  
  // [MOD] Do not trim worked minutes by policy here. 
  // We want worked_minutes to store total site duration (Total - Breaks), as requested.
  // if (template && !template.include_overtime_in_total && shift) {
  //   finalWorkedMinutes = regularWorkedMinutes;
  // }

  let lateMinutes = 0;
  let earlyOutMinutes = 0;
  let fineMinutes = 0;
  let fineAmount = 0;
  let earlyOvertimeMinutes = Math.min(rawEarlyOT, overtimeMinutes);
  let lateOtData = { rate: 0, amount: 0, minutes: 0, calculation_type: 5 };
  let earlyOtData = { rate: 0, amount: 0, minutes: 0, calculation_type: 5 };

  let fineData = {
    late_entry: { minutes: 0, amount: 0, rate: 0, calculation_type: 5 },
    early_exit: { minutes: 0, amount: 0, rate: 0, calculation_type: 5 },
    excess_breaks: { minutes: 0, amount: 0, rate: 0, calculation_type: 5 }
  };

  if (shift) {
    // expectedShiftWorkMinutes already calculated at 624

    // Skip late entry/early exit calculation if flag is set (for out-of-shift timing case)
    if (!meta.skipFineCalculation) {
      // Check for Flexible Shift: if actual work duration >= shift duration, skip late/fine calculation
      let skipLateFineForFlexibleShift = false;
      if (shift.shift_type === "Flexible Shift" && firstIn && lastOut) {
        const actualIn = dayjs(firstIn.punch_time);
        const actualOut = dayjs(lastOut.punch_time);
        const actualWorkDuration = actualOut.diff(actualIn, "minute", true);
        
        if (actualWorkDuration >= expectedShiftWorkMinutes) {
          skipLateFineForFlexibleShift = true;
        }
      }

      if (!skipLateFineForFlexibleShift) {
        if (firstIn) {
          const actualIn = dayjs(firstIn.punch_time);

          // LATE ENTRY CALCULATION
          const diffIn = actualIn.diff(shiftStart, "minute", true);
          if (diffIn > (shift.grace_minutes || 0)) {
            lateMinutes = Math.floor(diffIn);
          }
        }

        if (lastOut) {
          const actualOut = dayjs(lastOut.punch_time);
          const isManualNonWorking = existingDay && [3, 4].includes(existingDay.status);

          if (!isWeeklyOff && !isHoliday && !isManualNonWorking) {
            const diffOut = shiftEnd.diff(actualOut, "minute", true);
            if (diffOut > (shift.early_exit_grace || 0)) {
              earlyOutMinutes = Math.floor(diffOut);
            }
          }
        }
      }
    }

    // 🏆 OVERTIME REFINEMENT
    if (template && (template.overtime_allowed || template.early_overtime_allowed)) {
      const oldOT = overtimeMinutes;
      if (overtimeMinutes < (template.min_overtime_mins || 0)) {
        overtimeMinutes = 0;
      }
      if (template.max_overtime_mins > 0 && overtimeMinutes > template.max_overtime_mins) {
        overtimeMinutes = template.max_overtime_mins;
      }

      // Sync finalWorkedMinutes if OT was trimmed and it was included in total
      // [MOD] Do not trim worked minutes by OT policy here.
      // if (template.include_overtime_in_total && oldOT !== overtimeMinutes) {
      //   finalWorkedMinutes = Math.max(0, finalWorkedMinutes - (oldOT - overtimeMinutes));
      // }

      // Re-split early OT after trimming
      earlyOvertimeMinutes = Math.min(earlyOvertimeMinutes, overtimeMinutes);
    }
    // 💸 FINE & BENEFIT CALCULATION
    const monthStart = dayjs(date).startOf('month').format('YYYY-MM-DD');

    // Skip fine calculation if flag is set (for out-of-shift timing case)
    if (meta.skipFineCalculation) {
      lateMinutes = 0;
      earlyOutMinutes = 0;
      fineAmount = 0;
      fineMinutes = 0;
      fineData = {
        late_entry: { minutes: 0, amount: 0, rate: 0, calculation_type: 5 },
        early_exit: { minutes: 0, amount: 0, rate: 0, calculation_type: 5 },
        excess_breaks: { minutes: 0, amount: 0, rate: 0, calculation_type: 5 }
      };
    } else if (template && template.fines_allowed !== false) {
      let rule = null;
      // Late Entry Fine
      if (lateMinutes > 0) {
        fineData.late_entry.minutes = lateMinutes;
        if (template.late_entry_rules.length > 0) {
          rule = getMatchingRule(lateMinutes, template.late_entry_rules);
          if (rule) {
            // Check Tiered Occurrence Limit
            if (rule.occurrence_limit > 0 && rule.action_after_limit && rule.action_after_limit !== "NONE") {
              const ruleOccurrences = await AttendanceDay.count({
                where: {
                  employee_id: employeeId,
                  attendance_date: { [Op.gte]: monthStart, [Op.lt]: date },
                  company_id: employee.company_id,
                  [Op.and]: [sequelize.literal(`fine_data->'late_entry' IS NOT NULL`)],

                  status: { [Op.ne]: 2 }
                },
                transaction
              });

              if ((ruleOccurrences + 1) > rule.occurrence_limit) {
                // Override rule for this calculation
                rule = {
                  ...rule,
                  type: rule.action_after_limit,
                  value: rule.action_value || rule.value,
                  isEscalated: true
                };
              }
            }

            const tierSuffix = rule.isEscalated ? " (Escalated)" : "";
            if (rule.type === '1' || rule.type === 'FIXED' || rule.type === 'FIXED_AMOUNT') {
              const amount = parseFloat(rule.value || 0);
              fineAmount += amount;
              fineData.late_entry = { minutes: lateMinutes, amount, rate: amount, calculation_type: 1 };
            } else if (rule.type === '2' || rule.type === 'FIXED_PER_HOUR') {
              const rate = parseFloat(rule.value || 0);
              const amount = parseFloat(((lateMinutes / 60) * rate).toFixed(2));
              fineAmount += amount;
              fineData.late_entry = { minutes: lateMinutes, amount, rate, calculation_type: 2 };
            } else if (rule.type === '3' || rule.type === 'HALF_DAY') {
              const rate = parseFloat((dailyWage * 0.5).toFixed(2));
              fineAmount += rate;
              fineData.late_entry = { minutes: lateMinutes, amount: rate, rate, calculation_type: 3 };
              meta.forcedStatus = 1; // Mark as Half Day
              meta.overrideAutomationNote = `Penalty: Late Entry Tier Limit reached${tierSuffix} (${lateMinutes} mins)`;
            } else if (rule.type === '4' || rule.type === 'FULL_DAY') {
              const rate = parseFloat(dailyWage.toFixed(2));
              fineAmount += rate;
              fineData.late_entry = { minutes: lateMinutes, amount: rate, rate, calculation_type: 4 };
              meta.forcedStatus = 5; // Mark as Absent
              meta.overrideAutomationNote = `Penalty: Late Entry Tier Limit reached${tierSuffix} (${lateMinutes} mins)`;
            } else if (['5', '6', '7', '8'].includes(rule.type)) {
              const res = getRateIdAndAmount(rule.type, rule.value, lateMinutes, dailyWage, hourlyWage);
              fineData.late_entry = { minutes: lateMinutes, amount: res.amount, rate: res.rate, calculation_type: res.rateId };
              fineAmount += res.amount;
            } else if (rule.type === 'PERCENTAGE') {
              const rate = parseFloat((dailyWage * ((parseFloat(rule.value) || 0) / 100)).toFixed(2));
              fineAmount += rate;
              fineData.late_entry = { minutes: lateMinutes, amount: rate, rate, calculation_type: 2 };
            } else if (rule.type === 'MINUTE_DEDUCTION') {
              const deductMins = parseFloat(rule.value || 0);
              finalWorkedMinutes -= deductMins;
              fineData.late_entry = { minutes: lateMinutes, amount: 0, rate: 0, calculation_type: 2, deducted_mins: deductMins };
            } else if (rule.type === 'NONE') {
              fineData.late_entry = { minutes: lateMinutes, amount: 0, rate: 0, calculation_type: 5 };
            } else {
              const res = getRateIdAndAmount(rule.type, rule.value, lateMinutes, dailyWage, hourlyWage);
              fineData.late_entry = { minutes: lateMinutes, amount: res.amount, rate: res.rate, calculation_type: res.rateId };
              fineAmount += res.amount;
            }
          } else if (template.late_entry_fine_type !== 'NONE') {
            const lateCount = await AttendanceDay.count({
              where: {
                employee_id: employeeId,
                attendance_date: { [Op.gte]: monthStart, [Op.lt]: date },
                company_id: employee.company_id,
                [Op.and]: [sequelize.literal(`fine_data->'late_entry' IS NOT NULL`)],
                status: { [Op.ne]: 2 }
              },
              transaction
            });
            if ((lateCount + 1) > (template.late_entry_limit || 0)) {
              if (template.late_entry_fine_type === 'FIXED') {
                const amount = parseFloat(template.late_entry_fine_value || 0);
                fineAmount += amount;
                fineData.late_entry = { minutes: lateMinutes, amount, rate: amount, calculation_type: 1 };
              } else if (template.late_entry_fine_type === 'MINUTE_DEDUCTION') {
                finalWorkedMinutes -= parseFloat(template.late_entry_fine_value || 0);
              } else if (template.late_entry_fine_type === 'DEDUCTION') {
                const res = getRateIdAndAmount(template.late_entry_fine_type, template.late_entry_fine_value, lateMinutes, dailyWage, hourlyWage);
                fineData.late_entry = { minutes: lateMinutes, amount: res.amount, rate: res.rate, calculation_type: res.rateId };
                fineAmount += res.amount;
              } else if (template.late_entry_fine_type === 'HALF_DAY') {
                const rate = parseFloat((dailyWage * 0.5).toFixed(2));
                fineAmount += rate;
                fineData.late_entry = { minutes: lateMinutes, amount: rate, rate, calculation_type: 3 };
                meta.forcedStatus = 1; // Mark as Half Day
                meta.overrideAutomationNote = "Penalty: Late Entry Limit Exceeded (Half Day)";
              } else if (template.late_entry_fine_type === 'FULL_DAY') {
                const rate = parseFloat(dailyWage.toFixed(2));
                fineAmount += rate;
                fineData.late_entry = { minutes: lateMinutes, amount: rate, rate, calculation_type: 4 };
                meta.forcedStatus = 5; // Mark as Absent
                meta.overrideAutomationNote = "Penalty: Late Entry Limit Exceeded (Full Day)";
              }
            }
          }
        } else {
          // Default 1x Salary Deduction if no rules match or no rules defined
          const res = getRateIdAndAmount(5, 1, lateMinutes, dailyWage, hourlyWage);
          fineData.late_entry = { minutes: lateMinutes, amount: res.amount, rate: res.rate, calculation_type: res.rateId };
          fineAmount += res.amount;
        }
        
        // --- FALLBACK: Default 1x Salary Deduction for Late Entry ---
        if (lateMinutes > 0 && fineData.late_entry.amount <= 0 && (!rule || rule.type !== 'NONE' || rule.amount > 0)) {
           const res = getRateIdAndAmount(5, 1, lateMinutes, dailyWage, hourlyWage);
           fineData.late_entry = { minutes: lateMinutes, amount: res.amount, rate: res.rate, calculation_type: res.rateId };
           fineAmount += res.amount;
        }

        rule = null;
        // Early Exit Fine
        if (earlyOutMinutes > 0) {
          fineData.early_exit.minutes = earlyOutMinutes;
          if (template.early_exit_rules.length > 0) {
            rule = getMatchingRule(earlyOutMinutes, template.early_exit_rules);
            if (rule) {
              // Check Tiered Occurrence Limit
              if (rule.occurrence_limit > 0 && rule.action_after_limit && rule.action_after_limit !== "NONE") {
                const ruleOccurrences = await AttendanceDay.count({
                  where: {
                    employee_id: employeeId,
                    attendance_date: { [Op.gte]: monthStart, [Op.lt]: date },
                    company_id: employee.company_id,
                    [Op.and]: [sequelize.literal(`fine_data->'early_exit' IS NOT NULL`)],
                    status: { [Op.ne]: 2 }
                  },
                  transaction
                });

                if ((ruleOccurrences + 1) > rule.occurrence_limit) {
                  // Override rule for this calculation
                  rule = {
                    ...rule,
                    type: rule.action_after_limit,
                    value: rule.action_value || rule.value,
                    isEscalated: true
                  };
                }
              }

              const tierSuffix = rule.isEscalated ? " (Escalated)" : "";

              if (rule.type === '1' || rule.type === 'FIXED' || rule.type === 'FIXED_AMOUNT') {
                const amount = parseFloat(rule.value || 0);
                fineAmount += amount;
                fineData.early_exit = { minutes: earlyOutMinutes, amount, rate: amount, calculation_type: 1 };
              } else if (rule.type === '2' || rule.type === 'FIXED_PER_HOUR') {
                const rate = parseFloat(rule.value || 0);
                const amount = parseFloat(((earlyOutMinutes / 60) * rate).toFixed(2));
                fineAmount += amount;
                fineData.early_exit = { minutes: earlyOutMinutes, amount, rate, calculation_type: 2 };
              } else if (rule.type === '3' || rule.type === 'HALF_DAY') {
                const rate = parseFloat((dailyWage * 0.5).toFixed(2));
                fineAmount += rate;
                fineData.early_exit = { minutes: earlyOutMinutes, amount: rate, rate, calculation_type: 3 };
                meta.forcedStatus = 1; // Mark as Half Day
                meta.overrideAutomationNote = `Penalty: Early Exit Tier Limit reached${tierSuffix} (${earlyOutMinutes} mins)`;
              } else if (rule.type === '4' || rule.type === 'FULL_DAY') {
                const rate = parseFloat(dailyWage.toFixed(2));
                fineAmount += rate;
                fineData.early_exit = { minutes: earlyOutMinutes, amount: rate, rate, calculation_type: 4 };
                meta.forcedStatus = 5; // Mark as Absent
                meta.overrideAutomationNote = `Penalty: Early Exit Tier Limit reached${tierSuffix} (${earlyOutMinutes} mins)`;
              } else if (['5', '6', '7', '8'].includes(rule.type)) {
                const res = getRateIdAndAmount(rule.type, rule.value, earlyOutMinutes, dailyWage, hourlyWage);
                fineData.early_exit = { minutes: earlyOutMinutes, amount: res.amount, rate: res.rate, calculation_type: res.rateId };
                fineAmount += res.amount;
              } else if (rule.type === 'PERCENTAGE') {
                const rate = parseFloat((dailyWage * ((parseFloat(rule.value) || 0) / 100)).toFixed(2));
                fineAmount += rate;
                fineData.early_exit = { minutes: earlyOutMinutes, amount: rate, rate, calculation_type: 2 };
              } else if (rule.type === 'MINUTE_DEDUCTION') {
                const deductMins = parseFloat(rule.value || 0);
                finalWorkedMinutes -= deductMins;
                fineData.early_exit = { minutes: earlyOutMinutes, amount: 0, rate: 0, calculation_type: 2, deducted_mins: deductMins };
              } else if (rule.type === 'NONE') {
                fineData.early_exit = { minutes: earlyOutMinutes, amount: 0, rate: 0, calculation_type: 5 };
              } else {
                const res = getRateIdAndAmount(rule.type, rule.value, earlyOutMinutes, dailyWage, hourlyWage);
                fineData.early_exit = { minutes: earlyOutMinutes, amount: res.amount, rate: res.rate, calculation_type: res.rateId };
                fineAmount += res.amount;
              }
            } else if (template.early_exit_fine_type !== 'NONE') {
              const earlyExitCount = await AttendanceDay.count({
                where: {
                  employee_id: employeeId,
                  attendance_date: { [Op.gte]: monthStart, [Op.lt]: date },
                  company_id: employee.company_id,
                  [Op.and]: [sequelize.literal(`fine_data->'early_exit' IS NOT NULL`)],
                  status: { [Op.ne]: 2 }
                },
                transaction
              });
              if ((earlyExitCount + 1) > (template.early_exit_limit || 0)) {
                if (template.early_exit_fine_type === 'FIXED') {
                  const amount = parseFloat(template.early_exit_fine_value || 0);
                  fineAmount += amount;
                  fineData.early_exit = { minutes: earlyOutMinutes, amount, rate: amount, calculation_type: 1 };
                } else if (template.early_exit_fine_type === 'MINUTE_DEDUCTION') {
                  finalWorkedMinutes -= parseFloat(template.early_exit_fine_value || 0);
                  fineData.early_exit = { minutes: earlyOutMinutes, amount: 0, rate: 0, calculation_type: 2, deducted_mins: parseFloat(template.early_exit_fine_value || 0) };
                } else if (template.early_exit_fine_type === 'DEDUCTION') {
                  const res = getRateIdAndAmount(template.early_exit_fine_type, template.early_exit_fine_value, earlyOutMinutes, dailyWage, hourlyWage);
                  fineData.early_exit = { minutes: earlyOutMinutes, amount: res.amount, rate: res.rate, calculation_type: res.rateId };
                  fineAmount += res.amount;
                } else if (template.early_exit_fine_type === 'HALF_DAY') {
                  const amount = parseFloat((dailyWage * 0.5).toFixed(2));
                  fineAmount += amount;
                  fineData.early_exit = { minutes: earlyOutMinutes, amount, rate: amount, calculation_type: 3 };
                  meta.forcedStatus = 1; // Mark as Half Day
                  meta.overrideAutomationNote = "Penalty: Early Exit Limit Exceeded (Half Day)";
                } else if (template.early_exit_fine_type === 'FULL_DAY') {
                  const amount = parseFloat(dailyWage.toFixed(2));
                  fineAmount += amount;
                  fineData.early_exit = { minutes: earlyOutMinutes, amount, rate: amount, calculation_type: 4 };
                  meta.forcedStatus = 5; // Mark as Absent
                  meta.overrideAutomationNote = "Penalty: Early Exit Limit Exceeded (Full Day)";
                }
              }
            }
          } 
          
          // --- FALLBACK: Default 1x Salary Deduction for Early Exit ---
          if (fineData.early_exit.amount <= 0 && (!rule || (rule.type !== 'NONE' && rule.type !== 'MINUTE_DEDUCTION'))) {
            const res = getRateIdAndAmount(5, 1, earlyOutMinutes, dailyWage, hourlyWage);
            fineData.early_exit = { minutes: earlyOutMinutes, amount: res.amount, rate: res.rate, calculation_type: res.rateId };
            fineAmount += res.amount;
          }
        }

          rule = null;
          let excessMins = 0;
          // Excess Break Fine (using fineableBreakMinutes instead of totalBreakMinutes)
          if (fineableBreakMinutes > (template.paid_break_duration_mins || 0)) {
            excessMins = fineableBreakMinutes - (template.paid_break_duration_mins || 0);
            fineData.excess_breaks.minutes = excessMins;
            rule = getMatchingRule(excessMins, template.break_rules);
            if (rule) {
              if (rule.type === '1' || rule.type === 'FIXED' || rule.type === 'FIXED_AMOUNT') {
                const amount = parseFloat(rule.value || 0);
                fineAmount += amount;
                fineData.excess_breaks = { minutes: excessMins, amount, rate: amount, calculation_type: 1 };
              } else if (rule.type === '2' || rule.type === 'FIXED_PER_HOUR') {
                const rate = parseFloat(rule.value || 0);
                const amount = parseFloat(((excessMins / 60) * rate).toFixed(2));
                fineAmount += amount;
                fineData.excess_breaks = { minutes: excessMins, amount, rate, calculation_type: 2 };
              } else if (rule.type === '3' || rule.type === 'HALF_DAY') {
                const rate = parseFloat((dailyWage * 0.5).toFixed(2));
                fineAmount += rate;
                fineData.excess_breaks = { minutes: excessMins, amount: rate, rate, calculation_type: 3 };
              } else if (rule.type === '4' || rule.type === 'FULL_DAY') {
                const rate = parseFloat(dailyWage.toFixed(2));
                fineAmount += rate;
                fineData.excess_breaks = { minutes: excessMins, amount: rate, rate, calculation_type: 4 };
              } else if (['5', '6', '7', '8'].includes(rule.type)) {
                const res = getRateIdAndAmount(rule.type, rule.value, excessMins, dailyWage, hourlyWage);
                fineData.excess_breaks = { minutes: excessMins, amount: res.amount, rate: res.rate, calculation_type: res.rateId };
                fineAmount += res.amount;
              } else if (rule.type === 'PERCENTAGE') {
                const rate = parseFloat((dailyWage * ((parseFloat(rule.value) || 0) / 100)).toFixed(2));
                fineAmount += rate;
                fineData.excess_breaks = { minutes: excessMins, amount: rate, rate, calculation_type: 2 };
              } else if (rule.type === 'MINUTE_DEDUCTION') {
                const deductMins = parseFloat(rule.value || 0);
                finalWorkedMinutes -= deductMins;
                fineData.excess_breaks = { minutes: excessMins, amount: 0, rate: 0, calculation_type: 2, deducted_mins: deductMins };
              } else {
                const res = getRateIdAndAmount(rule.type, rule.value, excessMins, dailyWage, hourlyWage);
                fineData.excess_breaks = { minutes: excessMins, amount: res.amount, rate: res.rate, calculation_type: res.rateId };
                fineAmount += res.amount;
              }
            }
          } 
          
          // --- FALLBACK: Default 1x Salary Deduction for Excess Breaks ---
          if (fineData.excess_breaks.amount <= 0 && (!rule || rule.type !== 'NONE')) {
            const res = getRateIdAndAmount(5, 1, excessMins, dailyWage, hourlyWage);
            fineData.excess_breaks = { minutes: excessMins, amount: res.amount, rate: res.rate, calculation_type: res.rateId };
            fineAmount += res.amount;
          }
        }
          // Shortage Fine (Work hours less than shift hours)
          // if (regularWorkedMinutes < expectedShiftWorkMinutes) {
          //   const shortageMins = expectedShiftWorkMinutes - regularWorkedMinutes;
          //   // Check if there's a specific rule or just default to 1x salary deduction
          //   const res = getRateIdAndAmount(shortageMins, hourlyWage, 1);
          //   fineData.shortage = { minutes: shortageMins, amount: res.amount, rate: res.rateId };
          //   fineAmount += res.amount;
          // }
    }
  } // End if (shift)

  // Move OT Data calculation OUTSIDE if(shift) so people without shifts still get their records populated
  // Late OT Calculation (Standard Overtime)
  const lateOvertimeMinutesRaw = Math.max(0, overtimeMinutes - earlyOvertimeMinutes);
  if (lateOvertimeMinutesRaw > 0) {
    const otRule = template ? getMatchingRule(lateOvertimeMinutesRaw, template.overtime_rules) : null;
    if (otRule) {
      if (otRule.type === '1' || otRule.type === 'FIXED_AMOUNT' || otRule.type === 'FIXED') {
        const amount = parseFloat(otRule.value || 0);
        lateOtData = { minutes: lateOvertimeMinutesRaw, amount, rate: amount, calculation_type: 1 };
      } else if (otRule.type === '2' || otRule.type === 'FIXED_PER_HOUR') {
        const rate = parseFloat(otRule.value || 0);
        const amount = parseFloat(((lateOvertimeMinutesRaw / 60) * rate).toFixed(2));
        lateOtData = { minutes: lateOvertimeMinutesRaw, amount, rate, calculation_type: 2 };
      } else if (otRule.type === '3' || otRule.type === 'HALF_DAY') {
        const rate = parseFloat((dailyWage * 0.5).toFixed(2));
        lateOtData = { minutes: lateOvertimeMinutesRaw, amount: rate, rate, calculation_type: 3 };
      } else if (otRule.type === '4' || otRule.type === 'FULL_DAY') {
        const rate = parseFloat(dailyWage.toFixed(2));
        lateOtData = { minutes: lateOvertimeMinutesRaw, amount: rate, rate, calculation_type: 4 };
      } else if (['5', '6', '7', '8'].includes(otRule.type)) {
        const res = getRateIdAndAmount(otRule.type, otRule.value, lateOvertimeMinutesRaw, dailyWage, hourlyWage);
        lateOtData = { minutes: lateOvertimeMinutesRaw, amount: res.amount, rate: res.rate, calculation_type: res.rateId };
      } else if (otRule.type === 'MINUTE_ADDITION') {
        const addMins = parseFloat(otRule.value || 0);
        overtimeMinutes += addMins;
        finalWorkedMinutes += addMins;
        lateOtData = { minutes: lateOvertimeMinutesRaw + addMins, amount: 0, rate: 0, calculation_type: 5 };
      } else {
        const res = getRateIdAndAmount(otRule.type, otRule.value, lateOvertimeMinutesRaw, dailyWage, hourlyWage);
        lateOtData = { minutes: lateOvertimeMinutesRaw, amount: res.amount, rate: res.rate, calculation_type: res.rateId };
      }
    } else {
      const res = getRateIdAndAmount(5, 1, lateOvertimeMinutesRaw, dailyWage, hourlyWage);
      lateOtData = { minutes: lateOvertimeMinutesRaw, amount: res.amount, rate: res.rate, calculation_type: res.rateId };
    }
  }

  if (earlyOvertimeMinutes > 0) {
    const earlyOtRule = template ? getMatchingRule(earlyOvertimeMinutes, template.early_overtime_rules) : null;
    if (earlyOtRule) {
      if (earlyOtRule.type === '1' || earlyOtRule.type === 'FIXED_AMOUNT' || earlyOtRule.type === 'FIXED') {
        const amount = parseFloat(earlyOtRule.value || 0);
        earlyOtData = { minutes: earlyOvertimeMinutes, amount, rate: amount, calculation_type: 1 };
      } else if (earlyOtRule.type === '2' || earlyOtRule.type === 'FIXED_PER_HOUR') {
        const rate = parseFloat(earlyOtRule.value || 0);
        const amount = parseFloat(((earlyOvertimeMinutes / 60) * rate).toFixed(2));
        earlyOtData = { minutes: earlyOvertimeMinutes, amount, rate, calculation_type: 2 };
      } else if (earlyOtRule.type === '3' || earlyOtRule.type === 'HALF_DAY') {
        const rate = parseFloat((dailyWage * 0.5).toFixed(2));
        earlyOtData = { minutes: earlyOvertimeMinutes, amount: rate, rate, calculation_type: 3 };
      } else if (earlyOtRule.type === '4' || earlyOtRule.type === 'FULL_DAY') {
        const rate = parseFloat(dailyWage.toFixed(2));
        earlyOtData = { minutes: earlyOvertimeMinutes, amount: rate, rate, calculation_type: 4 };
      } else if (['5', '6', '7', '8'].includes(earlyOtRule.type)) {
        const res = getRateIdAndAmount(earlyOtRule.type, earlyOtRule.value, earlyOvertimeMinutes, dailyWage, hourlyWage);
        earlyOtData = { minutes: earlyOvertimeMinutes, amount: res.amount, rate: res.rate, calculation_type: res.rateId };
      } else if (earlyOtRule.type === 'MINUTE_ADDITION') {
        const addMins = parseFloat(earlyOtRule.value || 0);
        overtimeMinutes += addMins;
        finalWorkedMinutes += addMins;
        earlyOtData = { minutes: earlyOvertimeMinutes + addMins, amount: 0, rate: 0, calculation_type: 5 };
      } else {
        const res = getRateIdAndAmount(earlyOtRule.type, earlyOtRule.value, earlyOvertimeMinutes, dailyWage, hourlyWage);
        earlyOtData = { minutes: earlyOvertimeMinutes, amount: res.amount, rate: res.rate, calculation_type: res.rateId };
      }
    } else {
      const res = getRateIdAndAmount(5, 1, earlyOvertimeMinutes, dailyWage, hourlyWage);
      earlyOtData = { minutes: earlyOvertimeMinutes, amount: res.amount, rate: res.rate, calculation_type: res.rateId };
    }
  }

  finalWorkedMinutes = Math.max(0, finalWorkedMinutes);

  // --- OVERRIDE IF TRACK IN/OUT IS DISABLED ---
  if (template && !template.track_in_out) {
    lateMinutes = 0;
    earlyOutMinutes = 0;
    fineAmount = 0;
    fineData = {
      late_entry: { minutes: 0, amount: 0, rate: 0, calculation_type: 5 },
      early_exit: { minutes: 0, amount: 0, rate: 0, calculation_type: 5 },
      excess_breaks: { minutes: 0, amount: 0, rate: 0, calculation_type: 5 }
    };
    overtimeMinutes = 0;
    earlyOvertimeMinutes = 0;
    lateOtData = { rate: 0, amount: 0, minutes: 0, calculation_type: 5 };
    earlyOtData = { rate: 0, amount: 0, minutes: 0, calculation_type: 5 };

    if (punches.length > 0) {
      finalWorkedMinutes = shift ? (shift.min_full_day_minutes || 480) : 480;
    }
  }

  // Generate default overtime data when no shift is assigned but overtime exists
  if (!shift && overtimeMinutes > 0) {
    const calculatedHourlyWage = dailyWage / unitWorkingHours; // Ensure hourly wage is calculated using dynamic divisor
    const result = getRateIdAndAmount(5, 1, overtimeMinutes, dailyWage, calculatedHourlyWage);
    lateOtData = {
      rate: result.rate,
      amount: result.amount,
      minutes: overtimeMinutes,
      calculation_type: result.rateId
    };
  }

  // --- ALLOW_NORMAL / COMP_OFF on Holiday/WeeklyOff: use first_in→last_out span with break deduction ---
  if ((meta.isHolidayAllowNormal || meta.isHolidayCompOff) && firstIn && lastOut) {
    const rawSpanMinutes = Math.max(0, dayjs(lastOut.punch_time).diff(dayjs(firstIn.punch_time), "minute"));
    
    // Calculate break minutes to deduct (same logic as regular days)
    let breakMinutesToDeduct = 0;
    if (shift && shift.ShiftBreaks && shift.ShiftBreaks.length > 0) {
      for (const breakRule of shift.ShiftBreaks) {
        if ((breakRule.is_automatic === true || breakRule.is_automatic === undefined) && breakRule.start_time && breakRule.end_time) {
          const breakStart = dayjs(`${date} ${breakRule.start_time}`);
          let breakEnd = dayjs(`${date} ${breakRule.end_time}`);
          
          // Handle breaks that cross midnight for night shifts
          if (breakEnd.isBefore(breakStart)) {
            breakEnd = breakEnd.add(1, 'day');
          }
          
          // Check if break period falls within work time
          const workStart = dayjs(firstIn.punch_time);
          const workEnd = dayjs(lastOut.punch_time);
          
          if (workStart.isBefore(breakEnd) && workEnd.isAfter(breakStart)) {
            const actualBreakStart = workStart.isAfter(breakStart) ? workStart : breakStart;
            const actualBreakEnd = workEnd.isBefore(breakEnd) ? workEnd : breakEnd;
            const breakOverlapMinutes = Math.max(0, actualBreakEnd.diff(actualBreakStart, 'minute'));
            breakMinutesToDeduct += breakOverlapMinutes;
          }
        }
      }
    }

    const effectiveWorkMinutes = Math.max(0, rawSpanMinutes - breakMinutesToDeduct);

    if (meta.isHolidayAllowNormal) {
      // ALLOW_NORMAL: effective time → overtime, worked = 0
      finalWorkedMinutes = 0;
      overtimeMinutes = effectiveWorkMinutes;
      earlyOvertimeMinutes = 0;
      // Recalculate OT data with effective time
      const otRes = getRateIdAndAmount(5, 1, effectiveWorkMinutes, dailyWage, hourlyWage);
      lateOtData = { minutes: effectiveWorkMinutes, amount: otRes.amount, rate: otRes.rate, calculation_type: otRes.rateId };
      earlyOtData = { rate: 0, amount: 0, minutes: 0, calculation_type: 5 };
    } else if (meta.isHolidayCompOff) {
      // --- COMP_OFF REFINEMENT ---
      // Distribute effectiveWorkMinutes between regular worked_minutes (for credit) and overtime_minutes
      const minCompOff = template ? (template.comp_off_min_working_mins || 0) : 0;
      const maxCompOff = template ? (template.comp_off_max_working_mins || 0) : 0;
      const fullShiftMins = expectedShiftWorkMinutes || 480;
      const halfShiftMins = fullShiftMins / 2;

      let worked = effectiveWorkMinutes;
      let ot = 0;
      let workedToSave = 0;

      if (worked < minCompOff) {
        ot = worked;
        workedToSave = 0;
      } else if (worked < maxCompOff) {
        workedToSave = halfShiftMins;
        ot = Math.max(0, worked - halfShiftMins);
      } else {
        workedToSave = fullShiftMins;
        ot = Math.max(0, worked - fullShiftMins);
      }

      finalWorkedMinutes = workedToSave;
      overtimeMinutes = ot;
      earlyOvertimeMinutes = 0;
      
      if (ot > 0) {
        const otRes = getRateIdAndAmount(5, 1, ot, dailyWage, hourlyWage);
        lateOtData = { minutes: ot, amount: otRes.amount, rate: otRes.rate, calculation_type: otRes.rateId };
      } else {
        lateOtData = { rate: 0, amount: 0, minutes: 0, calculation_type: 5 };
      }
      earlyOtData = { rate: 0, amount: 0, minutes: 0, calculation_type: 5 };
    }
  }

  let status = 5; // Default ABSENT
  let autoAbsentReason = null;

  // Determine working status based on punches and worked minutes
  const lastPunchType = punches[punches.length - 1]?.punch_type;
  if (lastPunchType === "IN") {
    // If last punch is IN, check if policy requires a punch out
    if (template && template.require_punch_out) {
      // Rule: Only mark ABSENT if the shift has already ended. 
      // Otherwise, they are considered "Currently Working".
      let hasShiftEnded = true;
      const today = dayjs().format("YYYY-MM-DD");

      if (shift && date === today) {
        let shiftEndTime = dayjs(`${date} ${shift.end_time}`);
        if (shift.is_night_shift || shift.end_time < shift.start_time) {
          shiftEndTime = shiftEndTime.add(1, 'day');
        }

        // If current time is before shift end + 2 hours buffer, treat as PRESENT (Working)
        if (dayjs().isBefore(shiftEndTime.add(2, 'hour'))) {
          hasShiftEnded = false;
        }
      } else if (!shift && date === today) {
        // No shift defined, and it's today. Avoid marking absent until the day is over.
        hasShiftEnded = false;
      }

      if (hasShiftEnded) {
        status = 9; // INCOMPLETE
        autoAbsentReason = "Incomplete: Mandatory punch-out missing";
      } else {
        status = 0; // PRESENT (Currently Working)
      }
    } else {
      status = 0; // PRESENT (Policy allows single punch)
    }
  } else {
    // Both IN and OUT exist (or at least last is OUT)
    const minHalfDay = shift ? shift.min_half_day_minutes : 240;
    const minFullDay = shift ? shift.min_full_day_minutes : 480;

    // ✅ Handle "Out of Shift Time" case: If employee works completely outside shift hours - check this FIRST
    if (shift && shiftWorkedMins === 0 && template) {
      meta.skipFineCalculation = true; // Flag to skip fine calculation
      meta.forceShiftIdNull = true; // Flag to set shift_id to null in attendance_day

      // Save original worked minutes before setting to 0
      const originalWorkedMinutes = finalWorkedMinutes;

      // Mark as ABSENT, set worked time to 0, fines to 0
      status = 5; // ABSENT
      autoAbsentReason = `Auto Absent: Worked time (${originalWorkedMinutes}m) outside shift hours`;
      finalWorkedMinutes = 0;
      lateMinutes = 0;
      earlyOutMinutes = 0;
      fineAmount = 0;
      fineMinutes = 0;
      fineData = {
        late_entry: { minutes: 0, amount: 0, rate: 0, calculation_type: 5 },
        early_exit: { minutes: 0, amount: 0, rate: 0, calculation_type: 5 },
        excess_breaks: { minutes: 0, amount: 0, rate: 0, calculation_type: 5 }
      };

      // All punch time goes to overtime (capped at max_overtime_mins if set)
      if (template.max_overtime_mins > 0) {
        overtimeMinutes = Math.min(originalWorkedMinutes, template.max_overtime_mins);
      } else {
        overtimeMinutes = originalWorkedMinutes;
      }
    }
    // Special handling for holidays - if holiday and worked, set HOLIDAY status
    // For ALLOW_NORMAL and COMP_OFF: set Present (0) instead of Holiday (4) if any work performed
    else if (meta.isHolidayCompOff && (finalWorkedMinutes > 0 || overtimeMinutes > 0)) {
      status = 0;
      // autoAbsentReason = `Present on Holiday (COMP_OFF): Worked ${finalWorkedMinutes}m, OT ${overtimeMinutes}m`;
    } else if (meta.isHolidayAllowNormal && overtimeMinutes > 0) {
      status = 0;
      // autoAbsentReason = `Present on Holiday (ALLOW_NORMAL): OT ${overtimeMinutes}m`;
    } else if (meta.isHoliday && overtimeMinutes > 0) {
      status = 4; // HOLIDAY
      autoAbsentReason = `Worked on Holiday: ${overtimeMinutes}m overtime`;
    } else if (!shift && overtimeMinutes > 0) {
      // ✅ Handle "No Shift" case: If employee works without shift, mark as PRESENT
      status = 0;
      autoAbsentReason = `Worked without shift: ${overtimeMinutes}m overtime`;
    } else if (finalWorkedMinutes >= minFullDay) {
      status = 0; // PRESENT
    } else if (finalWorkedMinutes >= minHalfDay) {
      status = 1; // HALF_DAY
      autoAbsentReason = `Auto Half Day: Worked time (${finalWorkedMinutes}m) between half-day (${minHalfDay}m) and full-day (${minFullDay}m) thresholds`;
    } else {
      status = 5; // ABSENT (Worked minutes below half-day threshold)
      autoAbsentReason = `Auto Absent: Worked time (${finalWorkedMinutes}m) below threshold (${minHalfDay}m)`;
    }
  }

  // OT minutes are already synced within the rule calculation blocks using trimmed values

  // Prevent Status Downgrade (User Request: "don't let it to change my status")
  // If existing status is Present/HalfDay, don't revert to Absent/HalfDay just because of minutes calculation
  const existingDayForStatus = meta.existingDay || await commonQuery.findOneRecord(AttendanceDay, {
    employee_id: employeeId,
    attendance_date: date,
  }, { attributes: ['status'] }, transaction, false, {});
  
  if (existingDayForStatus) {
    // If preserveStatus is set (e.g. Manual Punch), strictly keep the existing status
    if (meta.preserveStatus) {
      status = existingDayForStatus.status;
    }
    // Otherwise apply downgrade prevention logic
    else if ([12].includes(existingDayForStatus.status) && [1, 5, 13].includes(status)) {
      status = existingDayForStatus.status; // Keep Present or Out Duty
    } else if ([1, 13].includes(existingDayForStatus.status) && status === 5) {
      status = existingDayForStatus.status; // Keep Half Day or Half Out Duty
    }
  }
  if (meta.forcedStatus !== undefined) {
    status = meta.forcedStatus;
    if (meta.overrideAutomationNote) {
      autoAbsentReason = meta.overrideAutomationNote;
    }

    // Override fines and worked minutes for automated approvals (e.g. Short Leave treated as Present)
    if (status === 0 || status === 1) { // 0: Present, 1: Half Day
      if (status === 0) {
        finalWorkedMinutes = shift ? (shift.min_full_day_minutes || 480) : 480;
      } else if (status === 1) {
        finalWorkedMinutes = shift ? (shift.min_half_day_minutes || 240) : 240;
      }
    }
  }

  // [User Request] If status is Half-Day (1), do not calculate or store fines
  if (status === 1) {
    lateMinutes = 0;
    earlyOutMinutes = 0;
    fineAmount = 0;
    fineMinutes = 0;
    fineData = {
      late_entry: { minutes: 0, amount: 0, rate: 0, calculation_type: 5 },
      early_exit: { minutes: 0, amount: 0, rate: 0, calculation_type: 5 },
      excess_breaks: { minutes: 0, amount: 0, rate: 0, calculation_type: 5 }
    };
  }

  const existingDay2 = await commonQuery.findOneRecord(AttendanceDay, {
    employee_id: employeeId,
    attendance_date: date,
  }, {}, transaction, false, {});

  // ✅ Final check: If skipFineCalculation flag is set, ensure all values are 0
  if (meta.skipFineCalculation) {
    if (status !== 12 && status !== 13) {
      finalWorkedMinutes = 0;
    }
    lateMinutes = 0;
    earlyOutMinutes = 0;
    fineAmount = 0;
    fineMinutes = 0;
    fineData = {
      late_entry: { minutes: 0, amount: 0, rate: 0, calculation_type: 5 },
      early_exit: { minutes: 0, amount: 0, rate: 0, calculation_type: 5 },
      excess_breaks: { minutes: 0, amount: 0, rate: 0, calculation_type: 5 }
    };
  }

  // ✅ Skip fine and overtime calculations for full-day out-duty (status 12 only)
  // Half-day out-duty (status 13) allows fine/overtime calculations
  const isFullDayOutDuty = (status === 12);
  if (isFullDayOutDuty) {
    fineAmount = 0;
    fineMinutes = 0;
    fineData = {
      late_entry: { minutes: 0, amount: 0, rate: 0, calculation_type: 5 },
      early_exit: { minutes: 0, amount: 0, rate: 0, calculation_type: 5 },
      excess_breaks: { minutes: 0, amount: 0, rate: 0, calculation_type: 5 }
    };
    lateOtData = { rate: 0, amount: 0, minutes: 0, calculation_type: 5 };
    earlyOtData = { rate: 0, amount: 0, minutes: 0, calculation_type: 5 };
  }

  const attendancePayload = {
    employee_id: employeeId,
    attendance_date: date,
    shift_id: meta.forceShiftIdNull ? null : (shift ? shift.id : null),
    first_in: firstIn ? dayjs(firstIn.punch_time).format("HH:mm:ss") : null,
    last_out: lastOut ? dayjs(lastOut.punch_time).format("HH:mm:ss") : null,
    worked_minutes: Math.floor(finalWorkedMinutes),
    fine_minutes: (fineData.late_entry?.minutes || 0) + (fineData.early_exit?.minutes || 0) + (fineData.excess_breaks?.minutes || 0),
    total_break_minutes: totalBreakMinutes,
    overtime_minutes: (parseInt(lateOtData.minutes || 0) + parseInt(earlyOtData.minutes || 0)),
    overtime_amount: parseFloat((parseFloat(lateOtData.amount || 0) + parseFloat(earlyOtData.amount || 0)).toFixed(2)),
    overtime_data: (
      (lateOtData.minutes === 0 && lateOtData.amount === 0 && lateOtData.rate === 0) &&
      (earlyOtData.minutes === 0 && earlyOtData.amount === 0 && earlyOtData.rate === 0)
    ) ? null : { late_ot: lateOtData, early_ot: earlyOtData },
    fine_data: (
      (fineData.late_entry.minutes === 0 && fineData.late_entry.amount === 0) &&
      (fineData.early_exit.minutes === 0 && fineData.early_exit.amount === 0) &&
      (fineData.excess_breaks.minutes === 0 && fineData.excess_breaks.amount === 0)
      // (fineData.shortage.minutes === 0 && fineData.shortage.amount === 0)
    ) ? null : fineData,
    fine_amount: parseFloat(fineAmount.toFixed(2)),
    status: status,
    user_id: meta.user_id || 0,
    branch_id: meta.branch_id || employee.branch_id,
    company_id: meta.company_id || employee.company_id,
    note: (function () {
      let effectiveAutoReason = autoAbsentReason;
      // If we are now PRESENT/HALF_DAY, ignore negative auto reasons (e.g. from downgrade prevention)
      if ([0, 1, 12, 13].includes(status) && effectiveAutoReason) {
        if (typeof effectiveAutoReason === 'string' && (effectiveAutoReason.startsWith("Auto Absent:") || effectiveAutoReason.startsWith("Incomplete:"))) {
          effectiveAutoReason = null;
        }
      }

      if (effectiveAutoReason) return effectiveAutoReason;
      if (meta.note) return meta.note;

      const existingNote = existingDay2?.note || null;
      if ([0, 1, 12, 13].includes(status) && existingNote && typeof existingNote === 'string') {
        if (existingNote.startsWith("Auto Absent:") || existingNote.startsWith("Incomplete:")) {
          return null;
        }
      }
      return existingNote;
    })()
  };

  // Attach leave category if status is Leave/Half-day OR if forced by automation (e.g. Short Leave marked as Present)
  if ([0, 1, 6, 12, 13].includes(status) && meta.leave_category_id) {
    attendancePayload.leave_category_id = meta.leave_category_id;
    attendancePayload.leave_session = meta.leave_session || existingDay2?.leave_session;
  } else if ([1, 6].includes(status)) {
    attendancePayload.leave_category_id = meta.leave_category_id || existingDay2?.leave_category_id;
    attendancePayload.leave_session = meta.leave_session || existingDay2?.leave_session;
  }
  else {
    // Explicitly clear leave category/session when day is set to Present/Absent/Other
    attendancePayload.leave_category_id = null;
    attendancePayload.leave_session = null;
  }

  if (existingDay2) {
    // [User Request] Skip rebuild for past finalized data if automated
    // Automated/Cron runs use user_id 0 or undefined. We only allow rebuilding if current status is Absent (5) or Incomplete (9).
    const isCronRun = (meta.user_id === 0 || meta.user_id === undefined);
    const isSpecialStatus = [5, 9].includes(parseInt(existingDay2.status));

    if (isCronRun && !isSpecialStatus && !meta.forceRebuild) {
      console.log(`[Rebuild] Skipping automated rebuild for finalized record ${existingDay2.id} (Status: ${existingDay2.status}) for ${employeeId} on ${date}`);
      return;
    }

    const error = await syncAttendanceToLeaveBalance(employeeId, existingDay2, attendancePayload, transaction, employee);
    if (error) throw new Err(error);
    console.log(`[Rebuild] Updating existing day record ${existingDay2.id} with status ${status}...`);
    await commonQuery.updateRecordById(AttendanceDay, existingDay2.id, attendancePayload, transaction, false, { company_id: true });
  } else {
    const error = await syncAttendanceToLeaveBalance(employeeId, null, attendancePayload, transaction, employee);
    if (error) throw new Err(error);
    console.log(`[Rebuild] Creating new day record for ${employeeId} on ${date} with status ${status}...`);
    await commonQuery.createRecord(AttendanceDay, attendancePayload, transaction);
  }
}

async function manualPunch(employeeId, date, inTime, outTime, meta, transaction = null) {
  // 0. Fetch employee early for metadata and policy checks
  const employee = meta.employee || await commonQuery.findOneRecord(Employee, employeeId, {
    include: [
      { model: EmployeeAttendanceTemplate, where: { status: 0 }, as: "employeeAttendanceTemplate", required: false },
      { model: AttendanceTemplate, as: "attendanceTemplate", required: false }
    ],
  }, transaction, false, { company_id: true });

  const commonMeta = {
    user_id: meta.user_id || 0,
    company_id: meta.company_id || (employee ? employee.company_id : 0),
    branch_id: meta.branch_id || (employee ? employee.branch_id : 0),
    device_id: meta.device_id,
  };

  let shift = null;
  if (meta.shift_id) {
    shift = await commonQuery.findOneRecord(ShiftTemplate, { id: meta.shift_id, company_id: commonMeta.company_id, branch_id: commonMeta.branch_id, status: 0 }, {}, transaction, false, {});
  }

  if (!shift && commonMeta.branch_id && parseInt(commonMeta.branch_id) !== parseInt(employee?.branch_id)) {
    const pTime = inTime ? parseDateTime(inTime, date) : (outTime ? parseDateTime(outTime, date) : new Date(date));
    shift = await findMatchingShift(commonMeta.branch_id, commonMeta.company_id, pTime, transaction);
  }

  const attendanceDay = meta.existingDay || await commonQuery.findOneRecord(AttendanceDay, {
    employee_id: employeeId,
    attendance_date: date,
    company_id: commonMeta.company_id, // Added tenant check
  }, {}, transaction);

  if (!attendanceDay) {
    throw {
      handled: true,
      message: "Attendance Day record not found."
    };
  }
  const dayId = attendanceDay.id;
  // Update attendance day with the resolved shift and branch
  if (shift && attendanceDay.shift_id != shift.id) {
    await commonQuery.updateRecordById(AttendanceDay, dayId, { 
        shift_id: shift.id,
        branch_id: commonMeta.branch_id || attendanceDay.branch_id
    }, transaction, true, { company_id: true });
    
    attendanceDay.shift_id = shift.id;
    attendanceDay.branch_id = commonMeta.branch_id || attendanceDay.branch_id;
  }

  const findPunchByDayId = async (type, orderDir = "ASC") => {
    return await commonQuery.findOneRecord(AttendancePunch, {
      employee_id: employeeId,
      day_id: dayId, // Strictly searching by Day ID
      punch_type: type,
      status: 0
    }, {
      order: [["punch_time", orderDir]] // ASC for First IN, DESC for Last OUT
    }, transaction, true, { company_id: true });
  };

  // 1. Policy Validation: Block Attendance on Holidays/Weekly Off if Strict
  if (employee) {
    const template = employee.employeeAttendanceTemplate || employee.attendanceTemplate;
    if (template && template.holiday_policy === "BLOCK_ATTENDANCE") {
      const { isHoliday, isWeeklyOff } = await getDayOffInfo(employee, date, transaction);
      if (isHoliday || isWeeklyOff) {
        throw new Err(`Attendance is blocked on ${isHoliday ? 'Holidays' : 'Weekly Offs'} (Strict Policy)`);
      }
    }
  }

  // Support for Multiple Punches
  if (meta.punches && Array.isArray(meta.punches)) {
    // Clear all existing and unassigned punches for this employee on this date to ensure a clean state
    await commonQuery.hardDeleteRecords(AttendancePunch, { 
      [Op.or]: [
        { day_id: dayId },
        {
          day_id: null,
          employee_id: employeeId,
          punch_time: {
            [Op.between]: [`${date} 00:00:00`, `${date} 23:59:59`],
          }
        }
      ],
      status: 0 
    }, transaction, { company_id: true });

    // Create new punches from array
    for (const p of meta.punches) {
      if (!p.punch_time) continue;
      await commonQuery.createRecord(AttendancePunch, {
        employee_id: employeeId,
        day_id: dayId,
        punch_type: p.punch_type,
        punch_time: parseDateTime(p.punch_time, date),
        ...commonMeta
      }, transaction, { company_id: true });
    }
  } else {
    // [NEW] Clear existing punches if new times are provided, to ensure a clean state
    if (inTime !== undefined || outTime !== undefined) {
      console.log(`[manualPunch] Clearing all existing and unassigned punches for day ID ${dayId} / Date ${date} before creating new times.`);
      await commonQuery.hardDeleteRecords(AttendancePunch, { 
        [Op.or]: [
          { day_id: dayId },
          {
            day_id: null,
            employee_id: employeeId,
            punch_time: {
              [Op.between]: [`${date} 00:00:00`, `${date} 23:59:59`],
            }
          }
        ],
        status: 0 
      }, transaction, { company_id: true });
    }

    if (inTime && outTime) {
      const inDateObj = parseDateTime(inTime, date);
      const outDateObj = parseDateTime(outTime, date);
      const gap = dayjs(outDateObj).diff(dayjs(inDateObj), "minute", true);

      if (Math.abs(gap) < 2) {
        throw {
          handled: true,
          message: "Please wait at least 2 minutes between IN and OUT time"
        };
      }
      if (gap < 0) {
        throw {
          handled: true,
          message: "OUT time must be after IN time"
        };
      }
    }

    // 2. Handle IN punch
    if (inTime) {
      const inDateObj = parseDateTime(inTime, date);

      const existingIn = await findPunchByDayId("IN", "ASC");

      if (existingIn) {
        // Update existing IN punch
        await commonQuery.updateRecordById(AttendancePunch, { id: existingIn.id }, {
          punch_time: inDateObj,
          ...commonMeta
        }, transaction, false, { company_id: true });
      } else {
        // Create new IN punch with gap validation
        await commonQuery.createRecord(AttendancePunch, {
          employee_id: employeeId,
          day_id: dayId,
          punch_type: "IN",
          punch_time: inDateObj,
          ...commonMeta,
        }, transaction, { company_id: true });
      }
    }

    // 3. Handle OUT punch
    if (outTime) {
      const outDateObj = parseDateTime(outTime, date);
      // Find LAST OUT punch
      const existingOut = await findPunchByDayId("OUT", "DESC");

      if (existingOut) {
        // Update existing OUT punch
        await commonQuery.updateRecordById(AttendancePunch, { id: existingOut.id }, {
          punch_time: outDateObj,
          ...commonMeta
        }, transaction, false, { company_id: true });
      } else {
        // Create new OUT punch with validations
        await commonQuery.createRecord(AttendancePunch, {
          employee_id: employeeId,
          day_id: dayId,
          punch_type: "OUT",
          punch_time: outDateObj,
          ...commonMeta,
        }, transaction, { company_id: true });
      }
    }
  }

  // 4. Rebuild day
  if (!meta.skipRebuild) {
    const preserveStatus = (meta.preserveStatus !== undefined) ? meta.preserveStatus : true;
    await rebuildAttendanceDay(
      employeeId,
      date,
      { ...meta, forceRebuild: true, shift_id: shift ? shift.id : meta.shift_id, preserveStatus, isHoliday: meta.isHoliday },
      transaction
    );
  }
}
/**
 * Detects if a specific date is a Holiday or Weekly Off for an employee.
 */
async function getDayOffInfo(employee, date, transaction) {
  const res = { isHoliday: false, isWeeklyOff: false, holidayDetails: null };
  if (!employee) return res;

  // Holiday Check
  const holiday = await commonQuery.findOneRecord(EmployeeHoliday, {
    employee_id: employee.id,
    date: date,
    status: 0,
  }, {}, transaction, true, {});
  if (holiday) {
    res.isHoliday = true;
    res.holidayDetails = holiday;
  }
  // Weekly Off Check
  const d = dayjs(date);
  const dayOfWeek = d.day();
  const dayOfMonth = d.date();
  const weekNo = Math.ceil(dayOfMonth / 7);

  const weeklyOff = await commonQuery.findOneRecord(EmployeeWeeklyOff, {
    employee_id: employee.id,
    day_of_week: dayOfWeek,
    [Op.or]: [{ week_no: 0 }, { week_no: weekNo }],
    is_off: true,
    status: 0
  }, {}, transaction, true, {});
  if (weeklyOff) res.isWeeklyOff = true;

  return res;
}

/**
 * Syncs Compensatory Off credits based on working on holidays/weekly offs.
 */
async function syncCompOffCredit(employee, date, status, transaction, attendanceDay = null) {
  if (!employee) return;
  const LeaveBalanceService = require("../services/leaveBalanceService");
  const template = employee.employeeAttendanceTemplate || employee.attendanceTemplate;
  if (!template || template.holiday_policy !== "COMP_OFF") return;

  const { isHoliday, isWeeklyOff } = await getDayOffInfo(employee, date, transaction);
  if (!isHoliday && !isWeeklyOff) return;

  let compOffCategory = await commonQuery.findOneRecord(LeaveTemplateCategory, {
    is_compoff: true,
    leave_template_id: employee.leave_template,
    status: 0
  }, {}, transaction, false, {});

  if (!compOffCategory) {
    compOffCategory = await commonQuery.findOneRecord(LeaveTemplateCategory, {
      is_compoff: true,
      company_id: -1,
      status: 0
    }, {}, transaction, false, false);
  }

  if (!compOffCategory) return;

  // Determine if it's a working state based on status OR worked time on non-working days
  let isWorkingStatus = [0, 1, 12, 13].includes(Number(status));
  
  // Important: If it's a Holiday (4) or Weekly Off (3), check if they actually worked (worked_minutes > 0 or has times)
  if (!isWorkingStatus && [3, 4].includes(Number(status))) {
    const workedMins = attendanceDay ? parseFloat(attendanceDay.worked_minutes || 0) : 0;
    const hasPunches = attendanceDay ? (attendanceDay.first_in || attendanceDay.last_out) : false;
    if (workedMins > 0 || hasPunches) {
      isWorkingStatus = true;
    }
  }

  const employeeId = employee.id;

  // Find existing credit record for this date
  const existingCompOff = await commonQuery.findOneRecord(LeaveRequest, {
    employee_id: employeeId,
    start_date: date,
    leave_category_id: compOffCategory.id,
    approval_status: constants.LEAVE_APPROVAL_STATUS.APPROVED,
    status: 0
  }, {}, transaction, false, {});

  if (isWorkingStatus) {
    const minCompOff = template ? (template.comp_off_min_working_mins || 0) : 0;
    const maxCompOff = template ? (template.comp_off_max_working_mins || 0) : 0;
    const workedMins = attendanceDay ? parseFloat(attendanceDay.worked_minutes || 0) : 0;

    let creditAmount = 0;
    if (workedMins >= maxCompOff) {
      creditAmount = 1.0;
    } else if (workedMins >= minCompOff) {
      creditAmount = 0.5;
    }

    if (creditAmount > 0) {
      if (existingCompOff) {
        // Handle Correction (e.g. Full Day vs Half Day change)
        if (parseFloat(existingCompOff.total_days) !== creditAmount) {
          const diff = creditAmount - parseFloat(existingCompOff.total_days);
          const error = await LeaveBalanceService.adjustLeaveBalance(employeeId, compOffCategory.id, -diff, transaction, date, employee, true);
          if (error) return error;
          await commonQuery.updateRecordById(LeaveRequest, existingCompOff.id, { total_days: creditAmount, request_type: 'CREDIT' }, transaction);
        }
      } else {
        // New Credit
        const error = await LeaveBalanceService.adjustLeaveBalance(employeeId, compOffCategory.id, -creditAmount, transaction, date, employee, true);
        if (error) return error;

        await commonQuery.createRecord(LeaveRequest, {
          employee_id: employeeId,
          leave_category_id: compOffCategory.id,
          start_date: date,
          end_date: date,
          total_days: creditAmount,
          request_type: 'CREDIT',
          reason: `Comp Off earned for working on ${isHoliday ? 'Holiday' : 'Weekly Off'}`,
          approval_status: constants.LEAVE_APPROVAL_STATUS.APPROVED,
          approved_by: 0,
          company_id: employee.company_id,
          branch_id: employee.branch_id,
          user_id: 0,
          status: 0
        }, transaction);
      }
    } else if (existingCompOff) {
      // Remove Credit if status changed to non-working or worked time below minimum
      const error = await LeaveBalanceService.adjustLeaveBalance(employeeId, compOffCategory.id, parseFloat(existingCompOff.total_days), transaction, date, employee, true);
      if (error) return error;
      await commonQuery.softDeleteById(LeaveRequest, { id: existingCompOff.id }, transaction, false, {});
    }
  } else if (existingCompOff) {
    // Remove Credit if status changed to non-working (e.g. Absent)
    const error = await LeaveBalanceService.adjustLeaveBalance(employeeId, compOffCategory.id, parseFloat(existingCompOff.total_days), transaction, date, employee, true);
    if (error) return error;
    await commonQuery.softDeleteById(LeaveRequest, { id: existingCompOff.id }, transaction, false, {});
  }
}

/**
 * Syncs attendance status shifts to employee leave balance and history (LeaveRequest).
 * Comparison between OLD state and NEW state of the day.
 */
async function syncAttendanceToLeaveBalance(employeeId, oldDay, newDay, transaction, employee = null) {
  const LeaveBalanceService = require("../services/leaveBalanceService");
  const getDeduction = (status) => {
    if (Number(status) === 6) return 1.0; // LEAVE
    if (Number(status) === 1) return 0.5; // HALF_DAY
    return 0;
  };

  const date = (newDay && newDay.attendance_date) ? newDay.attendance_date : (oldDay ? oldDay.attendance_date : null);
  if (!date) return;

  const oldStatus = oldDay ? Number(oldDay.status) : null;
  const oldCategoryId = oldDay ? oldDay.leave_category_id : null;
  const oldDeduction = (oldCategoryId && oldStatus !== null) ? getDeduction(oldStatus) : 0;

  const newStatus = newDay ? Number(newDay.status) : null;
  const newCategoryId = newDay ? newDay.leave_category_id : null;
  const newDeduction = (newCategoryId && newStatus !== null) ? getDeduction(newStatus) : 0;

  // --- COMP-OFF CREDIT LOGIC ---
  if (!employee) {
    employee = await commonQuery.findOneRecord(Employee, employeeId, {
      include: [
        { model: EmployeeAttendanceTemplate, where: { status: 0 }, as: "employeeAttendanceTemplate", required: false },
        { model: AttendanceTemplate, as: "attendanceTemplate", required: false }
      ],
    }, transaction, false, {});
  }

  if (employee) {
    const error = await syncCompOffCredit(employee, date, newStatus !== null ? newStatus : oldStatus, transaction, newDay || oldDay);
    if (error) return error;
  }

  // CASE 1: Status changed AWAY from Leave/HalfDay (Refund)
  if (oldDeduction > 0 && newDeduction === 0) {
    return await LeaveBalanceService.syncLeaveRecord(employeeId, date, oldCategoryId, 0, transaction, employee);
  }
  // CASE 2: Status is NOW Leave/HalfDay (Deduct/Create)
  else if (newDeduction > 0) {
    // Even if oldDeduction was > 0, syncLeaveRecord handles updates (Category/Amount change)
    return await LeaveBalanceService.syncLeaveRecord(employeeId, date, newCategoryId, newDeduction, transaction, employee);
  }
}

/**
 * Bulk sync attendance records for WO/Holiday/Leave for a set of employees.
 * This is 100x faster than calling rebuildAttendanceDay in a loop.
 */
async function bulkSyncAttendanceDays(employeeIds, date, meta = {}, transaction = null) {
  if (!employeeIds.length) return;

  // 1. Fetch existing records to skip
  const existingRecords = await commonQuery.findAllRecords(
    AttendanceDay,
    {
      attendance_date: date,
      employee_id: { [Op.in]: employeeIds },
      status: { [Op.ne]: 2 }
    },
    {
      attributes: ['employee_id'],
      transaction
    }
  );
  const existingEmpIds = new Set(existingRecords.map(r => r.employee_id));
  const missingEmpIds = employeeIds.filter(id => !existingEmpIds.has(id));

  if (missingEmpIds.length === 0) return;

  // 2. Fetch employees for mapping (mostly for company/branch context and default shift)
  const [employees, employeeShifts] = await Promise.all([
    commonQuery.findAllRecords(
      Employee,
      { id: { [Op.in]: missingEmpIds } },
      {
        attributes: ['id', 'company_id', 'branch_id', 'shift_template'],
        include: [
          {
            model: EmployeeAttendanceTemplate,
            as: "employeeAttendanceTemplate",
            where: { status: 0 },
            required: false
          },
          {
            model: AttendanceTemplate,
            as: "attendanceTemplate",
            required: false
          },
          {
            model: ShiftTemplate,
            as: "shiftTemplate",
            attributes: ['id', 'start_time', 'end_time', 'is_night_shift'],
            required: false
          }
        ],
        transaction
      }
    ),
    commonQuery.findAllRecords(
      EmployeeShift,
      {
        employee_id: { [Op.in]: missingEmpIds },
        day_of_week: dayjs(date).day(),
        status: 0
      },
      {},
      transaction
    )
  ]);

  const empShiftMap = new Map(employeeShifts.map(s => [s.employee_id, s]));

  // 3. Fetch all potential non-working day triggers in bulk
  const [holidays, weeklyOffs, leaveRequests, outDutyRequests] = await Promise.all([
    commonQuery.findAllRecords(
      EmployeeHoliday,
      {
        employee_id: { [Op.in]: missingEmpIds },
        date,
        status: 0
      },
      {},
      transaction
    ),
    commonQuery.findAllRecords(
      EmployeeWeeklyOff,
      {
        employee_id: { [Op.in]: missingEmpIds },
        day_of_week: dayjs(date).day(),
        status: 0,
        is_off: true,
        [Op.or]: [{ week_no: 0 }, { week_no: Math.ceil(dayjs(date).date() / 7) }]
      },
      {},
      transaction
    ),
    commonQuery.findAllRecords(
      LeaveRequest,
      {
        employee_id: { [Op.in]: missingEmpIds },
        start_date: { [Op.lte]: date },
        end_date: { [Op.gte]: date },
        approval_status: constants.LEAVE_APPROVAL_STATUS.APPROVED,
        status: 0
      },
      {},
      transaction
    ),
    commonQuery.findAllRecords(
      OutDutyRequest,
      {
        employee_id: { [Op.in]: missingEmpIds },
        start_date: { [Op.lte]: date },
        end_date: { [Op.gte]: date },
        approval_status: constants.OUT_DUTY_STATUS.APPROVED,
        status: 0
      },
      {},
      transaction
    )
  ]);

  // MAPS: employeeId -> Record
  const holidayMap = new Map(holidays.map(h => [h.employee_id, h]));
  const weeklyOffMap = new Map(weeklyOffs.map(w => [w.employee_id, w]));
  const leaveMap = new Map(leaveRequests.map(l => [l.employee_id, l]));
  const outDutyMap = new Map(outDutyRequests.map(o => [o.employee_id, o]));

  const payloads = [];
  for (const emp of employees) {
    let status = null;
    let leave_cat = null;
    let note = null;

    if (outDutyMap.has(emp.id)) {
      status = 12; // OUT_DUTY
      // note = "System: Out Duty auto-detected";
    } else if (leaveMap.has(emp.id)) {
      status = 6; // LEAVE
      leave_cat = leaveMap.get(emp.id).leave_category_id;
      // note = "System: Leave auto-detected";
    } else if (holidayMap.has(emp.id)) {
      status = 4; // HOLIDAY
      // note = `System: Holiday auto-detected (${holidayMap.get(emp.id).name || 'Holiday'})`;
    } else if (weeklyOffMap.has(emp.id)) {
      status = 3; // WEEKLY_OFF
      // note = "System: Weekly Off auto-detected";
    } else {
      const template = emp.employeeAttendanceTemplate || emp.attendanceTemplate;
      if (template?.auto_mark_absent) {
        // Preference: EmployeeShift > Default ShiftTemplate
        const eShift = empShiftMap.get(emp.id);
        const shift = eShift || emp.shiftTemplate;

        const buffer = parseInt(template.auto_absent_buffer_days || 0);
        const markDate = dayjs(date).startOf('day');
        const today = dayjs().startOf('day');
        const now = dayjs();

        // Case 1: Past date (beyond buffer days)
        if (markDate.isBefore(today.subtract(buffer, 'day'))) {
          status = 5; // ABSENT
          // note = "System: Auto Absent (Policy)";
        }
        // Case 2: Shift ended (even for today or recent past)
        else if (shift && shift.end_time) {
          let shiftEnd = dayjs(`${date} ${shift.end_time}`);
          if (shift.is_night_shift || shift.end_time < shift.start_time) {
            shiftEnd = shiftEnd.add(1, 'day');
          }

          if (now.isAfter(shiftEnd)) {
            status = 5; // ABSENT
            // note = "System: Auto Absent (Shift Ended)";
          }
        }
      }
    }

    if (status) {
      payloads.push({
        employee_id: emp.id,
        attendance_date: date,
        status,
        leave_category_id: leave_cat,
        company_id: meta.company_id || emp.company_id,
        branch_id: meta.branch_id || emp.branch_id,
        user_id: meta.user_id || 0,
        note: note,
        created_at: new Date(),
        updated_at: new Date()
      });
    }
  }

  if (payloads.length > 0) {
    await commonQuery.bulkCreate(AttendanceDay, payloads, {}, transaction);
  }
}
module.exports = {
  punch,
  rebuildAttendanceDay,
  manualPunch,
  getOrCreateAttendanceDay,
  syncAttendanceToLeaveBalance,
  bulkSyncAttendanceDays,
  getDayOffInfo
};
