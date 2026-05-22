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
    User,
    EmployeeLeaveBalance,
    LeaveTemplateCategory
} = require("../../models");
const { commonQuery, handleError, constants, sequelize, formatDateTime, getCompanySetting } = require("../../helpers");
const { getFilteredAnnouncements } = require("../../helpers/functions/commonFunctions");
const { Op } = require("sequelize");
const dayjs = require("dayjs");
const { createNotification } = require("../../services/notificationService");
const LeaveBalanceService = require("../../services/leaveBalanceService");

const getProbationCompletionData = async (companyId) => {
    const today = dayjs().format("YYYY-MM-DD");
    const companySettings = await getCompanySetting(companyId);
    const companyProbationDays = Number(companySettings?.probation_period_days) || 0;

    let completedProbationEmployees = [];

    const probationEmployees = await commonQuery.findAllRecords(Employee, {
        status: 0,
        employment_type: 4,
        joining_date: { [Op.ne]: null }
    }, {
        attributes: ['id', 'first_name', 'employee_code', 'joining_date', 'employment_type', 'probation_period_days']
    }, null, false);

    completedProbationEmployees = probationEmployees
        .map(employee => {
            const empProbationDays = employee.probation_period_days !== null && employee.probation_period_days !== undefined
                ? Number(employee.probation_period_days)
                : companyProbationDays;

            const probationEndDate = dayjs(employee.joining_date).add(empProbationDays, 'day');

            return {
                id: employee.id,
                first_name: employee.first_name,
                employee_code: employee.employee_code,
                joining_date: employee.joining_date,
                employment_type: employee.employment_type,
                probation_period_days: employee.probation_period_days,
                probation_end_date: probationEndDate.format("YYYY-MM-DD")
            };
        })
        .filter(employee => dayjs(employee.probation_end_date).isSame(dayjs(today), 'day') || dayjs(employee.probation_end_date).isBefore(dayjs(today), 'day'));

    return {
        show_alert: completedProbationEmployees.length > 0,
        count: completedProbationEmployees.length,
        probation_period_days: companyProbationDays,
        completedProbationEmployees,
    };
};

