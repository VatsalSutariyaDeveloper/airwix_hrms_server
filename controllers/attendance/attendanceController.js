const { punch, manualPunch, rebuildAttendanceDay } = require("../../helpers/attendanceHelper");
const { validateRequest, commonQuery, handleError } = require("../../helpers");
const { constants } = require("../../helpers/constants");
const { Employee, AttendanceDay, AttendancePunch, LeaveRequest, LeaveTemplateCategory, Sequelize, sequelize, ShiftTemplate } = require("../../models");
const { Op } = Sequelize;
const dayjs = require("dayjs");
const customParseFormat = require('dayjs/plugin/customParseFormat');
dayjs.extend(customParseFormat);

/**
 * PUNCH (IN/OUT)
 */
exports.attendancePunch = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const requiredFields = {
      employee_id: "Employee"
    };

    const errors = await validateRequest(req.body, requiredFields);
    if (errors) {
      await t.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    const result = await punch(req.body.employee_id, {
      ...req.body,
      user_id: req.user.id,
      company_id: req.user.company_id,
      branch_id: req.user.branch_id,
      ip_address: req.ip
    }, t);
    
    await t.commit();
    return res.success(constants.ACTION_SUCCESSFUL, result);
  } catch (err) {
    await t.rollback();
    return handleError(err, res, req);
  }
};

/**
 * GET SUMMARY for a specific date
 */
