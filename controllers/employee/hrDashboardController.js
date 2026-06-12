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
    LeaveTemplateCategory,
    Reimbursement,
    ExpenseType
} = require("../../models");
const { commonQuery, handleError, constants, sequelize, formatDateTime, getCompanySetting, fileExists } = require("../../helpers");
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

        const allEmployees = await commonQuery.findAllRecords(Employee, { status: 0 }, { attributes: ["id"] });
        const employeeIds = allEmployees?.map(e => e.id) || [];
        const employeeScope = employeeIds.length > 0 ? { employee_id: { [Op.in]: employeeIds } } : {};

        const totalEmployees = allEmployees.length;

        // Initialize default values
        let presentToday = 0;
        let halfDayToday = 0;
        let absentToday = 0;
        let onLeaveToday = 0;
        let lateEntryCount = 0;
        let canteenPresentToday = 0;
        let canteenAbsentToday = 0;
        let guestCount = 0;

        // Only call count queries if total employee count > 0
        if (totalEmployees > 0) {
            presentToday = await commonQuery.countRecords(AttendanceDay, {
                attendance_date: today,
                status: 0,
                ...employeeScope
            }, {}, {});

            halfDayToday = await commonQuery.countRecords(AttendanceDay, {
                attendance_date: today,
                status: 1,
                ...employeeScope
            }, {}, {});

            absentToday = await commonQuery.countRecords(AttendanceDay, {
                attendance_date: today,
                status: 5,
                ...employeeScope
            }, {}, {});

            onLeaveToday = await commonQuery.countRecords(AttendanceDay, {
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

            lateEntryCount = lateEntryRecords.length;

            const canteenAttendanceToday = await commonQuery.findAllRecords(CanteenAttendance, {
                date: today
            }, {}, null, {});
          
            // Separate guest and employee data
            const guestAttendance = canteenAttendanceToday.filter(att => att.employee_id === null);
            const employeeAttendance = canteenAttendanceToday.filter(att => att.employee_id !== null);
            
            guestCount = guestAttendance.length;
            const presentEmployeeIds = employeeAttendance.map(att => att.employee_id);
            
            canteenPresentToday = presentEmployeeIds.length;
            canteenAbsentToday = allEmployees.length - presentEmployeeIds.length - guestCount;
        }

        return res.ok({
            totalEmployees,
            presentToday,
            halfDayToday,
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
                    case 'ATTENDANCE_SUPERVISOR':
                        return ((req.user.role_key === constants.ROLE_KEYS.REPORTING_MANAGER || req.user.is_reporting_manager) && employee.reporting_manager === req.user.id) ||
                            ((req.user.role_key === constants.ROLE_KEYS.ATTENDANCE_SUPERVISOR || req.user.is_attendance_supervisor) && employee.attendance_supervisor === req.user.id);
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

        return res.ok({ pendingCount: pendingGlobalCount });
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getPendingApprovalsDetails = async (req, res) => {
    try {
        const isSuperAdmin = req.user.is_super_admin;
        const isAdmin = req.user.is_admin;
        const roleKey = req.user.role_key;
        const userId = req.user.id;

        // Authorization checks helper (for Leaves, OutDuty, Regularization)
        const isUserAuthorizedForRequest = (request, levelField) => {
            if (isSuperAdmin) return true;

            const employee = request.employee;
            if (!employee) return false;

            const template = employee?.leaveTemplate;
            const currentLevel = request[levelField];
            const config = template ? (template.approval_config || []) : [];

            let currentStage = config.find(c => c.level === currentLevel) || { type: "ANYONE" };

            switch (currentStage.type) {
                case 'REPORTING_MANAGER':
                case 'ATTENDANCE_SUPERVISOR':
                    return ((roleKey === constants.ROLE_KEYS.REPORTING_MANAGER || req.user.is_reporting_manager) && employee.reporting_manager === userId) ||
                        ((roleKey === constants.ROLE_KEYS.ATTENDANCE_SUPERVISOR || req.user.is_attendance_supervisor) && employee.attendance_supervisor === userId);
                case 'ADMIN':
                    return isAdmin;
                case 'EMPLOYER':
                    return true;
                case 'ANYONE':
                    return employee.reporting_manager === userId ||
                        employee.attendance_supervisor === userId ||
                        isAdmin;
                default:
                    return false;
            }
        };

        // Query all tables in parallel
        const [leavesData, outDutiesData, regularizationsData, reimbursementsData] = await Promise.all([
            // 1. Leave & Encashment Requests
            commonQuery.findAllRecords(LeaveRequest, {
                approval_status: { [Op.in]: [constants.LEAVE_APPROVAL_STATUS.PENDING, constants.LEAVE_APPROVAL_STATUS.PARTIALLY_APPROVED] },
                status: 0
            }, {
                attributes: [
                    "id", "employee_id", "leave_category_id", "start_date", "end_date",
                    "total_days", "reason", "approval_status", "current_level",
                    "approval_history", "approved_by", "document", "status",
                    "request_type", "is_encashment", "start_session", "end_session", "createdAt"
                ],
                include: [
                    {
                        model: Employee,
                        as: "employee",
                        attributes: ["id", "first_name", "employee_code", "reporting_manager", "attendance_supervisor"],
                        include: [{ model: LeaveTemplate, as: "leaveTemplate" }]
                    },
                    {
                        model: LeaveTemplateCategory,
                        as: "category",
                        attributes: ["leave_category_name"]
                    },
                    {
                        model: User,
                        as: "approvedBy",
                        attributes: ["id", "user_name"],
                        required: false
                    }
                ],
                order: [['created_at', 'DESC']]
            }),

            // 2. Out Duty Requests
            commonQuery.findAllRecords(OutDutyRequest, {
                approval_status: { [Op.in]: [constants.OUT_DUTY_STATUS.PENDING, constants.OUT_DUTY_STATUS.PARTIALLY_APPROVED] },
                status: 0
            }, {
                include: [
                    {
                        model: Employee,
                        as: "employee",
                        attributes: ["id", "first_name", "employee_code", "reporting_manager", "attendance_supervisor", "leave_template"],
                        include: [{ model: LeaveTemplate, as: "leaveTemplate" }]
                    },
                    {
                        model: User,
                        as: "approvedBy",
                        attributes: ["id", "user_name"],
                        required: false
                    }
                ],
                order: [['created_at', 'DESC']]
            }),

            // 3. Attendance Regularization Requests
            commonQuery.findAllRecords(AttendanceRegularization, {
                approval_status: { [Op.in]: [constants.ATTENDANCE_REGULARIZATION_STATUS.PENDING, constants.ATTENDANCE_REGULARIZATION_STATUS.PARTIALLY_APPROVED] },
                status: 0
            }, {
                include: [
                    {
                        model: Employee,
                        as: "employee",
                        attributes: ["id", "first_name", "employee_code", "reporting_manager", "attendance_supervisor", "leave_template"],
                        include: [{ model: LeaveTemplate, as: "leaveTemplate" }]
                    },
                    {
                        model: User,
                        as: "approvedBy",
                        attributes: ["id", "user_name"],
                        required: false
                    }
                ],
                order: [['created_at', 'DESC']]
            }),

            // 4. Reimbursement Requests
            commonQuery.findAllRecords(Reimbursement, {
                approval_status: { [Op.in]: [constants.REIMBURSEMENT_APPROVAL_STATUS.PENDING, constants.REIMBURSEMENT_APPROVAL_STATUS.PARTIALLY_APPROVED] },
                status: 0
            }, {
                include: [
                    {
                        model: Employee,
                        as: "employee",
                        attributes: ["id", "first_name", "employee_code", "reporting_manager", "attendance_supervisor"]
                    },
                    {
                        model: ExpenseType,
                        as: "expenseType",
                        attributes: ["name"]
                    },
                    {
                        model: User,
                        as: "approvedBy",
                        attributes: ["id", "user_name"],
                        required: false
                    }
                ],
                order: [['created_at', 'DESC']]
            })
        ]);

        // Filter and format the results in memory
        const leaveRequests = [];
        const leaveEncashments = [];
        const outDuties = [];
        const attendanceRegularizations = [];
        const reimbursements = [];

        // Helper to format tracking summary for leaves
        const getLeaveTrackingSummary = (raw) => {
            const statusLabels = {
                [constants.LEAVE_APPROVAL_STATUS.PENDING]: "PENDING",
                [constants.LEAVE_APPROVAL_STATUS.PARTIALLY_APPROVED]: "PARTIALLY APPROVED",
                [constants.LEAVE_APPROVAL_STATUS.APPROVED]: "APPROVED",
                [constants.LEAVE_APPROVAL_STATUS.REJECTED]: "REJECTED",
                [constants.LEAVE_APPROVAL_STATUS.CANCELLED]: "CANCELLED",
                [constants.LEAVE_APPROVAL_STATUS.DELETED]: "DELETED",
            };
            const statusLabel = statusLabels[raw.approval_status] || "PENDING";
            const total = raw.employee?.leaveTemplate?.approval_levels || 1;
            let typeLabel = "";
            if (raw.request_type === 'CREDIT') typeLabel = " [EARNED]";
            else if (raw.request_type === 'ENCASHMENT') typeLabel = " [ENCASHMENT]";
            return `${statusLabel}${typeLabel} (Stage ${raw.current_level} of ${total})`;
        };

        // Filter Leaves & Encashments
        for (const reqObj of leavesData) {
            if (isUserAuthorizedForRequest(reqObj, 'current_level')) {
                const raw = reqObj.get({ plain: true });
                raw.tracking_summary = getLeaveTrackingSummary(raw);

                if (raw.document) {
                    const exists = fileExists(constants.LEAVE_DOC_FOLDER, raw.document);
                    raw.document_url = exists ? `${process.env.FILE_SERVER_URL}${constants.LEAVE_DOC_FOLDER}${raw.document}` : null;
                } else {
                    raw.document_url = null;
                }

                if (raw.is_encashment === true || raw.request_type === 'ENCASHMENT') {
                    leaveEncashments.push(raw);
                } else {
                    leaveRequests.push(raw);
                }
            }
        }

        // Filter Out Duties
        for (const reqObj of outDutiesData) {
            if (isUserAuthorizedForRequest(reqObj, 'current_out_duty_level')) {
                const raw = reqObj.get({ plain: true });
                raw.approved_by_name = raw.approvedBy?.user_name || null;
                outDuties.push(raw);
            }
        }

        // Filter Attendance Regularizations
        for (const reqObj of regularizationsData) {
            if (isUserAuthorizedForRequest(reqObj, 'current_level')) {
                const raw = reqObj.get({ plain: true });
                raw.approved_by_name = raw.approvedBy?.user_name || null;
                attendanceRegularizations.push(raw);
            }
        }

        // Filter Reimbursements
        for (const reqObj of reimbursementsData) {
            const employee = reqObj.employee;
            if (!employee) continue;

            let isAuthorized = false;
            if (isSuperAdmin) {
                isAuthorized = true;
            } else {
                if (employee.reporting_manager === userId ||
                    employee.attendance_supervisor === userId ||
                    isAdmin) {
                    isAuthorized = true;
                }
            }

            if (isAuthorized) {
                const raw = reqObj.get({ plain: true });

                const statusLabels = {
                    [constants.REIMBURSEMENT_APPROVAL_STATUS.PENDING]: "PENDING",
                    [constants.REIMBURSEMENT_APPROVAL_STATUS.PARTIALLY_APPROVED]: "PARTIALLY APPROVED",
                    [constants.REIMBURSEMENT_APPROVAL_STATUS.APPROVED]: "APPROVED",
                    [constants.REIMBURSEMENT_APPROVAL_STATUS.REJECTED]: "REJECTED",
                    [constants.REIMBURSEMENT_APPROVAL_STATUS.CANCELLED]: "CANCELLED",
                };
                const statusLabel = statusLabels[raw.approval_status] || "PENDING";
                raw.tracking_summary = `${statusLabel} (Stage ${raw.current_level})`;

                if (raw.bills_docs) {
                    const exists = fileExists(constants.REIMBURSEMENT_DOC_FOLDER, raw.bills_docs);
                    raw.bills_docs_url = exists ? `${process.env.FILE_SERVER_URL}${constants.REIMBURSEMENT_DOC_FOLDER}${raw.bills_docs}` : null;
                } else {
                    raw.bills_docs_url = null;
                }
                reimbursements.push(raw);
            }
        }

        // Search filtering
        const search = req.body.search ? req.body.search.toLowerCase() : null;

        const applySearchFilter = (list, searchFieldsFn) => {
            if (!search) return list;
            return list.filter(item => {
                const searchString = searchFieldsFn(item).toLowerCase();
                return searchString.includes(search);
            });
        };

        const filteredLeaves = applySearchFilter(leaveRequests, item =>
            `${item.employee?.first_name} ${item.employee?.employee_code} ${item.category?.leave_category_name} ${item.reason} ${item.tracking_summary}`
        );

        const filteredEncashments = applySearchFilter(leaveEncashments, item =>
            `${item.employee?.first_name} ${item.employee?.employee_code} ${item.category?.leave_category_name} ${item.reason} ${item.tracking_summary}`
        );

        const filteredOutDuties = applySearchFilter(outDuties, item =>
            `${item.employee?.first_name} ${item.employee?.employee_code} ${item.reason}`
        );

        const filteredRegularizations = applySearchFilter(attendanceRegularizations, item =>
            `${item.employee?.first_name} ${item.employee?.employee_code} ${item.reason}`
        );

        const filteredReimbursements = applySearchFilter(reimbursements, item =>
            `${item.employee?.first_name} ${item.employee?.employee_code} ${item.expenseType?.name} ${item.description} ${item.tracking_summary}`
        );

        return res.ok({
            leaveRequests: filteredLeaves,
            leaveEncashments: filteredEncashments,
            outDuties: filteredOutDuties,
            attendanceRegularizations: filteredRegularizations,
            reimbursements: filteredReimbursements
        });

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
            { status: 0 },
            {
                attributes: [
                    'department_id',
                    [sequelize.fn('COUNT', sequelize.col('Employee.id')), 'count']
                ],
                include: [{ model: Department, as: "department", attributes: ["name"], where: { status: { [Op.in]: [0, 1, 2] } } }],
                group: ['department_id', 'department.id', 'department.name'],
                order: [['department_id', 'ASC']],
                skipAutoCompanyInclude: true
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
                    [sequelize.fn('COUNT', sequelize.col('Payslip.id')), 'processed_count']
                ],
                raw: true,
                skipAutoCompanyInclude: true
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
            attributes: ['id', 'name', 'date', 'company_id']
        });

        if (holidays.length > 0) {
            for (const holiday of holidays) {
                // Get all active employees for this company
                const employees = await commonQuery.findAllRecords(Employee, {
                    company_id: holiday.company_id,
                    status: 0
                }, {
                    attributes: ['id', 'company_id']
                });

                // Get users for these employees
                const employeeIds = employees.map(e => e.id);
                const users = await commonQuery.findAllRecords(User, {
                    employee_id: { [Op.in]: employeeIds },
                    status: 0
                }, {
                    attributes: ['id', 'company_id']
                });

                // Create notification for each user
                for (const user of users) {
                    await createNotification({
                        user_id: user.id,
                        title: 'Holiday Tomorrow',
                        message: `Tomorrow is ${holiday.name}. Enjoy your holiday!`,
                        type: 'HOLIDAY',
                        reference_id: holiday.id,
                        company_id: user.company_id
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
            attributes: ['id', 'first_name', 'company_id', 'dob']
        });

        if (birthdayEmployees.length > 0) {
            for (const employee of birthdayEmployees) {
                // Get user for this employee
                const user = await commonQuery.findOneRecord(User, {
                    employee_id: employee.id,
                    status: 0
                }, {
                    attributes: ['id', 'company_id']
                });

                if (user) {
                    await createNotification({
                        user_id: user.id,
                        title: 'Happy Birthday!',
                        message: `Happy Birthday, ${employee.first_name}! 🎉`,
                        type: 'BIRTHDAY',
                        reference_id: employee.id,
                        company_id: user.company_id
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

            let minutes = 0;
            if (item.late_minutes !== undefined && item.late_minutes !== null) {
                minutes = Number(item.late_minutes);
            } else if (item.first_in && item.shiftTemplate?.start_time) {
                const firstInTime = dayjs(`2000-01-01 ${item.first_in}`);
                const shiftStartTime = dayjs(`2000-01-01 ${item.shiftTemplate.start_time}`);
                const diff = firstInTime.diff(shiftStartTime, "minute");
                minutes = diff > 0 ? diff : 0;
            }

            let lateDuration = "";
            if (minutes > 0) {
                const hours = Math.floor(minutes / 60);
                const mins = minutes % 60;
                const parts = [];
                if (hours > 0) parts.push(`${hours} Hr`);
                if (mins > 0) parts.push(`${mins} M`);
                lateDuration = parts.join(" ");
            } else {
                lateDuration = "0 M";
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
                late_duration: lateDuration
            };
        }).filter(Boolean);

        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getLeaveSummaryCounts = async (req, res) => {
    try {
        const startDate = req.body?.startDate;
        const endDate = req.body?.endDate;

        if (!startDate || !endDate) {
            return res.error(constants.VALIDATION_ERROR, { message: "startDate and endDate are required." });
        }

        const employeeWhere = { status: { [Op.in]: [0, 1, 2] } };

        if (!req.user.is_super_admin && !req.user.is_admin) {
            if (req.user.role_key === constants.ROLE_KEYS.ATTENDANCE_SUPERVISOR || req.user.is_attendance_supervisor) {
                employeeWhere.attendance_supervisor = req.user.id;
            } else if (req.user.role_key === constants.ROLE_KEYS.REPORTING_MANAGER || req.user.is_reporting_manager) {
                employeeWhere.reporting_manager = req.user.id;
            }
            employeeWhere[Op.or] = [
                { attendance_supervisor: req.user.id },
                { reporting_manager: req.user.id },
                { id: req.user.employee_id }
            ];
        }

        const whereClause = {
            [Op.and]: [
                { start_date: { [Op.lte]: dayjs(endDate).endOf('day').toDate() } },
                { end_date: { [Op.gte]: dayjs(startDate).startOf('day').toDate() } }
            ]
        };

        const leaves = await commonQuery.findAllRecords(LeaveRequest, whereClause, {
            include: [
                {
                    model: Employee,
                    as: "employee",
                    attributes: ["id"],
                    where: employeeWhere,
                    required: true
                }
            ],
            attributes: ["id", "approval_status"],
            raw: true
        });

        let total = 0;
        let approved = 0;
        let pending = 0;
        let rejected = 0;

        leaves.forEach(leave => {
            const status = Number(leave.approval_status);
            if (status === constants.LEAVE_APPROVAL_STATUS.APPROVED) {
                approved++;
            } else if (status === constants.LEAVE_APPROVAL_STATUS.PENDING || status === constants.LEAVE_APPROVAL_STATUS.PARTIALLY_APPROVED) {
                pending++;
            } else if (status === constants.LEAVE_APPROVAL_STATUS.REJECTED) {
                rejected++;
            }

            if (status !== constants.LEAVE_APPROVAL_STATUS.DELETED && status !== constants.LEAVE_APPROVAL_STATUS.CANCELLED) {
                total++;
            }
        });

        return res.ok({
            total,
            approved,
            pending,
            rejected
        });
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getDepartmentEmployees = async (req, res) => {
    try {
        const { departmentName } = req.body;
        if (!departmentName) {
            return res.badRequest("Department name is required.");
        }

        let whereClause = { status: 0 };
        if (departmentName === "Not Assign Department") {
            whereClause.department_id = null;
        } else {
            const dept = await commonQuery.findOneRecord(Department, {
                name: departmentName,
                status: { [Op.in]: [0, 1, 2] }
            });
            if (!dept) {
                return res.ok([]);
            }
            whereClause.department_id = dept.id;
        }

        const employees = await commonQuery.findAllRecords(Employee,
            whereClause,
            {
                attributes: ['id', 'first_name', 'employee_code', 'profile_image', 'email', 'mobile_no', 'joining_date'],
                include: [
                    {
                        model: DesignationMaster,
                        as: 'designation',
                        attributes: ['designation_name'],
                        required: false
                    }
                ],
                order: [['first_name', 'ASC']]
            }
        );

        const formatted = employees.map(emp => {
            const plainEmp = emp.get({ plain: true });
            return {
                id: plainEmp.id,
                first_name: plainEmp.first_name,
                employee_code: plainEmp.employee_code,
                email: plainEmp.email,
                mobile_no: plainEmp.mobile_no,
                joining_date: plainEmp.joining_date,
                designation_name: plainEmp.designation?.designation_name || "-",
                profile_image_url: plainEmp.profile_image
                    ? `${process.env.FILE_SERVER_URL}${constants.EMPLOYEE_IMG_FOLDER}${plainEmp.profile_image}`
                    : null
            };
        });

        return res.ok(formatted);
    } catch (err) {
        console.error("Get Department Employees Error", err);
        return handleError(err, res, req);
    }
};


