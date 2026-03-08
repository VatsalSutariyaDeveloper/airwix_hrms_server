const { Op } = require("sequelize");
const { AttendanceDay, AttendancePunch, Employee, AttendanceTemplate, HolidayTransaction, EmployeeShift, WeeklyOffTemplateDay, LeaveRequest, ShiftTemplate, EmployeeSalaryTemplate, EmployeeHoliday, EmployeeWeeklyOff, ShiftBreak, EmployeeAttendanceTemplate, LeaveTemplateCategory } = require("../models");
const commonQuery = require("./commonQuery");
const { Err } = require("./Err");
const dayjs = require("dayjs");
const { constants } = require("./constants");
// LeaveBalanceService is required lazily inside functions to avoid circular dependencies with attendanceHelper
// const LeaveBalanceService = require("../services/leaveBalanceService");

/**
 * Helper to parse time/datetime
 * If input is "2026-01-27 09:00:00", it uses that directly.
 * If input is "09:00:00", it prepends the provided baseDate.
 */
const parseDateTime = (timeStr, baseDate) => {
  if (!timeStr) return null;
  // Check if it's already a full date-time string (contains '-' or 'T')
  if (timeStr.includes("-") || timeStr.includes("T")) {
    return dayjs(timeStr).toDate();
  }
  if (timeStr.includes("-") || timeStr.includes("T") || timeStr.includes("/")) {
    return dayjs(timeStr).toDate();
  }
  return dayjs(`${baseDate} ${timeStr}`).toDate();
};

/**
 * Get or Create Attendance Day
 * Ensures robust finding/creating of the day record.
 */
async function getOrCreateAttendanceDay(employeeId, date, meta = {}, transaction = null) {
  const existingDay = await commonQuery.findOneRecord(AttendanceDay, {
    employee_id: employeeId,
    attendance_date: date,
  }, {}, transaction);

  if (existingDay) return existingDay;

  // Determine initial status based on holiday/weekly off/etc.
  // For now, default to ABSENT (5) or based on simple logic, 
  // but rebuildAttendanceDay usually handles strictly setting the status correctly later.
  // We just need the record to exist for day_id.

  const payload = {
    employee_id: employeeId,
    attendance_date: date,
    status: 5, // Default ABSENT
    user_id: meta.user_id || 0,
    company_id: meta.company_id || 0,
    branch_id: meta.branch_id || 0,
  };

  return await commonQuery.createRecord(AttendanceDay, payload, transaction);
}

async function punch(employeeId, meta, transaction = null) {
  const baseDate = dayjs().format("YYYY-MM-DD");
  const now = meta.punch_time ? parseDateTime(meta.punch_time, baseDate) : new Date();
  const today = dayjs(now).format("YYYY-MM-DD");

  // 0️⃣ Ensure AttendanceDay Exists (Required for day_id)
  const attendanceDay = await commonQuery.findOneRecord(AttendanceDay, {
    employee_id: employeeId,
    attendance_date: today,
  }, {}, transaction);

  if (!attendanceDay) {
    throw {
      handled: true,
      message: { message: "Attendance Day record not found." }
    };
  }
  const dayId = attendanceDay.id;

  // 0️⃣ Fetch Employee with Attendance Template (Specific or Master)
  const employee = await commonQuery.findOneRecord(Employee, employeeId, {
    include: [
      { model: EmployeeAttendanceTemplate, where: { status: 0 }, as: "employeeAttendanceTemplate", required: false },
      { model: AttendanceTemplate, as: "attendanceTemplate", required: false }
    ],
  }, transaction);

  if (!employee) throw new Error("Employee not found");
  const template = employee.employeeAttendanceTemplate || employee.attendanceTemplate;
  // 1️⃣ Check Holiday & Weekly Off Policy
  if (template) {
    let isNonWorking = false;
    let nonWorkingType = "";

    // Check Holiday
    if (employee.holiday_template) {
      const isHoliday = await commonQuery.findOneRecord(HolidayTransaction, {
        template_id: employee.holiday_template,
        date: today,
        status: 0,
      }, {}, transaction, false, { company_id: true });
      if (isHoliday) {
        isNonWorking = true;
        nonWorkingType = "holiday";
      }
    }

    // Check Weekly Off
    if (!isNonWorking && employee.weekly_off_template) {
       const dayOfWeek = dayjs(now).day();
       const dayOfMonth = dayjs(now).date();
       const weekNo = Math.ceil(dayOfMonth / 7);

       const weeklyOff = await commonQuery.findOneRecord(WeeklyOffTemplateDay, {
         template_id: employee.weekly_off_template,
         day_of_week: dayOfWeek,
         [Op.or]: [{ week_no: 0 }, { week_no: weekNo }],
         is_off: true,
         status: 0,
       }, {}, transaction, false, { company_id: true });
       if (weeklyOff) {
         isNonWorking = true;
         nonWorkingType = "weekly off";
       }
    }

    if (isNonWorking && template.holiday_policy === "BLOCK_ATTENDANCE") {
      throw new Error(`Attendance is blocked on ${nonWorkingType}s`);
    }
  }

  // 1️⃣.5️⃣ Fetch Shift & Validate Punch Restrictions
  const dayOfWeek = dayjs(now).day();
  const empShift = await commonQuery.findOneRecord(EmployeeShift, {
    employee_id: employeeId,
    day_of_week: dayOfWeek,
    status: 0,
  }, {}, transaction, false, { company_id: true });

  let shift = null;
  if (empShift) {
    shift = await commonQuery.findOneRecord(ShiftTemplate, empShift.shift_id, {}, transaction, false, { company_id: true });
  } else if (employee.shift_template) {
    shift = await commonQuery.findOneRecord(ShiftTemplate, employee.shift_template, {}, transaction, false, { company_id: true });
  }

  // 🛑 BLOCK PUNCH if no shift is assigned
  if (!shift) {
    throw new Err("Operation failed: Employee has no assigned shift. Punches cannot be recorded without a shift schedule.");
  }

  // Determine punch type (IN / OUT)
  // We need this to validate restrictions
  const lastPunch = await commonQuery.findOneRecord(AttendancePunch, {
    employee_id: employeeId,
    status: 0,
  }, {
    order: [["punch_time", "DESC"]],
  }, transaction);

  let punchType = meta.punch_type || "IN";
  if (!meta.punch_type) {
    if (lastPunch && lastPunch.punch_type === "IN") {
      const hoursSinceLastPunch = dayjs(now).diff(dayjs(lastPunch.punch_time), "hour", true);
      if (hoursSinceLastPunch < 24) {
        punchType = "OUT";
      }
    }
  }

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

  // 3️⃣ Validation: Every 'OUT' must have a preceding 'IN' within 24 hours
  if (punchType === "OUT") {
    if (!lastPunch || lastPunch.punch_type !== "IN") {
      throw new Err("Please punch IN first");
    }
    const hoursSinceLastPunch = dayjs(now).diff(dayjs(lastPunch.punch_time), "hour", true);
    if (hoursSinceLastPunch > 24) {
      throw new Err("Last punch IN was more than 24 hours ago. Please punch IN again.");
    }
  }

  // 4️⃣ Validation: Do not allow double IN
  if (punchType === "IN" && lastPunch && lastPunch.punch_type === "IN") {
    const hoursSinceLastPunch = dayjs(now).diff(dayjs(lastPunch.punch_time), "hour", true);
    if (hoursSinceLastPunch < 24) {
      throw new Err("You are already punched IN");
    }
  }

  // 5️⃣ Validation: Minimum 2 minutes gap between any consecutive punches
  // if (lastPunch) {
  //   const minutesSinceLastPunch = dayjs(now).diff(dayjs(lastPunch.punch_time), "minute", true);
  //   if (minutesSinceLastPunch < 2) {
  //     throw new Err("Please wait at least 2 minutes between punches");
  //   }
  // }

  // 4️⃣ Save raw punch
  const newPunch = await commonQuery.createRecord(AttendancePunch, {
    employee_id: employeeId,
    day_id: dayId,
    punch_type: punchType,
    punch_time: now,
    ...meta,
  }, transaction);

  // 5️⃣ Recalculate day attendance
  // Use the date from the punch itself for rebuild
  let dateToRebuild = dayjs(now).format("YYYY-MM-DD");
  if (punchType === "OUT" && lastPunch) {
    dateToRebuild = dayjs(lastPunch.punch_time).format("YYYY-MM-DD");
  }

  await rebuildAttendanceDay(employeeId, dateToRebuild, { ...meta, shift_id: shift ? shift.id : null }, transaction);

  return { punchType, punchTime: now, punchId: newPunch.id };
}