exports.getAttendanceSummary = async (req, res) => {
  try {

    const requiredFields = {
      date: "Date",
    };

    const errors = await validateRequest(req.body, requiredFields);
    if (errors) {
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    const { date, staff_type, shift_id } = req.body;
    const targetDate = date || new Date().toISOString().split("T")[0];

    const employeeWhere = { status: 0 };
    if (staff_type) employeeWhere.employee_type = staff_type;

    // Fetch all employees with their attendance for target date
    const employees = await commonQuery.findAllRecords(Employee, employeeWhere, {
      include: [
        {
          model: AttendanceDay,
          as: "attendance_days",
          where: { attendance_date: targetDate },
          required: false
        },
        {
          model: AttendancePunch,
          as: "attendance_punches",
          where: {
            punch_time: {
              [Op.between]: [`${targetDate} 00:00:00`, `${targetDate} 23:59:59`]
            }
          },
          required: false
        }
      ],
      order: [['first_name', 'ASC']],
      attributes: ['id', 'first_name', 'employee_code', 'employee_type', 'status']
    });

    // Fetch leave requests for target date
    const leaves = await commonQuery.findAllRecords(LeaveRequest, {
      start_date: { [Op.lte]: targetDate },
      end_date: { [Op.gte]: targetDate },
      approval_status: 'APPROVED',
      status: 0
    });

    const leaveEmployeeIds = new Set(leaves.map(l => l.employee_id));

    let summary = {
      totalStaff: employees.length,
      present: 0,
      absent: 0,
      halfDay: 0,
      weeklyOff: 0,
      holiday: 0,
      leave: leaveEmployeeIds.size,
      shortPresence: 0,
      currentlyWorking: 0,
      overtimeHours: 0,
      fineHours: 0,
      punchedIn: 0,
      punchedOut: 0
    };

    let totalOvertimeMins = 0;
    let totalFineMins = 0;

    employees.forEach(emp => {
      const day = emp.attendance_days?.[0];
      const punches = emp.attendance_punches || [];

      if (day) {
        if (day.status === 0) summary.present++;
        else if (day.status === 1) summary.halfDay++;
        else if (day.status === 3) summary.weeklyOff++;
        else if (day.status === 4) summary.holiday++;
        else if (day.status === 6) summary.leave++;
        else if (day.status === 5) {
          if (day.first_in) summary.shortPresence++;
          else summary.absent++;
        }
        
        totalFineMins += (day.late_minutes || 0) + (day.early_out_minutes || 0);
        totalOvertimeMins += (day.overtime_minutes || 0);

        if (day.overtime_minutes === 0 && day.worked_minutes > 480) {
          totalOvertimeMins += (day.worked_minutes - 480);
        }
      } else {
        // No attendance day record yet for today
        if (!leaveEmployeeIds.has(emp.id)) {
          if (punches.length > 0) summary.shortPresence++;
          else summary.absent++;
        }
      }

      if (punches.some(p => p.punch_type === 'IN')) summary.punchedIn++;
      if (punches.some(p => p.punch_type === 'OUT')) summary.punchedOut++;

      // Logic for 'currentlyWorking' (Last punch must be 'IN')
      if (punches.length > 0) {
        const sortedPunches = [...punches].sort((a,b) => new Date(b.punch_time) - new Date(a.punch_time));
        const lastPunch = sortedPunches[0];
        if (lastPunch.punch_type === 'IN') {
           summary.currentlyWorking++;
        }
      }
    });

    summary.overtimeHours = `${Math.floor(totalOvertimeMins / 60)}h ${totalOvertimeMins % 60}m`;
    summary.fineHours = `${Math.floor(totalFineMins / 60)}h ${totalFineMins % 60}m`;

    return res.ok({ summary, items: employees });
  } catch (err) {
    return handleError(err, res, req);
  }
}

/**
 * UPDATE ATTENDANCE DAY (Manual Entry)
 */
exports.updateAttendanceDay = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const requiredFields = {
      employee_id: "Employee",
      attendance_date: "Date",
      first_in: "In Time",
      last_out: "Out Time"
    };

    const errors = await validateRequest(req.body, requiredFields);
    if (errors) {
      await t.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    const { 
      employee_id, 
      attendance_date, 
      status, 
      first_in, 
      last_out, 
      late_minutes, 
      early_out_minutes, 
      worked_minutes,
      overtime_minutes,
      fine_amount,
      leave_category_id,
      leave_session,
      overtime_data,
      fine_data,
      is_locked,
      note
    } = req.body;

    // If times are provided manually, create corresponding AttendancePunch records
    if (first_in || last_out) {
      await manualPunch(employee_id, attendance_date, first_in, last_out, {
        user_id: req.user.id,
        company_id: req.user.company_id,
        branch_id: req.user.branch_id
      }, t);
    }
 
     const payload = {
      employee_id,
      attendance_date,
      status,
      user_id: req.user.id,
      company_id: req.user.company_id,
      branch_id: req.user.branch_id
    };

    if (first_in !== undefined) payload.first_in = first_in;
    if (last_out !== undefined) payload.last_out = last_out;
    if (late_minutes !== undefined) payload.late_minutes = late_minutes;
    if (early_out_minutes !== undefined) payload.early_out_minutes = early_out_minutes;
    if (worked_minutes !== undefined) payload.worked_minutes = worked_minutes;
    if (overtime_minutes !== undefined) payload.overtime_minutes = overtime_minutes;
    if (fine_amount !== undefined) payload.fine_amount = fine_amount;
    if (leave_category_id !== undefined) payload.leave_category_id = leave_category_id;
    if (leave_session !== undefined) payload.leave_session = leave_session;
    if (overtime_data !== undefined) payload.overtime_data = overtime_data;
    if (fine_data !== undefined) payload.fine_data = fine_data;
    if (is_locked !== undefined) payload.is_locked = is_locked;
    if (note !== undefined) payload.note = note;

    const existingRecord = await commonQuery.findOneRecord(AttendanceDay, { 
      employee_id, 
      attendance_date,
      status: { [Op.ne]: 99 } // Bypass commonQuery default status != 2 filter
    }, {}, t);
    let result;
    if (existingRecord) {
      result = await commonQuery.updateRecordById(AttendanceDay, { 
        id: existingRecord.id, 
        status: { [Op.ne]: 99 } 
      }, payload, t);
    } else {
      result = await commonQuery.createRecord(AttendanceDay, payload, t);
    }

    await t.commit();
    return res.success(constants.ATTENDANCE_UPDATED, result);
  } catch (err) {
    await t.rollback();
    return handleError(err, res, req);
  }
};

/**
 * DELETE INDIVIDUAL PUNCH
 */
exports.deletePunch = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { id } = req.body;
    if (!id) {
      await t.rollback();
      return res.error(constants.VALIDATION_ERROR, "Punch ID is required");
    }

    const punchRecord = await commonQuery.findOneRecord(AttendancePunch, { id }, {}, t);
    if (!punchRecord) {
      await t.rollback();
      return res.error(constants.NOT_FOUND, "Punch not found");
    }

    const employeeId = punchRecord.employee_id;
    const punchDate = new Date(punchRecord.punch_time).toISOString().split("T")[0];

    await commonQuery.softDeleteById(AttendancePunch, { id }, t);

    // After deleting a punch, we MUST rebuild the day summary
    await rebuildAttendanceDay(employeeId, punchDate, {
      user_id: req.user.id,
      company_id: req.user.company_id,
      branch_id: req.user.branch_id
    }, t);

    await t.commit();
    return res.success(constants.DELETED);
  } catch (err) {
    await t.rollback();
    return handleError(err, res, req);
  }
};

