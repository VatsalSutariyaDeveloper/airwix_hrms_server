const { Op } = require("sequelize");
const { AttendanceDay, AttendancePunch, Employee, AttendanceTemplate, HolidayTransaction, EmployeeShift, WeeklyOffTemplateDay, LeaveRequest, ShiftTemplate, EmployeeSalaryTemplate, EmployeeHoliday, EmployeeWeeklyOff, ShiftBreak, EmployeeAttendanceTemplate } = require("../models");
const commonQuery = require("./commonQuery");
const { Err } = require("./Err");
const dayjs = require("dayjs");
const { constants } = require("./constants");
const LeaveBalanceService = require("../services/leaveBalanceService");

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

  // 0️⃣ Fetch Employee with Attendance Template
  const employee = await commonQuery.findOneRecord(Employee, employeeId, {
    include: [{ model: EmployeeAttendanceTemplate, where: { status: 0 }, as: "employeeAttendanceTemplate" }],
  }, transaction);

  if (!employee) throw new Error("Employee not found");
  const template = employee.employeeAttendanceTemplate;
  // 1️⃣ Check Holiday Policy
  if (template && employee.holiday_template) {
    const isHoliday = await commonQuery.findOneRecord(HolidayTransaction, {
      template_id: employee.holiday_template,
      date: today,
      status: 0,
    }, {}, transaction);

    if (isHoliday && template.holiday_policy === "BLOCK_ATTENDANCE") {
      throw new Error("Attendance is blocked on holidays");
    }
  }

  // 1️⃣.5️⃣ Fetch Shift & Validate Punch Restrictions
  const empShift = await commonQuery.findOneRecord(EmployeeShift, {
    employee_id: employeeId,
    effective_from: { [Op.lte]: today },
    [Op.or]: [{ effective_to: null }, { effective_to: { [Op.gte]: today } }],
    status: 0,
  }, {
    order: [["effective_from", "DESC"]],
  }, transaction);

  let shift = null;
  if (empShift) {
    shift = await commonQuery.findOneRecord(ShiftTemplate, empShift.shift_id, {}, transaction);
  } else if (employee.shift_template) {
    shift = await commonQuery.findOneRecord(ShiftTemplate, employee.shift_template, {}, transaction);
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
    if (punchType === "IN" && shift.punch_in && shift.punch_in_time) {
      // Calculate earliest allowed time
      const [h, m, s] = (shift.punch_in_time || "00:00:00").split(":");
      const limitMinutes = parseInt(h) * 60 + parseInt(m);
      const shiftStart = dayjs(`${today} ${shift.start_time}`);
      const earliestAllowed = shiftStart.subtract(limitMinutes, "minute");

      if (dayjs(now).isBefore(earliestAllowed)) {
        throw new Err(`Punch IN not allowed before ${earliestAllowed.format("hh:mm A")} (Shift: ${shiftStart.format("hh:mm A")})`);
      }
    }

    if (punchType === "OUT" && shift.punch_out && shift.punch_out_time) {
      // Calculate latest allowed time
      const [h, m, s] = (shift.punch_out_time || "00:00:00").split(":");
      const limitMinutes = parseInt(h) * 60 + parseInt(m);
      let shiftEnd = dayjs(`${today} ${shift.end_time}`);
      if (shift.is_night_shift || shift.end_time < shift.start_time) {
        shiftEnd = shiftEnd.add(1, "day");
      }
      const latestAllowed = shiftEnd.add(limitMinutes, "minute");

      if (dayjs(now).isAfter(latestAllowed)) {
        throw new Err(`Punch OUT not allowed after ${latestAllowed.format("hh:mm A")} (Shift: ${shiftEnd.format("hh:mm A")})`);
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
  const employee = await commonQuery.findOneRecord(Employee, employeeId, {
    include: [{ model: EmployeeAttendanceTemplate, where: { status: 0 }, as: "employeeAttendanceTemplate" }],
  }, transaction);

  if (!employee) return;
  const template = employee.employeeAttendanceTemplate;

  // 0️⃣.A Check if record is locked
  const existingDay = await commonQuery.findOneRecord(AttendanceDay, {
    employee_id: employeeId,
    attendance_date: date,
  }, {}, transaction);

  if (existingDay && existingDay.is_locked) {
    console.log(`[Attendance] Day ${date} for emp ${employeeId} is locked. Skipping rebuild.`);
    return;
  }

  // Find all IN punches on the target date
  const inPunches = await commonQuery.findAllRecords(AttendancePunch, {
    employee_id: employeeId,
    punch_type: "IN",
    punch_time: {
      [Op.between]: [`${date} 00:00:00`, `${date} 23:59:59`],
    },
    status: 0,
  }, {
    order: [["punch_time", "ASC"]],
  }, transaction);

  const hasPunches = inPunches.length > 0;

  const approvedLeave = await commonQuery.findOneRecord(LeaveRequest, {
    employee_id: employeeId,
    approval_status: constants.LEAVE_APPROVAL_STATUS.APPROVED,
    start_date: { [Op.lte]: date },
    end_date: { [Op.gte]: date },
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
    // Continue reconstruction with punches...
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
  let holidayDetails = null;
  if (employee.holiday_template) {
    holidayDetails = await commonQuery.findOneRecord(HolidayTransaction, {
      template_id: employee.holiday_template,
      date: date,
      status: 0,
    }, {}, transaction);
    if (holidayDetails) isHoliday = true;
  }

  // 2️⃣ Check if it's a Weekly Off
  let isWeeklyOff = false;
  if (employee.weekly_off_template) {
    const dayOfWeek = dayjs(date).day(); // 0(Sun) to 6(Sat)
    const dayOfMonth = dayjs(date).date();
    const weekNo = Math.ceil(dayOfMonth / 7); // 1 to 5

    const weeklyOff = await commonQuery.findOneRecord(WeeklyOffTemplateDay, {
      template_id: employee.weekly_off_template,
      day_of_week: dayOfWeek,
      [Op.or]: [{ week_no: 0 }, { week_no: weekNo }],
      is_off: true,
      status: 0,
    }, {}, transaction);
    if (weeklyOff) isWeeklyOff = true;
  }
  // 3️⃣ Fetch assigned Shift for this employee and date
  const dayOfWeek = dayjs(date).day();
  const empShift = await commonQuery.findOneRecord(EmployeeShift, {
    employee_id: employeeId,
    day_of_week: dayOfWeek,
    status: 0,
  }, {}, transaction);

  const shiftInclude = [{ model: ShiftBreak, as: "ShiftBreaks" }];
  let shift = null;
  // 1. Try provided shift_id from meta
  if (meta.shift_id) {
    shift = await commonQuery.findOneRecord(ShiftTemplate, meta.shift_id, { include: shiftInclude }, transaction);
  }

  // 2. Fallback to specific EmployeeShift assignment for that date
  if (!shift && empShift) {
    shift = await commonQuery.findOneRecord(ShiftTemplate, empShift.shift_id, { include: shiftInclude }, transaction);
  }

  // 3. Fallback to Auto-matching based on First In punch
  const firstInPunch = inPunches[0];
  if (!shift && firstInPunch) {
    const allShifts = await commonQuery.findAllRecords(ShiftTemplate, {
      company_id: employee.company_id,
      status: 0
    }, { include: shiftInclude }, transaction);

    if (allShifts.length > 0) {
      const punchTimeOnly = dayjs(firstInPunch.punch_time).format("HH:mm:ss");
      const punchDate = dayjs(`${date} ${punchTimeOnly}`);
      let bestShift = null;
      let minDiff = Infinity;

      for (const s of allShifts) {
        const shiftStart = dayjs(`${date} ${s.start_time}`);
        let diff = Math.abs(punchDate.diff(shiftStart, "minute"));
        if (diff < minDiff) {
          minDiff = diff;
          bestShift = s;
        }
      }
      shift = bestShift;
    }
  }

  // 4. Fallback to employee's default shift template
  if (!shift && employee.shift_template) {
    shift = await commonQuery.findOneRecord(ShiftTemplate, employee.shift_template, { include: shiftInclude }, transaction);
  }

  let allPunches = [];
  if (template && !template.allow_multiple_punches && inPunches.length > 0) {
    // Only FIRST in and LAST out
    const firstIn = inPunches[0];
    allPunches.push(firstIn);
    const lastOut = await commonQuery.findOneRecord(AttendancePunch, {
      employee_id: employeeId,
      punch_type: "OUT",
      // attendance_date: date,
      status: 0,
      punch_time: { [Op.gt]: firstIn.punch_time }
    }, { order: [["punch_time", "DESC"]] }, transaction);
    if (lastOut) allPunches.push(lastOut);
  } else {
    for (const inP of inPunches) {
      allPunches.push(inP);
      const nextP = await commonQuery.findOneRecord(AttendancePunch, {
        employee_id: employeeId,
        punch_time: { [Op.gt]: inP.punch_time },
        status: 0,
      }, {
        order: [["punch_time", "ASC"]],
      }, transaction);
      if (nextP && nextP.punch_type === "OUT") {
        allPunches.push(nextP);
      }
    }
  }

  const punches = allPunches.filter((v, i, a) => a.findIndex(t => t.id === v.id) === i)
    .sort((a, b) => dayjs(a.punch_time).valueOf() - dayjs(b.punch_time).valueOf());

  // Handle No Punches Case
  if (punches.length === 0) {
    let emptyStatus = 5; // Default ABSENT
    if (isWeeklyOff) emptyStatus = 3;
    else if (isHoliday) emptyStatus = 4;

    const existingDay = await commonQuery.findOneRecord(AttendanceDay, {
      employee_id: employeeId,
      attendance_date: date,
    }, { attributes: ['id', 'status'] }, transaction);

    // If existing status is manually set to WeeklyOff(3), Holiday(4), Absent(5), Leave(6), preserve it
    // Unless we want to strictly enforce calendar? User requested "don't change my status".
    if (existingDay && [3, 4, 5, 6].includes(existingDay.status)) {
      emptyStatus = existingDay.status;
    }

    // [MOD] If onlyCreateNonWorking is set, skip creating status 5 (ABSENT)
    if (meta.onlyCreateNonWorking && emptyStatus === 5) {
      return;
    }

    const payload = {
      employee_id: employeeId,
      attendance_date: date,
      status: emptyStatus,
      shift_id: (isWeeklyOff || isHoliday) ? null : (shift ? shift.id : null),
      user_id: meta.user_id || 0,
      branch_id: meta.branch_id || 0,
      company_id: meta.company_id || 0,
      first_in: null,
      last_out: null,
      worked_minutes: 0,
      overtime_minutes: 0,
      late_minutes: 0,
      early_out_minutes: 0,
      early_overtime_minutes: 0,
      total_break_minutes: 0,
      overtime_data: null,
      fine_data: null,
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
      } else {
        // No Shift - All is regular work time? Or all is OT? 
        // Typically, without a shift, we just count it as worked time.
        shiftWorkedMins += pE.diff(pS, "minute");
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

  const totalSpanMinutes = shiftWorkedMins + earlyOTMins + lateOTMins;
  let finalWorkedMinutes = Math.max(0, totalSpanMinutes - breakToDeduct);

  // --- REFACTORED OVERTIME LOGIC ---
  let rawEarlyOT = earlyOTMins;
  let rawLateOT = lateOTMins;

  if (template) {
    if (!template.early_overtime_allowed) rawEarlyOT = 0;
    if (!template.overtime_allowed) rawLateOT = 0;
  }

  let overtimeMinutes = rawEarlyOT + rawLateOT;

  // If breaks took away more than regular shift work, deduct remainder from OT
  if (breakToDeduct > shiftWorkedMins) {
    const remainingBreak = breakToDeduct - shiftWorkedMins;
    overtimeMinutes = Math.max(0, overtimeMinutes - remainingBreak);
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

  if (template && !template.include_overtime_in_total && shift) {
    finalWorkedMinutes = regularWorkedMinutes;
  }

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
      if (template.include_overtime_in_total && oldOT !== overtimeMinutes) {
        finalWorkedMinutes = Math.max(0, finalWorkedMinutes - (oldOT - overtimeMinutes));
      }
      
      // Re-split early OT after trimming
      earlyOvertimeMinutes = Math.min(earlyOvertimeMinutes, overtimeMinutes);
    }
    // 💸 FINE & BENEFIT CALCULATION
    const monthStart = dayjs(date).startOf('month').format('YYYY-MM-DD');

    // --- Fetch Wages for Rate Calculation (Moved outside if(template)) ---
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
      false
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
        hourlyWage = dailyWage / 8; // Assuming 8 hour work day standard
      }
    }

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
        status = 5; // ABSENT
        autoAbsentReason = "Auto Absent: Mandatory punch-out missing";
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

    if (finalWorkedMinutes >= minFullDay) {
      status = 0; // PRESENT
    } else if (finalWorkedMinutes >= minHalfDay) {
      status = 1; // HALF_DAY
    } else {
      status = 5; // ABSENT (Worked minutes below half-day threshold)
      autoAbsentReason = `Auto Absent: Worked time (${finalWorkedMinutes}m) below threshold (${minHalfDay}m)`;
    }
  }

  // Ensure minutes are synced
  lateOtData.minutes = overtimeMinutes;
  earlyOtData.minutes = earlyOvertimeMinutes;

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
    else if (existingDayForStatus.status === 0 && (status === 1 || status === 5)) {
      status = 0; // Keep Present
    } else if (existingDayForStatus.status === 1 && status === 5) {
      status = 1; // Keep Half Day
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
    worked_minutes: Math.floor(regularWorkedMinutes),
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

  if (existingDay2) {
    await syncAttendanceToLeaveBalance(employeeId, existingDay2, attendancePayload, transaction);
    await commonQuery.updateRecordById(AttendanceDay, existingDay2.id, attendancePayload, transaction);
  } else {
    await syncAttendanceToLeaveBalance(employeeId, null, attendancePayload, transaction);
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

  let effectiveInPunch = null;

  const attendanceDay = await commonQuery.findOneRecord(AttendanceDay, {
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
      effectiveInPunch = await commonQuery.updateRecordById(AttendancePunch, { id: existingIn.id }, {
        punch_time: inDateObj,
        ...commonMeta
      }, transaction);
    } else {
      // Create new IN punch with gap validation
      effectiveInPunch = await commonQuery.createRecord(AttendancePunch, {
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
      await commonQuery.updateRecordById(AttendancePunch, existingOut.id, {
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

  // 4. Rebuild the day
  await rebuildAttendanceDay(employeeId, date, { ...meta, preserveStatus: true }, transaction);
}

/**
 * Syncs attendance status shifts to employee leave balance and history (LeaveRequest).
 * Comparison between OLD state and NEW state of the day.
 */
async function syncAttendanceToLeaveBalance(employeeId, oldDay, newDay, transaction) {
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

  // CASE 1: Status changed AWAY from Leave/HalfDay (Refund)
  if (oldDeduction > 0 && newDeduction === 0) {
    await LeaveBalanceService.syncLeaveRecord(employeeId, date, oldCategoryId, 0, transaction);
  }
  // CASE 2: Status is NOW Leave/HalfDay (Deduct/Create)
  else if (newDeduction > 0) {
    // Even if oldDeduction was > 0, syncLeaveRecord handles updates (Category/Amount change)
    await LeaveBalanceService.syncLeaveRecord(employeeId, date, newCategoryId, newDeduction, transaction);
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

  // 2. Fetch employees for mapping (mostly for company/branch context)
  const employees = await commonQuery.findAllRecords(
    Employee,
    {
      id: { [Op.in]: missingEmpIds }
    },
    {
      attributes: ['id', 'company_id', 'branch_id'],
      include: [{ 
        model: EmployeeAttendanceTemplate, 
        as: "employeeAttendanceTemplate",
        where: { status: 0 },
        required: false 
      }],
      transaction
    }
  );

  // 3. Fetch all potential non-working day triggers in bulk
  const [holidays, weeklyOffs, leaveRequests] = await Promise.all([
    commonQuery.findAllRecords(
      EmployeeHoliday,
      {
        employee_id: { [Op.in]: missingEmpIds },
        date,
        status: 0
      },
      { transaction }
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
      { transaction }
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
      { transaction }
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
    } else if (emp.employeeAttendanceTemplate?.auto_mark_absent) {
      // Rule: Only mark absent if the target date is in the past (beyond buffer days)
      const buffer = parseInt(emp.employeeAttendanceTemplate.auto_absent_buffer_days || 0);
      const markDate = dayjs(date).startOf('day');
      const today = dayjs().startOf('day');
      
      // If the date is strictly before (today - buffer), mark him absent
      if (markDate.isBefore(today.subtract(buffer, 'day'))) {
          status = 5; // ABSENT
          note = "System: Auto Absent (Policy)";
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
  bulkSyncAttendanceDays
};