async function rebuildAttendanceDay(employeeId, date, meta = {}, transaction = null) {
  // --- Fetch Wages for Rate Calculation (At function start for global scope) ---
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
    { attributes: ['ctc_monthly', 'lwp_calculation_basis'] },
    transaction,
    false,
    { company_id: true }
  );

  if (employeeSalaryTemplate) {
    ctcMonthly = parseFloat(employeeSalaryTemplate.ctc_monthly || 0);
    if (employeeSalaryTemplate.lwp_calculation_basis === 'DAYS_IN_MONTH') {
      const d = dayjs(date);
      monthDays = d.daysInMonth();
    } else if (employeeSalaryTemplate.lwp_calculation_basis === 'WORKING_DAYS') {
      monthDays = 26;
    }
    if (monthDays > 0) {
      dailyWage = ctcMonthly / monthDays;
      hourlyWage = dailyWage / 8; 
    }
  }

  // Helper to map multiplier to ID
  const getRateIdAndAmount = (minutes, wage, multiplier) => {
    let rateId = 5; // Default 1x Salary
    const m = parseFloat(multiplier || 1);

    if (m === 1) rateId = 5;
    else if (m === 1.5) rateId = 6;
    else if (m === 2) rateId = 7;
    else if (m === 3) rateId = 8;
    else rateId = 2; // Fixed Per Hour for custom multipliers

    const amount = parseFloat(((minutes / 60) * wage * m).toFixed(2));
    return { rateId, amount };
  };

  if (meta.onlyCreateNonWorking && meta.skipIfPunchesExist) {
    const exists = await AttendanceDay.count({ where: { employee_id: employeeId, attendance_date: date, status: { [Op.ne]: 2 } }, transaction });
    if (exists > 0) return;
  }
  const employee = meta.employee || await commonQuery.findOneRecord(Employee, employeeId, {
    include: [
      { model: EmployeeAttendanceTemplate, where: { status: 0 }, as: "employeeAttendanceTemplate", required: false },
      { model: AttendanceTemplate, as: "attendanceTemplate", required: false }
    ],
  }, transaction);

  if (!employee) return;
  const template = employee.employeeAttendanceTemplate || employee.attendanceTemplate;

  // 0️⃣.A Check if record is locked
  const existingDay = meta.existingDay || await commonQuery.findOneRecord(AttendanceDay, {
    employee_id: employeeId,
    attendance_date: date,
  }, {}, transaction);

  if (existingDay && existingDay.is_locked) {
    console.log(`[Attendance] Day ${date} for emp ${employeeId} is locked. Skipping rebuild.`);
    return;
  }

  // Find all punches on the target date (including night shift crossover check if needed)
  const allDayPunches = meta.preFetchedPunches || await commonQuery.findAllRecords(AttendancePunch, {
    employee_id: employeeId,
    // [MOD] Search by day_id if available, otherwise by time range
    [Op.or]: [
      existingDay ? { day_id: existingDay.id } : null,
      { 
        day_id: null, // Only pick up 'unassigned' punches from the calendar date range
        punch_time: {
          [Op.between]: [`${date} 00:00:00`, `${date} 23:59:59`],
        }
      }
    ].filter(Boolean),
    status: 0,
  }, {
    order: [["punch_time", "ASC"]],
  }, transaction);

  const inPunches = allDayPunches.filter(p => p.punch_type === "IN");
  const hasPunches = allDayPunches.length > 0;

  const approvedLeave = (meta.preFetchedLeave !== undefined) ? meta.preFetchedLeave : await commonQuery.findOneRecord(LeaveRequest, {
    employee_id: employeeId,
    approval_status: constants.LEAVE_APPROVAL_STATUS.APPROVED,
    start_date: { [Op.lte]: date },
    end_date: { [Op.gte]: date },
    is_encashment: false,
    status: 0
  }, {}, transaction);

  // IF PUNCHES EXIST: Cancel any overlapping Leave
  if (hasPunches && approvedLeave) {
    if (approvedLeave.start_date === date && approvedLeave.end_date === date) {
      // Single day leave - Cancel it
      await LeaveBalanceService.syncLeaveRecord(employeeId, date, approvedLeave.leave_category_id, 0, transaction);
    } else {
      // Multi-day leave - Refund balance for THIS day and mark as cancelled (simplest way to fulfill user request)
      await LeaveBalanceService.adjustLeaveBalance(employeeId, approvedLeave.leave_category_id, -1, transaction);
      await commonQuery.updateRecordById(LeaveRequest, approvedLeave.id, {
        approval_status: constants.LEAVE_APPROVAL_STATUS.CANCELLED,
        note: `Auto-cancelled due to punch on ${date}`
      }, transaction);
    }
  }

  // IF NO PUNCHES and APPROVED LEAVE: Apply Leave and Return
  if (!hasPunches && approvedLeave) {
    const leavePayload = {
      employee_id: employeeId,
      attendance_date: date,
      status: 6, // LEAVE
      shift_id: null,
      leave_category_id: approvedLeave.leave_category_id,
      user_id: meta.user_id || 0,
      branch_id: meta.branch_id || 0,
      company_id: meta.company_id || 0,
    };

    const existingDay1 = await commonQuery.findOneRecord(AttendanceDay, {
      employee_id: employeeId,
      attendance_date: date,
    }, {}, transaction);

    if (existingDay1) {
      await syncAttendanceToLeaveBalance(employeeId, existingDay1, leavePayload, transaction);
      await commonQuery.updateRecordById(AttendanceDay, existingDay1.id, leavePayload, transaction);
    } else {
      await syncAttendanceToLeaveBalance(employeeId, null, leavePayload, transaction);
      await commonQuery.createRecord(AttendanceDay, leavePayload, transaction);
    }
    return;
  }

  // 1️⃣ Check if it's a Holiday
  let isHoliday = false;
  let holidayDetails = (meta.preFetchedHoliday !== undefined) ? meta.preFetchedHoliday : null;
  
  if (holidayDetails === null && employee.holiday_template && !meta.preFetchedHoliday) {
    holidayDetails = await commonQuery.findOneRecord(HolidayTransaction, {
      template_id: employee.holiday_template,
      date: date,
      status: 0,
    }, {}, transaction, false, { company_id: true });
  }
  if (holidayDetails) isHoliday = true;

  // 2️⃣ Check if it's a Weekly Off
  let isWeeklyOff = false;
  const dayOfWeek = meta.dayOfWeek !== undefined ? meta.dayOfWeek : dayjs(date).day();
  const dayOfMonth = dayjs(date).date();
  const weekNo = meta.weekNo !== undefined ? meta.weekNo : Math.ceil(dayOfMonth / 7);

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
    }, {}, transaction, false, { company_id: true });
    if (weeklyOff) isWeeklyOff = true;
  }

  // 3️⃣ Fetch assigned Shift for this employee and date
  const empShift = (meta.preFetchedEmpShifts) 
    ? meta.preFetchedEmpShifts.find(s => s.day_of_week === dayOfWeek)
    : await commonQuery.findOneRecord(EmployeeShift, {
        employee_id: employeeId,
        day_of_week: dayOfWeek,
        status: 0,
      }, {}, transaction, false, { company_id: true });

  const shiftInclude = [{ model: ShiftBreak, as: "ShiftBreaks" }];
  let shift = null;

  // Function to get shift from pre-fetched map or query
  const getShift = async (sId) => {
    if (meta.preFetchedShiftTemplates && meta.preFetchedShiftTemplates.has(sId)) {
        return meta.preFetchedShiftTemplates.get(sId);
    }
    return await commonQuery.findOneRecord(ShiftTemplate, sId, { include: shiftInclude }, transaction, false, { company_id: true });
  };

  // 1. Try provided shift_id from meta
  if (meta.shift_id) {
    shift = await getShift(meta.shift_id);
  }

  // 2. Fallback to specific EmployeeShift assignment for that date
  if (!shift && empShift) {
    if (empShift.shift_id) {
      shift = await getShift(empShift.shift_id);
    } else {
      // Manual shift defined in EmployeeShift
      shift = empShift;
    }
  }

  // 3. Fallback to employee's default shift template
  if (!shift && employee.shift_template) {
    shift = await getShift(employee.shift_template);
  }

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
        if (p.punch_type === "IN") {
            inP = p; // Start/Restart a block with the latest IN
        } else if (p.punch_type === "OUT" && inP) {
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
    }, { attributes: ['id', 'status', 'worked_minutes', 'late_minutes', 'early_out_minutes', 'overtime_minutes', 'early_overtime_minutes', 'total_break_minutes', 'overtime_data', 'fine_data', 'first_in', 'last_out', 'leave_category_id', 'leave_session', 'note'] }, transaction);

    // [MOD] Preserve existing status if it exists. 
    // This prevents auto-absent logic from overwriting manual updates like "Present" or "Half Day"
    // especially when Time Tracking is OFF.
    if (existingDay) {
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
      branch_id: meta.branch_id || 0,
      company_id: meta.company_id || 0,
      first_in: existingDay?.first_in || null,
      last_out: existingDay?.last_out || null,
      worked_minutes: finalNoPunchMinutes,
      overtime_minutes: (existingDay && existingDay.status === emptyStatus) ? (existingDay.overtime_minutes || 0) : 0,
      late_minutes: (existingDay && existingDay.status === emptyStatus) ? (existingDay.late_minutes || 0) : 0,
      early_out_minutes: (existingDay && existingDay.status === emptyStatus) ? (existingDay.early_out_minutes || 0) : 0,
      early_overtime_minutes: (existingDay && existingDay.status === emptyStatus) ? (existingDay.early_overtime_minutes || 0) : 0,
      total_break_minutes: (existingDay && existingDay.status === emptyStatus) ? (existingDay.total_break_minutes || 0) : 0,
      overtime_data: (existingDay && existingDay.status === emptyStatus) ? (existingDay.overtime_data || null) : null,
      fine_data: (existingDay && existingDay.status === emptyStatus) ? (existingDay.fine_data || null) : null,
      leave_category_id: null,
      leave_session: null,
      note: emptyStatus === 4 ? "System: Holiday restored (No punches found)" : (emptyStatus === 3 ? "System: Weekly Off restored (No punches found)" : (existingDay?.note || null))
    };

    if (existingDay) {
      // If manually adjusting status, incorporate the category/session from meta or preserve existing
      if ([1, 6].includes(emptyStatus)) {
        payload.leave_category_id = meta.leave_category_id || existingDay.leave_category_id;
        payload.leave_session = meta.leave_session || existingDay.leave_session;
      }

      await syncAttendanceToLeaveBalance(employeeId, existingDay, payload, transaction);
      await commonQuery.updateRecordById(AttendanceDay, existingDay.id, payload, transaction);
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
  const firstIn = punches.find(p => p.punch_type === "IN");
  const lastOut = [...punches].reverse().find(p => p.punch_type === "OUT");

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
  }

  // 1. Calculate Gross Minutes in each region (Shift, Early OT, Late OT)
  for (let i = 0; i < punches.length - 1; i++) {
    if (punches[i].punch_type === "IN" && punches[i + 1].punch_type === "OUT") {
      const pS = dayjs(punches[i].punch_time);
      const pE = dayjs(punches[i + 1].punch_time);

      if (shift) {
        if (meta.isHoliday) {
          // When it's a holiday, all work time should be treated as overtime
          const sessionMinutes = pE.diff(pS, "minute");
          lateOTMins += sessionMinutes;
        } else {
          // Normal shift logic
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
              lateOTMins += pE.diff(lOverlapStart, "minute");
            }
          }
        }
      } else {
        // No Shift or Holiday - All work time should be stored as overtime
        const sessionMinutes = pE.diff(pS, "minute");
        if (meta.isHoliday) {
          // When it's a holiday, all work time goes to overtime
          lateOTMins += sessionMinutes;
        } else {
          // No shift assigned on regular day - treat as overtime
          lateOTMins += sessionMinutes;
        }
      }
    }
  }

  // 2. Identify Actual Gaps (Break time between punch pairs)
  for (let i = 0; i < punches.length - 1; i++) {
    if (punches[i].punch_type === "OUT" && punches[i + 1].punch_type === "IN") {
      actualGapsMins += Math.round(dayjs(punches[i + 1].punch_time).diff(dayjs(punches[i].punch_time), "minute", true));
    }
  }

  // 3. Identify Scheduled Breaks (Unpaid intervals defined in shift)
  if (shift && shift.ShiftBreaks && Array.isArray(shift.ShiftBreaks) && firstIn && lastOut) {
    const pIn = dayjs(firstIn.punch_time);
    const pOut = dayjs(lastOut.punch_time);
    
    for (const sb of shift.ShiftBreaks) {
      if (sb.pay_type === "Unpaid" && sb.break_type === "Intervals") {
        if (sb.start_time && sb.end_time) {
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

            let coveredByGap = 0;
            for (let i = 0; i < punches.length - 1; i++) {
              if (punches[i].punch_type === "OUT" && punches[i + 1].punch_type === "IN") {
                const gS = dayjs(punches[i].punch_time);
                const gE = dayjs(punches[i + 1].punch_time);
                const overlapS = dayjs(Math.max(gS.valueOf(), intersectStart.valueOf()));
                const overlapE = dayjs(Math.min(gE.valueOf(), intersectEnd.valueOf()));
                if (overlapE.isAfter(overlapS)) coveredByGap += overlapE.diff(overlapS, "minute");
              }
            }
            scheduledBreaksMins += Math.max(0, Math.round(sbMins - coveredByGap));
          }
        }
      }
    }
  }

  totalBreakMinutes = actualGapsMins + scheduledBreaksMins;

  // 4. Final Break Deduction Logic
  let breakToDeduct = totalBreakMinutes;
  if (template) {
    if (template.break_rules?.length > 0) {
      const rule = template.break_rules.find(r => totalBreakMinutes >= r.from_mins && totalBreakMinutes <= r.to_mins);
      if (rule) breakToDeduct = Math.max(0, totalBreakMinutes - (parseFloat(rule.value) || 0));
    } else if (template.paid_break_duration_mins > 0) {
      breakToDeduct = Math.max(0, totalBreakMinutes - template.paid_break_duration_mins);
    }
  }

  let totalSpanMinutes = 0;
  for (let i = 0; i < punches.length - 1; i++) {
    if (punches[i].punch_type === "IN" && punches[i + 1].punch_type === "OUT") {
      totalSpanMinutes += dayjs(punches[i + 1].punch_time).diff(dayjs(punches[i].punch_time), "minute");
    }
  }
  let finalWorkedMinutes = Math.max(0, totalSpanMinutes);
  
  // When no shift is assigned OR it's a holiday, set worked minutes to 0 so all time goes to overtime
  if (!shift || meta.isHoliday) {
    finalWorkedMinutes = 0;
  }
  
  // [MOD] We keep breakToDeduct for OT/Fine calculations but we don't deduct it from finalWorkedMinutes 
  // because the user wants 'working time show total work time'.

  // --- REFACTORED OVERTIME LOGIC ---
  let rawEarlyOT = earlyOTMins;
  let rawLateOT = lateOTMins;

  if (template && shift && !meta.isHoliday) {
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

  // [MOD] Do not trim worked minutes by policy here. 
  // We want worked_minutes to store total site duration (Total - Breaks), as requested.
  // if (template && !template.include_overtime_in_total && shift) {
  //   finalWorkedMinutes = regularWorkedMinutes;
  // }

  let lateMinutes = 0;
  let earlyOutMinutes = 0;
  let fineAmount = 0;
  let earlyOvertimeMinutes = Math.min(rawEarlyOT, overtimeMinutes);
  let lateOtData = { rate: 0, amount: 0, minutes: 0 };
  let earlyOtData = { rate: 0, amount: 0, minutes: 0 };
  
  let fineData = {
    late_entry: { minutes: 0, amount: 0, rate: 5 },
    early_exit: { minutes: 0, amount: 0, rate: 5 },
    excess_breaks: { minutes: 0, amount: 0, rate: 5 },
    // shortage: { minutes: 0, amount: 0, rate: 5 }
  };

  if (shift) {
    // expectedShiftWorkMinutes already calculated at 624

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

    const getMatchingRule = (mins, rules) => {
      if (!rules || !Array.isArray(rules)) return null;
      return rules.find(r => mins >= r.from_mins && mins <= r.to_mins);
    };
  if (template) {
    // Late Entry Fine
    if (template.late_entry_rules.length > 0) {
        const rule = getMatchingRule(lateMinutes, template.late_entry_rules);
        if (rule) {
          if (rule.type === 'FIXED' || rule.type === 'FIXED_AMOUNT') {
            const amount = parseFloat(rule.value || 0);
            fineAmount += amount;
            fineData.late_entry = { minutes: lateMinutes, amount, rate: 2 };
          } else if (rule.type === 'FIXED_PER_HOUR') {
            const amount = parseFloat(((lateMinutes / 60) * (parseFloat(rule.value) || 0)).toFixed(2));
            fineAmount += amount;
            fineData.late_entry = { minutes: lateMinutes, amount, rate: 2 };
          } else if (rule.type === 'HALF_DAY') {
            const amount = parseFloat((dailyWage * 0.5).toFixed(2));
            fineAmount += amount;
            fineData.late_entry = { minutes: lateMinutes, amount, rate: 2 };
          } else if (rule.type === 'FULL_DAY') {
            const amount = parseFloat(dailyWage.toFixed(2));
            fineAmount += amount;
            fineData.late_entry = { minutes: lateMinutes, amount, rate: 2 };
          } else if (rule.type === 'PERCENTAGE') {
            const amount = parseFloat((dailyWage * ((parseFloat(rule.value) || 0) / 100)).toFixed(2));
            fineAmount += amount;
            fineData.late_entry = { minutes: lateMinutes, amount, rate: 2 };
          } else if (rule.type === 'MINUTE_DEDUCTION') {
            const deductMins = parseFloat(rule.value || 0);
            finalWorkedMinutes -= deductMins;
            fineData.late_entry = { minutes: lateMinutes, amount: 0, rate: 2, deducted_mins: deductMins };
          } else {
            const multiplier = !isNaN(parseFloat(rule.type)) ? rule.type : (rule.value || 1);
            const res = getRateIdAndAmount(lateMinutes, hourlyWage, multiplier);
            fineData.late_entry = { minutes: lateMinutes, amount: res.amount, rate: res.rateId };
            fineAmount += res.amount;
          }
        } else if (template.late_entry_fine_type !== 'NONE') {
          const lateCount = await AttendanceDay.count({
            where: {
              employee_id: employeeId,
              attendance_date: { [Op.between]: [monthStart, date] },
              late_minutes: { [Op.gt]: 0 },
            },
            transaction
          });
          if ((lateCount + 1) > (template.late_entry_limit || 0)) {
            if (template.late_entry_fine_type === 'FIXED') {
              fineAmount += parseFloat(template.late_entry_fine_value || 0);
              fineData.late_entry = { minutes: lateMinutes, amount: parseFloat(template.late_entry_fine_value || 0), rate: 2 };
            } else if (template.late_entry_fine_type === 'MINUTE_DEDUCTION') {
              finalWorkedMinutes -= parseFloat(template.late_entry_fine_value || 0);
            } else if (template.late_entry_fine_type === 'DEDUCTION') {
              const res = getRateIdAndAmount(lateMinutes, hourlyWage, template.late_entry_fine_value || 1);
              fineData.late_entry = { minutes: lateMinutes, amount: res.amount, rate: res.rateId };
              fineAmount += res.amount;
            }
          }
        } else {
          // AUTO FINE: Default to 1x salary deduction if no rules specified
          const res = getRateIdAndAmount(lateMinutes, hourlyWage, 1);
          fineData.late_entry = { minutes: lateMinutes, amount: res.amount, rate: res.rateId };
          fineAmount += res.amount;
        }
      }

      // Early Exit Fine
      if (template.early_exit_rules.length > 0) {
        const rule = getMatchingRule(earlyOutMinutes, template.early_exit_rules);
        if (rule) {
          if (rule.type === 'FIXED' || rule.type === 'FIXED_AMOUNT') {
            const amount = parseFloat(rule.value || 0);
            fineAmount += amount;
            fineData.early_exit = { minutes: earlyOutMinutes, amount, rate: 2 };
          } else if (rule.type === 'FIXED_PER_HOUR') {
            const amount = parseFloat(((earlyOutMinutes / 60) * (parseFloat(rule.value) || 0)).toFixed(2));
            fineAmount += amount;
            fineData.early_exit = { minutes: earlyOutMinutes, amount, rate: 2 };
          } else if (rule.type === 'HALF_DAY') {
            const amount = parseFloat((dailyWage * 0.5).toFixed(2));
            fineAmount += amount;
            fineData.early_exit = { minutes: earlyOutMinutes, amount, rate: 2 };
          } else if (rule.type === 'FULL_DAY') {
            const amount = parseFloat(dailyWage.toFixed(2));
            fineAmount += amount;
            fineData.early_exit = { minutes: earlyOutMinutes, amount, rate: 2 };
          } else if (rule.type === 'PERCENTAGE') {
            const amount = parseFloat((dailyWage * ((parseFloat(rule.value) || 0) / 100)).toFixed(2));
            fineAmount += amount;
            fineData.early_exit = { minutes: earlyOutMinutes, amount, rate: 2 };
          } else if (rule.type === 'MINUTE_DEDUCTION') {
            const deductMins = parseFloat(rule.value || 0);
            finalWorkedMinutes -= deductMins;
            fineData.early_exit = { minutes: earlyOutMinutes, amount: 0, rate: 2, deducted_mins: deductMins };
          } else {
            const multiplier = !isNaN(parseFloat(rule.type)) ? rule.type : (rule.value || 1);
            const res = getRateIdAndAmount(earlyOutMinutes, hourlyWage, multiplier);
            fineData.early_exit = { minutes: earlyOutMinutes, amount: res.amount, rate: res.rateId };
            fineAmount += res.amount;
          }
        } else if (template.early_exit_fine_type !== 'NONE') {
          const earlyExitCount = await AttendanceDay.count({
            where: {
              employee_id: employeeId,
              attendance_date: { [Op.between]: [monthStart, date] },
              early_out_minutes: { [Op.gt]: 0 },
            },
            transaction
          });
          if ((earlyExitCount + 1) > (template.early_exit_limit || 0)) {
            if (template.early_exit_fine_type === 'FIXED') {
              fineAmount += parseFloat(template.early_exit_fine_value || 0);
              fineData.early_exit = { minutes: earlyOutMinutes, amount: parseFloat(template.early_exit_fine_value || 0), rate: 2 };
            } else if (template.early_exit_fine_type === 'MINUTE_DEDUCTION') {
              finalWorkedMinutes -= parseFloat(template.early_exit_fine_value || 0);
            } else if (template.early_exit_fine_type === 'DEDUCTION') {
              const res = getRateIdAndAmount(earlyOutMinutes, hourlyWage, template.early_exit_fine_value || 1);
              fineData.early_exit = { minutes: earlyOutMinutes, amount: res.amount, rate: res.rateId };
              fineAmount += res.amount;
            }
          }
        } else {
          // AUTO FINE: Default to 1x salary deduction if no rules specified
          const res = getRateIdAndAmount(earlyOutMinutes, hourlyWage, 1);
          fineData.early_exit = { minutes: earlyOutMinutes, amount: res.amount, rate: res.rateId };
          fineAmount += res.amount;
        }
      }

      // Excess Break Fine
      if (totalBreakMinutes > (template.paid_break_duration_mins || 0)) {
        const excessMins = totalBreakMinutes - (template.paid_break_duration_mins || 0);
        const rule = getMatchingRule(excessMins, template.break_rules);
        if (rule) {
          if (rule.type === 'FIXED' || rule.type === 'FIXED_AMOUNT') {
            const amount = parseFloat(rule.value || 0);
            fineAmount += amount;
            fineData.excess_breaks = { minutes: excessMins, amount, rate: 2 };
          } else if (rule.type === 'FIXED_PER_HOUR') {
            const amount = parseFloat(((excessMins / 60) * (parseFloat(rule.value) || 0)).toFixed(2));
            fineAmount += amount;
            fineData.excess_breaks = { minutes: excessMins, amount, rate: 2 };
          } else if (rule.type === 'HALF_DAY') {
            const amount = parseFloat((dailyWage * 0.5).toFixed(2));
            fineAmount += amount;
            fineData.excess_breaks = { minutes: excessMins, amount, rate: 2 };
          } else if (rule.type === 'FULL_DAY') {
            const amount = parseFloat(dailyWage.toFixed(2));
            fineAmount += amount;
            fineData.excess_breaks = { minutes: excessMins, amount, rate: 2 };
          } else if (rule.type === 'PERCENTAGE') {
            const amount = parseFloat((dailyWage * ((parseFloat(rule.value) || 0) / 100)).toFixed(2));
            fineAmount += amount;
            fineData.excess_breaks = { minutes: excessMins, amount, rate: 2 };
          } else if (rule.type === 'MINUTE_DEDUCTION') {
            const deductMins = parseFloat(rule.value || 0);
            finalWorkedMinutes -= deductMins;
            fineData.excess_breaks = { minutes: excessMins, amount: 0, rate: 2, deducted_mins: deductMins };
          } else {
            const multiplier = !isNaN(parseFloat(rule.type)) ? rule.type : (rule.value || 1);
            const res = getRateIdAndAmount(excessMins, hourlyWage, multiplier);
            fineData.excess_breaks = { minutes: excessMins, amount: res.amount, rate: res.rateId };
            fineAmount += res.amount;
          }
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

    // Late OT Calculation (Standard Overtime)
    const lateOvertimeMinutesRaw = Math.max(0, overtimeMinutes - earlyOvertimeMinutes);
    if (lateOvertimeMinutesRaw > 0) {
      const otRule = template ? getMatchingRule(lateOvertimeMinutesRaw, template.overtime_rules) : null;
      if (otRule) {
        if (otRule.type === 'FIXED_AMOUNT' || otRule.type === 'FIXED') {
          lateOtData.amount = parseFloat(otRule.value || 0);
          lateOtData.rate = 2;
          lateOtData.minutes = lateOvertimeMinutesRaw;
        } else if (otRule.type === 'FIXED_PER_HOUR') {
          lateOtData.amount = parseFloat(((lateOvertimeMinutesRaw / 60) * (parseFloat(otRule.value) || 0)).toFixed(2));
          lateOtData.rate = 2;
          lateOtData.minutes = lateOvertimeMinutesRaw;
        } else if (otRule.type === 'HALF_DAY') {
          lateOtData.amount = parseFloat((dailyWage * 0.5).toFixed(2));
          lateOtData.rate = 2;
          lateOtData.minutes = lateOvertimeMinutesRaw;
        } else if (otRule.type === 'FULL_DAY') {
          lateOtData.amount = parseFloat(dailyWage.toFixed(2));
          lateOtData.rate = 2;
          lateOtData.minutes = lateOvertimeMinutesRaw;
        } else if (otRule.type === 'MINUTE_ADDITION') {
          const addMins = parseFloat(otRule.value || 0);
          overtimeMinutes += addMins;
          finalWorkedMinutes += addMins;
          lateOtData.minutes = lateOvertimeMinutesRaw + addMins;
          lateOtData.rate = 2;
          lateOtData.amount = 0;
        } else {
          const multiplier = !isNaN(parseFloat(otRule.type)) ? otRule.type : (otRule.value || 1);
          const result = getRateIdAndAmount(lateOvertimeMinutesRaw, hourlyWage, multiplier);
          lateOtData.rate = result.rateId;
          lateOtData.amount = result.amount;
          lateOtData.minutes = lateOvertimeMinutesRaw;
        }
      } else {
        const result = getRateIdAndAmount(lateOvertimeMinutesRaw, hourlyWage, 1);
        lateOtData.rate = result.rateId;
        lateOtData.amount = result.amount;
        lateOtData.minutes = lateOvertimeMinutesRaw;
      }
    }

    if (earlyOvertimeMinutes > 0) {
      const earlyOtRule = template ? getMatchingRule(earlyOvertimeMinutes, template.early_overtime_rules) : null;
      if (earlyOtRule) {
        if (earlyOtRule.type === 'FIXED_AMOUNT' || earlyOtRule.type === 'FIXED') {
          earlyOtData.amount = parseFloat(earlyOtRule.value || 0);
          earlyOtData.rate = 2;
          earlyOtData.minutes = earlyOvertimeMinutes;
        } else if (earlyOtRule.type === 'FIXED_PER_HOUR') {
          earlyOtData.amount = parseFloat(((earlyOvertimeMinutes / 60) * (parseFloat(earlyOtRule.value) || 0)).toFixed(2));
          earlyOtData.rate = 2;
          earlyOtData.minutes = earlyOvertimeMinutes;
        } else if (earlyOtRule.type === 'HALF_DAY') {
          earlyOtData.amount = parseFloat((dailyWage * 0.5).toFixed(2));
          earlyOtData.rate = 2;
          earlyOtData.minutes = earlyOvertimeMinutes;
        } else if (earlyOtRule.type === 'FULL_DAY') {
          earlyOtData.amount = parseFloat(dailyWage.toFixed(2));
          earlyOtData.rate = 2;
          earlyOtData.minutes = earlyOvertimeMinutes;
        } else if (earlyOtRule.type === 'MINUTE_ADDITION') {
          const addMins = parseFloat(earlyOtRule.value || 0);
          overtimeMinutes += addMins;
          finalWorkedMinutes += addMins;
          earlyOtData.minutes = earlyOvertimeMinutes + addMins;
          earlyOtData.rate = 2;
          earlyOtData.amount = 0;
        } else {
          const multiplier = !isNaN(parseFloat(earlyOtRule.type)) ? earlyOtRule.type : (earlyOtRule.value || 1);
          const result = getRateIdAndAmount(earlyOvertimeMinutes, hourlyWage, multiplier);
          earlyOtData.rate = result.rateId;
          earlyOtData.amount = result.amount;
          earlyOtData.minutes = earlyOvertimeMinutes;
        }
      } else {
        const result = getRateIdAndAmount(earlyOvertimeMinutes, hourlyWage, 1);
        earlyOtData.rate = result.rateId;
        earlyOtData.amount = result.amount;
        earlyOtData.minutes = earlyOvertimeMinutes;
      }
    }
  }

  finalWorkedMinutes = Math.max(0, finalWorkedMinutes);

  // --- OVERRIDE IF TRACK IN/OUT IS DISABLED ---
  if (template && !template.track_in_out) {
    lateMinutes = 0;
    earlyOutMinutes = 0;
    fineAmount = 0;
    fineData = {
      late_entry: { minutes: 0, amount: 0, rate: 5 },
      early_exit: { minutes: 0, amount: 0, rate: 5 },
      excess_breaks: { minutes: 0, amount: 0, rate: 5 }
    };
    overtimeMinutes = 0;
    earlyOvertimeMinutes = 0;
    lateOtData = { rate: 0, amount: 0, minutes: 0 };
    earlyOtData = { rate: 0, amount: 0, minutes: 0 };

    if (punches.length > 0) {
      finalWorkedMinutes = shift ? (shift.min_full_day_minutes || 480) : 480;
    }
  }

  // Generate default overtime data when no shift is assigned but overtime exists
  if (!shift && overtimeMinutes > 0) {
    const calculatedHourlyWage = dailyWage / 8; // Ensure hourly wage is calculated as daily/8
    const result = getRateIdAndAmount(overtimeMinutes, calculatedHourlyWage, 1);
    lateOtData = {
      rate: result.rateId,
      amount: result.amount,
      minutes: overtimeMinutes
    };
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

    // Special handling for holidays - if holiday and worked, set HOLIDAY status
    if (meta.isHoliday && overtimeMinutes > 0) {
      status = 4; // HOLIDAY
      autoAbsentReason = `Worked on Holiday: ${overtimeMinutes}m overtime`;
    } else if (finalWorkedMinutes >= minFullDay) {
      status = 0; // PRESENT
    } else if (finalWorkedMinutes >= minHalfDay) {
      status = 1; // HALF_DAY
    } else {
      status = 5; // ABSENT (Worked minutes below half-day threshold)
      autoAbsentReason = `Auto Absent: Worked time (${finalWorkedMinutes}m) below threshold (${minHalfDay}m)`;
    }
  }

  // OT minutes are already synced within the rule calculation blocks using trimmed values

  // Prevent Status Downgrade (User Request: "don't let it to change my status")
  // If existing status is Present/HalfDay, don't revert to Absent/HalfDay just because of minutes calculation
  const existingDayForStatus = await commonQuery.findOneRecord(AttendanceDay, {
    employee_id: employeeId,
    attendance_date: date,
  }, { attributes: ['status'] }, transaction);

  if (existingDayForStatus) {
    // If preserveStatus is set (e.g. Manual Punch), strictly keep the existing status
    if (meta.preserveStatus) {
      status = existingDayForStatus.status;
    }
    // Otherwise apply downgrade prevention logic
    else if ([0, 12].includes(existingDayForStatus.status) && [1, 5, 13].includes(status)) {
      status = existingDayForStatus.status; // Keep Present or On Duty
    } else if ([1, 13].includes(existingDayForStatus.status) && status === 5) {
      status = existingDayForStatus.status; // Keep Half Day or Half On Duty
    }
  }

  const existingDay2 = await commonQuery.findOneRecord(AttendanceDay, {
    employee_id: employeeId,
    attendance_date: date,
  }, {}, transaction);

  const attendancePayload = {
    employee_id: employeeId,
    attendance_date: date,
    shift_id: shift ? shift.id : null,
    first_in: firstIn ? dayjs(firstIn.punch_time).format("HH:mm:ss") : null,
    last_out: lastOut ? dayjs(lastOut.punch_time).format("HH:mm:ss") : null,
    worked_minutes: Math.floor(finalWorkedMinutes),
    late_minutes: lateMinutes,
    early_out_minutes: earlyOutMinutes,
    early_overtime_minutes: earlyOvertimeMinutes,
    total_break_minutes: totalBreakMinutes,
    overtime_minutes: overtimeMinutes,
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
    fine_amount: fineAmount,
    status: status,
    user_id: meta.user_id || 0,
    branch_id: meta.branch_id || 0,
    company_id: meta.company_id || 0,
    note: autoAbsentReason || (meta.note || existingDay2?.note || null)
  };

  // If status is 1 (HALF_DAY) or 6 (LEAVE), we need category from meta or existing record
  if ([1, 6].includes(status)) {
    attendancePayload.leave_category_id = meta.leave_category_id || existingDay2?.leave_category_id;
    attendancePayload.leave_session = meta.leave_session || existingDay2?.leave_session;
  }
  else {
    // Explicitly clear leave category/session when day is set to Present/Absent/Other
    attendancePayload.leave_category_id = null;
    attendancePayload.leave_session = null;
  }

  if (existingDay2) {
    const error = await syncAttendanceToLeaveBalance(employeeId, existingDay2, attendancePayload, transaction, employee);
    if (error) throw new Err(error);
    await commonQuery.updateRecordById(AttendanceDay, existingDay2.id, attendancePayload, transaction);
  } else {
    const error = await syncAttendanceToLeaveBalance(employeeId, null, attendancePayload, transaction, employee);
    if (error) throw new Err(error);
    await commonQuery.createRecord(AttendanceDay, attendancePayload, transaction);
  }
}

async function manualPunch(employeeId, date, inTime, outTime, meta, transaction = null) {
  const commonMeta = {
    user_id: meta.user_id || 0,
    company_id: meta.company_id || 0,
    branch_id: meta.branch_id || 0,
    device_id: "MANUAL",
  };

  const attendanceDay = meta.existingDay || await commonQuery.findOneRecord(AttendanceDay, {
    employee_id: employeeId,
    attendance_date: date,
  }, {}, transaction);

  if (!attendanceDay) {
    throw {
      handled: true,
      message: { message: "Attendance Day record not found." }
    };
  }
  const dayId = attendanceDay.id;

  const findPunchByDayId = async (type, orderDir = "ASC") => {
    return await commonQuery.findOneRecord(AttendancePunch, {
      employee_id: employeeId,
      day_id: dayId, // Strictly searching by Day ID
      punch_type: type,
      status: 0
    }, {
      order: [["punch_time", orderDir]] // ASC for First IN, DESC for Last OUT
    }, transaction);
  };

  // 1. Policy Validation: Block Attendance on Holidays/Weekly Off if Strict
  const employee = meta.employee || await commonQuery.findOneRecord(Employee, employeeId, {
    include: [
      { model: EmployeeAttendanceTemplate, where: { status: 0 }, as: "employeeAttendanceTemplate", required: false },
      { model: AttendanceTemplate, as: "attendanceTemplate", required: false }
    ],
  }, transaction);

  if (employee) {
    const template = employee.employeeAttendanceTemplate || employee.attendanceTemplate;
    if (template && template.holiday_policy === "BLOCK_ATTENDANCE") {
      const { isHoliday, isWeeklyOff } = await getDayOffInfo(employee, date, transaction);
      if (isHoliday || isWeeklyOff) {
        throw {
          handled: true,
          message: { message: `Attendance is blocked on ${isHoliday ? 'Holidays' : 'Weekly Offs'} (Strict Policy)` }
        };
      }
    }
  }

  // Support for Multiple Punches
  if (meta.punches && Array.isArray(meta.punches)) {
    // Clear existing punches for this day_id
    await commonQuery.updateRecordById(AttendancePunch, { day_id: dayId, status: 0 }, { status: 2 }, transaction);
    
    // Create new punches from array
    for (const p of meta.punches) {
      if (!p.punch_time) continue;
      await commonQuery.createRecord(AttendancePunch, {
        employee_id: employeeId,
        day_id: dayId,
        punch_type: p.punch_type,
        punch_time: parseDateTime(p.punch_time, date),
        ...commonMeta
      }, transaction);
    }
  } else {
    if (inTime && outTime) {
      const inDateObj = parseDateTime(inTime, date);
      const outDateObj = parseDateTime(outTime, date);
      const gap = dayjs(outDateObj).diff(dayjs(inDateObj), "minute", true);

      if (Math.abs(gap) < 2) {
        throw {
          handled: true,
          message: { message: "Please wait at least 2 minutes between IN and OUT time" }
        };
      }
      if (gap < 0) {
        throw {
          handled: true,
          message: { message: "OUT time must be after IN time" }
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
        }, transaction);
      } else {
        // Create new IN punch with gap validation
        await commonQuery.createRecord(AttendancePunch, {
          employee_id: employeeId,
          day_id: dayId,
          punch_type: "IN",
          punch_time: inDateObj,
          ...commonMeta,
        }, transaction);
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
        }, transaction);
      } else {
        // Create new OUT punch with validations
        await commonQuery.createRecord(AttendancePunch, {
          employee_id: employeeId,
          day_id: dayId,
          punch_type: "OUT",
          punch_time: outDateObj,
          ...commonMeta,
        }, transaction);
      }
    }
  }

  // 4. Rebuild day
  if (!meta.skipRebuild) {
    await rebuildAttendanceDay(employeeId, date, { ...meta, preserveStatus: true, isHoliday: meta.isHoliday }, transaction);
  }
}
/**
 * Detects if a specific date is a Holiday or Weekly Off for an employee.
 */