exports.getCounts = async (req, res) => {
    try {
        const today = req.body.date ? dayjs(req.body.date).format("YYYY-MM-DD") : dayjs().format("YYYY-MM-DD");

        const allEmployees = await commonQuery.findAllRecords(Employee, { status: 0 }, { attributes: ["id"] }, false);
        const employeeIds = allEmployees?.map(e => e.id) || [];
        const employeeScope = employeeIds.length > 0 ? { employee_id: { [Op.in]: employeeIds } } : {};

        const totalEmployees = allEmployees.length;

        const presentToday = await commonQuery.countRecords(AttendanceDay, {
            attendance_date: today,
            status: { [Op.in]: [0, 1] },
            ...employeeScope
        }, {}, {});
console.log("presentToday",presentToday)
        const absentToday = await commonQuery.countRecords(AttendanceDay, {
            attendance_date: today,
            status: 5,
            ...employeeScope
        }, {}, {});

        const onLeaveToday = await commonQuery.countRecords(AttendanceDay, {
            attendance_date: today,
            status: 6,
            ...employeeScope
        }, {}, {});
        
        const lateEntry = await commonQuery.findAllRecords(AttendanceDay,
            {
                attendance_date: today,
                ...employeeScope
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
            {}
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

        const canteenAttendanceToday = await commonQuery.findAllRecords(CanteenAttendance, {
            date: today
        }, {}, null, {});
      
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

exports.getProbationCompletionAlert = async (req, res) => {
    try {
        const response = await getProbationCompletionData(req.user.company_id);
        return res.ok(response);
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
        const currentMonth = req.body.month ? parseInt(req.body.month) : dayjs().month() + 1; // 1-12
        const currentYear = req.body.year ? parseInt(req.body.year) : dayjs().year();

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

exports.updateProbationAction = async (req, res) => {
    try {
        const { employeeId, action, exitDate, extendedDays } = req.body;

        if (!employeeId || !action) {
            return res.badRequest("Employee ID and action are required.");
        }

        const employee = await commonQuery.findOneRecord(Employee, { id: employeeId });
        if (!employee) {
            return res.badRequest("Employee not found.");
        }

        if (action === "reject") {
            if (!exitDate) {
                return res.badRequest("Exit date is required for rejection.");
            }

            const today = dayjs().format("YYYY-MM-DD");
            const isExitDateReached = dayjs(exitDate).isSame(dayjs(today), 'day') || dayjs(exitDate).isBefore(dayjs(today), 'day');

            const employeePayload = {
                exit_date: exitDate,
                resignation_status: 2 // Exited/Inactive marked
            };

            if (isExitDateReached) {
                employeePayload.status = 4; // Exited
            }

            await commonQuery.updateRecordById(Employee, employee.id, employeePayload);

            if (isExitDateReached) {
                await User.update({ status: 4 }, { where: { employee_id: employee.id } });
            }

            return res.ok({ message: "Employee probation rejected and exit date saved successfully." });

        } else if (action === "extend") {
            if (extendedDays === undefined || extendedDays === null || isNaN(Number(extendedDays))) {
                return res.badRequest("Valid extended days are required.");
            }

            const companySettings = await getCompanySetting(req.user.company_id);
            const companyProbationDays = Number(companySettings?.probation_period_days) || 0;

            const currentProbationDays = employee.probation_period_days !== null && employee.probation_period_days !== undefined
                ? Number(employee.probation_period_days)
                : companyProbationDays;

            const newProbationDays = currentProbationDays + Number(extendedDays);

            await commonQuery.updateRecordById(Employee, employee.id, {
                probation_period_days: newProbationDays
            });

            return res.ok({ message: `Probation extended by ${extendedDays} days (Total: ${newProbationDays} days) successfully.` });
        } else {
            return res.badRequest("Invalid action type.");
        }
    } catch (err) {
        return handleError(err, res, req);
    }
};

const compileLeaveSummary = async (employee) => {
    const employee_id = employee.id;
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

    const balances = await commonQuery.findAllRecords(EmployeeLeaveBalance, balanceCriteria);

    const history = await commonQuery.findAllRecords(LeaveRequest, {
        employee_id,
        status: 0
    }, {
        include: [
            {
                model: LeaveTemplateCategory,
                as: "category",
                attributes: ["id", "leave_category_name"]
            },
            {
                model: User,
                as: "approvedBy",
                attributes: ["id", "user_name"],
                required: false
            }
        ],
        order: [["start_date", "DESC"]]
    });

    let totalUsed = 0;
    let totalLeft = 0;
    const formattedBalances = balances.map(b => {
        const used = parseFloat(b.used_leaves || 0);
        const pending = parseFloat(b.pending_leaves || 0);

        totalUsed += used;
        totalLeft += pending;

        return {
            id: b.id,
            leave_name: b.leave_category_name,
            balance: `${pending.toFixed(1)} Left`,
            to_be_accrued: `${used.toFixed(1)} Used`
        };
    });

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

        if ([constants.LEAVE_APPROVAL_STATUS.APPROVED, constants.LEAVE_APPROVAL_STATUS.PARTIALLY_APPROVED, constants.LEAVE_APPROVAL_STATUS.PENDING].includes(leave.approval_status)) {
            if (leave.request_type !== 'CREDIT') {
                group.total_days += parseFloat(leave.total_days || 0);
            }
        }

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

        const isCredit = leave.request_type === 'CREDIT';
        const labelPrefix = isCredit ? "(+) " : "";
        const typeSuffix = isCredit ? " (Earned)" : "";

        group.leaves.push({
            id: leave.id,
            date_range: dateRange,
            request_type: leave.request_type || 'DEBIT',
            applied_date: leave.createdAt ? dayjs(leave.createdAt).format("D MMM, ddd") : "",
            duration_display: `${labelPrefix}${parseFloat(leave.total_days).toFixed(1)} Days | ${leave.category?.leave_category_name}${typeSuffix}`,
            duration_days: `${labelPrefix}${parseFloat(leave.total_days).toFixed(1)} Days`,
            leave_type: `${leave.category?.leave_category_name}${typeSuffix}`,
            reason: leave.reason || "",
            document_url: leave.document ? `${process.env.FILE_SERVER_URL}${constants.LEAVE_DOC_FOLDER}${leave.document}` : null,
            status_id: leave.approval_status,
            status: statusMap[leave.approval_status] || "PENDING",
            status_color: isCredit ? "#10B981" : (colorMap[leave.approval_status] || "#F59E0B"),
            approved_by: leave.approvedBy?.user_name || null,
            approval_remark: leave.approval_remark || "",
            start_session: leave.start_session === 0 ? "Full Day" : (leave.start_session === 1 ? "Session 1" : "Session 2"),
            end_session: leave.end_session === 0 ? "Full Day" : (leave.end_session === 1 ? "Session 1" : "Session 2")
        });
    });

    return {
        leave_balance: {
            total_balance_text: `${totalLeft.toFixed(1)} Leaves`,
            categories: formattedBalances,
            total_used_text: `${totalUsed.toFixed(1)} Days`
        },
        leave_history: groupedHistory
    };
};

exports.getLateEntryEmployees = async (req, res) => {
    try {
        const today = dayjs().format("YYYY-MM-DD");

        const allEmployees = await commonQuery.findAllRecords(Employee, { status: 0 }, { attributes: ["id"] }, false);
        const employeeIds = allEmployees?.map(e => e.id) || [];
        const employeeScope = employeeIds.length > 0 ? { employee_id: { [Op.in]: employeeIds } } : {};

        const lateEntry = await commonQuery.findAllRecords(AttendanceDay,
            {
                attendance_date: today,
                ...employeeScope
            },
            {
                include: [
                    {
                        model: ShiftTemplate,
                        as: 'shiftTemplate',
                        required: false,
                        attributes: ['start_time', 'grace_minutes']
                    },
                    {
                        model: Employee,
                        as: 'employee',
                        attributes: ['id', 'first_name', 'employee_code', 'profile_image', 'joining_date', 'employment_type']
                    }
                ]
            },
            null,
            {}
        );

        const lateEntryRecords = lateEntry.filter(record => {
            if (!record.first_in || !record.shiftTemplate) return false;
            
            const firstInTime = dayjs(`2000-01-01 ${record.first_in}`);
            const shiftStartTime = dayjs(`2000-01-01 ${record.shiftTemplate.start_time}`);
            const graceMinutes = record.shiftTemplate.grace_minutes || 0;
            const allowedTime = shiftStartTime.add(graceMinutes, 'minute');
            
            return firstInTime.isAfter(allowedTime);
        });

        const data = lateEntryRecords.map(item => {
            if (!item.employee) return null;
            const plainEmployee = item.employee.get({ plain: true });

            let lateMin = "";
            if (item.late_minutes !== undefined && item.late_minutes !== null) {
                lateMin = String(item.late_minutes);
            } else if (item.first_in && item.shiftTemplate?.start_time) {
                const firstInTime = dayjs(`2000-01-01 ${item.first_in}`);
                const shiftStartTime = dayjs(`2000-01-01 ${item.shiftTemplate.start_time}`);
                const diff = firstInTime.diff(shiftStartTime, "minute");
                lateMin = diff > 0 ? String(diff) : "0";
            }

            return {
                id: plainEmployee.id,
                first_name: plainEmployee.first_name,
                employee_code: plainEmployee.employee_code,
                profile_image: plainEmployee.profile_image,
                first_in: item.first_in,
                shift_start: item.shiftTemplate?.start_time,
                profile_image_url: plainEmployee.profile_image 
                    ? `${process.env.FILE_SERVER_URL}${constants.EMPLOYEE_IMG_FOLDER}${plainEmployee.profile_image}` 
                    : null,
                late_min: lateMin
            };
        }).filter(Boolean);

        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};

