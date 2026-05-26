const { commonQuery, handleError } = require("../../helpers");
const { getFilteredAnnouncements } = require("../../helpers/functions/commonFunctions");
const { constants } = require("../../helpers/constants");
const { Employee, AttendanceDay, AttendancePunch, LeaveTemplateCategory, sequelize, ShiftTemplate, EmployeeHoliday, EmployeeWeeklyOff, OutDutyRequest, Department, DesignationMaster, LeaveRequest, EmployeeLeaveBalance, BranchMaster, CanteenAttendance, DeviceMaster } = require("../../models");
const { Op } = require("sequelize");
const dayjs = require("dayjs");
const customParseFormat = require('dayjs/plugin/customParseFormat');
const isSameOrBefore = require('dayjs/plugin/isSameOrBefore');
dayjs.extend(customParseFormat);
dayjs.extend(isSameOrBefore);

const enrichReportData = async (reportData, employeesItems, transaction) => {
  if (!Array.isArray(reportData) || reportData.length === 0) return;
  if (!Array.isArray(employeesItems) || employeesItems.length === 0) return;

  const branchIds = [...new Set(employeesItems.map(emp => emp.branch_id).filter(Boolean))];
  const companyIds = [...new Set(employeesItems.map(emp => emp.company_id).filter(Boolean))];

  const [branches, companies] = await Promise.all([
    BranchMaster.findAll({ where: { id: { [Op.in]: branchIds } }, attributes: ['id', 'branch_name'], raw: true, transaction }),
    sequelize.models.CompanyMaster.findAll({ where: { id: { [Op.in]: companyIds } }, attributes: ['id', 'company_name'], raw: true, transaction })
  ]);

  const branchMap = Object.fromEntries(branches.map(b => [b.id, b.branch_name]));
  const companyMap = Object.fromEntries(companies.map(c => [c.id, c.company_name]));

  const empMap = {};
  employeesItems.forEach(emp => {
    const data = {
      company_name: companyMap[emp.company_id] || 'N/A',
      branch_name: branchMap[emp.branch_id] || 'N/A'
    };
    if (emp.id) empMap[emp.id] = data;
    if (emp.employee_code) empMap[emp.employee_code] = data;
  });

  reportData.forEach(row => {
    const key = row.employee_id || row.employee_code;
    const enriched = empMap[key] || empMap[row.employee_code] || empMap[row.employee_id];
    if (enriched) {
      row.company_name = enriched.company_name;
      row.branch_name = enriched.branch_name;
    } else {
      row.company_name = row.company_name || 'N/A';
      row.branch_name = row.branch_name || 'N/A';
    }
  });
};


const hasSelectedValue = (value) => {
  if (Array.isArray(value)) {
    const cleaned = value.filter(v =>
      v !== undefined &&
      v !== null &&
      v !== "" &&
      v !== "All" &&
      v !== "all" &&
      v !== 0 &&
      v !== "0"
    );
    return cleaned.length > 0 ? cleaned : null;
  }
  return (
    value !== undefined &&
    value !== null &&
    value !== "" &&
    value !== "All" &&
    value !== "all" &&
    value !== 0 &&
    value !== "0"
  ) ? value : null;
};

const buildEmploymentRangeWhere = (startDate, endDate) => ({
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
});

const buildEmployeePaginationBody = (reqBody, extraFilter = {}, status = [0, 1]) => ({
  ...reqBody,
  status,
  filter: {
    ...(reqBody?.filter || {}),
    ...extraFilter
  }
});

/**
 * GET CANTEEN ATTENDANCE REPORT
 */