async function getDayOffInfo(employee, date, transaction) {
  const res = { isHoliday: false, isWeeklyOff: false, holidayDetails: null };
  if (!employee) return res;

  // Holiday Check
  if (employee.holiday_template) {
    const holiday = await commonQuery.findOneRecord(HolidayTransaction, {
      template_id: employee.holiday_template,
      date: date,
      status: 0,
    }, {}, transaction, false, { company_id: true });
    if (holiday) {
      res.isHoliday = true;
      res.holidayDetails = holiday;
    }
  }

  // Weekly Off Check
  if (employee.weekly_off_template) {
    const d = dayjs(date);
    const dayOfWeek = d.day(); 
    const dayOfMonth = d.date();
    const weekNo = Math.ceil(dayOfMonth / 7);

    const weeklyOff = await commonQuery.findOneRecord(WeeklyOffTemplateDay, {
      template_id: employee.weekly_off_template,
      day_of_week: dayOfWeek,
      [Op.or]: [{ week_no: 0 }, { week_no: weekNo }],
      is_off: true,
      status: 0
    }, {}, transaction, false, { company_id: true });
    if (weeklyOff) res.isWeeklyOff = true;
  }

  return res;
}

/**
 * Syncs Compensatory Off credits based on working on holidays/weekly offs.
 */
