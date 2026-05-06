const {
    Employee,
    AttendanceDay,
    LeaveRequest,
    Holiday,
    Department,
    DesignationMaster,
    ShiftTemplate,
    Payslip,
    CanteenAttendance,
    LeaveTemplate,
    OutDutyRequest,
    AttendanceRegularization,
    EmployeeResignation,
    Announcement,
    Notification,
    User
} = require("../../models");
const { commonQuery, handleError, constants, sequelize, formatDateTime } = require("../../helpers");
const { getFilteredAnnouncements } = require("../../helpers/functions/commonFunctions");
const { Op } = require("sequelize");
const dayjs = require("dayjs");
const { createNotification } = require("../../services/notificationService");

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
                        return req.user.role_key === constants.ROLE_KEYS.REPORTING_MANAGER && employee.reporting_manager === req.user.id;
                    case 'ATTENDANCE_SUPERVISOR':
                        return req.user.role_key === constants.ROLE_KEYS.ATTENDANCE_SUPERVISOR && employee.attendance_supervisor === req.user.id;
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
        const userId = req.user.id;
        const roleId = req.user.role_id;

        // Use reusable function to get unread announcement count (exclude read announcements)
        const announcementCount = await getFilteredAnnouncements(userId, roleId, { Announcement, Notification }, true, true);

        return res.ok({ announcementCount });
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

exports.getBirthdayList = async (req, res) => {
    try {
        const today = dayjs().format('YYYY-MM-DD');
        const thirtyDaysLater = dayjs().add(30, 'days').format('YYYY-MM-DD');

        const birthdayEmployees = await commonQuery.findAllRecords(Employee, {
            status: 0,
            [Op.and]: [
                sequelize.where(
                    sequelize.literal(`make_date(extract(year from date '${today}')::int, extract(month from "dob")::int, extract(day from "dob")::int)`),
                    {
                        [Op.between]: [today, thirtyDaysLater]
                    }
                )
            ]
        }, {
            attributes: ['id', 'first_name', 'employee_code', 'dob', 'profile_image', 'department_id', 'designation_id'],
            include: [
                {
                    model: Department,
                    as: 'department',
                    attributes: ['name'],
                    required: false
                },
                {
                    model: DesignationMaster,
                    as: 'designation',
                    attributes: ['designation_name'],
                    required: false
                }
            ],
            order: [
                [sequelize.literal(`EXTRACT(MONTH FROM "dob")`), 'ASC'],
                [sequelize.literal(`EXTRACT(DAY FROM "dob")`), 'ASC']
            ]
        });

        const birthdayList = birthdayEmployees.map(emp => {
            const empDayjs = dayjs(emp.dob);
            const isToday = empDayjs.format('MM-DD') === dayjs().format('MM-DD');
            const plainEmp = emp.get({ plain: true });
            
            return {
                ...plainEmp,
                is_today: isToday,
                profile_image_url: plainEmp.profile_image 
                    ? `${process.env.FILE_SERVER_URL}${constants.EMPLOYEE_IMG_FOLDER}${plainEmp.profile_image}` 
                    : null
            };
        });

        return res.ok(birthdayList);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.sendHolidayAndBirthdayNotifications = async (asOf = null) => {
    try {
        const today = asOf ? dayjs(asOf) : dayjs();
        const todayDate = today.format('YYYY-MM-DD');
        const todayMonth = today.format('MM');
        const todayDay = today.format('DD');

        // 1. Holiday Notifications (General - for all employees)
        const holidays = await commonQuery.findAllRecords(Holiday, {
            date: todayDate,
            status: 0
        }, {
            attributes: ['id', 'name', 'date', 'company_id', 'branch_id']
        });

        if (holidays.length > 0) {
            for (const holiday of holidays) {
                // Get all active employees for this company/branch
                const employees = await commonQuery.findAllRecords(Employee, {
                    company_id: holiday.company_id,
                    status: 0,
                    ...(holiday.branch_id ? { branch_id: holiday.branch_id } : {})
                }, {
                    attributes: ['id', 'company_id', 'branch_id']
                });

                // Get users for these employees
                const employeeIds = employees.map(e => e.id);
                const users = await commonQuery.findAllRecords(User, {
                    employee_id: { [Op.in]: employeeIds },
                    status: 0
                }, {
                    attributes: ['id', 'company_id', 'branch_id']
                });

                // Create notification for each user
                for (const user of users) {
                    await createNotification({
                        user_id: user.id,
                        title: 'Holiday Tomorrow',
                        message: `Tomorrow is ${holiday.name}. Enjoy your holiday!`,
                        type: 'HOLIDAY',
                        reference_id: holiday.id,
                        company_id: user.company_id,
                        branch_id: user.branch_id
                    });
                }
                console.log(`✅ Holiday notification created for ${holiday.name} - ${users.length} users notified`);
            }
        }

        // 2. Birthday Notifications (Individual - only for the employee whose birthday it is)
        const birthdayEmployees = await commonQuery.findAllRecords(Employee, {
            status: 0,
            [Op.and]: [
                sequelize.where(sequelize.literal(`TO_CHAR("dob", 'MM')`), todayMonth),
                sequelize.where(sequelize.literal(`TO_CHAR("dob", 'DD')`), todayDay)
            ]
        }, {
            attributes: ['id', 'first_name', 'company_id', 'branch_id', 'dob']
        });

        if (birthdayEmployees.length > 0) {
            for (const employee of birthdayEmployees) {
                // Get user for this employee
                const user = await commonQuery.findOneRecord(User, {
                    employee_id: employee.id,
                    status: 0
                }, {
                    attributes: ['id', 'company_id', 'branch_id']
                });

                if (user) {
                    await createNotification({
                        user_id: user.id,
                        title: 'Happy Birthday!',
                        message: `Happy Birthday, ${employee.first_name}! 🎉`,
                        type: 'BIRTHDAY',
                        reference_id: employee.id,
                        company_id: user.company_id,
                        branch_id: user.branch_id
                    });
                    console.log(`✅ Birthday notification created for ${employee.first_name}`);
                }
            }
        }

        console.log('✅ Holiday and birthday notifications completed.');
        return { success: true, holidayCount: holidays.length, birthdayCount: birthdayEmployees.length };
    } catch (err) {
        console.error('❌ Holiday and birthday notifications failed:', err.message);
        throw err;
    }
};

