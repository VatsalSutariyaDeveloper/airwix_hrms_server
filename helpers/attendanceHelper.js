const { Op } = require("sequelize");
const { AttendanceDay, AttendancePunch, Employee, AttendanceTemplate, HolidayTransaction, Shift, EmployeeShift, WeeklyOffTemplateDay, LeaveRequest } = require("../models");
const commonQuery = require("./commonQuery");
const { Err } = require("./Err");
const dayjs = require("dayjs");

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
  return dayjs(`${baseDate} ${timeStr}`).toDate();
};

async function punch(employeeId, meta, transaction = null) {
  const baseDate = dayjs().format("YYYY-MM-DD");
  const now = meta.punch_time ? parseDateTime(meta.punch_time, baseDate) : new Date();
  const today = dayjs(now).format("YYYY-MM-DD");

  // 0️⃣ Fetch Employee with Attendance Template
  const employee = await commonQuery.findOneRecord(Employee, employeeId, {
    include: [{ model: AttendanceTemplate, as: "attendanceTemplate" }],
  }, transaction);

  if (!employee) throw new Error("Employee not found");
  const template = employee.attendanceTemplate;

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
    shift = await commonQuery.findOneRecord(Shift, empShift.shift_id, {}, transaction);
  } else if (employee.shift_template) {
    shift = await commonQuery.findOneRecord(Shift, employee.shift_template, {}, transaction);
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
  if (lastPunch) {
    const minutesSinceLastPunch = dayjs(now).diff(dayjs(lastPunch.punch_time), "minute", true);
    if (minutesSinceLastPunch < 2) {
      throw new Err("Please wait at least 2 minutes between punches");
    }
  }

  // 4️⃣ Save raw punch
  const newPunch = await commonQuery.createRecord(AttendancePunch, {
    employee_id: employeeId,
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
  
  await rebuildAttendanceDay(employeeId, dateToRebuild, meta, transaction);

  return { punchType, punchTime: now, punchId: newPunch.id };
}

async function rebuildAttendanceDay(employeeId, date, meta = {}, transaction = null) {
  const employee = await commonQuery.findOneRecord(Employee, employeeId, {
    include: [{ model: AttendanceTemplate, as: "attendanceTemplate" }],
  }, transaction);

  if (!employee) return;
  const template = employee.attendanceTemplate;

  // 0️⃣.A Check if record is locked
  const existingDay = await commonQuery.findOneRecord(AttendanceDay, { 
    employee_id: employeeId, 
    attendance_date: date,
    status: { [Op.ne]: 99 }
  }, {}, transaction);

  if (existingDay && existingDay.is_locked) {
    console.log(`[Attendance] Day ${date} for emp ${employeeId} is locked. Skipping rebuild.`);
    return;
  }

  // 0️⃣ Check if there's an approved Leave for this date
  const approvedLeave = await commonQuery.findOneRecord(LeaveRequest, {
      employee_id: employeeId,
      approval_status: "APPROVED",
      start_date: { [Op.lte]: date },
      end_date: { [Op.gte]: date },
      status: 0
  }, {}, transaction);

  if (approvedLeave) {
    const leavePayload = {
        employee_id: employeeId,
        attendance_date: date,
        status: 6, // LEAVE
        user_id: meta.user_id || 0,
        branch_id: meta.branch_id || 0,
        company_id: meta.company_id || 0,
    };

    const existingDay1 = await commonQuery.findOneRecord(AttendanceDay, { 
        employee_id: employeeId, 
        attendance_date: date,
        status: { [Op.ne]: 99 }
    }, {}, transaction);

    if (existingDay1) {
        await commonQuery.updateRecordById(AttendanceDay, existingDay1.id, leavePayload, transaction);
    } else {
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
  // 3️⃣ Fetch Shift for this employee and date
  const empShift = await commonQuery.findOneRecord(EmployeeShift, {
      employee_id: employeeId,
      effective_from: { [Op.lte]: date },
      [Op.or]: [{ effective_to: null }, { effective_to: { [Op.gte]: date } }],
      status: 0,
  }, {
    order: [["effective_from", "DESC"]],
  }, transaction);

  let shift = null;
  if (empShift) {
    shift = await commonQuery.findOneRecord(Shift, empShift.shift_id, {}, transaction);
  } else if (employee.shift_template) {
    shift = await commonQuery.findOneRecord(Shift, employee.shift_template, {}, transaction);
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

  let allPunches = [];
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

  const punches = allPunches.filter((v, i, a) => a.findIndex(t => t.id === v.id) === i)
                            .sort((a, b) => dayjs(a.punch_time).valueOf() - dayjs(b.punch_time).valueOf());

  // Handle No Punches Case
  if (punches.length === 0) {
    let emptyStatus = 5; // Default ABSENT
    if (isWeeklyOff) emptyStatus = 3;
    else if (isHoliday) emptyStatus = 4;

    const payload = {
      employee_id: employeeId,
      attendance_date: date,
      status: emptyStatus,
      user_id: meta.user_id || 0,
      branch_id: meta.branch_id || 0,
      company_id: meta.company_id || 0,
    };

    const existingDay = await commonQuery.findOneRecord(AttendanceDay, { 
      employee_id: employeeId, 
      attendance_date: date,
      status: { [Op.ne]: 99 }
    }, {}, transaction);

    if (existingDay) {
      // If it was manual override or leave, we might NOT want to overwrite? 
      // For now, if we are rebuilding, we overwrite basic status.
      await commonQuery.updateRecordById(AttendanceDay, existingDay.id, payload, transaction);
    } else {
      await commonQuery.createRecord(AttendanceDay, payload, transaction);
    }
    return;
  }

  const firstIn = punches.find((p) => p.punch_type === "IN");
  const lastOut = [...punches].reverse().find((p) => p.punch_type === "OUT");

  let actualWorkedMinutes = 0;
  let totalBreakMinutes = 0;

  if (template && !template.deduct_breaks_from_total) {
    if (firstIn && lastOut) {
      actualWorkedMinutes = dayjs(lastOut.punch_time).diff(dayjs(firstIn.punch_time), "minute", true);
    }
  } else {
    for (let i = 0; i < punches.length - 1; i++) {
      if (punches[i].punch_type === "IN" && punches[i + 1].punch_type === "OUT") {
        actualWorkedMinutes += dayjs(punches[i+1].punch_time).diff(dayjs(punches[i].punch_time), "minute", true);
      } else if (punches[i].punch_type === "OUT" && punches[i + 1].punch_type === "IN") {
        totalBreakMinutes += dayjs(punches[i+1].punch_time).diff(dayjs(punches[i].punch_time), "minute", true);
      }
    }
  }

  let finalWorkedMinutes = actualWorkedMinutes;

  if (template) {
    if (template.deduct_breaks_from_total && template.paid_break_duration_mins > 0) {
      const breakToAddBack = Math.min(totalBreakMinutes, template.paid_break_duration_mins);
      finalWorkedMinutes += breakToAddBack;
    }

    if (!template.include_overtime_in_total && shift) {
      const shiftStart = dayjs(`${date} ${shift.start_time}`);
      let shiftEnd = dayjs(`${date} ${shift.end_time}`);
      if (shift.is_night_shift || shift.end_time < shift.start_time) {
        shiftEnd = shiftEnd.add(1, "day");
      }
      const shiftDuration = shiftEnd.diff(shiftStart, "minute");

      if (finalWorkedMinutes > shiftDuration) {
        finalWorkedMinutes = shiftDuration;
      }
    }
  }

  let lateMinutes = 0;
  let earlyOutMinutes = 0;
  let overtimeMinutes = 0;
  let fineAmount = 0;

  if (shift) {
    const shiftStart = dayjs(`${date} ${shift.start_time}`);
    let shiftEnd = dayjs(`${date} ${shift.end_time}`);
    if (shift.is_night_shift || shift.end_time < shift.start_time) {
      shiftEnd = shiftEnd.add(1, "day");
    }
    const shiftDuration = shiftEnd.diff(shiftStart, "minute");

    if (firstIn) {
      const actualIn = dayjs(firstIn.punch_time);
      const diff = actualIn.diff(shiftStart, "minute", true);
      if (diff > (shift.grace_minutes || 0)) {
        lateMinutes = Math.floor(diff);
      }
    }

    if (lastOut) {
      const actualOut = dayjs(lastOut.punch_time);
      const diff = shiftEnd.diff(actualOut, "minute", true);
      if (diff > (shift.early_exit_grace || 0)) {
        earlyOutMinutes = Math.floor(diff);
      }
    }

    // 🏆 OVERTIME CALCULATION
    if (template && template.overtime_allowed) {
      const extraMinutes = actualWorkedMinutes - shiftDuration;
      if (extraMinutes >= (template.min_overtime_mins || 0)) {
        overtimeMinutes = Math.floor(extraMinutes);
        if (template.max_overtime_mins > 0 && overtimeMinutes > template.max_overtime_mins) {
          overtimeMinutes = template.max_overtime_mins;
        }
      }
    }

    // 💸 FINE CALCULATION (Late Entry & Early Exit)
    if (template) {
        const monthStart = dayjs(date).startOf('month').format('YYYY-MM-DD');
        const monthEnd = dayjs(date).endOf('month').format('YYYY-MM-DD');

        // Check Late Entry Fine
        if (lateMinutes > 0 && template.late_entry_fine_type !== 'NONE') {
            const lateCount = await AttendanceDay.count({
                where: {
                    employee_id: employeeId,
                    attendance_date: { [Op.between]: [monthStart, date] },
                    late_minutes: { [Op.gt]: 0 },
                    status: { [Op.ne]: 99 }
                },
                transaction
            });

            if ((lateCount + 1) > (template.late_entry_limit || 0)) {
                if (template.late_entry_fine_type === 'FIXED') {
                    fineAmount += parseFloat(template.late_entry_fine_value || 0);
                }
                // Percentage logic would require basic salary, usually handled at monthly level
                // but if template specifies a fixed value, we apply it here.
            }
        }

        // Check Early Exit Fine
        if (earlyOutMinutes > 0 && template.early_exit_fine_type !== 'NONE') {
            const earlyExitCount = await AttendanceDay.count({
                where: {
                    employee_id: employeeId,
                    attendance_date: { [Op.between]: [monthStart, date] },
                    early_out_minutes: { [Op.gt]: 0 },
                    status: { [Op.ne]: 99 }
                },
                transaction
            });

            if ((earlyExitCount + 1) > (template.early_exit_fine_limit || 0)) {
                if (template.early_exit_fine_type === 'FIXED') {
                    fineAmount += parseFloat(template.early_exit_fine_value || 0);
                }
            }
        }
    }
  }

  let status = 5; // Default ABSENT
  const minHalfDay = shift ? shift.min_half_day_minutes : 240;
  const minFullDay = shift ? shift.min_full_day_minutes : 480;

  if (finalWorkedMinutes >= minFullDay) {
    status = 0; // PRESENT
  } else if (finalWorkedMinutes >= minHalfDay) {
    status = 1; // HALF_DAY
  }

  const attendancePayload = {
    employee_id: employeeId,
    attendance_date: date,
    shift_id: shift ? shift.id : null,
    first_in: firstIn ? dayjs(firstIn.punch_time).format("HH:mm:ss") : null,
    last_out: lastOut ? dayjs(lastOut.punch_time).format("HH:mm:ss") : null,
    worked_minutes: Math.floor(finalWorkedMinutes),
    late_minutes: lateMinutes,
    early_out_minutes: earlyOutMinutes,
    overtime_minutes: overtimeMinutes,
    fine_amount: fineAmount,
    status: status,
    user_id: meta.user_id || 0,
    branch_id: meta.branch_id || 0,
    company_id: meta.company_id || 0,
  };

  const existingDay2 = await commonQuery.findOneRecord(AttendanceDay, { 
    employee_id: employeeId, 
    attendance_date: date,
    status: { [Op.ne]: 99 }
  }, {}, transaction);
  
  if (existingDay2) {
    await commonQuery.updateRecordById(AttendanceDay, existingDay2.id, attendancePayload, transaction);
  } else {
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

  const getLatestPunch = async () => {
    return await commonQuery.findOneRecord(AttendancePunch, {
      employee_id: employeeId,
      status: 0,
    }, {
      order: [["punch_time", "DESC"]],
    }, transaction);
  };

  const findExistingPunchToday = async (type) => {
    return await commonQuery.findOneRecord(AttendancePunch, {
      employee_id: employeeId,
      punch_type: type,
      punch_time: {
        [Op.between]: [`${date} 00:00:00`, `${date} 23:59:59`]
      },
      status: 0
    }, {}, transaction);
  };

  // 1. Pre-validate gap if both are provided
  if (inTime && outTime) {
    const inDateObj = parseDateTime(inTime, date);
    const outDateObj = parseDateTime(outTime, date);
    const gap = dayjs(outDateObj).diff(dayjs(inDateObj), "minute", true);
    
    if (Math.abs(gap) < 2) {
      throw new Err("Please wait at least 2 minutes between IN and OUT time");
    }
    if (gap < 0) {
      throw new Err("OUT time must be after IN time");
    }
  }

  // 2. Handle IN punch
  if (inTime) {
    const inDateObj = parseDateTime(inTime, date);
    const existingIn = await findExistingPunchToday("IN");

    if (existingIn) {
      // Update existing IN punch
      effectiveInPunch = await commonQuery.updateRecordById(AttendancePunch, { id: existingIn.id }, {
        punch_time: inDateObj,
        ...commonMeta
      }, transaction);
    } else {
      // Create new IN punch with gap validation
      const lastPunch = await getLatestPunch();
      if (lastPunch && Math.abs(dayjs(inDateObj).diff(dayjs(lastPunch.punch_time), "minute", true)) < 2) {
        throw new Err("Please wait at least 2 minutes between punches");
      }

      effectiveInPunch = await commonQuery.createRecord(AttendancePunch, {
        employee_id: employeeId,
        punch_type: "IN",
        punch_time: inDateObj,
        ...commonMeta,
      }, transaction);
    }
  }

  // 3. Handle OUT punch
  if (outTime) {
    const outDateObj = parseDateTime(outTime, date);
    const existingOut = await findExistingPunchToday("OUT");

    if (existingOut) {
      // Update existing OUT punch
      await commonQuery.updateRecordById(AttendancePunch, existingOut.id, {
        punch_time: outDateObj,
        ...commonMeta
      }, transaction);
    } else {
      // Create new OUT punch with validations
      const lastPunch = effectiveInPunch || await getLatestPunch();
      
      if (!lastPunch || lastPunch.punch_type !== "IN") {
        throw new Err("Please punch IN first");
      }
      
      if (Math.abs(dayjs(outDateObj).diff(dayjs(lastPunch.punch_time), "minute", true)) < 2) {
        throw new Err("Please wait at least 2 minutes between punches");
      }

      await commonQuery.createRecord(AttendancePunch, {
        employee_id: employeeId,
        punch_type: "OUT",
        punch_time: outDateObj,
        ...commonMeta,
      }, transaction);
    }
  }

  // 4. Rebuild the day
  await rebuildAttendanceDay(employeeId, date, meta, transaction);
}

module.exports = {
  punch,
  rebuildAttendanceDay,
  manualPunch,
};