async function syncCompOffCredit(employee, date, status, transaction) {
  if (!employee) return;
  const LeaveBalanceService = require("../services/leaveBalanceService");
  const template = employee.employeeAttendanceTemplate || employee.attendanceTemplate;
  if (!template || template.holiday_policy !== "COMP_OFF") return;

  const { isHoliday, isWeeklyOff } = await getDayOffInfo(employee, date, transaction);
  if (!isHoliday && !isWeeklyOff) return;

  const compOffCategory = await commonQuery.findOneRecord(LeaveTemplateCategory, {
    is_compoff: true,
    leave_template_id: employee.leave_template,
    status: 0
  }, {}, transaction, false, { company_id: true });

  if (!compOffCategory) return;

  const isWorkingStatus = [0, 1, 12, 13].includes(Number(status));
  const employeeId = employee.id;

  // Find existing credit record for this date
  const existingCompOff = await commonQuery.findOneRecord(LeaveRequest, {
    employee_id: employeeId,
    start_date: date,
    leave_category_id: compOffCategory.id,
    approval_status: constants.LEAVE_APPROVAL_STATUS.APPROVED,
    status: 0
  }, {}, transaction);

  if (isWorkingStatus) {
    const creditAmount = [0, 12].includes(Number(status)) ? 1.0 : 0.5;
    
    if (existingCompOff) {
      // Handle Correction (e.g. Full Day vs Half Day change)
      if (parseFloat(existingCompOff.total_days) !== creditAmount) {
        const diff = creditAmount - parseFloat(existingCompOff.total_days);
        const error = await LeaveBalanceService.adjustLeaveBalance(employeeId, compOffCategory.id, -diff, transaction);
        if (error) return error;
        await commonQuery.updateRecordById(LeaveRequest, existingCompOff.id, { total_days: creditAmount }, transaction);
      }
    } else {
      // New Credit
      const error = await LeaveBalanceService.adjustLeaveBalance(employeeId, compOffCategory.id, -creditAmount, transaction);
      if (error) return error;
      
      await commonQuery.createRecord(LeaveRequest, {
        employee_id: employeeId,
        leave_category_id: compOffCategory.id,
        start_date: date,
        end_date: date,
        total_days: creditAmount,
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
    // Remove Credit if status changed to non-working (e.g. Absent)
    const error = await LeaveBalanceService.adjustLeaveBalance(employeeId, compOffCategory.id, parseFloat(existingCompOff.total_days), transaction);
    if (error) return error;
    await commonQuery.softDeleteById(LeaveRequest, { id: existingCompOff.id }, transaction);
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
    }, transaction);
  }

  if (employee) {
    const error = await syncCompOffCredit(employee, date, newStatus !== null ? newStatus : oldStatus, transaction);
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
      transaction,
      { company_id: true }
    )
  ]);

  const empShiftMap = new Map(employeeShifts.map(s => [s.employee_id, s]));

  // 3. Fetch all potential non-working day triggers in bulk
  const [holidays, weeklyOffs, leaveRequests] = await Promise.all([
    commonQuery.findAllRecords(
      EmployeeHoliday,
      {
        employee_id: { [Op.in]: missingEmpIds },
        date,
        status: 0
      },
      {},
      transaction,
      { company_id: true }
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
      transaction,
      { company_id: true }
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
    )
  ]);

  // MAPS: employeeId -> Record
  const holidayMap = new Map(holidays.map(h => [h.employee_id, h]));
  const weeklyOffMap = new Map(weeklyOffs.map(w => [w.employee_id, w]));
  const leaveMap = new Map(leaveRequests.map(l => [l.employee_id, l]));

  const payloads = [];
  for (const emp of employees) {
    let status = null;
    let leave_cat = null;
    let note = null;

    if (leaveMap.has(emp.id)) {
      status = 6; // LEAVE
      leave_cat = leaveMap.get(emp.id).leave_category_id;
      note = "System: Leave auto-detected";
    } else if (holidayMap.has(emp.id)) {
      status = 4; // HOLIDAY
      note = `System: Holiday auto-detected (${holidayMap.get(emp.id).name || 'Holiday'})`;
    } else if (weeklyOffMap.has(emp.id)) {
      status = 3; // WEEKLY_OFF
      note = "System: Weekly Off auto-detected";
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
          note = "System: Auto Absent (Policy)";
      } 
      // Case 2: Shift ended (even for today or recent past)
      else if (shift && shift.end_time) {
          let shiftEnd = dayjs(`${date} ${shift.end_time}`);
          if (shift.is_night_shift || shift.end_time < shift.start_time) {
              shiftEnd = shiftEnd.add(1, 'day');
          }
          
          if (now.isAfter(shiftEnd)) {
              status = 5; // ABSENT
              note = "System: Auto Absent (Shift Ended)";
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

