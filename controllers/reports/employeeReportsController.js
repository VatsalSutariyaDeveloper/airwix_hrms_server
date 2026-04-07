const { commonQuery, handleError} = require("../../helpers");
const { Employee, AttendanceDay, Sequelize, ShiftTemplate, EmployeeHoliday, EmployeeWeeklyOff, Department, DesignationMaster, EmployeeResignation, ResignationReason } = require("../../models");
const { Op } = Sequelize;
const dayjs = require("dayjs");
const customParseFormat = require('dayjs/plugin/customParseFormat');
const isSameOrBefore = require('dayjs/plugin/isSameOrBefore');
dayjs.extend(customParseFormat);
dayjs.extend(isSameOrBefore);

/**
 * GET PERFORMANCE REPORT
 */
exports.getPerformanceReport = async (req, res) => {
  try {
    const { month, year, branch_id, department_id, staff_type } = req.body;
    if (!month || !year) return res.badRequest("Month and Year are required");

    const startDate = dayjs(`${year}-${month}-01`).startOf('month').format('YYYY-MM-DD');
    const endDate = dayjs(startDate).endOf('month').format('YYYY-MM-DD');

    // 1. Fetch Employees
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
    if (branch_id && branch_id !== 'All' && branch_id !== 0 && branch_id !== '0') employeeWhere.branch_id = branch_id;
    if (staff_type) {
        const typeMap = { 'Staff': 1, 'Worker': 2 };
        if (typeMap[staff_type]) employeeWhere.employee_type = typeMap[staff_type];
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
        attributes: ['id', 'first_name', 'employee_code', 'employee_type', 'worker_type', 'joining_date', 'exit_date'],
        include: [
          { model: Department, as: 'department', attributes: ['name'] },
          { model: ShiftTemplate, as: 'shiftTemplate', attributes: ['shift_name', 'total_payable_hours'] },
          { model: DesignationMaster, as: 'designation', attributes: ['designation_name'] }
        ]
      },
      {},
      { company_id: true, branch_id: true }
    );

    if (!employees || employees.items.length === 0) return res.ok({ month, year, items: [], total: 0, currentPage: 1, pageSize: 10, totalPages: 0, hasNextPage: false, hasPreviousPage: false, appliedFilters: {} });

    const empIds = employees.items.map(e => e.id);

    // 2. Fetch Data (Attendance, Leaves, Holidays, Weekly Offs)
    const [attendanceRows, holidays, weeklyOffs] = await Promise.all([
      commonQuery.findAllRecords(AttendanceDay, { 
        employee_id: { [Op.in]: empIds }, 
        attendance_date: { [Op.between]: [startDate, endDate] } 
      }),
      commonQuery.findAllRecords(EmployeeHoliday, { 
        employee_id: { [Op.in]: empIds }, 
        date: { [Op.between]: [startDate, endDate] } 
      }),
      commonQuery.findAllRecords(EmployeeWeeklyOff, { 
        employee_id: { [Op.in]: empIds } 
      })
    ]);

    const attendanceMap = new Map();
    attendanceRows.forEach(row => attendanceMap.set(`${row.employee_id}_${row.attendance_date}`, row));

    const daysArray = [];
    let curr = dayjs(startDate);
    while (curr.isBefore(endDate) || curr.isSame(endDate, 'day')) {
        daysArray.push(curr.format('YYYY-MM-DD'));
        curr = curr.add(1, 'day');
    }

    const reportData = [];

    // 3. Transform data into performance metrics
    for (const emp of employees.items) {
      let stats = {
        present: 0, halfDay: 0, absent: 0, leave: 0, holiday: 0, weeklyOff: 0, onDuty: 0,
        totalWorkedMinutes: 0, totalLateMinutes: 0, totalOvertimeMinutes: 0,
        scheduledWorkingDays: 0
      };

      for (const d of daysArray) {
        const key = `${emp.id}_${d}`;
        const dayRecord = attendanceMap.get(key);
        const dayOfWeek = dayjs(d).day();
        const weekNo = Math.ceil(dayjs(d).date() / 7);
        const isHoliday = holidays.some(h => h.date === d);
        const isWeeklyOff = weeklyOffs.some(wo => wo.employee_id === emp.id && wo.day_of_week === dayOfWeek && (wo.week_no === 0 || wo.week_no === weekNo));

        let sid = null;
        if (dayRecord) {
            sid = dayRecord.status;
        } else if (dayjs(d).isBefore(dayjs(emp.joining_date || dayjs()), 'day') || (emp.exit_date && dayjs(d).isAfter(dayjs(emp.exit_date), 'day'))) {
            sid = 'N/A';
        } else if (isHoliday) {
            sid = 4;
        } else if (isWeeklyOff) {
            sid = 3;
        } else {
            sid = 5; // Default to Absent for working days with no record
        }

        if (sid === 'N/A') {
            // Skip N/A days
        } else if (sid === 3) {
            stats.weeklyOff++;
        } else if (sid === 4) {
            stats.holiday++;
        } else {
            stats.scheduledWorkingDays++;
            if (sid === 0) stats.present++;
            else if (sid === 1 || sid === 13) stats.halfDay++;
            else if (sid === 5) stats.absent++;
            else if (sid === 6) stats.leave++;
            else if (sid === 12) stats.onDuty++;
        }

        if (dayRecord) {
            stats.totalWorkedMinutes += parseFloat(dayRecord.worked_minutes || 0);
            
            // Punctuality reflects all types of fineable minutes
            const fineData = dayRecord.fine_data || {};
            const lateInMins = parseFloat(fineData.late_entry?.minutes || 0);
            const earlyExitMins = parseFloat(fineData.early_exit?.minutes || 0);
            const excessBreakMins = parseFloat(fineData.excess_breaks?.minutes || 0);
            
            stats.totalLateMinutes += (lateInMins + earlyExitMins + excessBreakMins);
            stats.totalOvertimeMinutes += parseFloat(dayRecord.overtime_minutes || 0);
        }
      }

      // KPI Calculations
      const attendance_ratio = stats.scheduledWorkingDays > 0 ? (stats.present + stats.onDuty + (stats.halfDay * 0.5)) / stats.scheduledWorkingDays : 0;
      const attendance_score = Math.min(100, attendance_ratio * 100);

      const punctuality_score = stats.present > 0 ? Math.max(0, 100 - (stats.totalLateMinutes / (stats.present * 10)) * 10) : 0;
      
      const expected_work_mins = stats.scheduledWorkingDays * (parseFloat(emp.shiftTemplate?.total_payable_hours || 8) * 60);
      const efficiency_score = expected_work_mins > 0 ? Math.min(100, (stats.totalWorkedMinutes / expected_work_mins) * 100) : 0;

      const overall_score = (attendance_score * 0.4) + (punctuality_score * 0.3) + (efficiency_score * 0.3);

      reportData.push({
        employee_id: emp.id,
        employee_code: emp.employee_code,
        employee_name: emp.first_name,
        department: emp.department?.name || 'N/A',
        designation: emp.designation?.designation_name || 'N/A',
        shift: emp.shiftTemplate?.shift_name || 'N/A',
        metrics: {
            attendance_score: parseFloat(attendance_score.toFixed(2)),
            punctuality_score: parseFloat(punctuality_score.toFixed(2)),
            efficiency_score: parseFloat(efficiency_score.toFixed(2)),
            overall_score: parseFloat(overall_score.toFixed(2)),
            rating: overall_score >= 90 ? 'Excellent' : overall_score >= 75 ? 'Good' : overall_score >= 60 ? 'Average' : 'Below Average'
        },
        summary: stats
      });
    }

    return res.ok({
      month, year,
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

exports.getEmployeeExitReport = async (req, res) => {
    try {
        const { start_date, end_date, branch_id, department_id } = req.body;
        
        let where = { 
            company_id: req.user.company_id,
        };

        if (start_date && end_date) {
            where.exit_date = { [Op.between]: [start_date, end_date] };
        } else {
            where[Op.or] = [
                { exit_date: { [Op.ne]: null } },
                { status: 1 }, 
                { resignation_status: { [Op.gt]: 0 } }
            ];
        }

        if (branch_id && branch_id !== 'All' && branch_id !== 0 && branch_id !== '0') {
            where.branch_id = branch_id;
        }
        if (department_id && department_id !== 'All' && department_id !== 0 && department_id !== '0') {
            where.department_id = department_id;
        }

        const fieldConfig = [
            ["first_name", true, true],
            ["employee_code", true, true],
        ];

        const employees = await commonQuery.fetchPaginatedData(
            Employee,
            { ...where, ...req.body },
            fieldConfig,
            {
                attributes: ['id', 'first_name', 'employee_code', 'joining_date', 'exit_date', 'resignation_status', 'status'],
                include: [
                    { model: DesignationMaster, as: 'designation', attributes: ['designation_name'] },
                    { model: Department, as: 'department', attributes: ['name'] },
                    { 
                        model: EmployeeResignation, 
                        as: 'resignations', 
                        where: { status: 0 }, 
                        required: false,
                        include: [{ model: ResignationReason, as: 'reason_type', attributes: ['reason_name'] }],
                        order: [['created_at', 'DESC']],
                    }
                ],
                order: [['exit_date', 'DESC']]
            },
            {},
            { company_id: true, branch_id: true }
        );

        const reportData = employees.items.map(emp => {
            const latestResignation = emp.resignations?.[0];
            return {
                id: emp.id,
                employee_name: emp.first_name,
                employee_code: emp.employee_code,
                department: emp.department?.name || 'N/A',
                designation: emp.designation?.designation_name || 'N/A',
                joining_date: emp.joining_date,
                exit_date: emp.exit_date || latestResignation?.approved_lwd || latestResignation?.preferred_lwd || '-',
                resignation_date: latestResignation?.resignation_date || '-',
                reason: latestResignation?.reason_type?.reason_name || latestResignation?.reason_description || 'N/A',
                exit_type: latestResignation ? 'Resignation' : (emp.exit_date ? 'Terminated/Other' : 'N/A'),
                status: emp.resignation_status === 1 ? 'On Notice' : (emp.status === 4 ? 'Exited' : 'Active'),
                ff_status: latestResignation?.ff_settlement_status === 2 ? 'Settled' : (latestResignation?.ff_settlement_status === 1 ? 'In Progress' : 'Pending')
            };
        });

        return res.ok({
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