/**
 * DELETE ATTENDANCE DAY (and all its punches)
 */
exports.deleteAttendanceDay = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { employee_id, attendance_date } = req.body;
    if (!employee_id || !attendance_date) {
      await t.rollback();
      return res.error(constants.VALIDATION_ERROR, "Employee ID and Date are required");
    }

    // 1. Delete all raw punches for this day
    await commonQuery.softDeleteById(AttendancePunch, {
      employee_id,
      punch_time: {
        [Op.between]: [`${attendance_date} 00:00:00`, `${attendance_date} 23:59:59`]
      }
    }, t);

    // 2. Delete the day summary
    await commonQuery.softDeleteById(AttendanceDay, { 
      employee_id, 
      attendance_date,
      status: { [Op.ne]: 99 } // Bypass commonQuery status 2 filter
    }, t);

    await t.commit();
    return res.success(constants.DELETED);
  } catch (err) {
    await t.rollback();
    return handleError(err, res, req);
  }
};

/**
 * BULK UPDATE ATTENDANCE DAY
 */
exports.bulkUpdateAttendanceDay = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { 
      employee_ids, 
      attendance_date, 
      status, 
      first_in, 
      last_out,
      leave_category_id,
      leave_session,
      overtime_data,
      fine_data,
      overtime_minutes,
      fine_amount,
      note
    } = req.body;
    
    if (!employee_ids || !Array.isArray(employee_ids) || !attendance_date) {
      await t.rollback();
      return res.error(constants.VALIDATION_ERROR, "Employee IDs array and Date are required");
    }

    for (const employee_id of employee_ids) {
      // Reuse manualPunch if times are provided
      if (first_in || last_out) {
        await manualPunch(employee_id, attendance_date, first_in, last_out, {
          user_id: req.user.id,
          company_id: req.user.company_id,
          branch_id: req.user.branch_id
        }, t);
      }

      const payload = {
        employee_id,
        attendance_date,
        status,
        user_id: req.user.id,
        company_id: req.user.company_id,
        branch_id: req.user.branch_id
      };

      if (status !== undefined) payload.status = status;
      if (first_in !== undefined) payload.first_in = first_in;
      if (last_out !== undefined) payload.last_out = last_out;
      if (leave_category_id !== undefined) payload.leave_category_id = leave_category_id;
      if (leave_session !== undefined) payload.leave_session = leave_session;
      if (overtime_data !== undefined) payload.overtime_data = overtime_data;
      if (fine_data !== undefined) payload.fine_data = fine_data;
      if (overtime_minutes !== undefined) payload.overtime_minutes = overtime_minutes;
      if (fine_amount !== undefined) payload.fine_amount = fine_amount;
      if (note !== undefined) payload.note = note;

      const existingRecord = await commonQuery.findOneRecord(AttendanceDay, { 
        employee_id, 
        attendance_date,
        status: { [Op.ne]: 99 }
      }, {}, t);

      if (existingRecord) {
        await commonQuery.updateRecordById(AttendanceDay, { 
          id: existingRecord.id, 
          status: { [Op.ne]: 99 } 
        }, payload, t);
      } else {
        await commonQuery.createRecord(AttendanceDay, payload, t);
      }
    }

    await t.commit();
    return res.success(constants.ACTION_SUCCESSFUL);
  } catch (err) {
    await t.rollback();
    return handleError(err, res, req);
  }
};

/**
 * GET ATTENDANCE DAY DETAILS
 * Fetches details for a specific employee and date, including raw punches.
 */
