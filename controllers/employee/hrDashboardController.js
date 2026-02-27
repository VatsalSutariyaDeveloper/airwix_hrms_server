const {
    Employee,
    AttendanceDay,
    LeaveRequest,
    Holiday,
    Department,
    EmployeeLeaveBalance,
    ShiftTemplate,
    sequelize,
    Payslip,
    CanteenAttendance
} = require("../../models");
const { commonQuery, handleError, constants } = require("../../helpers");
const { Op } = require("sequelize");
const dayjs = require("dayjs");

exports.getCounts = async (req, res) => {
    try {
        const today = dayjs().format("YYYY-MM-DD");

        // Total Active Employees
        const totalEmployees = await commonQuery.countRecords(Employee, { status: 0 }, req);

        // Present Today (Status 0=Present, 1=HalfDay)
        const presentToday = await commonQuery.countRecords(AttendanceDay, {
            attendance_date: today,
            status: { [Op.in]: [0, 1] }
        });

        const absentToday = await commonQuery.countRecords(AttendanceDay, {
            attendance_date: today,
            status: 5
        });

        // On Leave Today (Status 6=Leave)
        const onLeaveToday = await commonQuery.countRecords(AttendanceDay, {
            attendance_date: today,
            status: 6
        });

        // Pending Leave Requests
        const pendingLeaves = await commonQuery.countRecords(LeaveRequest,
            {
                approval_status: { [Op.in]: [constants.LEAVE_APPROVAL_STATUS.PENDING, constants.LEAVE_APPROVAL_STATUS.PARTIALLY_APPROVED] },
                status: 0 // Active record
            },
            {
                include: [{
                    model: Employee,
                    as: 'employee',
                    required: true
                }]
            }
        );

        // Late Entry Count (employees who arrived after shift start time + grace period)
        const lateEntry = await commonQuery.findAllRecords(AttendanceDay,
            {
                attendance_date: today
            },
            {
                include: [{
                    model: ShiftTemplate,
                    as: 'shiftTemplate',
                    required: false,
                    attributes: ['start_time', 'grace_minutes']
                }]
            }
        );
       
        // Count late entries by comparing first_in time with shift start time + grace minutes
        const lateEntryRecords = lateEntry.filter(record => {
            // Skip records without first_in time or shift template
            if (!record.first_in || !record.shiftTemplate) return false;
            
            const firstInTime = dayjs(`2000-01-01 ${record.first_in}`);
            const shiftStartTime = dayjs(`2000-01-01 ${record.shiftTemplate.start_time}`);
            const graceMinutes = record.shiftTemplate.grace_minutes || 0;
            const allowedTime = shiftStartTime.add(graceMinutes, 'minute');
            
            return firstInTime.isAfter(allowedTime);
        });

        const lateEntryCount = lateEntryRecords.length;

        // Canteen Attendance for Today - fetch all employees and their canteen status
        const allEmployees = await commonQuery.findAllRecords(Employee, { status: 0 });
        const canteenAttendanceToday = await commonQuery.findAllRecords(CanteenAttendance, {
            date: today
        });
      
        // Get employee IDs who have canteen attendance today
        const presentEmployeeIds = canteenAttendanceToday.map(att => att.employee_id);
        
        // Count present and absent employees
        const canteenPresentToday = presentEmployeeIds.length;
        const canteenAbsentToday = allEmployees.length - presentEmployeeIds.length;

        return res.ok({
            totalEmployees,
            presentToday,
            absentToday,
            onLeaveToday,
            pendingLeaves,
            lateEntry: lateEntryCount,
            canteenPresentToday,
            canteenAbsentToday
        });
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getUpcomingHolidays = async (req, res) => {
    try {
        const today = dayjs().format("YYYY-MM-DD");
        const holidays = await commonQuery.findAllRecords(Holiday,
            {
                date: { [Op.gte]: today },
                status: 0
            },
            {
                limit: 5,
                order: [['date', 'ASC']]
            }
        );
        return res.ok(holidays);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getDepartmentStats = async (req, res) => {
    try {
        const stats = await commonQuery.findAllRecords(Employee,
            {},
            {
                attributes: [
                    'department_id',
                    [sequelize.fn('COUNT', sequelize.col('Employee.id')), 'count']
                ],
                include: [{ model: Department, as: "department", attributes: ["name"], where: { status: {[Op.in]: [0,1,2]} } }],
                group: ['department_id', 'department.id', 'department.name'],
                order: [['department_id', 'ASC']]
            }
        );

        const format = stats.map(s => ({
            name: s.department ? s.department.name : "Not Assign Department",
            count: parseInt(s.getDataValue('count'))
        }));

        return res.ok(format);
    } catch (err) {
        console.error("Dept Stats Error", err);
        return handleError(err, res, req);
    }
};

exports.getRecentLeaves = async (req, res) => {
    try {
        const requests = await commonQuery.findAllRecords(LeaveRequest,
            { status: 0 },
            {
                limit: 5,
                order: [['createdAt', 'DESC']],
                include: [
                    {
                        model: Employee,
                        as: "employee",
                        attributes: ["first_name", "employee_code"],
                        required: true
                    }
                ]
            }
        );
        return res.ok(requests);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getPayrollOverview = async (req, res) => {
    try {
        const currentMonth = dayjs().month() + 1; // 1-12
        const currentYear = dayjs().year();

        // Total Payout for current month (Finalized only)
        const payoutStats = await commonQuery.findAllRecords(Payslip,
            {
                month: currentMonth,
                year: currentYear,
                status: 1 // Finalized
            },
            {
                attributes: [
                    [sequelize.fn('SUM', sequelize.col('net_salary')), 'total_payout'],
                    [sequelize.fn('COUNT', sequelize.col('id')), 'processed_count']
                ],
                raw: true
            },
        );

        // Pending Payslips (Draft)
        const draftStats = await commonQuery.countRecords(Payslip, {
            month: currentMonth,
            year: currentYear,
            status: 0 // Draft
        });

        return res.ok({
            month: dayjs().format("MMMM YYYY"),
            totalPayout: payoutStats[0]?.total_payout || 0,
            processedCount: payoutStats[0]?.processed_count || 0,
            draftCount: draftStats
        });
    } catch (err) {
        return handleError(err, res, req);
    }
};
