const { punch, manualPunch, rebuildAttendanceDay, getOrCreateAttendanceDay } = require("../../helpers/attendanceHelper");
const { validateRequest, commonQuery, handleError, uploadFile } = require("../../helpers");
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

    // Handle image upload if provided
    let punchImage = null;
    if (req.files && (req.files.image || req.files['image'])) {
      const savedFiles = await uploadFile(
        req, 
        res, 
        constants.PUNCH_IMAGE_FOLDER, 
        t
      );
      punchImage = savedFiles.image || savedFiles['image'];
      
      if (!punchImage) {
        await t.rollback();
        return res.error(constants.SERVER_ERROR, { message: "Image upload failed" });
      }
    }

    const result = await punch(
      req.body.employee_id, 
      {
      ...req.body,
      user_id: req.user.id,
      company_id: req.user.company_id,
      branch_id: req.user.branch_id,
      ip_address: req.ip,
      image_name: punchImage
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
          required: false,
          include: [
            {
              model: AttendancePunch,
              as: "AttendancePunches",
              required: false
            },
          ]
        },
        {
          model: ShiftTemplate,
          as: "shiftTemplate",
          attributes: ["id", "shift_name", "start_time", "end_time"]
        }
        // {
        //   model: AttendancePunch,
        //   as: "attendance_punches",
        //   where: {
        //     punch_time: {
        //       [Op.between]: [`${targetDate} 00:00:00`, `${targetDate} 23:59:59`]
        //     }
        //   },
        //   required: false
        // }
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
      const punches = emp.attendance_days?.[0]?.AttendancePunches || [];

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

        // Add full datetime for first_in/last_out
        if (day.first_in) {
          const firstInPunch = punches.find(p => p.punch_type === 'IN' && dayjs(p.punch_time).format('HH:mm:ss') === day.first_in);
          day.first_in_full = firstInPunch ? firstInPunch.punch_time : dayjs(`${day.attendance_date} ${day.first_in}`).toDate();
        }
        if (day.last_out) {
          const lastOutPunch = punches.reverse().find(p => p.punch_type === 'OUT' && dayjs(p.punch_time).format('HH:mm:ss') === day.last_out);
          day.last_out_full = lastOutPunch ? lastOutPunch.punch_time : dayjs(`${day.attendance_date} ${day.last_out}`).toDate();
        }
        // Restore punches order
        punches.sort((a,b) => new Date(a.punch_time) - new Date(b.punch_time));
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
    };

    // Add conditional required fields based on status
    if (req.body.status === 0) {
      if(!req.body.note){
        requiredFields.first_in = "In Time";
      }
    } else if (req.body.status === 1) {
      if(!req.body.note){
        // requiredFields.first_in = "In Time";
        // requiredFields.last_out = "Out Time";
      }
      requiredFields.leave_category_id = "Leave Category";
    }

    const errors = await validateRequest(req.body, requiredFields);
    if (errors) {
      await t.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    let { 
      employee_id, 
      attendance_date, 
      status, 
      first_in, 
      last_out, 
      late_minutes, 
      early_out_minutes, 
      worked_minutes,
      overtime_minutes,
      early_overtime_minutes,
      total_break_minutes,
      fine_amount,
      leave_category_id,
      leave_session,
      overtime_data,
      fine_data,
      is_locked,
      note
    } = req.body;

    const day = await getOrCreateAttendanceDay(
      employee_id,
      attendance_date,
      {
        user_id: req.user.id,
        company_id: req.user.company_id,
        branch_id: req.user.branch_id,
      },
      t
    );

    let needsPunchUpdate = false;
    let effectiveFirstIn = first_in;
    let effectiveLastOut = last_out;
    
    // Determine Effective Status (Current DB status if not changing)
    let effectiveStatus = status !== undefined ? status : day.status;

    // 🛑 Prevent Automatic Status Upgrade (User Request: "don't let it change my status")
    // If employee is Absent/Leave/Holiday (3,4,5,6) and frontend sends Present/HalfDay (0,1)
    // We IGNORE the frontend status and keep the existing one UNLESS times are explicitly being updated.
    const isExistingNonWorking = [3, 4, 5, 6].includes(day.status);
    const isIncomingWorking = [0, 1].includes(status);
    const isTimeUpdate = (first_in !== undefined || last_out !== undefined);

    if (isExistingNonWorking && isIncomingWorking && !isTimeUpdate) {
        effectiveStatus = day.status;
        status = day.status; // Update local variable for payload
    }

    // Check if status is non-working (3: WEEKLY_OFF, 4: HOLIDAY, 5: ABSENT, 6: LEAVE)
    const isNonWorkingStatus = [3, 4, 5, 6].includes(effectiveStatus);

    // Check if Times are explicitly provided (User modifying Time)
    // isTimeUpdate already calculated above

    if (isTimeUpdate) {
        needsPunchUpdate = true;
    }

    if (isNonWorkingStatus) {
        // Only clear punches if they are NOT being explicitly updated for WO(3) or HL(4)
        const isPunchAllowed = [3, 4].includes(effectiveStatus) && isTimeUpdate;
        
        if (!isPunchAllowed) {
             effectiveFirstIn = null;
             effectiveLastOut = null;
             needsPunchUpdate = false;
        }
    }

    // 🔄 Auto-calculate Times if Overtime is Changed (ONLY if Time is NOT explicitly updated)
    if (!isNonWorkingStatus && !isTimeUpdate && day.shift_id && (overtime_minutes !== undefined || early_overtime_minutes !== undefined || early_out_minutes !== undefined || late_minutes !== undefined)) {
        const shift = await commonQuery.findOneRecord(ShiftTemplate, { id: day.shift_id });
        if (shift) {
            needsPunchUpdate = true;

            // Early Overtime -> Adjust First In
            if (early_overtime_minutes !== undefined) {
                // Construct Full Date Time for Shift Start
                let shiftStart = dayjs(`${attendance_date} ${shift.start_time}`);
                // Handle case where shift start might technically be on prev day if late shift? (Less likely for start, but possible)
                effectiveFirstIn = shiftStart.subtract(early_overtime_minutes, 'minute').format("YYYY-MM-DD HH:mm:ss");
            }
            // Late Entry -> Adjust First In (if not overridden by Early OT)
            else if (late_minutes !== undefined) {
                 let shiftStart = dayjs(`${attendance_date} ${shift.start_time}`);
                 effectiveFirstIn = shiftStart.add(late_minutes, 'minute').format("YYYY-MM-DD HH:mm:ss");
            }

            // Late Overtime -> Adjust Last Out
            if (overtime_minutes !== undefined) {
                let shiftEnd = dayjs(`${attendance_date} ${shift.end_time}`);
                // Handle Night Shift Crossing Midnight
                if (shift.is_night_shift || shift.end_time < shift.start_time) {
                    shiftEnd = shiftEnd.add(1, 'day');
                }

                const lastOutPunch = await commonQuery.findOneRecord(AttendancePunch, {
                    day_id: day.id,
                    punch_type: 'OUT'
                }, { order: [['punch_time', 'DESC']] }, t);

                let baseTime = shiftEnd;

                // 🌟 HYBRID LOGIC: If employee left EARLY (before shift end), 
                // add OT to their actual leave time to "fill the gap" or extend.
                // Otherwise (if they completed shift), add OT to Shift End.
                if (lastOutPunch && dayjs(lastOutPunch.punch_time).isBefore(shiftEnd)) {
                    baseTime = dayjs(lastOutPunch.punch_time);
                }

                const requestEarlyOt = early_overtime_minutes !== undefined ? early_overtime_minutes : (day.early_overtime_minutes || 0);
                const lateOvertime = parseFloat(overtime_minutes || 0) - parseFloat(requestEarlyOt || 0);
                
                effectiveLastOut = baseTime.add(lateOvertime, 'minute').format("YYYY-MM-DD HH:mm:ss");
            }
            // Early Exit -> Adjust Last Out (if not overridden by OT)
             else if (early_out_minutes !== undefined) {
                let shiftEnd = dayjs(`${attendance_date} ${shift.end_time}`);
                if (shift.is_night_shift || shift.end_time < shift.start_time) {
                    shiftEnd = shiftEnd.add(1, 'day');
                }
                effectiveLastOut = shiftEnd.subtract(early_out_minutes, 'minute').format("YYYY-MM-DD HH:mm:ss");
            }
        }
    }

    // Only trigger punch update if strictly needed
    if (needsPunchUpdate && (effectiveFirstIn || effectiveLastOut)) {
      await manualPunch(employee_id, attendance_date, effectiveFirstIn, effectiveLastOut, {
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

    // Clear data for non-working statuses
    if ([3, 4, 5, 6].includes(status)) {
        // ALLOW overtime/punch for WO(3) and HL(4) if times are explicitly provided
        const isPunchAllowed = [3, 4].includes(status) && (payload.first_in || payload.last_out || overtime_minutes);

        if (!isPunchAllowed) {
            payload.first_in = null;
            payload.last_out = null;
            payload.worked_minutes = 0;
            payload.total_break_minutes = 0;
            payload.overtime_minutes = 0;
            payload.overtime_data = null;
        } else {
             // If Allowed, we KEEP first_in, last_out, worked_minutes, overtime_minutes
            if (first_in !== undefined) payload.first_in = first_in;
            if (last_out !== undefined) payload.last_out = last_out;
            if (worked_minutes !== undefined) payload.worked_minutes = worked_minutes;
            if (overtime_minutes !== undefined) payload.overtime_minutes = overtime_minutes;
            if (overtime_data !== undefined) {
                 payload.overtime_data = (overtime_data === 'null' || overtime_data === null) ? null : overtime_data;
            }
        }

        // Always clear these for non-working status
        payload.late_minutes = 0;
        payload.early_out_minutes = 0; 
        payload.early_overtime_minutes = 0;
        payload.fine_data = null;
        
        if (status !== 6) {
            payload.leave_category_id = null;
            payload.leave_session = null;
        } else {
             // For LEAVE (6), we MUST assign the category/session if provided
             if (leave_category_id !== undefined) payload.leave_category_id = leave_category_id;
        }
    } else {

        if (first_in !== undefined) payload.first_in = first_in;
        if (last_out !== undefined) payload.last_out = last_out;
        
        if (late_minutes !== undefined) payload.late_minutes = late_minutes;
        if (early_out_minutes !== undefined) payload.early_out_minutes = early_out_minutes;
        if (early_overtime_minutes !== undefined) payload.early_overtime_minutes = early_overtime_minutes;
        if (worked_minutes !== undefined) payload.worked_minutes = worked_minutes;
        if (overtime_minutes !== undefined) payload.overtime_minutes = overtime_minutes;
        if (fine_amount !== undefined) payload.fine_amount = fine_amount;
        if (overtime_data !== undefined) {
             payload.overtime_data = (overtime_data === 'null' || overtime_data === null) ? null : overtime_data;
        }
        if (fine_data !== undefined) {
             const finalFineData = (fine_data === 'null' || fine_data === null) ? null : fine_data;
             payload.fine_data = finalFineData;
             // If fine_data is cleared significantly, ensure fine_amount is also cleared if not provided
             if (finalFineData === null && fine_amount === undefined) {
                 payload.fine_amount = 0;
             }
        }

        if (total_break_minutes !== undefined) payload.total_break_minutes = total_break_minutes;
        if (leave_category_id !== undefined) payload.leave_category_id = leave_category_id;
        if (leave_session !== undefined) payload.leave_session = leave_session;
    }

    if (is_locked !== undefined) payload.is_locked = is_locked;
    if (note !== undefined) payload.note = note;

    const result = await commonQuery.updateRecordById(AttendanceDay, { id: day.id }, payload, t);

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

    // 1. Fetch the day to get ID
    const day = await commonQuery.findOneRecord(AttendanceDay, { 
      employee_id, 
      attendance_date,
    }, {}, t);

    if (day) {
      // 2. Delete punches by day_id
      await commonQuery.softDeleteById(AttendancePunch, {
        day_id: day.id
      }, t);

      // 3. Delete the day summary
      await commonQuery.softDeleteById(AttendanceDay, { 
        id: day.id
      }, t);
    } else {
       // Fallback: Delete by date range if day record not found (to be safe? or just return?)
       // User emphasized matching day_id. If no day, effectively no day-bound punches.
       // We can iterate punches by date and delete them? 
       // But if day_id is enforced now, finding by date might delete orphaned punches?
       // Let's stick to deleting if Day exists. If not, maybe we just return success or try unsafe delete?
       // Safe delete by date range for backward compatibility:
       await commonQuery.softDeleteById(AttendancePunch, {
        employee_id,
        punch_time: {
           [Op.between]: [`${attendance_date} 00:00:00`, `${attendance_date} 23:59:59`]
        }
       }, t);
    }

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
      }, {}, t);

      if (existingRecord) {
        await commonQuery.updateRecordById(AttendanceDay, { 
          id: existingRecord.id,
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
        },
        {
          model: AttendancePunch,
          as: "AttendancePunches",
          required: false,
          order: [["punch_time", "ASC"]]
        }
      ]
    });

    // 2. Fetch all raw punches for this day
    // const punches = await commonQuery.findAllRecords(AttendancePunch, {
    //   employee_id,
    //   punch_time: {
    //     [Op.between]: [`${attendance_date} 00:00:00`, `${attendance_date} 23:59:59`]
    //   },
    //   status: 0
    // }, {
    //   order: [["punch_time", "ASC"]]
    // });

    // 3. Process AttendanceDay and add image URLs to punches
    let attendanceDayJson = null;
    let punchesWithImages = [];

    if (attendanceDay) {
      attendanceDayJson = attendanceDay.get ? attendanceDay.toJSON() : attendanceDay;

      if (attendanceDayJson.AttendancePunches) {
        punchesWithImages = attendanceDayJson.AttendancePunches.map(punch => {
          // Add full image URL if image_name exists
          if (punch.image_name) {
            punch.image_url = `${process.env.FILE_SERVER_URL}${constants.PUNCH_IMAGE_FOLDER}${punch.image_name}`;
          } else {
            punch.image_url = null;
          }
          return punch;
        });
        
        // Re-assign processed punches to the day object
        attendanceDayJson.AttendancePunches = punchesWithImages;
      }
    }

    return res.ok({
      attendanceDay: attendanceDayJson,
      // punches: punchesWithImages
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
