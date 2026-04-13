const {
    Employee,
    AttendanceDay,
    LeaveRequest,
    Holiday,
    Department,
    ShiftTemplate,
    Payslip,
    CanteenAttendance,
    LeaveTemplate,
    OutDutyRequest,
    AttendanceRegularization,
    EmployeeResignation,
    Announcement
} = require("../../models");
const { commonQuery, handleError, constants, sequelize, formatDateTime } = require("../../helpers");
const { Op } = require("sequelize");
const dayjs = require("dayjs");

exports.getCounts = async (req, res) => {
    try {
        const today = dayjs().format("YYYY-MM-DD");

        const totalEmployees = await commonQuery.countRecords(Employee, { status: 0 }, {}, false);

        const presentToday = await commonQuery.countRecords(AttendanceDay, {
            attendance_date: today,
            status: { [Op.in]: [0, 1] }
        }, {}, false);

        const absentToday = await commonQuery.countRecords(AttendanceDay, {
            attendance_date: today,
            status: 5
        }, {}, false);

        const onLeaveToday = await commonQuery.countRecords(AttendanceDay, {
            attendance_date: today,
            status: 6
        }, {}, false);
        
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
            },
            null,
            false
        );
       
        const lateEntryRecords = lateEntry.filter(record => {
            if (!record.first_in || !record.shiftTemplate) return false;
            
            const firstInTime = dayjs(`2000-01-01 ${record.first_in}`);
            const shiftStartTime = dayjs(`2000-01-01 ${record.shiftTemplate.start_time}`);
            const graceMinutes = record.shiftTemplate.grace_minutes || 0;
            const allowedTime = shiftStartTime.add(graceMinutes, 'minute');
            
            return firstInTime.isAfter(allowedTime);
        });

        const lateEntryCount = lateEntryRecords.length;

        const allEmployees = await commonQuery.findAllRecords(Employee, { status: 0 }, {}, null, false);
        const canteenAttendanceToday = await commonQuery.findAllRecords(CanteenAttendance, {
            date: today
        }, {}, null, false);
      
        // Separate guest and employee data
        const guestAttendance = canteenAttendanceToday.filter(att => att.employee_id === null);
        const employeeAttendance = canteenAttendanceToday.filter(att => att.employee_id !== null);
        
        const guestCount = guestAttendance.length;
        const presentEmployeeIds = employeeAttendance.map(att => att.employee_id);
        
        const canteenPresentToday = presentEmployeeIds.length;
        const canteenAbsentToday = allEmployees.length - presentEmployeeIds.length - guestCount;

        return res.ok({
            totalEmployees,
            presentToday,
            absentToday,
            onLeaveToday,
            lateEntry: lateEntryCount,
            canteenPresentToday,
            canteenAbsentToday,
            guestCount
        });
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getPendingCount = async (req, res) => {
    try {
        let pendingLeaves = 0;
        let authorizedOutDutyRequests = 0;
        let authorizedAttendanceRegularizationRequests = 0;
        let authorizedEmployeeResignationRequests = 0;

        if (req.user.is_super_admin) {
            // Optimization for super admins
            pendingLeaves = await commonQuery.countRecords(LeaveRequest, { approval_status: { [Op.in]: [0, 1] }, status: 0 });
            authorizedOutDutyRequests = await commonQuery.countRecords(OutDutyRequest, { approval_status: { [Op.in]: [0, 1] }, status: 0 });
            authorizedAttendanceRegularizationRequests = await commonQuery.countRecords(AttendanceRegularization, { approval_status: { [Op.in]: [0, 1] }, status: 0 });
            authorizedEmployeeResignationRequests = await commonQuery.countRecords(EmployeeResignation, { approval_status: { [Op.in]: [0, 1] }, status: 0 });
        } else {
            // Helper function to check authorization
            const isUserAuthorizedForRequest = (request, levelField) => {
                const employee = request.employee;
                if (!employee) return false;

                const template = employee?.leaveTemplate;
                const currentLevel = request[levelField];
                const config = template ? (template.approval_config || []) : [];

                let currentStage = config.find(c => c.level === currentLevel) || { type: "ANYONE" };

                switch (currentStage.type) {
                    case 'REPORTING_MANAGER':
                        return req.user.role_id === constants.REPORTING_MANAGER_ROLE_ID && employee.reporting_manager === req.user.id;
                    case 'ATTENDANCE_SUPERVISOR':
                        return req.user.role_id === constants.ATTENDANCE_SUPERVISOR_ROLE_ID && employee.attendance_supervisor === req.user.id;
                    case 'ADMIN':
                        return req.user.is_admin;
                    case 'EMPLOYER':
                        return true;
                    case 'ANYONE':
                        return employee.reporting_manager === req.user.id ||
                               employee.attendance_supervisor === req.user.id ||
                               req.user.is_admin;
                    default:
                        return false;
                }
            };

            const queryIncludeOptions = {
                include: [
                    {
                        model: Employee,
                        as: "employee",
                        attributes: ["id", "first_name", "employee_code", "reporting_manager", "attendance_supervisor"],
                        include: [{ model: LeaveTemplate, as: "leaveTemplate" }]
                    }
                ]
            };

            const allPendingRequests = await commonQuery.findAllRecords(LeaveRequest,
                { approval_status: { [Op.in]: [0, 1] }, status: 0 },
                queryIncludeOptions,
            );

            for (const request of allPendingRequests) {
                if (isUserAuthorizedForRequest(request, 'current_level')) {
                    pendingLeaves++;
                }
            }

            const pendingOutDutyRequests = await commonQuery.findAllRecords(OutDutyRequest,
                { approval_status: { [Op.in]: [0, 1] }, status: 0 },
                queryIncludeOptions,
                null,
                true
            );

            for (const request of pendingOutDutyRequests) {
                if (isUserAuthorizedForRequest(request, 'current_out_duty_level')) {
                    authorizedOutDutyRequests++;
                }
            }

            const pendingAttendanceRegularizationRequests = await commonQuery.findAllRecords(AttendanceRegularization,
                { approval_status: { [Op.in]: [0, 1] }, status: 0 },
                queryIncludeOptions,
                null,
                true
            );

            for (const request of pendingAttendanceRegularizationRequests) {
                if (isUserAuthorizedForRequest(request, 'current_level')) {
                    authorizedAttendanceRegularizationRequests++;
                }
            }

            const pendingEmployeeResignationRequests = await commonQuery.findAllRecords(EmployeeResignation,
                { approval_status: { [Op.in]: [0, 1] }, status: 0 },
                queryIncludeOptions,
                null,
                true
            );

            for (const request of pendingEmployeeResignationRequests) {
                if (isUserAuthorizedForRequest(request, 'current_level')) {
                    authorizedEmployeeResignationRequests++;
                }
            }
        }
        
        const pendingGlobalCount = pendingLeaves + authorizedOutDutyRequests + authorizedAttendanceRegularizationRequests + authorizedEmployeeResignationRequests;

        return res.ok({pendingCount: pendingGlobalCount});
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getPendingAnnouncementCount = async (req, res) => {
    try {
        const announcementCount = await commonQuery.countRecords(Announcement, {
            status: 0
        });
        return res.ok({announcementCount});
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
            { status: 0},
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
        }, {}, false);

        return res.ok({
            month: formatDateTime(new Date(), "MMMM YYYY"),
            totalPayout: payoutStats[0]?.total_payout || 0,
            processedCount: payoutStats[0]?.processed_count || 0,
            draftCount: draftStats
        });
    } catch (err) {
        return handleError(err, res, req);
    }
};

