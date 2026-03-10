const { punch, manualPunch, rebuildAttendanceDay, getOrCreateAttendanceDay, syncAttendanceToLeaveBalance, bulkSyncAttendanceDays } = require("../../helpers/attendanceHelper");
const { validateRequest, commonQuery, handleError, uploadFile } = require("../../helpers");
const { constants } = require("../../helpers/constants");
const { Employee, AttendanceDay, AttendancePunch, LeaveRequest, LeaveTemplateCategory, Sequelize, sequelize, ShiftTemplate, EmployeeHoliday, User, EmployeeWeeklyOff, EmployeeLeaveBalance, ShiftBreak, EmployeeAttendanceTemplate, AttendanceTemplate, LeaveTemplate, HolidayTransaction, WeeklyOffTemplateDay, DeviceMaster } = require("../../models");
const { Op } = Sequelize;
const dayjs = require("dayjs");
const customParseFormat = require('dayjs/plugin/customParseFormat');
const LeaveBalanceService = require("../../services/leaveBalanceService");
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
        constants.ATTENDANCE_FOLDER, 
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
      user_id: req.user?.access === 'attendance device' ? 0 : req.user.id,
      company_id: req.user.company_id,
      branch_id: req.user.branch_id,
      ip_address: req.ip,
      device_id: req.user?.access === 'attendance device' ? req.user.id : (req.body.device_id || null),
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

    const { date, staff_type, shift_id, page, limit, search, filter } = req.body;
    const targetDate = date || dayjs().format("YYYY-MM-DD");

    // 1. Prepare base filters for Employee list
    const consolidatedFilter = { ...(filter || {}), status: 0 };
    if (staff_type) consolidatedFilter.employee_type = staff_type;
    if (shift_id) consolidatedFilter.shift_template = shift_id;

    // Create a shared employee filter for all summary queries
    const employeeWhere = { ...consolidatedFilter, company_id: req.user.company_id };
    if (search) {
      employeeWhere[Op.or] = [
        { first_name: { [Op.iLike]: `%${search}%` } },
        { employee_code: { [Op.iLike]: `%${search}%` } }
      ];
    }

    // 1.5 AUTO-SYNC: Create records for WO/Holiday/Leave if missing
    // This allows them to show up in summary and list immediately.
    try {
        const isPastOrToday = dayjs(targetDate).isBefore(dayjs().add(1, 'day'), 'day');
        if (isPastOrToday) {
            const employeesToSync = await Employee.findAll({
                where: employeeWhere,
                attributes: ['id', 'company_id', 'branch_id']
            });

            if (employeesToSync.length > 0) {
              await bulkSyncAttendanceDays(
                employeesToSync.map(e => e.id),
                targetDate,
                { 
                  user_id: req.user.id, 
                  company_id: req.user.company_id, 
                  branch_id: req.user.branch_id 
                }
              );
            }
        }
    } catch (syncErr) {
        console.error("Attendance Auto-Sync Error:", syncErr);
    }

    const fieldConfig = [
      ["first_name", true, true],
      ["employee_code", true, true],
    ];

    // 2. FETCH PAGINATED LIST (Lightweight: only 20 records with full associations)
    const employeesResult = await commonQuery.fetchPaginatedData(
      Employee, 
      { ...req.body, status: 0, filter: consolidatedFilter }, 
      fieldConfig, 
      {
        include: [
          {
            model: AttendanceDay,
            as: "attendanceDays",
            where: { attendance_date: targetDate, status: {[Op.ne]: 2} },
            required: false,
            include: [
              {
                model: AttendancePunch,
                as: "attendancePunches",
                required: false
              },
              {
                model: LeaveTemplateCategory,
                as: "leaveCategory",
                attributes: ["id", "leave_category_name"],
                required: false
              },
              {
                model: ShiftTemplate,
                as: "shiftTemplate",
                attributes: ["id", "shift_name", "start_time", "end_time"],
                include: [{ model: ShiftBreak, as: "ShiftBreaks" }]
              }
            ]
          },
          {
            model: ShiftTemplate,
            as: "shiftTemplate",
            attributes: ["id", "shift_name", "start_time", "end_time"],
            include: [{ model: ShiftBreak, as: "ShiftBreaks" }]
          },
          { model: EmployeeAttendanceTemplate, as: "employeeAttendanceTemplate", where: { status: 0 }, required: false },
          { model: AttendanceTemplate, as: "attendanceTemplate", required: false }
        ],
        order: [['first_name', 'ASC']],
        attributes: ['id', 'first_name', 'employee_code', 'employee_type', 'worker_type', 'shift_template', 'status', 'holiday_template', 'weekly_off_template', "branch_id"]
      }
    );

    // 2.5 Identify WO/Holiday for the paginated items
    const itemIds = employeesResult.items.map(e => e.id);
    if (itemIds.length > 0) {
      const dayOfWeek = dayjs(targetDate).day();
      const weekNo = Math.ceil(dayjs(targetDate).date() / 7);

      const [itemHolidays, itemWeeklyOffs] = await Promise.all([
        commonQuery.findAllRecords(EmployeeHoliday, { 
          employee_id: { [Op.in]: itemIds }, 
          date: targetDate, 
          status: 0 
        }, {}, null, { company_id: true }),
        commonQuery.findAllRecords(EmployeeWeeklyOff, { 
          employee_id: { [Op.in]: itemIds }, 
          day_of_week: dayOfWeek, 
          status: 0, 
          is_off: true,
          [Op.or]: [{ week_no: 0 }, { week_no: weekNo }]
        }, {}, null, { company_id: true })
      ]);

      const itemHolidayMap = new Set(itemHolidays.map(h => h.employee_id));
      const itemWeeklyOffMap = new Set(itemWeeklyOffs.map(w => w.employee_id));

      employeesResult.items.forEach(emp => {
        const day = emp.attendanceDays?.[0];
        if (day) {
          day.setDataValue('is_scheduled_holiday', itemHolidayMap.has(emp.id));
          day.setDataValue('is_scheduled_weekly_off', itemWeeklyOffMap.has(emp.id));
          
          // Enhanced Status Text logic (Same as monthly summary)
          const statusMap = { 0: "Present", 1: "Half Day", 3: "Weekly Off", 4: "Holiday", 5: "Absent", 6: "Leave", 12: "On Duty", 13: "Half On Duty" };
          let statusText = statusMap[day.status] || "Pending";
          if (day.status === 4) {
             const h = itemHolidays.find(h => h.employee_id === emp.id);
             statusText = h ? h.name : "Holiday";
          } else if (day.status === 6) {
             statusText = day.leaveCategory?.leave_category_name || "Leave";
          } else if (day.status === 1 && day.leaveCategory?.leave_category_name) {
             statusText = `Half Day / ${day.leaveCategory.leave_category_name}`;
          } else if (day.status === 0 && day.leaveCategory?.leave_category_name) {
             statusText = day.leaveCategory.leave_category_name;
          }
          day.setDataValue('status_text', statusText);
          
          if (day.first_in) {
            const punches = day.attendancePunches || [];
            const firstInPunch = punches.find(p => p.punch_type === 'IN' && dayjs(p.punch_time).format('HH:mm:ss') === day.first_in);
            day.first_in_full = firstInPunch ? firstInPunch.punch_time : dayjs(`${day.attendance_date} ${day.first_in}`).toDate();
          }
          if (day.last_out) {
            const punches = day.attendancePunches || [];
            const lastOutPunch = [...punches].reverse().find(p => p.punch_type === 'OUT' && dayjs(p.punch_time).format('HH:mm:ss') === day.last_out);
            day.last_out_full = lastOutPunch ? lastOutPunch.punch_time : dayjs(`${day.attendance_date} ${day.last_out}`).toDate();
          }
          if (day.attendancePunches) {
            day.attendancePunches.sort((a,b) => new Date(a.punch_time) - new Date(b.punch_time));
          }
        }
      });
    }

    // 3. CALCULATE SUMMARY (Efficient aggregate query on AttendanceDay)
    
    // Total matching employees for the summary context
    const totalStaff = employeesResult.total;

    // Aggregate counts from AttendanceDay table for this date
    // This is much faster than fetching objects.
    const dayStats = await commonQuery.findAllRecords(
      AttendanceDay, 
      { 
        attendance_date: targetDate, 
        status: { [Op.ne]: 2 },
        company_id: req.user.company_id
      },
      {
        include: [{
          model: Employee,
          as: 'employee',
          where: employeeWhere,
          required: true,
          attributes: []
        }],
        attributes: [
          'status',
          [sequelize.fn('COUNT', sequelize.col('AttendanceDay.id')), 'count'],
          [sequelize.fn('SUM', sequelize.col('late_minutes')), 'total_late'],
          [sequelize.fn('SUM', sequelize.col('early_out_minutes')), 'total_early_out'],
          [sequelize.fn('SUM', sequelize.col('overtime_minutes')), 'total_ot'],
          // Custom logic for short presence (status 5 and first_in exists)
          [sequelize.literal(`COUNT(CASE WHEN "AttendanceDay".status = 0 AND "AttendanceDay".first_in IS NOT NULL THEN 1 END)`), 'short_presence_count'],
          [sequelize.literal(`COUNT(CASE WHEN "AttendanceDay".status = 5 AND "AttendanceDay".first_in IS NULL THEN 1 END)`), 'absent_count_from_day'],
          [sequelize.literal(`COUNT(CASE WHEN "AttendanceDay".first_in IS NOT NULL THEN 1 END)`), 'punched_in_count'],
          [sequelize.literal(`COUNT(CASE WHEN "AttendanceDay".last_out IS NOT NULL THEN 1 END)`), 'punched_out_count'],
          [sequelize.fn('SUM', sequelize.col('fine_amount')), 'total_fine_amount']
        ],
        group: ['AttendanceDay.status'],
    raw: true
      }
    );

    let summary = {
      totalStaff,
      present: 0,
      absent: 0,
      halfDay: 0,
      weeklyOff: 0,
      holiday: 0,
      leave: 0,
      shortPresence: 0,
      currentlyWorking: 0,
      pendingPunch: 0,
      overtimeHours: "0h 0m",
      fineHours: "0h 0m",
      fineAmount: 0,
      punchedIn: 0,
      punchedOut: 0,
      incomplete: 0
    };

    let totalFineMins = 0;
    let totalOvertimeMins = 0;
    let totalAccounted = 0;

    dayStats.forEach(stat => {
      const count = parseInt(stat.count);
      const status = parseInt(stat.status);
      
      if (status === 0) summary.present += count;
      else if (status === 12) summary.present += count; // On Duty
      else if (status === 1) summary.halfDay += count;
      else if (status === 13) summary.halfDay += count; // Half On Duty
      else if (status === 3) summary.weeklyOff += count;
      else if (status === 4) summary.holiday += count;
      else if (status === 6) summary.leave += count;
      else if (status === 5) summary.absent += count;
      else if (status === 9) summary.incomplete += count;
      
      totalAccounted += count;
      totalFineMins += (parseInt(stat.total_late) || 0) + (parseInt(stat.total_early_out) || 0);
      totalOvertimeMins += (parseInt(stat.total_ot) || 0);
      summary.fineAmount += parseFloat(stat.total_fine_amount || 0);
      summary.shortPresence += parseInt(stat.short_presence_count || 0);
      summary.punchedIn += parseInt(stat.punched_in_count || 0);
      summary.punchedOut += parseInt(stat.punched_out_count || 0);
    });

    // Handle employees without day records (considered Absent/Pending)
    const unaccounted = Math.max(0, totalStaff - totalAccounted);
    // summary.absent += unaccounted;
    summary.pendingPunch = unaccounted;

    summary.currentlyWorking = Math.max(0, summary.punchedIn - summary.punchedOut);
    summary.overtimeHours = `${Math.floor(totalOvertimeMins / 60)}h ${totalOvertimeMins % 60}m`;
    summary.fineHours = `${Math.floor(totalFineMins / 60)}h ${totalFineMins % 60}m`;

    return res.ok({ 
      summary, 
      items: employeesResult.items,
      total: employeesResult.total,
      currentPage: employeesResult.currentPage,
      pageSize: employeesResult.pageSize,
      totalPages: employeesResult.totalPages
    });

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

    const emp = await commonQuery.findOneRecord(Employee, { id: req.body.employee_id }, {
      include: [
        { model: EmployeeAttendanceTemplate, as: "employeeAttendanceTemplate", where: { status: 0 }, required: false },
        { model: AttendanceTemplate, as: "attendanceTemplate", required: false },
        { model: ShiftTemplate, as: "shiftTemplate", required: false }
      ]
    });
    const template = emp?.employeeAttendanceTemplate || emp?.attendanceTemplate;
    const isTrackInOutOn = template ? template.track_in_out : true;
    
    // Get shift_id from employee if available
    const shift_id = emp && emp.shift_template ? emp.shift_template : null;

    // Add conditional required fields based on status
    if ([0, 12].includes(req.body.status)) {
      if(!req.body.note && isTrackInOutOn){
        // requiredFields.first_in = "In Time";
      }
    } else if ([1, 13].includes(req.body.status)) {
      if(!req.body.note && isTrackInOutOn){
        // requiredFields.first_in = "In Time";
        // requiredFields.last_out = "Out Time";
      }
      if (req.body.status === 1) {
          requiredFields.leave_category_id = "Leave Category";
      }
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
      overtime_amount,
      fine_data,
      is_locked,
      note,
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
    const isIncomingWorking = [0, 1, 12, 13].includes(status);
    const isTimeUpdate = (first_in !== undefined || last_out !== undefined);

    if (isExistingNonWorking && isIncomingWorking && !isTimeUpdate && isTrackInOutOn) {
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

    // 🔄 Auto-calculate Times if Overtime/Fine is Adjusted (and Times are NOT explicitly provided)
    if (!isNonWorkingStatus && !isTimeUpdate && day.shift_id && (overtime_minutes !== undefined || early_overtime_minutes !== undefined || early_out_minutes !== undefined || late_minutes !== undefined)) {
        const shift = await commonQuery.findOneRecord(ShiftTemplate, { id: day.shift_id });
        if (shift) {
            needsPunchUpdate = true;

            const firstInPunch = await commonQuery.findOneRecord(AttendancePunch, {
                day_id: day.id,
                punch_type: 'IN',
                status: 0
            }, { order: [['punch_time', 'ASC']] }, t);

            const lastOutPunch = await commonQuery.findOneRecord(AttendancePunch, {
                day_id: day.id,
                punch_type: 'OUT',
                status: 0
            }, { order: [['punch_time', 'DESC']] }, t);

            // 1. EARLY OVERTIME or LATE ENTRY (Affects First In)
            if (early_overtime_minutes !== undefined) {
                const baseIn = firstInPunch ? dayjs(firstInPunch.punch_time) : dayjs(`${attendance_date} ${shift.start_time}`);
                effectiveFirstIn = baseIn.subtract(early_overtime_minutes, 'minute').format("YYYY-MM-DD HH:mm:ss");
            }
            else if (late_minutes !== undefined) {
                const baseIn = firstInPunch ? dayjs(firstInPunch.punch_time) : dayjs(`${attendance_date} ${shift.start_time}`);
                effectiveFirstIn = baseIn.add(late_minutes, 'minute').format("YYYY-MM-DD HH:mm:ss");
            }

            // 2. LATE OVERTIME or EARLY EXIT (Affects Last Out)
            if (overtime_minutes !== undefined || early_out_minutes !== undefined) {
                let shiftEnd = dayjs(`${attendance_date} ${shift.end_time}`);
                if (shift.is_night_shift || shift.end_time < shift.start_time) {
                    shiftEnd = shiftEnd.add(1, 'day');
                }

                let baseOut = lastOutPunch ? dayjs(lastOutPunch.punch_time) : shiftEnd;

                if (overtime_minutes !== undefined) {
                    const requestEarlyOt = early_overtime_minutes !== undefined ? early_overtime_minutes : (day.early_overtime_minutes || 0);
                    const lateOvertime = Math.max(0, parseFloat(overtime_minutes || 0) - parseFloat(requestEarlyOt || 0));
                    effectiveLastOut = baseOut.add(lateOvertime, 'minute').format("YYYY-MM-DD HH:mm:ss");
                }
                else if (early_out_minutes !== undefined) {
                    effectiveLastOut = baseOut.subtract(early_out_minutes, 'minute').format("YYYY-MM-DD HH:mm:ss");
                }
            }
        }
    }

    // Only trigger punch update if strictly needed
    if (needsPunchUpdate && (effectiveFirstIn || effectiveLastOut || req.body.punches)) {
      
      // Check if today is a holiday - if so, store working hours as overtime
      let isTodayHoliday = false;
      if (emp.holiday_template) {
        const holidayRecord = await commonQuery.findOneRecord(
          HolidayTransaction,
          {
            template_id: emp.holiday_template,
            date: attendance_date,
            status: 0
          },
          {},
          t,
          false,
          { company_id: true }
        );
        isTodayHoliday = !!holidayRecord;
      }
      
      await manualPunch(employee_id, attendance_date, effectiveFirstIn, effectiveLastOut, {
        user_id: req.user.id,
        company_id: req.user.company_id,
        branch_id: req.user.branch_id,
        shift_id: shift_id,
        bypassShiftRestrictions: true,
        employee: emp, // Pass pre-fetched employee
        existingDay: day, // Pass pre-fetched day
        punches: req.body.punches, // Pass punches array if provided
        isHoliday: isTodayHoliday // Pass holiday flag to helper
      }, t);
    }
 
     // Handle manualPunch with status 1,2,3,5 - delete punches for today
    // Clear punches for non-working status
    // [MOD] Removed clearing punches for non-working status to allow punches for Half Day, Overtime on WO/Holiday, etc.
    /*
    if ([1, 3, 4, 5, 6].includes(req.body.status)) {
      console.log(`Clearing punches for status ${req.body.status} on ${attendance_date}`);
      await commonQuery.updateRecordById(
        AttendancePunch, 
        {
          employee_id: employee_id,
          day_id: day.id,
          status: 0
        }, 
        { status: 2 }, t);
    }
    */
     const payload = {
      employee_id,
      attendance_date,
      status,
      user_id: req.user.id,
      company_id: req.user.company_id,
      branch_id: req.user.branch_id
    };
    
    if (shift_id) payload.shift_id = shift_id;

    // Clear data for non-working statuses
    if ([3, 4, 5, 6].includes(status)) {
        // ALLOW overtime/punch for WO(3) and HL(4) if times are explicitly provided
        const isPunchAllowed = [3, 4].includes(status) && (payload.first_in || payload.last_out || overtime_minutes);

        if (!isPunchAllowed) {
            payload.first_in = null;
            payload.last_out = null;
            payload.shift_id = null;
            payload.worked_minutes = 0;
            payload.total_break_minutes = 0;
            payload.overtime_minutes = 0;
            payload.overtime_data = null;
            payload.overtime_amount = 0; // Ensure amount is cleared
        } else {
             // If Allowed, we KEEP first_in, last_out, worked_minutes, overtime_minutes
            if (first_in !== undefined) payload.first_in = first_in;
            if (last_out !== undefined) payload.last_out = last_out;
            if (worked_minutes !== undefined) payload.worked_minutes = worked_minutes;
            if (overtime_minutes !== undefined) payload.overtime_minutes = overtime_minutes;
            if (overtime_data !== undefined) {
                 payload.overtime_data = (overtime_data === 'null' || overtime_data === null) ? null : overtime_data;
            }
            if (overtime_amount !== undefined) {
                payload.overtime_amount = overtime_amount;
            } else if (payload.overtime_data && typeof payload.overtime_data === 'object') {
                payload.overtime_amount = parseFloat((parseFloat(payload.overtime_data.late_ot?.amount || 0) + parseFloat(payload.overtime_data.early_ot?.amount || 0)).toFixed(2));
            } else if (payload.overtime_data === null) {
                payload.overtime_amount = 0;
            }
        }

        // Always clear these for non-working status
        payload.late_minutes = 0;
        payload.early_out_minutes = 0; 
        payload.early_overtime_minutes = 0;
        payload.fine_data = null;
        payload.fine_amount = 0; // Ensure fine amount is cleared
        
        if (status !== 6) {
            payload.leave_category_id = null;
            payload.leave_session = null;
        } else {
             // For LEAVE (6), we MUST assign the category/session if provided
             if (leave_category_id !== undefined) payload.leave_category_id = leave_category_id;
             if (overtime_amount !== undefined) payload.overtime_amount = overtime_amount;
             if (overtime_data !== undefined) {
                 payload.overtime_data = (overtime_data === 'null' || overtime_data === null) ? null : overtime_data;
                 if (payload.overtime_data && typeof payload.overtime_data === 'object') {
                     payload.overtime_amount = parseFloat((parseFloat(payload.overtime_data.late_ot?.amount || 0) + parseFloat(payload.overtime_data.early_ot?.amount || 0)).toFixed(2));
                 } else if (payload.overtime_data === null) {
                     payload.overtime_amount = 0;
                 }
             }
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
             if (payload.overtime_data && typeof payload.overtime_data === 'object') {
                 payload.overtime_amount = parseFloat((parseFloat(payload.overtime_data.late_ot?.amount || 0) + parseFloat(payload.overtime_data.early_ot?.amount || 0)).toFixed(2));
             } else if (payload.overtime_data === null) {
                 payload.overtime_amount = 0;
             }
        }
        if (overtime_amount !== undefined) payload.overtime_amount = overtime_amount;
        if (fine_data !== undefined) {
             const finalFineData = (fine_data === 'null' || fine_data === null) ? null : fine_data;
             payload.fine_data = finalFineData;
             if (payload.fine_data && typeof payload.fine_data === 'object' && fine_amount === undefined) {
                 payload.fine_amount = parseFloat((
                     parseFloat(payload.fine_data.late_entry?.amount || 0) + 
                     parseFloat(payload.fine_data.early_exit?.amount || 0) + 
                     parseFloat(payload.fine_data.excess_breaks?.amount || 0)
                 ).toFixed(2));
             }
             // If fine_data is cleared significantly, ensure fine_amount is also cleared if not provided
             if (finalFineData === null && fine_amount === undefined) {
                 payload.fine_amount = 0;
             }
        }

        if (total_break_minutes !== undefined) payload.total_break_minutes = total_break_minutes;
        if (leave_category_id !== undefined) payload.leave_category_id = leave_category_id;
        if (leave_session !== undefined) payload.leave_session = leave_session;
    }

    // If status is not Half Day(1) or Leave(6) or Half OD (13), explicitly clear leave category/session
    if (status !== undefined && ![1, 6, 13].includes(status)) {
      payload.leave_category_id = null;
      payload.leave_session = null;
    }

    if (is_locked !== undefined) payload.is_locked = is_locked;
    if (note !== undefined) payload.note = note;

    // Synchronize leave balance based on status changes (Half Day/Leave)
    const balanceError = await syncAttendanceToLeaveBalance(employee_id, day, payload, t, emp);
    if (balanceError) {
      await t.rollback();
      return res.error(constants.LEAVE_BALANCE_ERROR,balanceError);
    }

    const result = await commonQuery.updateRecordById(AttendanceDay, { id: day.id }, payload, t);

    // --- LATE CHECK: SHORT LEAVE DEDUCTION ---
    // If employee is 120+ minutes late and has a last out time, deduct 1 from Short Leave.
    if (emp.leave_template) {
        // Refresh day record to get latest recalculated values (from manualPunch/rebuildAttendanceDay)
        const currentDay = await commonQuery.findOneRecord(AttendanceDay, { id: day.id }, {}, t);
        
        const shortLeaveCategory = await commonQuery.findOneRecord(LeaveTemplateCategory, {
            leave_template_id: emp.leave_template,
            leave_category_name: "Short Leave",
            status: 0
        }, {}, t, false, false); // requireTenantFields: false to find company-wide categories

        if (shortLeaveCategory && currentDay) {
            const AUTO_REASON_LATE = "Auto-generated Short Leave (Late Check)";
            const currentLateMinutes = currentDay.late_minutes || 0;
            const currentEarlyOutMinutes = currentDay.early_out_minutes || 0;
            const currentLastOut = currentDay.last_out;
            
            const totalMissedMinutes = currentLateMinutes + currentEarlyOutMinutes;
            const isLateForShortLeave = currentLastOut && totalMissedMinutes >= 120;

            const existingShortLeave = await commonQuery.findOneRecord(LeaveRequest, {
                employee_id: employee_id,
                start_date: attendance_date,
                leave_category_id: shortLeaveCategory.id,
                reason: AUTO_REASON_LATE,
                status: 0
            }, {}, t);

            if (isLateForShortLeave) {
                if (!existingShortLeave) {
                    // Check balance before deducting
                    const balance = await commonQuery.findOneRecord(EmployeeLeaveBalance, {
                        employee_id: employee_id,
                        leave_category_id: shortLeaveCategory.id,
                        status: 0
                    }, {}, t, false, { company_id: true });


                    if (balance && parseFloat(balance.pending_leaves || 0) >= 1) {
                        const leaveError = await LeaveBalanceService.syncLeaveRecord(employee_id, attendance_date, shortLeaveCategory.id, 1.0, t, emp);
                        if (leaveError) {
                            console.error(`[ShortLeaveLog] syncLeaveRecord Error: ${leaveError}`);
                            await t.rollback();
                            return res.error(constants.LEAVE_BALANCE_ERROR, leaveError);
                        }
                        await LeaveRequest.update({ reason: AUTO_REASON_LATE }, { 
                            where: { 
                                employee_id: employee_id, 
                                start_date: attendance_date, 
                                leave_category_id: shortLeaveCategory.id,
                                reason: "Auto-generated from Attendance"
                            },
                            transaction: t 
                        });
                    } 
                }
            } else if (existingShortLeave) {
                // Reverse deduction if conditions are no longer met
                const leaveError = await LeaveBalanceService.syncLeaveRecord(employee_id, attendance_date, shortLeaveCategory.id, 0, t, emp);
                if (leaveError) {
                    await t.rollback();
                    return res.error(constants.LEAVE_BALANCE_ERROR, leaveError);
                }
            }
        }
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

    // 1. Fetch the day to get ID
    const day = await commonQuery.findOneRecord(AttendanceDay, { 
      employee_id, 
      attendance_date,
    }, {}, t);

    if (day) {
      // 1.5 Synchronize leave balance before deletion (Refund if Half Day/Leave)
      const balanceError = await syncAttendanceToLeaveBalance(employee_id, day, null, t);
      if (balanceError) {
        await t.rollback();
        return res.error(balanceError);
      }

      // 2. Delete punches by day_id
      await commonQuery.softDeleteById(AttendancePunch, {
        day_id: day.id
      }, t);

      // 3. Delete the day summary
      await commonQuery.softDeleteById(AttendanceDay, { 
        id: day.id
      }, t);
    } else {
       // Fallback: Delete punches and also clear any leave record for this date
       await LeaveBalanceService.syncLeaveRecord(employee_id, attendance_date, 0, 0, t);

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

    // Pre-fetch all employees to avoid redundant queries in the loop
    const employees = await commonQuery.findAllRecords(Employee, { id: { [Op.in]: employee_ids } }, {
      include: [
        { model: EmployeeAttendanceTemplate, as: "employeeAttendanceTemplate", where: { status: 0 }, required: false },
        { model: AttendanceTemplate, as: "attendanceTemplate", required: false },
        { model: ShiftTemplate, as: "shiftTemplate", required: false }
      ]
    }, t);
    const empMap = new Map(employees.map(e => [e.id, e]));

    for (const employee_id of employee_ids) {
      const emp = empMap.get(employee_id);
      
      // Get shift_id from employee if available
      const employee_shift_id = emp && emp.shift_template ? emp.shift_template : null;
      
      const existingRecord = await commonQuery.findOneRecord(AttendanceDay, { 
        employee_id, 
        attendance_date,
      }, {}, t);

      // Reuse manualPunch if times are provided
      if (first_in || last_out) {
        await manualPunch(employee_id, attendance_date, first_in, last_out, {
          user_id: req.user.id,
          company_id: req.user.company_id,
          branch_id: req.user.branch_id,
          shift_id: employee_shift_id,
          employee: emp, // Pass pre-fetched employee
          existingDay: existingRecord // Pass pre-fetched day
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
      if (employee_shift_id) payload.shift_id = employee_shift_id;

      // Clear non-working data for status 3,4,5,6 if no times provided
      if ([3, 4, 5, 6].includes(status)) {
        const isTimeProvided = first_in !== undefined || last_out !== undefined;
        if (!isTimeProvided) {
            payload.first_in = null;
            payload.last_out = null;
            payload.shift_id = null;
            payload.worked_minutes = 0;
            payload.overtime_minutes = 0;
        }
        
        // Also clear punches
        await commonQuery.updateRecordById(AttendancePunch, {
          employee_id,
          day_id: existingRecord?.id,
          status: 0
        }, { status: 2 }, t);
      }

      if (leave_category_id !== undefined) payload.leave_category_id = leave_category_id;
      if (leave_session !== undefined) payload.leave_session = leave_session;
      if (overtime_data !== undefined) {
          payload.overtime_data = overtime_data;
          if (payload.overtime_data && typeof payload.overtime_data === 'object') {
              payload.overtime_amount = parseFloat((parseFloat(payload.overtime_data.late_ot?.amount || 0) + parseFloat(payload.overtime_data.early_ot?.amount || 0)).toFixed(2));
          } else if (payload.overtime_data === null) {
              payload.overtime_amount = 0;
          }
      }
      if (fine_data !== undefined) payload.fine_data = fine_data;
      if (overtime_minutes !== undefined) payload.overtime_minutes = overtime_minutes;
      if (fine_amount !== undefined) payload.fine_amount = fine_amount;
      if (note !== undefined) payload.note = note;

      // Synchronize leave balance based on status changes (Half Day/Leave)
      const balanceError = await syncAttendanceToLeaveBalance(employee_id, existingRecord, payload, t, emp);
      if (balanceError) {
        await t.rollback();
        return res.error(balanceError);
      }

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
          as: "shiftTemplate",
          attributes: ["id", "shift_name", "start_time", "end_time"]
        },
        {
          model: Employee,
          as: "employee",
          attributes: ["id", "first_name", "employee_code"]
        },
        {
          model: LeaveTemplateCategory,
          as: "leaveCategory", 
          attributes: ["id", "leave_category_name"],
          required: false
        },
        {
          model: AttendancePunch,
          as: "attendancePunches",
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

      // Enrich with schedule flags
      const dayOfWeek = dayjs(attendance_date).day();
      const weekNo = Math.ceil(dayjs(attendance_date).date() / 7);

      let [isHoliday, isWeeklyOff] = await Promise.all([
        commonQuery.findOneRecord(EmployeeHoliday, { 
          employee_id, 
          date: attendance_date, 
          status: 0 
        }, {}, null, false, { company_id: true }),
        commonQuery.findOneRecord(EmployeeWeeklyOff, { 
          employee_id, 
          day_of_week: dayOfWeek, 
          status: 0, 
          is_off: true,
          [Op.or]: [{ week_no: 0 }, { week_no: weekNo }]
        }, {}, null, false, { company_id: true })
      ]);

      // Fallback to Master Templates
      if (!isHoliday && attendanceDay?.employee?.holiday_template) {
          isHoliday = await commonQuery.findOneRecord(HolidayTransaction, {
              template_id: attendanceDay.employee.holiday_template,
              date: attendance_date,
              status: 0
          }, {}, null, false, { company_id: true });
      }
      if (!isWeeklyOff && attendanceDay?.employee?.weekly_off_template) {
          isWeeklyOff = await commonQuery.findOneRecord(WeeklyOffTemplateDay, {
              template_id: attendanceDay.employee.weekly_off_template,
              day_of_week: dayOfWeek,
              [Op.or]: [{ week_no: 0 }, { week_no: weekNo }],
              is_off: true,
              status: 0
          }, {}, null, false, { company_id: true });
      }

      attendanceDayJson.is_scheduled_holiday = !!isHoliday;
      attendanceDayJson.is_scheduled_weekly_off = !!isWeeklyOff;

      if (attendanceDayJson.attendancePunches) {
        punchesWithImages = attendanceDayJson.attendancePunches.map(punch => {
          // Add full image URL if image_name exists
          if (punch.image_name) {
            punch.image_url = `${process.env.FILE_SERVER_URL}${constants.ATTENDANCE_FOLDER}${punch.image_name}`;
          } else {
            punch.image_url = null;
          }
          return punch;
        });
        
        // Re-assign processed punches to the day object
        attendanceDayJson.attendancePunches = punchesWithImages;
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
      // employee_id: "Employee",
      month_year: "Month & Year"
    };

    const errors = await validateRequest(req.body, requiredFields);
    if (errors) {
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    let { employee_id, month_year } = req.body;
    if(!employee_id){
      employee_id = req.user.employee_id;
    }
    
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
      attributes: ['id', 'first_name', 'employee_code', 'employee_type', 'shift_template', 'leave_template','holiday_template', 'weekly_off_template'],
      include: [
        { model: EmployeeAttendanceTemplate, as: "employeeAttendanceTemplate", where: { status: 0 }, required: false },
        { model: AttendanceTemplate, as: "attendanceTemplate", required: false },
        { model: ShiftTemplate, as: "shiftTemplate", required: false }
      ]
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
          as: "shiftTemplate"
        },
        {
          model: LeaveTemplateCategory,
          as: "leaveCategory"
        }
      ],
      order: [["attendance_date", "ASC"]]
    });

    // 2.1 Fetch Holidays for the month
    let employeeHolidays = await commonQuery.findAllRecords(EmployeeHoliday, {
      employee_id,
      date: { [Op.between]: [startDate, endDate] },
      status: 0
    }, {}, null, { company_id: true });
    // Fallback to Master Template
    if (employeeHolidays.length === 0 && employee.holiday_template) {
        employeeHolidays = await commonQuery.findAllRecords(HolidayTransaction, {
            template_id: employee.holiday_template,
            date: { [Op.between]: [startDate, endDate] },
            status: 0
        }, {}, null, { company_id: true });
    }

    // 2.2 Fetch Weekly Offs for the employee
    let employeeWeeklyOffs = await commonQuery.findAllRecords(EmployeeWeeklyOff, {
      employee_id,
      status: 0,
      is_off: true
    }, {}, null, { company_id: true });
    // Fallback to Master Template
    if (employeeWeeklyOffs.length === 0 && employee.weekly_off_template) {
        employeeWeeklyOffs = await commonQuery.findAllRecords(WeeklyOffTemplateDay, {
            template_id: employee.weekly_off_template,
            is_off: true,
            status: 0
        }, {}, null, { company_id: true });
    }

    // 3. Fetch all raw punches for the month with User info
    const punches = await commonQuery.findAllRecords(AttendancePunch, {
      employee_id,
      punch_time: {
        [Op.between]: [`${startDate} 00:00:00`, `${endDate} 23:59:59`]
      },
      status: 0
    }, {
      include: [{
        model: User,
        as: 'user',
        attributes: ['id', 'user_name']
      },
      {
        model: DeviceMaster,
        as: 'device',
        attributes: ['id', 'device_name']
      }],
      order: [["punch_time", "ASC"]]
    });

    const summary = {
      present: 0,
      halfDay: 0,
      absent: 0,
      leave: 0,
      fine: 0,
      fineAmount: 0,
      overtime: 0
    };

    let totalFineMins = 0;
    let totalOvertimeMins = 0;

    const allDays = [];
    const daysInMonth = date.daysInMonth();
    
    const today = dayjs().format('YYYY-MM-DD');
    for (let d = 1; d <= daysInMonth; d++) {
      const curDate = date.date(d).format('YYYY-MM-DD');
      const dayObj = dayjs(curDate);
      
      // Stop if date is in the future
      if (dayObj.isAfter(dayjs(), 'day')) continue;
      
      const attendanceDay = attendanceDays.find(ad => ad.attendance_date === curDate);
      const dayPunches = punches.filter(p => dayjs(p.punch_time).format('YYYY-MM-DD') === curDate);
      
      let dayData = {
        date_display: dayObj.format("DD MMM"),
        day_display: dayObj.format("dddd"),
        attendance_date: curDate,
        shift_name: "N/A",
        time_range: "0:00 Hrs",
        day_status: 10, // Default Not Marked
        status: "Not Marked",
        note: null,
        punches: []
      };

      if (attendanceDay) {
        // Summary Counts
        if (attendanceDay.status === 0 || attendanceDay.status === 12) summary.present++;
        else if (attendanceDay.status === 1 || attendanceDay.status === 13) summary.halfDay++;
        else if (attendanceDay.status === 5) summary.absent++;
        else if (attendanceDay.status === 6) summary.leave++;

        // Only calculate fine minutes if a fine amount actually exists (as requested)
        let dayFinePenaltyMins = 0;
        if (attendanceDay.fine_data) {
          const fd = attendanceDay.fine_data;
          if (fd.late_entry?.minutes > 0) dayFinePenaltyMins += parseInt(fd.late_entry.minutes) || 0;
          if (fd.early_exit?.minutes > 0) dayFinePenaltyMins += parseInt(fd.early_exit.minutes) || 0;
          if (fd.excess_breaks?.minutes > 0) dayFinePenaltyMins += parseInt(fd.excess_breaks.minutes) || 0;
        } else if ((parseFloat(attendanceDay.fine_amount) || 0) > 0) {
          // Fallback if fine_data is missing but fine_amount exists
          dayFinePenaltyMins = (parseInt(attendanceDay.late_minutes) || 0) + (parseInt(attendanceDay.early_out_minutes) || 0);
        }

        totalFineMins += dayFinePenaltyMins;
        summary.fineAmount += parseFloat(attendanceDay.fine_amount) || 0;
        // overtime_minutes is already the total (early + late) from helper, so no need to add early_overtime_minutes again
        totalOvertimeMins += (parseInt(attendanceDay.overtime_minutes) || 0);

        const shiftName = attendanceDay.shiftTemplate?.shift_name || "N/A";
        const statusMap = { 0: "Present", 1: "Half Day", 3: "Weekly Off", 4: "Holiday", 5: "Absent", 6: "Leave", 12: "On Duty", 13: "Half On Duty" };
        let statusText = statusMap[attendanceDay.status] || "Unknown";

        if (attendanceDay.status === 6) {
          statusText = attendanceDay.leaveCategory?.leave_category_name || "Leave";
        } else if (attendanceDay.status === 4) {
          const h = employeeHolidays.find(h => h.date === curDate);
          statusText = h ? h.name : "Holiday";
        } else if (attendanceDay.status === 1 && attendanceDay.leaveCategory?.leave_category_name) {
          statusText = `Half Day / ${attendanceDay.leaveCategory.leave_category_name}`;
        } else if (attendanceDay.status === 0 && attendanceDay.leaveCategory?.leave_category_name) {
          statusText = attendanceDay.leaveCategory.leave_category_name;
        }

        let timeRange = "0:00 Hrs";
        if (attendanceDay.first_in && attendanceDay.last_out) {
          timeRange = `${dayjs(attendanceDay.first_in, "HH:mm:ss").format("hh:mm a")} - ${dayjs(attendanceDay.last_out, "HH:mm:ss").format("hh:mm a")}`;
        } else if (attendanceDay.first_in) {
          timeRange = `${dayjs(attendanceDay.first_in, "HH:mm:ss").format("hh:mm a")} - Pending`;
        }

        let varianceStr = "";
        const dayFine = dayFinePenaltyMins;
        const totalOvertime = (parseInt(attendanceDay.overtime_minutes) || 0);
        
        if (dayFine > 0 && totalOvertime > 0) {
          // Show both fine and overtime
          varianceStr = ` [+ ${Math.floor(totalOvertime / 60)}:${(totalOvertime % 60).toString().padStart(2, '0')} Hrs] [- ${Math.floor(dayFine / 60)}:${(dayFine % 60).toString().padStart(2, '0')} Hrs]`;
        } else if (dayFine > 0) {
          // Show only fine
          varianceStr = ` [- ${Math.floor(dayFine / 60)}:${(dayFine % 60).toString().padStart(2, '0')} Hrs]`;
        } else if (totalOvertime > 0) {
          // Show only overtime
          varianceStr = ` [+ ${Math.floor(totalOvertime / 60)}:${(totalOvertime % 60).toString().padStart(2, '0')} Hrs]`;
        }

        dayData = {
          ...dayData,
          id: attendanceDay.id,
          first_in: attendanceDay.first_in,
          last_out: attendanceDay.last_out,
          worked_minutes: attendanceDay.worked_minutes,
          late_minutes: attendanceDay.late_minutes,
          early_out_minutes: attendanceDay.early_out_minutes,
          early_overtime_minutes: attendanceDay.early_overtime_minutes,
          overtime_minutes: attendanceDay.overtime_minutes,
          fine_amount: attendanceDay.fine_amount,
          overtime_data: attendanceDay.overtime_data,
          fine_data: attendanceDay.fine_data,
          leave_session: attendanceDay.leave_session,
          is_locked: attendanceDay.is_locked,
          shift_id: attendanceDay.shift_id,
          shift_name: shiftName,
          time_range: timeRange + varianceStr,
          day_status: attendanceDay.status,
          status: statusText,
          note: attendanceDay.note,
          leave_category_id: attendanceDay.leave_category_id,
          is_scheduled_holiday: !!employeeHolidays.find(h => h.date === curDate),
          is_scheduled_weekly_off: !!employeeWeeklyOffs.find(wo => {
             const dayOfWeek = dayObj.day();
             const weekOfMonth = Math.ceil(dayObj.date() / 7);
             return wo.day_of_week === dayOfWeek && (wo.week_no === 0 || wo.week_no === weekOfMonth);
          }),
          punches: dayPunches.map(p => ({
            id: p.id,
            time: dayjs(p.punch_time).format("hh:mm a"),
            date_time: dayjs(p.punch_time).format("DD MMM, hh:mm A"),
            type: p.punch_type,
            punch_by: p.user?.user_name || "System",
            image_url: p.image_name ? `${process.env.FILE_SERVER_URL}${constants.ATTENDANCE_FOLDER}${p.image_name}` : null,
            punch_text: `Punched ${p.punch_type === 'IN' ? 'In' : 'Out'} via Face Scan | ${shiftName} | through ${p.device?.device_name || 'App'}`
          })).reverse()
        };
      } else {
        // No attendance record - Check Holiday
        const holiday = employeeHolidays.find(h => h.date === curDate);
        if (holiday) {
          dayData.status = holiday.name || "Holiday";
          dayData.day_status = 4;
        } else {
          // Check Weekly Off
          const dayOfWeek = dayObj.day(); // 0 is Sunday
          const weekOfMonth = Math.ceil(dayObj.date() / 7);
          const isWO = employeeWeeklyOffs.find(wo => 
            wo.day_of_week === dayOfWeek && (wo.week_no === 0 || wo.week_no === weekOfMonth) && wo.is_off && wo.status === 0
          );
          if (isWO) {
            dayData.status = "Weekly Off";
            dayData.day_status = 3;
          }
        }
        
        // Count as Absent if explicitly marked as Absent (day_status 5) and not Today/Future
        if (dayData.day_status === 5 && dayObj.isBefore(dayjs(), 'day')) {
            summary.absent++;
        }
      }
      
      allDays.push(dayData);
    }

    // Finalize Summary Formatting
    summary.fine = `${Math.floor(totalFineMins / 60)}:${(totalFineMins % 60).toString().padStart(2, '0')}`;
    summary.overtime = `${Math.floor(totalOvertimeMins / 60)}:${(totalOvertimeMins % 60).toString().padStart(2, '0')}`;

    return res.ok({
      employeeDetails: employee,
      month_year: date.format('MMMM YYYY'),
      summary,
      attendance: allDays.reverse() // DESC order
    });
  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * Get Leave Summary (Balance & History)
 * Grouped by Month for History
 */
exports.getLeaveSummary = async (req, res) => {
  try {
    let { employee_id } = req.body;
    if(!employee_id){
      employee_id = req.user.employee_id;
    }

    if (!employee_id) {
       return res.error(constants.VALIDATION_ERROR, "Employee ID is required");
    }

    // 1. Fetch Leave Balances
    const employee = await commonQuery.findOneRecord(Employee, employee_id, {
      include: [{ model: LeaveTemplate, as: "leaveTemplate" }]
    });

    let balanceCriteria = { employee_id, status: 0 };
    if (employee && employee.leaveTemplate) {
      const { end } = LeaveBalanceService.getCycleDates(employee.joining_date, employee.leaveTemplate.leave_policy_cycle);
      balanceCriteria.year = end.year();
      if (employee.leaveTemplate.leave_policy_cycle === 'MONTHLY') {
        balanceCriteria.month = end.month() + 1;
      } else {
        balanceCriteria.month = null;
      }
    }

    const balances = await commonQuery.findAllRecords(EmployeeLeaveBalance, balanceCriteria, {}, null, { company_id: true });

    // 2. Fetch Leave Requests for History (Ordered by date)
    const history = await commonQuery.findAllRecords(LeaveRequest, {
      employee_id,
      status: 0
    }, {
      include: [
        {
          model: LeaveTemplateCategory,
          as: "category",
          attributes: ["id", "leave_category_name"]
        }
        ,
        // Include approver user so we can show name in history
        {
          model: User,
          as: "approvedBy",
          attributes: ["id", "user_name"],
          required: false
        }
      ],
      order: [["start_date", "DESC"]]
    });

    // 3. Format Balances
    let totalUsed = 0;
    let totalLeft = 0;
    const formattedBalances = balances.map(b => {
      const used = parseFloat(b.used_leaves || 0);
      const allocated = parseFloat(b.total_allocated || 0);
      const left = allocated - used;
      
      totalUsed += used;
      totalLeft += left;

      return {
        id: b.id,
        leave_name: b.leave_category_name,
        balance: `${left.toFixed(1)} Left`,
        to_be_accrued: 0 // Following design
      };
    });

    // 4. Group History by Month
    const groupedHistory = [];
    history.forEach(leave => {
      const monthYear = dayjs(leave.start_date).format("MMM, YYYY");
      let group = groupedHistory.find(g => g.month_label === monthYear);
      
      if (!group) {
        group = {
          month_label: monthYear,
          total_days: 0,
          leaves: []
        };
        groupedHistory.push(group);
      }

      // Only count approved leaves in the monthly header count if needed, 
      // but usually the header shows total requested in that month
      group.total_days += parseFloat(leave.total_days || 0);
      
      const start = dayjs(leave.start_date);
      const end = dayjs(leave.end_date);
      const dateRange = `${start.format("D MMM, ddd")} - ${end.format("D MMM, ddd")}`;

      const statusMap = {
        [constants.LEAVE_APPROVAL_STATUS.PENDING]: "PENDING",
        [constants.LEAVE_APPROVAL_STATUS.PARTIALLY_APPROVED]: "PARTIALLY APPROVED",
        [constants.LEAVE_APPROVAL_STATUS.APPROVED]: "APPROVED",
        [constants.LEAVE_APPROVAL_STATUS.REJECTED]: "REJECTED",
        [constants.LEAVE_APPROVAL_STATUS.CANCELLED]: "CANCELLED",
        [constants.LEAVE_APPROVAL_STATUS.DELETED]: "DELETED",
      };

      const colorMap = {
        [constants.LEAVE_APPROVAL_STATUS.APPROVED]: "#10B981",
        [constants.LEAVE_APPROVAL_STATUS.REJECTED]: "#EF4444",
        [constants.LEAVE_APPROVAL_STATUS.PENDING]: "#F59E0B",
        [constants.LEAVE_APPROVAL_STATUS.PARTIALLY_APPROVED]: "#3B82F6",
        [constants.LEAVE_APPROVAL_STATUS.CANCELLED]: "#6B7280",
        [constants.LEAVE_APPROVAL_STATUS.DELETED]: "#9CA3AF",
      };

      group.leaves.push({
        id: leave.id,
        date_range: dateRange,
        duration_display: `${parseFloat(leave.total_days).toFixed(1)} Days | ${leave.category?.leave_category_name}`,
        reason: leave.reason || "",
        status_id: leave.approval_status,
        status: statusMap[leave.approval_status] || "PENDING",
        status_color: colorMap[leave.approval_status] || "#F59E0B",
        approved_by: leave.approvedBy?.user_name || null
      });
    });

    return res.ok({
      leave_balance: {
        total_balance_text: `${totalLeft.toFixed(1)} Leaves`,
        categories: formattedBalances,
        total_used_text: `${totalUsed.toFixed(1)} Days`
      },
      leave_history: groupedHistory
    });

  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * Update Attendance Note Only
 */
exports.updateAttendanceNote = async (req, res) => {
  try {
    const { employee_id, attendance_date, note } = req.body;

    if (!employee_id || !attendance_date) {
      return res.error(constants.VALIDATION_ERROR, "Employee ID and Date are required");
    }

    const attendanceDay = await commonQuery.findOneRecord(AttendanceDay, {
      employee_id,
      attendance_date
    });

    if (!attendanceDay) {
      return res.error(constants.NOT_FOUND, "Attendance record not found for this date");
    }

    await commonQuery.updateRecordById(AttendanceDay, attendanceDay.id, { note });

    return res.ok({ message: "Note updated successfully" });
  } catch (err) {
    return handleError(err, res, req);
  }
};