exports.getCanteenAttendanceReport = async (req, res) => {
  try {
    const {
      report_type,
      date,
      month_year,
      staff_type,
      branch_id,
      department_id,
      company_id
    } = req.body;
    const employeeTypeLabels = { 1: "Staff", 2: "Worker", 3: "Contractor" };
    const rawCanteenFilter = (
      req.body.canteen_filter ??
      req.body.canteen_type ??
      req.body.audience_type ??
      req.body.entry_type ??
      req.body.filter_type
    );

    let selectedFilters = [];
    if (Array.isArray(rawCanteenFilter)) {
      selectedFilters = rawCanteenFilter;
    } else if (typeof rawCanteenFilter === "string") {
      if (rawCanteenFilter.includes(',')) {
        selectedFilters = rawCanteenFilter.split(',').map(s => s.trim());
      } else {
        const val = rawCanteenFilter.trim().toLowerCase();
        if (val === 'all') {
          selectedFilters = ['1', '2', '3', 'guest'];
        } else if (val === 'employee') {
          selectedFilters = ['1', '2', '3'];
        } else if (val === 'guest') {
          selectedFilters = ['guest'];
        } else {
          selectedFilters = [rawCanteenFilter];
        }
      }
    } else {
      selectedFilters = ['1', '2', '3', 'guest'];
    }

    const shouldIncludeEmployees = selectedFilters.some(f => f === '1' || f === '2' || f === '3' || String(f).toLowerCase() === 'employee' || String(f).toLowerCase() === 'all');
    const shouldIncludeGuests = selectedFilters.some(f => String(f).toLowerCase() === 'guest' || String(f).toLowerCase() === 'all');

    let canteenFilter = "all";
    if (shouldIncludeEmployees && !shouldIncludeGuests) {
      canteenFilter = "employee";
    } else if (!shouldIncludeEmployees && shouldIncludeGuests) {
      canteenFilter = "guest";
    }

    if (!report_type || !['daily', 'monthly'].includes(report_type)) {
      return res.error(
        constants.VALIDATION_ERROR,
        "report_type must be either 'daily' or 'monthly'"
      );
    }

    let startDate, endDate;

    // Date handling
    if (report_type === 'daily') {
      if (!date) {
        return res.error(
          constants.VALIDATION_ERROR,
          "date is required for daily report"
        );
      }

      startDate = date;
      endDate = date;
    } else {
      if (!month_year) {
        return res.error(
          constants.VALIDATION_ERROR,
          "month_year is required for monthly report"
        );
      }

      const parsedDate = dayjs(
        month_year.trim(),
        ["MMM YYYY", "MMMM YYYY", "YYYY-MM", "MM-YYYY", "YYYY-M", "M-YYYY"]
      );

      if (!parsedDate.isValid()) {
        return res.error(
          constants.VALIDATION_ERROR,
          "Invalid month and year format"
        );
      }

      startDate = parsedDate.startOf('month').format('YYYY-MM-DD');
      endDate = parsedDate.endOf('month').format('YYYY-MM-DD');
    }

    const employeeFilter = {};
    const cleanedBranch = hasSelectedValue(branch_id);
    if (cleanedBranch) employeeFilter.branch_id = cleanedBranch;
    const cleanedCompany = hasSelectedValue(company_id);
    if (cleanedCompany) employeeFilter.company_id = cleanedCompany;
    if (hasSelectedValue(staff_type)) employeeFilter.employee_type = staff_type;
    if (hasSelectedValue(branch_id)) employeeFilter.branch_id = branch_id;
    if (shouldIncludeEmployees) {
      const selectedEmployeeTypes = selectedFilters
        .filter(f => f === '1' || f === '2' || f === '3' || f === 1 || f === 2 || f === 3)
        .map(f => parseInt(f));
      if (selectedEmployeeTypes.length > 0) {
        employeeFilter.employee_type = { [Op.in]: selectedEmployeeTypes };
      } else if (hasSelectedValue(staff_type)) {
        employeeFilter.employee_type = staff_type;
      }
    } else {
      if (hasSelectedValue(staff_type)) employeeFilter.employee_type = staff_type;
    }
    if (hasSelectedValue(department_id)) employeeFilter.department_id = department_id;

    const daysArray = [];
    let currentDay = dayjs(startDate);
    while (currentDay.isBefore(dayjs(endDate)) || currentDay.isSame(dayjs(endDate), 'day')) {
      daysArray.push(currentDay.format('YYYY-MM-DD'));
      currentDay = currentDay.add(1, 'day');
    }

    const requestedPage = Math.max(parseInt(req.body?.page) || 1, 1);
    const isFetchAll = req.body?.limit === "all" || req.body?.limit === "All";
    const requestedLimit = isFetchAll ? null : Math.max(parseInt(req.body?.limit) || 10, 1);
    const combinedOffset = isFetchAll ? 0 : (requestedPage - 1) * requestedLimit;
    const today = dayjs();

    const buildReportRow = ({ rowId, employeeName, employeeCode = null, employeeType, isGuest, records = [] }) => {
      const attendanceByDate = new Map();

      records.forEach((record) => {
        if (!attendanceByDate.has(record.date)) {
          attendanceByDate.set(record.date, dayjs(record.created_at).format('h:mm A'));
        }
      });

      const row = {
        employee_id: rowId,
        employee_name: employeeName,
        employee_code: employeeCode,
        employee_type: employeeType,
        is_guest: isGuest,
        Total_count: 0
      };

      if (report_type === 'daily') {
        const day = daysArray[0];
        const presentTime = attendanceByDate.get(day);

        row.status = presentTime
          ? "PRESENT"
          : (dayjs(day).isBefore(today, 'day') ? "ABSENT" : "PENDING");
        row.time = presentTime || "-";
        row.Total_count = presentTime ? 1 : 0;
        return row;
      }

      row.days = {};

      daysArray.forEach((day) => {
        const presentTime = attendanceByDate.get(day);
        let status = "ABSENT";

        if (presentTime) {
          status = "PRESENT";
          row.Total_count += 1;
        } else if (dayjs(day).isSame(today, 'day') || dayjs(day).isAfter(today, 'day')) {
          status = "PENDING";
        }

        row.days[day] = { status };
      });

      return row;
    };

    const guestWhere = {
      is_guest: true,
      status: 0,
      date: {
        [Op.between]: [startDate, endDate]
      }
    };
    const guestSearchWhere = req.body?.search
      ? {
        ...guestWhere,
        guest_name: {
          [Op.iLike]: `%${req.body.search}%`
        }
      }
      : guestWhere;

    // Count unique guest names (each unique guest_name = one "row" in the report)
    const guestCount = shouldIncludeGuests
      ? await CanteenAttendance.count({
        where: guestSearchWhere,
        distinct: true,
        col: 'guest_name'
      })
      : 0;

    const employees = shouldIncludeEmployees
      ? await commonQuery.fetchPaginatedData(
        Employee,
        buildEmployeePaginationBody(req.body, employeeFilter),
        [
          ["first_name", true, true],
          ["employee_code", true, true]
        ],
        {
          attributes: [
            'id',
            'first_name',
            'employee_code',
            'employee_type',
            'company_id',
            'branch_id'
          ],
          order: [['first_name', 'ASC']]
        },
        true,
        'created_at',
        buildEmploymentRangeWhere(startDate, endDate)
      )
      : {
        items: [],
        total: 0
      };

    const employeeIds = employees.items.map(emp => emp.id);
    const attendanceRecords = employeeIds.length > 0
      ? await commonQuery.findAllRecords(
        CanteenAttendance,
        {
          employee_id: { [Op.in]: employeeIds },
          status: 0,
          is_guest: false,
          date: {
            [Op.between]: [startDate, endDate]
          }
        },
        {
          attributes: [
            'id',
            'employee_id',
            'date',
            'created_at'
          ],
          order: [['employee_id', 'ASC'], ['date', 'ASC'], ['created_at', 'ASC']]
        },
        null,
        {}
      )
      : [];

    const attendanceByEmployeeId = attendanceRecords.reduce((acc, record) => {
      if (!acc.has(record.employee_id)) acc.set(record.employee_id, []);
      acc.get(record.employee_id).push(record);
      return acc;
    }, new Map());

    const totalRecords = employees.total + guestCount;

    if (totalRecords === 0) {
      return res.ok({
        items: [],
        total: 0,
        currentPage: 1,
        pageSize: 10,
        totalPages: 0,
        hasNextPage: false,
        hasPreviousPage: false
      });
    }

    const reportData = [];
    employees.items.forEach((emp) => {
      reportData.push(buildReportRow({
        rowId: emp.id,
        employeeName: emp.first_name?.replace(/[\r\n]+/g, ' ').trim() || '',
        employeeCode: emp.employee_code,
        employeeType: employeeTypeLabels[emp.employee_type] || 'Employee',
        isGuest: false,
        records: attendanceByEmployeeId.get(emp.id) || []
      }));
    });

    if (shouldIncludeGuests) {
      let guestNames = [];

      if (isFetchAll) {
        guestNames = await CanteenAttendance.findAll({
          where: guestSearchWhere,
          attributes: ['guest_name'],
          group: ['guest_name'],
          order: [['guest_name', 'ASC']],
          raw: true
        });
      } else {
        // How many employee rows appear before the current page's window?
        // employees.total = total matching employees across all pages.
        // combinedOffset = absolute row index of the start of this page.
        //
        // If the page's window starts after all employees have been shown,
        // guestStartIndex > 0; otherwise guests start filling the remaining
        // slots on this page after employees run out.
        const guestStartIndex = Math.max(0, combinedOffset - employees.total);

        // How many employee rows are actually on THIS page?
        const employeesOnThisPage = employees.items.length;

        // Remaining slots on this page after employee rows are placed
        const remainingSpace = Math.max(0, requestedLimit - employeesOnThisPage);

        if (remainingSpace > 0) {
          guestNames = await CanteenAttendance.findAll({
            where: guestSearchWhere,
            attributes: ['guest_name'],
            group: ['guest_name'],
            order: [['guest_name', 'ASC']],
            offset: guestStartIndex,
            limit: remainingSpace,
            raw: true
          });
        }
      }

      const paginatedGuestNames = guestNames.map(record => record.guest_name).filter(Boolean);

      if (paginatedGuestNames.length > 0) {
        const guestRecords = await commonQuery.findAllRecords(
          CanteenAttendance,
          {
            ...guestWhere,
            guest_name: {
              [Op.in]: paginatedGuestNames
            }
          },
          {
            order: [['guest_name', 'ASC']]
          }
        );

        const guestMap = new Map();
        guestRecords.forEach((record) => {
          if (!guestMap.has(record.guest_name)) guestMap.set(record.guest_name, []);
          guestMap.get(record.guest_name).push(record);
        });

        paginatedGuestNames.forEach((guestName) => {
          reportData.push(buildReportRow({
            rowId: null,
            employeeName: guestName,
            employeeCode: null,
            employeeType: 'Guest',
            isGuest: true,
            records: guestMap.get(guestName) || []
          }));
        });
      }
    }
    await enrichReportData(reportData, employees.items);

    return res.ok({
      report_type,
      canteen_filter: canteenFilter,
      start_date: startDate,
      end_date: endDate,

      items: reportData,

      total: totalRecords,
      employee_total: employees.total,
      guest_total: guestCount,

      currentPage: isFetchAll ? 1 : requestedPage,
      pageSize: isFetchAll ? totalRecords : requestedLimit,
      totalPages: isFetchAll ? 1 : Math.ceil(totalRecords / requestedLimit),

      hasNextPage: isFetchAll ? false : (requestedPage * requestedLimit) < totalRecords,
      hasPreviousPage: isFetchAll ? false : requestedPage > 1
    });

  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * GET ATTENDANCE REPORT (Daily or Monthly)
 */
exports.getAttendanceReport = async (req, res) => {
  try {
    const { report_type, date, month_year, staff_type, branch_id, department_id, company_id } = req.body;

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

    const employeeFilter = {};
    const cleanedBranch = hasSelectedValue(branch_id);
    if (cleanedBranch) employeeFilter.branch_id = cleanedBranch;
    const cleanedCompany = hasSelectedValue(company_id);
    if (cleanedCompany) employeeFilter.company_id = cleanedCompany;
    if (hasSelectedValue(staff_type)) employeeFilter.employee_type = staff_type;
    if (hasSelectedValue(department_id)) employeeFilter.department_id = department_id;

    // 1. Fetch All Active Employees
    const fieldConfig = [
      ["first_name", true, true],
      ["employee_code", true, true],
    ];

    const reqBodyCopy = { ...req.body };
    let allMatchingEmployeeIds = [];
    if (req.body.search && req.body.search.trim() !== '') {
      const searchString = req.body.search.trim();
      const searchLike = `%${searchString}%`;

      // A. Query Employee table for first_name or employee_code
      const employeesMatchingSearch = await Employee.findAll({
        where: {
          [Op.or]: [
            { first_name: { [Op.iLike]: searchLike } },
            { employee_code: { [Op.iLike]: searchLike } }
          ],
          ...buildEmploymentRangeWhere(startDate, endDate)
        },
        attributes: ['id'],
        raw: true
      });

      // B. Query DeviceMaster for matching device_name
      // const matchingDevices = await DeviceMaster.findAll({
      //   where: {
      //     device_name: {
      //       [Op.iLike]: `%${searchString}%`
      //     }
      //   },
      //   attributes: ['id'],
      //   raw: true
      // });

      // let employeeIdsFromDevices = [];
      // if (matchingDevices.length > 0) {
      //   const deviceIds = matchingDevices.map(d => d.id);
      //   const devicePunches = await AttendancePunch.findAll({
      //     where: {
      //       device_id: { [Op.in]: deviceIds },
      //       status: 0,
      //       [Op.and]: [
      //         sequelize.literal(`DATE(punch_time) BETWEEN '${startDate}' AND '${endDate}'`)
      //       ]
      //     },
      //     attributes: ['employee_id'],
      //     raw: true
      //   });
      //   employeeIdsFromDevices = devicePunches.map(p => p.employee_id).filter(Boolean);
      // }

      allMatchingEmployeeIds = [...new Set([
        ...employeesMatchingSearch.map(e => e.id),
        // ...employeeIdsFromDevices
      ])];

      if (allMatchingEmployeeIds.length === 0) {
        employeeFilter.id = null; // Forces empty result
      } else {
        employeeFilter.id = { [Op.in]: allMatchingEmployeeIds };
      }
      
      // Remove search term so fetchPaginatedData doesn't run redundant name search filter
      delete reqBodyCopy.search;
    }

    const employees = await commonQuery.fetchPaginatedData(
      Employee,
      buildEmployeePaginationBody(reqBodyCopy, employeeFilter),
      fieldConfig,
      {
        attributes: ['id', 'first_name', 'employee_code', 'employee_type', 'worker_type', 'holiday_template', 'weekly_off_template', 'joining_date', 'exit_date', 'branch_id', 'company_id'],
        include: [
          { model: ShiftTemplate, as: "shiftTemplate", attributes: ["id", "shift_name"] },
          { model: Department, as: "department", attributes: ["name"] },
          { model: DesignationMaster, as: "designation", attributes: ["designation_name"] }
        ],
        order: [['first_name', 'ASC']]
      },
      {},
      'created_at',
      buildEmploymentRangeWhere(startDate, endDate)
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
        { model: LeaveTemplateCategory, as: "leaveCategory", attributes: ["id", "leave_category_name", "is_paid", "is_compoff"] }
      ],
      order: [['attendance_date', 'ASC']]
    }, null, {});

    const attendanceDayIds = attendanceDays.map(day => day.id).filter(Boolean);

    // 2.1. Fetch Punch Records for detailed attendance data
    let punchRecords = [];
    if (attendanceDayIds.length > 0) {
      punchRecords = await commonQuery.findAllRecords(AttendancePunch, {
        day_id: { [Op.in]: attendanceDayIds },
        status: 0
      }, {
        include: [
          { model: DeviceMaster, as: 'device', attributes: ['id', 'device_name'] }
        ],
        order: [['employee_id', 'ASC'], ['punch_time', 'ASC']]
      }, null, {});
    }

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
      let currDate = dayjs(od.start_date);
      const limitDate = dayjs(od.end_date);
      while (currDate.isBefore(limitDate) || currDate.isSame(limitDate, 'day')) {
        outDutyMap.set(`${od.employee_id}_${currDate.format('YYYY-MM-DD')}`, true);
        currDate = currDate.add(1, 'day');
      }
    });

    // Group punch records by employee and attendance day if available, otherwise fallback to punch date
    const punchesByEmployeeDay = new Map();
    punchRecords.forEach(punch => {
      const date = dayjs(punch.punch_time).format('YYYY-MM-DD');
      const key = punch.day_id ? `${punch.employee_id}_${punch.day_id}` : `${punch.employee_id}_${date}`;
      if (!punchesByEmployeeDay.has(key)) {
        punchesByEmployeeDay.set(key, []);
      }
      punchesByEmployeeDay.get(key).push({
        punch_time: punch.punch_time,
        punch_type: punch.punch_type,
        formatted_time: dayjs(punch.punch_time).format('h:mm A'),
        device_name: punch.device ? punch.device.device_name : '-'
      });
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
          totalOvertimeMinutes: 0,
          totalBreakMinutes: 0,
          activeDays: 0,
          totalActiveDays: 0,
          payDay: 0,
          absentDay: 0,
          casualLeave: 0,
          compoffLeave: 0,
          paidLeave: 0,
          unpaidLeave: 0,
          leaveCounts: {
            "Casual Leave": 0,
            "Compoff Leave": 0,
            "Paid Leave": 0,
            "Unpaid Leave": 0
          }
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
        let breakMins = 0;

        const dayOfWeek = dayjs(d).day();
        const weekNo = Math.ceil(dayjs(d).date() / 7);
        const isScheduledWo = weeklyOffs.some(wo => wo.employee_id === emp.id && wo.day_of_week === dayOfWeek && (wo.week_no === 0 || wo.week_no === weekNo));

        let leaveCategoryName = null;
        let isHalfDayLeave = false;

        if (dayRecord) {
          statusId = dayRecord.status;
          const sMap = { 0: "Present", 1: "Half Day", 3: "Weekly Off", 4: "Holiday", 5: "Absent", 6: "Leave", 12: "Out Duty", 13: "Half Out Duty" };
          status = sMap[statusId] || "Pending";

          if (statusId === 6 && dayRecord.leaveCategory) {
            status = dayRecord.leaveCategory.leave_category_name;
            leaveCategoryName = dayRecord.leaveCategory.leave_category_name;
          } else if (statusId === 1 && dayRecord.leaveCategory) {
            status = `Half Day / ${dayRecord.leaveCategory.leave_category_name}`;
            leaveCategoryName = dayRecord.leaveCategory.leave_category_name;
            isHalfDayLeave = true;
          }

          if (dayRecord.first_in) inTime = dayjs(dayRecord.first_in, 'HH:mm:ss').format('h:mm A');
          if (dayRecord.last_out) outTime = dayjs(dayRecord.last_out, 'HH:mm:ss').format('h:mm A');
          workedMins = dayRecord.worked_minutes || 0;
          lateMins = dayRecord.fine_data?.late_entry?.minutes || 0;
          otMins = dayRecord.overtime_minutes || 0;
          breakMins = dayRecord.total_break_minutes || 0;

          if (statusId === 0) {
            empData.summary.present += 1;
          } else if (statusId === 1) {
            empData.summary.halfDay += 1;
            if (dayRecord.leaveCategory) {
              const leaveName = dayRecord.leaveCategory.leave_category_name;
              const catName = leaveName.toLowerCase();
              const isPaid = dayRecord.leaveCategory.is_paid !== false;
              const isCompoff = !!dayRecord.leaveCategory.is_compoff;
              const isCasual = catName.includes("casual");
              const isComp = isCompoff || catName.includes("comp");

              empData.summary.leave += 0.5;
              if (!empData.summary.leaveCounts[leaveName]) {
                empData.summary.leaveCounts[leaveName] = 0;
              }
              empData.summary.leaveCounts[leaveName] += 0.5;

              if (isCasual) empData.summary.casualLeave += 0.5;
              else if (isComp) empData.summary.compoffLeave += 0.5;
              else if (isPaid) empData.summary.paidLeave += 0.5;
              else empData.summary.unpaidLeave += 0.5;
            }
          } else if (statusId === 3) {
            empData.summary.weeklyOff += 1;
          } else if (statusId === 4) {
            empData.summary.holiday += 1;
          } else if (statusId === 5) {
            empData.summary.absent += 1;
          } else if (statusId === 6) {
            empData.summary.leave += 1;
            if (dayRecord.leaveCategory) {
              const leaveName = dayRecord.leaveCategory.leave_category_name;
              const catName = leaveName.toLowerCase();
              const isPaid = dayRecord.leaveCategory.is_paid !== false;
              const isCompoff = !!dayRecord.leaveCategory.is_compoff;
              const isCasual = catName.includes("casual");
              const isComp = isCompoff || catName.includes("comp");

              if (!empData.summary.leaveCounts[leaveName]) {
                empData.summary.leaveCounts[leaveName] = 0;
              }
              empData.summary.leaveCounts[leaveName] += 1.0;

              if (isCasual) empData.summary.casualLeave += 1.0;
              else if (isComp) empData.summary.compoffLeave += 1.0;
              else if (isPaid) empData.summary.paidLeave += 1.0;
              else empData.summary.unpaidLeave += 1.0;
            } else {
              empData.summary.unpaidLeave += 1.0;
            }
          } else if (statusId === 12) {
            empData.summary.outDuty += 1;
          } else if (statusId === 13) {
            empData.summary.halfDay += 1;
          }
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
        empData.summary.totalBreakMinutes += breakMins;

        // Get punch data for this employee and day record if available, otherwise fallback to date
        const punchKey = dayRecord ? `${emp.id}_${dayRecord.id}` : `${emp.id}_${d}`;
        const punches = punchesByEmployeeDay.get(punchKey) || [];

        // Group punches into IN-OUT pairs
        const punchPairs = [];
        let currentPair = null;

        punches.forEach(punch => {
          if (punch.punch_type === 'IN') {
            if (currentPair && currentPair.in) {
              // Start new pair if previous IN didn't have OUT
              punchPairs.push(currentPair);
            }
            currentPair = { in: punch.formatted_time, in_device_name: punch.device_name || '-', out: null, out_device_name: '-' };
          } else if (punch.punch_type === 'OUT' && currentPair && currentPair.in) {
            currentPair.out = punch.formatted_time;
            currentPair.out_device_name = punch.device_name || '-';
            punchPairs.push(currentPair);
            currentPair = null;
          }
        });

        // Add the last pair if it has IN but no OUT
        if (currentPair && currentPair.in) {
          punchPairs.push(currentPair);
        }

        empData.days[d] = {
          day_id: dayRecord ? dayRecord.id : null,
          status,
          inTime,
          outTime,
          workedMins: Math.floor(workedMins / 60) + 'h ' + (workedMins % 60) + 'm',
          otMins: Math.floor(otMins / 60) + 'h ' + (otMins % 60) + 'm',
          lateMins: Math.floor(lateMins / 60) + 'h ' + (lateMins % 60) + 'm',
          breakMins: Math.floor(breakMins / 60) + 'h ' + (breakMins % 60) + 'm',
          punch_pairs: punchPairs.length > 0 ? punchPairs : [{ in: '-', out: '-' }],
          leave_category_name: leaveCategoryName,
          is_half_day_leave: isHalfDayLeave
        };
      }

      // Calculate final activeDays, totalActiveDays, payDay, absentDay
      const activeDaysVal = empData.summary.present + empData.summary.outDuty + (empData.summary.halfDay * 0.5);
      empData.summary.activeDays = parseFloat(activeDaysVal.toFixed(1));
      empData.summary.totalActiveDays = parseFloat(activeDaysVal.toFixed(1));

      const absentDayVal = empData.summary.absent + (empData.summary.halfDay * 0.5);
      empData.summary.absentDay = parseFloat(absentDayVal.toFixed(1));

      // payDay strictly excludes unpaid leaves
      const paidLeavesVal = empData.summary.paidLeave + empData.summary.casualLeave + empData.summary.compoffLeave;
      const payDayVal = activeDaysVal + paidLeavesVal + empData.summary.weeklyOff + empData.summary.holiday;
      empData.summary.payDay = parseFloat(payDayVal.toFixed(1));

      // Round all other numeric fields to 1 decimal place
      empData.summary.present = parseFloat(empData.summary.present.toFixed(1));
      empData.summary.absent = parseFloat(empData.summary.absent.toFixed(1));
      empData.summary.halfDay = parseFloat(empData.summary.halfDay.toFixed(1));
      empData.summary.leave = parseFloat(empData.summary.leave.toFixed(1));
      empData.summary.weeklyOff = parseFloat(empData.summary.weeklyOff.toFixed(1));
      empData.summary.holiday = parseFloat(empData.summary.holiday.toFixed(1));
      empData.summary.outDuty = parseFloat(empData.summary.outDuty.toFixed(1));
      empData.summary.casualLeave = parseFloat(empData.summary.casualLeave.toFixed(1));
      empData.summary.compoffLeave = parseFloat(empData.summary.compoffLeave.toFixed(1));
      empData.summary.paidLeave = parseFloat(empData.summary.paidLeave.toFixed(1));
      empData.summary.unpaidLeave = parseFloat(empData.summary.unpaidLeave.toFixed(1));

      // Also round each dynamic leave count to 1 decimal place
      if (empData.summary.leaveCounts) {
        for (const leaveName of Object.keys(empData.summary.leaveCounts)) {
          empData.summary.leaveCounts[leaveName] = parseFloat(empData.summary.leaveCounts[leaveName].toFixed(1));
        }
      }

      reportData.push(empData);
    }
    await enrichReportData(reportData, employees.items);

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
    const { month, year, branch_id, department_id, company_id } = req.body;

    if (!month || !year) {
      return res.error("VALIDATION_ERROR", { message: "Month and Year are required" });
    }

    const startDate = dayjs(`${year}-${month}-01`).startOf('month').format('YYYY-MM-DD');
    let endDate = dayjs(`${year}-${month}-01`).endOf('month').format('YYYY-MM-DD');

    // Cap the endDate to today's date if the selected month is the current month or in the future
    if (dayjs(endDate).isAfter(dayjs(), 'day')) {
      endDate = dayjs().format('YYYY-MM-DD');
    }

    const employeeFilter = {};
    const cleanedBranch = hasSelectedValue(branch_id);
    if (cleanedBranch) employeeFilter.branch_id = cleanedBranch;
    const cleanedCompany = hasSelectedValue(company_id);
    if (cleanedCompany) employeeFilter.company_id = cleanedCompany;
    if (hasSelectedValue(department_id)) employeeFilter.department_id = department_id;

    const fieldConfig = [
      ["first_name", true, true],
      ["employee_code", true, true],
    ];

    const employees = await commonQuery.fetchPaginatedData(
      Employee,
      buildEmployeePaginationBody(req.body, employeeFilter),
      fieldConfig,
      {
        attributes: ['id', 'first_name', 'employee_code', 'mobile_no', 'branch_id', 'employee_type', 'worker_type', 'company_id'],
        distinct: true,
        include: [
          { model: Department, as: 'department', attributes: ['name'] },
          { model: DesignationMaster, as: 'designation', attributes: ['designation_name'] },
          {
            model: AttendanceDay,
            as: 'attendanceDays',
            required: true,
            where: {
              attendance_date: { [Op.between]: [startDate, endDate] },
              [Op.or]: [
                sequelize.literal(`"attendanceDays".fine_data->'late_entry' IS NOT NULL`),
                sequelize.literal(`"attendanceDays".fine_data->'early_exit' IS NOT NULL`)
              ],
              status: { [Op.ne]: 2 }
            }
          }
        ]
      },
      true,
      'created_at',
      buildEmploymentRangeWhere(startDate, endDate)
    );

    if (employees.items.length === 0) return res.ok({ daysArray: [], items: [], total: 0, currentPage: 1, pageSize: 10, totalPages: 0, hasNextPage: false, hasPreviousPage: false, appliedFilters: {} });

    // Extract attendance records from the joined data
    const attendanceRecords = [];
    employees.items.forEach(emp => {
      if (emp.attendanceDays && emp.attendanceDays.length > 0) {
        emp.attendanceDays.forEach(ad => {
          attendanceRecords.push(ad);
        });
      }
    });

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
      const pInfo = punctualityDataMap[emp.id] || {
        days: {},
        totalLateMins: 0,
        totalEarlyMins: 0,
        lateCount: 0,
        earlyCount: 0,
        totalFineAmount: 0
      };

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

    await enrichReportData(reportData, employees.items);

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
 * GET MISS PUNCH OUT REPORT
 */
exports.getMissPunchOutReport = async (req, res) => {
  try {
    const { report_type, date, month, year, branch_id, department_id, company_id } = req.body;

    let startDate, endDate;
    if (report_type === 'daily' && date) {
      startDate = dayjs(date).format('YYYY-MM-DD');
      endDate = dayjs(date).format('YYYY-MM-DD');
    } else {
      const targetMonth = month || dayjs().month() + 1;
      const targetYear = year || dayjs().year();

      startDate = dayjs(`${targetYear}-${targetMonth}-01`).startOf('month').format('YYYY-MM-DD');
      endDate = dayjs(`${targetYear}-${targetMonth}-01`).endOf('month').format('YYYY-MM-DD');
    }

    // Cap the endDate to today's date if the selected end date is in the future
    if (dayjs(endDate).isAfter(dayjs(), 'day')) {
      endDate = dayjs().format('YYYY-MM-DD');
    }

    const employeeFilter = {};
    const cleanedBranch = hasSelectedValue(branch_id);
    if (cleanedBranch) employeeFilter.branch_id = cleanedBranch;
    const cleanedCompany = hasSelectedValue(company_id);
    if (cleanedCompany) employeeFilter.company_id = cleanedCompany;
    if (hasSelectedValue(department_id)) employeeFilter.department_id = department_id;

    const fieldConfig = [
      ["first_name", true, true],
      ["employee_code", true, true],
    ];

    const employees = await commonQuery.fetchPaginatedData(
      Employee,
      buildEmployeePaginationBody(req.body, employeeFilter),
      fieldConfig,
      {
        attributes: ['id', 'first_name', 'employee_code', 'mobile_no', 'branch_id', 'employee_type', 'worker_type', 'company_id'],
        distinct: true,
        include: [
          { model: Department, as: 'department', attributes: ['name'] },
          { model: DesignationMaster, as: 'designation', attributes: ['designation_name'] },
          {
            model: AttendanceDay,
            as: 'attendanceDays',
            required: true,
            where: {
              attendance_date: { [Op.between]: [startDate, endDate] },
              [Op.or]: [
                { last_out: null, first_in: { [Op.ne]: null } },
                { first_in: null, last_out: { [Op.ne]: null } }
              ],
              status: { [Op.ne]: 2 }
            }
          }
        ]
      },
      true,
      'created_at',
      buildEmploymentRangeWhere(startDate, endDate)
    );

    if (employees.items.length === 0) return res.ok({ daysArray: [], items: [], total: 0, currentPage: 1, pageSize: 10, totalPages: 0, hasNextPage: false, hasPreviousPage: false, appliedFilters: {} });

    // Extract attendance records from the joined data
    const attendanceRecords = [];
    employees.items.forEach(emp => {
      if (emp.attendanceDays && emp.attendanceDays.length > 0) {
        emp.attendanceDays.forEach(ad => {
          attendanceRecords.push(ad);
        });
      }
    });

    // Group miss punch out records by employee
    const missPunchOutDataMap = {};
    attendanceRecords.forEach(record => {
      if (!missPunchOutDataMap[record.employee_id]) {
        missPunchOutDataMap[record.employee_id] = { days: {}, totalCount: 0 };
      }

      missPunchOutDataMap[record.employee_id].days[record.attendance_date] = {
        punchIn: record.first_in,
        punchOut: record.last_out
      };
      missPunchOutDataMap[record.employee_id].totalCount += 1;
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
      const pInfo = missPunchOutDataMap[emp.id] || { days: {}, totalCount: 0 };

      let row = {
        employee_name: emp.first_name || '-',
        employee_code: emp.employee_code || '-',
        phone_number: emp.mobile_no || '-',
        department: emp.department?.name || '-',
        designation: emp.designation?.designation_name || '-',
        employee_type: { 1: "Staff", 2: "Worker", 3: "Contractor" }[emp.employee_type] || 'N/A',
        worker_type: { 1: "On-role", 2: "Off-role" }[emp.worker_type] || 'N/A',
        miss_punch_out_count: pInfo.totalCount,
        days: {}
      };

      Object.keys(pInfo.days).forEach(dateStr => {
        const day = pInfo.days[dateStr];
        const formattedDate = dayjs(dateStr).format('D-MMM-YY');

        row.days[formattedDate] = {
          punch_in: day.punchIn,
          punch_out: day.punchOut
        };
      });

      reportData.push(row);
    });

    await enrichReportData(reportData, employees.items);

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
    const { month, year, branch_id, department_id, company_id } = req.body;

    if (!month || !year) {
      return res.error("VALIDATION_ERROR", { message: "Month and Year are required" });
    }

    const startDate = dayjs(`${year}-${month}-01`).startOf('month').format('YYYY-MM-DD');
    let endDate = dayjs(`${year}-${month}-01`).endOf('month').format('YYYY-MM-DD');

    // Cap the endDate to today's date if the selected month is the current month or in the future
    if (dayjs(endDate).isAfter(dayjs(), 'day')) {
      endDate = dayjs().format('YYYY-MM-DD');
    }

    const employeeFilter = {};
    const cleanedBranch = hasSelectedValue(branch_id);
    if (cleanedBranch) employeeFilter.branch_id = cleanedBranch;
    const cleanedCompany = hasSelectedValue(company_id);
    if (cleanedCompany) employeeFilter.company_id = cleanedCompany;
    if (hasSelectedValue(department_id)) employeeFilter.department_id = department_id;

    const fieldConfig = [
      ["first_name", true, true],
      ["employee_code", true, true],
    ];

    const employees = await commonQuery.fetchPaginatedData(
      Employee,
      buildEmployeePaginationBody(req.body, employeeFilter),
      fieldConfig,
      {
        attributes: ['id', 'first_name', 'employee_code', 'mobile_no', 'branch_id', 'employee_type', 'worker_type'],
        include: [
          { model: Department, as: 'department', attributes: ['name'] },
          { model: DesignationMaster, as: 'designation', attributes: ['designation_name'] }
        ]
      },
      true,
      'created_at',
      buildEmploymentRangeWhere(startDate, endDate)
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
    }, null, {});

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
        total_overtime: `${hours < 10 ? '0' + hours : hours}h ${mins < 10 ? '0' + mins : mins}m`,
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
          duration: `${h < 10 ? '0' + h : h}h ${min < 10 ? '0' + min : min}m`,
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
    const { year, staff_type, branch_id, company_id } = req.body;

    if (!year) {
      return res.error(constants.VALIDATION_ERROR, "year is required");
    }

    const startDateStr = `${year}-01-01`;
    const endDateStr = `${year}-12-31`;
    const startDate = dayjs(startDateStr);
    const endDate = dayjs(endDateStr);

    // Fetch Employees
    const employeeFilter = {};
    const cleanedBranch = hasSelectedValue(branch_id);
    if (cleanedBranch) employeeFilter.branch_id = cleanedBranch;
    const cleanedCompany = hasSelectedValue(company_id);
    if (cleanedCompany) employeeFilter.company_id = cleanedCompany;
    if (hasSelectedValue(staff_type)) employeeFilter.employee_type = staff_type;

    // Fetch all branches for mapping since it's not directly included via model sometimes
    const branchWhere = {};
    if (cleanedCompany) {
      branchWhere.company_id = cleanedCompany;
    } else {
      branchWhere.company_id = req.user.company_id;
    }
    const branches = await commonQuery.findAllRecords(BranchMaster, branchWhere);
    const branchMap = {};
    branches.forEach(b => branchMap[b.id] = b.branch_name);

    const fieldConfig = [
      ["first_name", true, true],
      ["employee_code", true, true],
    ];

    const employees = await commonQuery.fetchPaginatedData(
      Employee,
      buildEmployeePaginationBody(req.body, employeeFilter, 0),
      fieldConfig,
      {
        attributes: ['id', 'first_name', 'employee_code', 'mobile_no', 'joining_date', 'branch_id', 'company_id'],
        include: [
          { model: Department, as: 'department', attributes: ['name'] },
          { model: DesignationMaster, as: 'designation', attributes: ['designation_name'] },
        ]
      },
      true,
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
      if (!balancesByEmp[b.employee_id]) balancesByEmp[b.employee_id] = {};
      const catName = b.leave_category_name;
      const assigned = parseFloat(b.total_allocated || 0) + parseFloat(b.carry_forward_leaves || 0);
      balancesByEmp[b.employee_id][catName] = assigned;
    });

    // Prepare categories
    const allLeaveCategories = await commonQuery.findAllRecords(LeaveTemplateCategory, { status: 0 });
    const leaveCatNames = allLeaveCategories.map(c => c.leave_category_name);
    const allCategories = ['Week Off', 'Holiday', ...leaveCatNames];

    // Fetch leaves, weekoffs, holidays
    const leaves = await commonQuery.findAllRecords(LeaveRequest, {
      employee_id: { [Op.in]: employeeIds },
      request_type: 'DEBIT',
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
      if (!holidaysByEmp[h.employee_id]) holidaysByEmp[h.employee_id] = [];
      holidaysByEmp[h.employee_id].push({ date: h.date, name: h.name });
    });

    const weekOffsByEmp = {};
    weekOffs.forEach(w => {
      if (!weekOffsByEmp[w.employee_id]) weekOffsByEmp[w.employee_id] = [];
      weekOffsByEmp[w.employee_id].push({ day: w.day_of_week, weekMask: w.week_no });
    });

    const leavesByEmp = {};
    leaves.forEach(l => {
      if (!leavesByEmp[l.employee_id]) leavesByEmp[l.employee_id] = [];
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
      for (let m = 1; m <= 12; m++) {
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

        while (current.isSameOrBefore(lr.end, 'day')) {
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

    await enrichReportData(reportData, employees.items);

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
