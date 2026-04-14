const { commonQuery, handleError} = require("../../helpers");
const { constants } = require("../../helpers/constants");
const { Employee, AttendanceDay, LeaveTemplateCategory, sequelize, ShiftTemplate, EmployeeHoliday, EmployeeWeeklyOff, OutDutyRequest, Department, DesignationMaster, LeaveRequest, EmployeeLeaveBalance, BranchMaster } = require("../../models");
const { Op } = require("sequelize");
const dayjs = require("dayjs");
const customParseFormat = require('dayjs/plugin/customParseFormat');
const isSameOrBefore = require('dayjs/plugin/isSameOrBefore');
dayjs.extend(customParseFormat);
dayjs.extend(isSameOrBefore);

/**
 * GET ATTENDANCE REPORT (Daily or Monthly)
 */
exports.getAttendanceReport = async (req, res) => {
  try {
    const { report_type, date, month_year, staff_type, branch_id, department_id } = req.body;

    if (!report_type || !['daily', 'monthly'].includes(report_type)) {
      return res.error(constants.VALIDATION_ERROR, "report_type must be either 'daily' or 'monthly'");
    }

    let startDate, endDate;
    if (report_type === 'daily') {
      if (!date) return res.error(constants.VALIDATION_ERROR, "date is required for daily report");
      startDate = date;
      endDate = date;
    } else {
      if (!month_year) return res.error(constants.VALIDATION_ERROR, "month_year is required for monthly report");
      const normalizedMonthYear = month_year.trim().replace(/\b[a-z]/g, l => l.toUpperCase());
      const parsedDate = dayjs(normalizedMonthYear, ["MMM YYYY", "MMMM YYYY", "YYYY-MM", "MM-YYYY", "YYYY-M", "M-YYYY"]);
      if (!parsedDate.isValid()) {
        return res.error(constants.VALIDATION_ERROR, "Invalid month and year format");
      }
      startDate = parsedDate.startOf('month').format('YYYY-MM-DD');
      endDate = parsedDate.endOf('month').format('YYYY-MM-DD');
    }

    const employeeWhere = { 
      company_id: req.user.company_id,
      status: [0, 1],
      [Op.and]: [
        {
          [Op.or]: [
            { joining_date: null },
            { joining_date: { [Op.lte]: endDate } }
          ]
        },
        {
          [Op.or]: [
            { exit_date: null },
            { exit_date: { [Op.gte]: startDate } }
          ]
        }
      ]
    };
    if (branch_id && branch_id !== 'All' && branch_id !== 0 && branch_id !== '0') employeeWhere.branch_id = branch_id;
    if (staff_type) employeeWhere.employee_type = staff_type;
    if (department_id && department_id !== 'All') employeeWhere.department_id = department_id;

    // 1. Fetch All Active Employees
    const fieldConfig = [
      ["first_name", true, true],
      ["employee_code", true, true],
    ];

    const employees = await commonQuery.fetchPaginatedData(
      Employee,
      { ...employeeWhere, ...req.body },
      fieldConfig,
      {
        attributes: ['id', 'first_name', 'employee_code', 'employee_type', 'worker_type', 'holiday_template', 'weekly_off_template', 'joining_date', 'exit_date', 'branch_id'],
        include: [
          { model: ShiftTemplate, as: "shiftTemplate", attributes: ["id", "shift_name"] },
          { model: Department, as: "department", attributes: ["name"] },
          { model: DesignationMaster, as: "designation", attributes: ["designation_name"] }
        ],
        order: [['first_name', 'ASC']]
      },
      { company_id: true, branch_id: true },
      'created_at'
    );

    if (employees.items.length === 0) return res.ok({ items: [], total: 0, currentPage: 1, pageSize: 10, totalPages: 0, hasNextPage: false, hasPreviousPage: false, appliedFilters: {} });

    const employeeIds = employees.items.map(e => e.id);

    // 2. Fetch Attendance Days
    const attendanceDays = await commonQuery.findAllRecords(AttendanceDay, {
      employee_id: { [Op.in]: employeeIds },
      attendance_date: { [Op.between]: [startDate, endDate] },
      status: { [Op.ne]: 2 }
    }, {
      include: [
        { model: LeaveTemplateCategory, as: "leaveCategory", attributes: ["id", "leave_category_name"] }
      ],
      order: [['attendance_date', 'ASC']]
    }, null, { company_id: true });

    // 3. Pre-fetch Holidays & Week Offs & Out Duty
    const [holidays, weeklyOffs, outDuties] = await Promise.all([
      commonQuery.findAllRecords(EmployeeHoliday, { employee_id: { [Op.in]: employeeIds }, date: { [Op.between]: [startDate, endDate] }, status: 0 }),
      commonQuery.findAllRecords(EmployeeWeeklyOff, { employee_id: { [Op.in]: employeeIds }, status: 0, is_off: true }),
      commonQuery.findAllRecords(OutDutyRequest, { employee_id: { [Op.in]: employeeIds }, approval_status: constants.OUT_DUTY_STATUS.APPROVED, start_date: { [Op.lte]: endDate }, end_date: { [Op.gte]: startDate }, status: 0 })
    ]);

    // Fast lookups
    const attendanceMap = new Map();
    attendanceDays.forEach(day => {
      const key = `${day.employee_id}_${day.attendance_date}`;
      attendanceMap.set(key, day);
    });

    const holidayMap = new Map();
    holidays.forEach(h => {
      const key = `${h.employee_id}_${h.date}`;
      holidayMap.set(key, true);
    });

    const outDutyMap = new Map();
    outDuties.forEach(od => {
      const currDate = dayjs(od.start_date);
      const limitDate = dayjs(od.end_date);
      while(currDate.isBefore(limitDate) || currDate.isSame(limitDate, 'day')) {
         outDutyMap.set(`${od.employee_id}_${currDate.format('YYYY-MM-DD')}`, true);
         currDate.add(1, 'day');
      }
    });

    // Generate date range
    let curDate = dayjs(startDate);
    const end = dayjs(endDate);
    const daysArray = [];
    while (curDate.isBefore(end) || curDate.isSame(end, 'day')) {
      daysArray.push(curDate.format('YYYY-MM-DD'));
      curDate = curDate.add(1, 'day');
    }

    const reportData = [];

    // 4. Transform data into report structure
    for (const emp of employees.items) {
      const empData = {
        employee_id: emp.id,
        employee_code: emp.employee_code,
        employee_name: emp.first_name.trim(),
        employee_type: emp.employee_type || 'N/A',
        employee_type_label: { 1: "Staff", 2: "Worker", 3: "Contractor" }[emp.employee_type] || 'N/A',
        worker_type_label: { 1: "On-role", 2: "Off-role" }[emp.worker_type] || '',
        department: emp.department?.name || '-',
        designation: emp.designation?.designation_name || '-',
        shift_name: emp.shiftTemplate?.shift_name || 'N/A',
        days: {},
        summary: {
           present: 0,
           halfDay: 0,
           absent: 0,
           leave: 0,
           holiday: 0,
           weeklyOff: 0,
           outDuty: 0,
           totalWorkedMinutes: 0,
           totalLateMinutes: 0,
           totalOvertimeMinutes: 0
        }
      };

      for (const d of daysArray) {
        const key = `${emp.id}_${d}`;
        const dayRecord = attendanceMap.get(key);
        
        let status = "PENDING";
        let statusId = null;
        let inTime = null;
        let outTime = null;
        let workedMins = 0;
        let lateMins = 0;
        let otMins = 0;
        
        const dayOfWeek = dayjs(d).day();
        const weekNo = Math.ceil(dayjs(d).date() / 7);
        const isScheduledWo = weeklyOffs.some(wo => wo.employee_id === emp.id && wo.day_of_week === dayOfWeek && (wo.week_no === 0 || wo.week_no === weekNo));

        if (dayRecord) {
           statusId = dayRecord.status;
           const sMap = { 0: "Present", 1: "Half Day", 3: "Weekly Off", 4: "Holiday", 5: "Absent", 6: "Leave", 12: "Out Duty", 13: "Half Out Duty" };
           status = sMap[statusId] || "Pending";
           
           if (statusId === 6 && dayRecord.leaveCategory) status = dayRecord.leaveCategory.leave_category_name;
           else if (statusId === 1 && dayRecord.leaveCategory) status = `Half Day / ${dayRecord.leaveCategory.leave_category_name}`;

           if (dayRecord.first_in) inTime = dayRecord.first_in;
           if (dayRecord.last_out) outTime = dayRecord.last_out;
           workedMins = dayRecord.worked_minutes || 0;
           lateMins = dayRecord.fine_data?.late_entry?.minutes || 0;
           otMins = dayRecord.overtime_minutes || 0;

           if (statusId === 0) empData.summary.present += 1;
           else if (statusId === 1) empData.summary.halfDay += 1;
           else if (statusId === 3) empData.summary.weeklyOff += 1;
           else if (statusId === 4) empData.summary.holiday += 1;
           else if (statusId === 5) empData.summary.absent += 1;
           else if (statusId === 6) empData.summary.leave += 1;
           else if (statusId === 12) empData.summary.outDuty += 1;
           else if (statusId === 13) empData.summary.halfDay += 1;
        } else {
           // Inherit auto statuses
           if (holidayMap.has(key)) {
               status = "Holiday";
               empData.summary.holiday += 1;
           } else if (isScheduledWo) {
               status = "Weekly Off";
               empData.summary.weeklyOff += 1;
           } else if (outDutyMap.has(key)) {
               status = "Out Duty";
               empData.summary.outDuty += 1;
           } else if (dayjs(d).isBefore(dayjs(emp.joining_date || dayjs()), 'day') || (emp.exit_date && dayjs(d).isAfter(dayjs(emp.exit_date), 'day'))) {
               status = "N/A";
           } else if (dayjs(d).isSame(dayjs(), 'day') || dayjs(d).isAfter(dayjs(), 'day')) {
               status = "Pending";
           } else {
               status = "Absent";
               empData.summary.absent += 1;
           }
        }

        empData.summary.totalWorkedMinutes += workedMins;
        empData.summary.totalLateMinutes += lateMins;
        empData.summary.totalOvertimeMinutes += otMins;

        empData.days[d] = {
           status,
           inTime,
           outTime,
           workedMins: Math.floor(workedMins / 60) + 'h ' + (workedMins % 60) + 'm',
           otMins: Math.floor(otMins / 60) + 'h ' + (otMins % 60) + 'm',
           lateMins: Math.floor(lateMins / 60) + 'h ' + (lateMins % 60) + 'm',
        };
      }

      reportData.push(empData);
    }

    return res.ok({
      report_type,
      start_date: startDate,
      end_date: endDate,
      items: reportData,
      total: employees.total,
      totals: employees.totals,
      currentPage: employees.currentPage,
      pageSize: employees.pageSize,
      totalPages: employees.totalPages,
      hasNextPage: employees.hasNextPage,
      hasPreviousPage: employees.hasPreviousPage,
      appliedFilters: employees.appliedFilters
    });
  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * GET LATE ENTRY REPORT
 */
exports.getLateEntryReport = async (req, res) => {
  try {
    const { month, year, branch_id, department_id } = req.body;

    if (!month || !year) {
      return res.error("VALIDATION_ERROR", { message: "Month and Year are required" });
    }

    const startDate = dayjs(`${year}-${month}-01`).startOf('month').format('YYYY-MM-DD');
    let endDate = dayjs(`${year}-${month}-01`).endOf('month').format('YYYY-MM-DD');

    // Cap the endDate to today's date if the selected month is the current month or in the future
    if (dayjs(endDate).isAfter(dayjs(), 'day')) {
        endDate = dayjs().format('YYYY-MM-DD');
    }

    let employeeWhere = { 
      company_id: req.user.company_id,
      status: [0, 1],
      [Op.and]: [
        {
          [Op.or]: [
            { joining_date: null },
            { joining_date: { [Op.lte]: endDate } }
          ]
        },
        {
          [Op.or]: [
            { exit_date: null },
            { exit_date: { [Op.gte]: startDate } }
          ]
        }
      ]
    };
    if (branch_id && branch_id !== 'All' && branch_id !== 0 && branch_id !== '0') {
      employeeWhere.branch_id = branch_id;
    }
    if (department_id && department_id !== 'All') employeeWhere.department_id = department_id;

    const fieldConfig = [
      ["first_name", true, true],
      ["employee_code", true, true],
    ];

    const employees = await commonQuery.fetchPaginatedData(
      Employee,
      { ...employeeWhere, ...req.body },
      fieldConfig,
      {
        attributes: ['id', 'first_name', 'employee_code', 'mobile_no', 'branch_id', 'employee_type', 'worker_type'],
        include: [
          { model: Department, as: 'department', attributes: ['name'] },
          { model: DesignationMaster, as: 'designation', attributes: ['designation_name'] }
        ]
      },
      { company_id: true, branch_id: true },
      'created_at'
    );

    if (employees.items.length === 0) return res.ok({ daysArray: [], items: [], total: 0, currentPage: 1, pageSize: 10, totalPages: 0, hasNextPage: false, hasPreviousPage: false, appliedFilters: {} });

    const employeeIds = employees.items.map(e => e.id);

    // Fetch all attendance records with late minutes OR early exit minutes > 0
    const attendanceRecords = await commonQuery.findAllRecords(AttendanceDay, {
      employee_id: { [Op.in]: employeeIds },
      attendance_date: { [Op.between]: [startDate, endDate] },
      [Op.or]: [
        sequelize.literal(`fine_data->'late_entry' IS NOT NULL`),
        sequelize.literal(`fine_data->'early_exit' IS NOT NULL`)
      ],
      status: { [Op.ne]: 2 }
    }, {
      order: [['attendance_date', 'ASC']]
    }, null, { company_id: true });

    // Group punctuality records by employee
    const punctualityDataMap = {};
    attendanceRecords.forEach(record => {
      if (!punctualityDataMap[record.employee_id]) {
         punctualityDataMap[record.employee_id] = { 
           days: {}, 
           totalLateMins: 0, 
           totalEarlyMins: 0,
           lateCount: 0, 
           earlyCount: 0,
           totalFineAmount: 0 
         };
      }
      
      const fineData = record.fine_data || {};
      const lateMins = fineData.late_entry?.minutes || 0;
      const lateFine = parseFloat(fineData.late_entry?.amount || 0);
      const earlyMins = fineData.early_exit?.minutes || 0;
      const earlyFine = parseFloat(fineData.early_exit?.amount || 0);
      
      if (lateMins > 0 || earlyMins > 0) {
        punctualityDataMap[record.employee_id].days[record.attendance_date] = { 
          lateMins, 
          lateFine,
          earlyMins,
          earlyFine,
          totalMins: lateMins + earlyMins,
          totalFine: lateFine + earlyFine
        };
        
        if (lateMins > 0) {
          punctualityDataMap[record.employee_id].totalLateMins += lateMins;
          punctualityDataMap[record.employee_id].lateCount += 1;
        }
        if (earlyMins > 0) {
          punctualityDataMap[record.employee_id].totalEarlyMins += earlyMins;
          punctualityDataMap[record.employee_id].earlyCount += 1;
        }
        punctualityDataMap[record.employee_id].totalFineAmount += (lateFine + earlyFine);
      }
    });

    const reportData = [];

    // Construct dynamically the full array of dates in the month to use as dynamic columns optionally
    let curDate = dayjs(startDate);
    const end = dayjs(endDate);
    const daysArray = [];
    while (curDate.isBefore(end) || curDate.isSame(end, 'day')) {
      daysArray.push(curDate.format('D-MMM-YY'));
      curDate = curDate.add(1, 'day');
    }

    employees.items.forEach(emp => {
      const pInfo = punctualityDataMap[emp.id];
      if (!pInfo) return;

      const totalLateMins = pInfo.totalLateMins || 0;
      const totalEarlyMins = pInfo.totalEarlyMins || 0;
      const hoursLate = Math.floor(totalLateMins / 60);
      const minsLate = totalLateMins % 60;
      const hoursEarly = Math.floor(totalEarlyMins / 60);
      const minsEarly = totalEarlyMins % 60;
      
      let row = {
        employee_name: emp.first_name || '-',
        employee_code: emp.employee_code || '-',
        phone_number: emp.mobile_no || '-',
        department: emp.department?.name || '-',
        designation: emp.designation?.designation_name || '-',
        employee_type: { 1: "Staff", 2: "Worker", 3: "Contractor" }[emp.employee_type] || 'N/A',
        worker_type: { 1: "On-role", 2: "Off-role" }[emp.worker_type] || 'N/A',
        late_days_count: pInfo.lateCount,
        early_exit_count: pInfo.earlyCount,
        total_late: `${hoursLate > 0 ? hoursLate + 'h ' : ''}${minsLate}m`,
        total_early: `${hoursEarly > 0 ? hoursEarly + 'h ' : ''}${minsEarly}m`,
        total_fine_amount: pInfo.totalFineAmount.toFixed(2),
        days: {} 
      };

      Object.keys(pInfo.days).forEach(dateStr => {
         const day = pInfo.days[dateStr];
         const formattedDate = dayjs(dateStr).format('D-MMM-YY');
         
         let detailStr = "";
         if (day.lateMins > 0) detailStr += `L: ${day.lateMins}m `;
         if (day.earlyMins > 0) detailStr += `E: ${day.earlyMins}m`;
         
         row.days[formattedDate] = {
            duration: detailStr.trim(),
            amount: day.totalFine
         };
      });

      reportData.push(row);
    });

    return res.ok({
      daysArray: daysArray,
      items: reportData,
      total: employees.total,
      totals: employees.totals,
      currentPage: employees.currentPage,
      pageSize: employees.pageSize,
      totalPages: employees.totalPages,
      hasNextPage: employees.hasNextPage,
      hasPreviousPage: employees.hasPreviousPage,
      appliedFilters: employees.appliedFilters
    });

  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * GET OVERTIME REPORT
 */
exports.getOvertimeReport = async (req, res) => {
  try {
    const { month, year, branch_id, department_id } = req.body;

    if (!month || !year) {
      return res.error("VALIDATION_ERROR", { message: "Month and Year are required" });
    }

    const startDate = dayjs(`${year}-${month}-01`).startOf('month').format('YYYY-MM-DD');
    let endDate = dayjs(`${year}-${month}-01`).endOf('month').format('YYYY-MM-DD');

    // Cap the endDate to today's date if the selected month is the current month or in the future
    if (dayjs(endDate).isAfter(dayjs(), 'day')) {
        endDate = dayjs().format('YYYY-MM-DD');
    }

    let employeeWhere = { 
      company_id: req.user.company_id,
      status: [0, 1],
      [Op.and]: [
        {
          [Op.or]: [
            { joining_date: null },
            { joining_date: { [Op.lte]: endDate } }
          ]
        },
        {
          [Op.or]: [
            { exit_date: null },
            { exit_date: { [Op.gte]: startDate } }
          ]
        }
      ]
    };
    if (branch_id && branch_id !== 'All' && branch_id !== 0 && branch_id !== '0') {
      employeeWhere.branch_id = branch_id;
    }
    if (department_id && department_id !== 'All') employeeWhere.department_id = department_id;

    const fieldConfig = [
      ["first_name", true, true],
      ["employee_code", true, true],
    ];

    const employees = await commonQuery.fetchPaginatedData(
      Employee,
      { ...employeeWhere, ...req.body },
      fieldConfig,
      {
        attributes: ['id', 'first_name', 'employee_code', 'mobile_no', 'branch_id', 'employee_type', 'worker_type'],
        include: [
          { model: Department, as: 'department', attributes: ['name'] },
          { model: DesignationMaster, as: 'designation', attributes: ['designation_name'] }
        ]
      },
      { company_id: true, branch_id: true },
      'created_at'
    );

    if (employees.items.length === 0) return res.ok({ daysArray: [], items: [], total: 0, currentPage: 1, pageSize: 10, totalPages: 0, hasNextPage: false, hasPreviousPage: false, appliedFilters: {} });

    const employeeIds = employees.items.map(e => e.id);

    // Fetch all attendance records for overtime
    const attendanceRecords = await commonQuery.findAllRecords(AttendanceDay, {
      employee_id: { [Op.in]: employeeIds },
      attendance_date: { [Op.between]: [startDate, endDate] },
      status: { [Op.ne]: 2 }
    }, {
      order: [['attendance_date', 'ASC']]
    }, null, { company_id: true });

    // Group overtime records by employee
    const otDataMap = {};
    attendanceRecords.forEach(record => {
      if (!otDataMap[record.employee_id]) {
         otDataMap[record.employee_id] = { days: {}, totalOTMins: 0, totalOTAmount: 0 };
      }
      const otMins = record.overtime_minutes || 0;
      const otAmount = parseFloat(record.overtime_amount || 0);
      if (otMins >= 0) {
          otDataMap[record.employee_id].days[record.attendance_date] = { mins: otMins, amount: otAmount };
          otDataMap[record.employee_id].totalOTMins += otMins;
          otDataMap[record.employee_id].totalOTAmount += otAmount;
      }
    });

    const reportData = [];

    // Construct dynamically the full array of dates in the month to use as dynamic columns optionally
    let curDate = dayjs(startDate);
    const end = dayjs(endDate);
    const daysArray = [];
    while (curDate.isBefore(end) || curDate.isSame(end, 'day')) {
      daysArray.push(curDate.format('D-MMM-YY'));
      curDate = curDate.add(1, 'day');
    }

    employees.items.forEach(emp => {
      const otInfo = otDataMap[emp.id] || { days: {}, totalOTMins: 0, totalOTAmount: 0 };

      const totalMins = otInfo.totalOTMins;
      const hours = Math.floor(totalMins / 60);
      const mins = totalMins % 60;
      
      let row = {
        employee_name: emp.first_name || '-',
        employee_code: emp.employee_code || '-',
        phone_number: emp.mobile_no || '-',
        department: emp.department?.name || '-',
        designation: emp.designation?.designation_name || '-',
        employee_type: { 1: "Staff", 2: "Worker", 3: "Contractor" }[emp.employee_type] || 'N/A',
        worker_type: { 1: "On-role", 2: "Off-role" }[emp.worker_type] || 'N/A',
        total_overtime: `${hours < 10 ? '0'+hours : hours}h ${mins < 10 ? '0'+mins : mins}m`,
        total_overtime_amount: otInfo.totalOTAmount.toFixed(2),
        days: {} // Date string to overtime duration string
      };

      // Populate daily overtime minutes string
      daysArray.forEach(dateStr => {
         const sysDateStr = dayjs(dateStr, 'D-MMM-YY').format('YYYY-MM-DD');
         const d = otInfo.days[sysDateStr] || { mins: 0, amount: 0 };
         const m = d.mins;
         const h = Math.floor(m / 60);
         const min = m % 60;
         row.days[dateStr] = m > 0 ? {
           duration: `${h < 10 ? '0'+h : h}h ${min < 10 ? '0'+min : min}m`,
           amount: d.amount.toFixed(2)
         } : '-';
      });

      reportData.push(row);
    });

    return res.ok({
      daysArray: daysArray,
      items: reportData,
      total: employees.total,
      totals: employees.totals,
      currentPage: employees.currentPage,
      pageSize: employees.pageSize,
      totalPages: employees.totalPages,
      hasNextPage: employees.hasNextPage,
      hasPreviousPage: employees.hasPreviousPage,
      appliedFilters: employees.appliedFilters
    });

  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.getLeaveReport = async (req, res) => {
    try {
        const { year, staff_type, branch_id } = req.body;

        if (!year) {
             return res.error(constants.VALIDATION_ERROR, "year is required");
        }

        const startDateStr = `${year}-01-01`;
        const endDateStr = `${year}-12-31`;
        const startDate = dayjs(startDateStr);
        const endDate = dayjs(endDateStr);

        // Fetch Employees
        const employeeWhere = { status: 0, company_id: req.user.company_id };
        if (branch_id && branch_id !== 'All' && branch_id !== 0 && branch_id !== '0') employeeWhere.branch_id = branch_id;
        if (staff_type) employeeWhere.employee_type = staff_type;

        // Fetch all branches for mapping since it's not directly included via model sometimes
        const branches = await commonQuery.findAllRecords(BranchMaster, { company_id: req.user.company_id });
        const branchMap = {};
        branches.forEach(b => branchMap[b.id] = b.branch_name);

        const fieldConfig = [
            ["first_name", true, true],
            ["employee_code", true, true],
        ];

        const employees = await commonQuery.fetchPaginatedData(
            Employee,
            { ...employeeWhere, ...req.body },
            fieldConfig,
            {
                attributes: ['id', 'first_name', 'employee_code', 'mobile_no', 'joining_date', 'branch_id'],
                include: [
                    { model: Department, as: 'department', attributes: ['name'] },
                    { model: DesignationMaster, as: 'designation', attributes: ['designation_name'] },
                ]
            },
            { company_id: true },
            'created_at'
        );

        if (employees.items.length === 0) return res.ok({ categories: [], items: [], total: 0, currentPage: 1, pageSize: 10, totalPages: 0, hasNextPage: false, hasPreviousPage: false, appliedFilters: {} });
        const employeeIds = employees.items.map(e => e.id);

        // Fetch LeaveBalances logic
        const balances = await commonQuery.findAllRecords(EmployeeLeaveBalance, {
            year: parseInt(year),
            employee_id: { [Op.in]: employeeIds },
            status: 0
        });

        const balancesByEmp = {};
        balances.forEach(b => {
            if(!balancesByEmp[b.employee_id]) balancesByEmp[b.employee_id] = {};
            const catName = b.leave_category_name;
            const assigned = parseFloat(b.total_allocated || 0) + parseFloat(b.carry_forward_leaves || 0);
            balancesByEmp[b.employee_id][catName] = assigned;
        });

        // Prepare categories
        const allLeaveCategories = await commonQuery.findAllRecords(LeaveTemplateCategory, { company_id: req.user.company_id, branch_id: req.user.branch_id, status: 0 });
        const leaveCatNames = allLeaveCategories.map(c => c.leave_category_name);
        const allCategories = ['Week Off', 'Holiday', ...leaveCatNames];

        // Fetch leaves, weekoffs, holidays
        const leaves = await commonQuery.findAllRecords(LeaveRequest, {
            employee_id: { [Op.in]: employeeIds },
            approval_status: constants.LEAVE_APPROVAL_STATUS.APPROVED,
            status: 0,
            [Op.or]: [
                { start_date: { [Op.between]: [startDateStr, endDateStr] } },
                { end_date: { [Op.between]: [startDateStr, endDateStr] } },
                { [Op.and]: [{ start_date: { [Op.lte]: startDateStr } }, { end_date: { [Op.gte]: endDateStr } }] }
            ]
        }, {
            include: [{ model: LeaveTemplateCategory, as: 'category', attributes: ['leave_category_name'] }]
        });

        const holidays = await commonQuery.findAllRecords(EmployeeHoliday, {
            employee_id: { [Op.in]: employeeIds },
            status: 0,
            date: { [Op.between]: [startDateStr, endDateStr] }
        });

        const weekOffs = await commonQuery.findAllRecords(EmployeeWeeklyOff, {
            employee_id: { [Op.in]: employeeIds },
            status: 0
        });

        const holidaysByEmp = {};
        holidays.forEach(h => {
            if(!holidaysByEmp[h.employee_id]) holidaysByEmp[h.employee_id] = [];
            holidaysByEmp[h.employee_id].push({ date: h.date, name: h.name });
        });

        const weekOffsByEmp = {};
        weekOffs.forEach(w => {
            if(!weekOffsByEmp[w.employee_id]) weekOffsByEmp[w.employee_id] = [];
            weekOffsByEmp[w.employee_id].push({ day: w.day_of_week, weekMask: w.week_no });
        });

        const leavesByEmp = {};
        leaves.forEach(l => {
            if(!leavesByEmp[l.employee_id]) leavesByEmp[l.employee_id] = [];
            leavesByEmp[l.employee_id].push({
                start: dayjs(l.start_date).isBefore(startDate) ? startDate : dayjs(l.start_date),
                end: dayjs(l.end_date).isAfter(endDate) ? endDate : dayjs(l.end_date),
                total_days: l.total_days,
                category: l.category?.leave_category_name || 'Other'
            });
        });

        const reportData = employees.items.map(emp => {
            const row = {
                employee_code: emp.employee_code || '-',
                employee_name: emp.first_name || '-',
                phone: emp.mobile_no || '-',
                branch: branchMap[emp.branch_id] || '-',
                department: emp.department?.name || '-',
                designation: emp.designation?.designation_name || '-',
                assigned: balancesByEmp[emp.id] || {},
                total_used: {},
                pending: {}, // [NEW] Track pending balance
                months: {}
            };
            
            allCategories.forEach(c => {
                row.total_used[c] = 0;
                row.pending[c] = 0;
            });
            for(let m=1; m<=12; m++) {
                row.months[m] = {};
                allCategories.forEach(c => row.months[m][c] = 0);
            }

            const empHolidays = holidaysByEmp[emp.id] || [];
            const empWeekOffs = weekOffsByEmp[emp.id] || [];
            const empLeaves = leavesByEmp[emp.id] || [];
            const leaveSet = new Set();
            
            empLeaves.forEach(lr => {
                let current = lr.start;
                const spanDays = lr.end.diff(lr.start, 'day') + 1;
                // If a leave started or ended out of year, total_days might be off, but approximation holds for split
                const dailyVal = parseFloat(lr.total_days || 0) / spanDays;
                
                while(current.isSameOrBefore(lr.end, 'day')) {
                    const m = current.month() + 1;
                    const cat = lr.category;
                    if (row.months[m][cat] !== undefined) {
                        row.months[m][cat] += dailyVal;
                        row.total_used[cat] += dailyVal;
                    }
                    if (dailyVal >= 0.5) leaveSet.add(current.format('YYYY-MM-DD'));
                    current = current.add(1, 'day');
                }
            });

            // Prevent checking dates before joining
            const empStartDate = emp.joining_date && dayjs(emp.joining_date).isAfter(startDate) 
                                ? dayjs(emp.joining_date) : startDate;

            for (let d = empStartDate; d.isSameOrBefore(endDate, 'day'); d = d.add(1, 'day')) {
                const dateStr = d.format('YYYY-MM-DD');
                if (leaveSet.has(dateStr)) continue; // skip weekoff count if actively on leave
                
                const m = d.month() + 1;
                
                const isHoli = empHolidays.find(h => h.date === dateStr);
                if (isHoli) {
                    row.months[m]['Holiday'] += 1;
                    row.total_used['Holiday'] += 1;
                    continue;
                }

                const weekOfMonth = Math.ceil(d.date() / 7);
                const isWO = empWeekOffs.find(w => {
                     return w.day === d.day() && (w.weekMask === 0 || w.weekMask === weekOfMonth);
                });

                if (isWO) {
                    row.months[m]['Week Off'] += 1;
                    row.total_used['Week Off'] += 1;
                }
            }

            // [NEW] Final calculation of rounded pending balances
            allCategories.forEach(c => {
                row.total_used[c] = parseFloat(row.total_used[c].toFixed(2));
                if (row.assigned[c] !== undefined) {
                    row.pending[c] = parseFloat((row.assigned[c] - row.total_used[c]).toFixed(2));
                } else {
                    row.pending[c] = '-'; // For categories like Week Off/Holiday that don't have a fixed allocation
                }
            });

            return row;
        });

        return res.ok({
            categories: allCategories,
            items: reportData,
            total: employees.total,
            totals: employees.totals,
            currentPage: employees.currentPage,
            pageSize: employees.pageSize,
            totalPages: employees.totalPages,
            hasNextPage: employees.hasNextPage,
            hasPreviousPage: employees.hasPreviousPage,
            appliedFilters: employees.appliedFilters
        });
    } catch (err) {
        return handleError(err, res, req);
    }
};