exports.getAttendanceDayDetails = async (req, res) => {
  try {
    const requiredFields = {
      employee_id: "Employee",
      attendance_date: "Date"
    };

    const errors = await validateRequest(req.body, requiredFields);
    if (errors) {
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    const { employee_id, attendance_date } = req.body;

    // 1. Fetch the AttendanceDay record
    const attendanceDay = await commonQuery.findOneRecord(AttendanceDay, {
      employee_id,
      attendance_date,
      status: { [Op.ne]: 99 }
    }, {
      include: [
        {
          model: ShiftTemplate,
          as: "ShiftTemplate",
          attributes: ["id", "shift_name", "start_time", "end_time"]
        },
        {
          model: Employee,
          as: "Employee",
          attributes: ["id", "first_name", "employee_code"]
        },
        {
          model: LeaveTemplateCategory,
          as: "LeaveCategory", 
          attributes: ["id", "leave_category_name"],
          required: false
        }
      ]
    });

    // 2. Fetch all raw punches for this day
    const punches = await commonQuery.findAllRecords(AttendancePunch, {
      employee_id,
      punch_time: {
        [Op.between]: [`${attendance_date} 00:00:00`, `${attendance_date} 23:59:59`]
      },
      status: 0
    }, {
      order: [["punch_time", "ASC"]]
    });

    return res.ok({
      attendanceDay: attendanceDay || null,
      punches: punches
    });
  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * GET MONTHLY ATTENDANCE WITH PUNCHES
 * Fetches attendance records and punches for an employee for a specific month.
 * Expected month_year format: \"Jan 2026\", \"January 2026\", or \"2026-01\"
 */
exports.getMonthlyAttendance = async (req, res) => {
  try {
    const requiredFields = {
      employee_id: "Employee",
      month_year: "Month & Year"
    };

    const errors = await validateRequest(req.body, requiredFields);
    if (errors) {
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    const { employee_id, month_year } = req.body;
    
    // Normalize input (e.g., "jan 2026" -> "Jan 2026")
    const normalizedMonthYear = month_year.trim().replace(/\b[a-z]/g, l => l.toUpperCase());

    // Parse the date using various formats
    const date = dayjs(normalizedMonthYear, ["MMM YYYY", "MMMM YYYY", "YYYY-MM", "MM-YYYY", "YYYY-M", "M-YYYY"]);
    
    if (!date.isValid()) {
      return res.error(constants.VALIDATION_ERROR, "Invalid month and year format. Use 'Jan 2026' or 'January 2026'");
    }

    const startDate = date.startOf('month').format('YYYY-MM-DD');
    const endDate = date.endOf('month').format('YYYY-MM-DD');

    // 1. Fetch employee details
    const employee = await commonQuery.findOneRecord(Employee, { id: employee_id }, {
      attributes: ['id', 'first_name', 'employee_code', 'employee_type']
    });

    if (!employee) {
      return res.error(constants.NOT_FOUND, "Employee not found");
    }

    // 2. Fetch AttendanceDay records for the month
    const attendanceDays = await commonQuery.findAllRecords(AttendanceDay, {
      employee_id,
      attendance_date: {
        [Op.between]: [startDate, endDate]
      },
      status: { [Op.ne]: 99 }
    }, {
      include: [
        {
          model: ShiftTemplate,
          as: "ShiftTemplate",
          attributes: ["id", "shift_name", "start_time", "end_time"]
        }
      ],
      order: [["attendance_date", "ASC"]]
    });

    // 3. Fetch all raw punches for the month
    const punches = await commonQuery.findAllRecords(AttendancePunch, {
      employee_id,
      punch_time: {
        [Op.between]: [`${startDate} 00:00:00`, `${endDate} 23:59:59`]
      },
      status: 0
    }, {
      order: [["punch_time", "ASC"]]
    });

    // 4. Map punches to their respective days
    // We create a map of days in the month to ensure all days are represented if needed, 
    // or just return the existing records.
    const attendanceWithPunches = attendanceDays.map(day => {
      const dayDate = day.attendance_date;
      const dayPunches = punches.filter(p => 
        dayjs(p.punch_time).format('YYYY-MM-DD') === dayDate
      );
      
      const dayJson = day.get ? day.toJSON() : day;

      // Status mapping for human-readable labels
      const statusMap = {
        0: "PRESENT",
        1: "HALF DAY",
        3: "WEEKLY OFF",
        4: "HOLIDAY",
        5: "ABSENT",
        6: "LEAVE"
      };

      return {
        ...dayJson,
        status_text: statusMap[day.status] || "UNKNOWN",
        punches: dayPunches
      };
    });

    return res.ok({
      employeeDetails: employee,
      month_year: date.format('MMMM YYYY'),
      startDate,
      endDate,
      attendance: attendanceWithPunches
    }, "employee");
  } catch (err) {
    return handleError(err, res, req);
  }
};
