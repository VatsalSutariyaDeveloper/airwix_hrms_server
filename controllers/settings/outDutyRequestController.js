const { validateRequest, commonQuery, handleError, Op, formatDateTime } = require("../../helpers");
const { constants } = require("../../helpers/constants");
const { sequelize, OutDutyRequest, User, Employee, EmployeeAttendanceTemplate, AttendanceTemplate, LeaveTemplate, RolePermission } = require("../../models");
const dayjs = require("dayjs");
const notificationService = require("../../services/notificationService");
const { resolvePendingApprovers, getNextApprovalState, isUserAuthorizedForStage } = require("../../helpers/approvalHelper");
const { rebuildAttendanceDay } = require("../../helpers/attendanceHelper");

const syncedOutDutyTenants = new Set();
async function ensureOutDutyRequestSynced(tenantPrefix) {
    const cacheKey = `${tenantPrefix || 'default'}_OutDutyRequest`;
    if (!syncedOutDutyTenants.has(cacheKey)) {
        try {
            await OutDutyRequest.sync({ alter: true });
            syncedOutDutyTenants.add(cacheKey);
        } catch (syncErr) {
            console.error("Failed to sync OutDutyRequest table:", syncErr.message);
        }
    }
}

const getApproversForOutDutyRequest = async (employeeId, currentLevel, transaction) => {
    try {
        const employee = await commonQuery.findOneRecord(Employee, employeeId, {
            include: [
                { model: EmployeeAttendanceTemplate, as: "employeeAttendanceTemplate", where: { status: 0 }, required: false },
                { model: AttendanceTemplate, as: "attendanceTemplate", required: false }
            ]
        }, transaction);

        if (!employee) return [];

        const template = employee.employeeAttendanceTemplate || employee.attendanceTemplate;
        let config = template ? (template.out_duty_approval_config || []) : [];
        if (typeof config === 'string') {
            try { config = JSON.parse(config); } catch (e) { config = []; }
        }
        if (!Array.isArray(config)) config = [];
        const currentStage = config.find(c => c.level === currentLevel) || { type: "ANYONE" };
        const { type } = currentStage;

        const userIds = new Set();

        if (type === 'REPORTING_MANAGER' || type === 'ATTENDANCE_SUPERVISOR' || type === 'ANYONE') {
            if (employee.reporting_manager) {
                userIds.add(employee.reporting_manager);
            }
            if (employee.attendance_supervisor) {
                userIds.add(employee.attendance_supervisor);
            }
        }

        if (type === 'ADMIN' || type === 'ANYONE' || type === 'EMPLOYER') {
            const adminFilters = {
                status: 0,
                [Op.or]: [
                    { is_super_admin: true },
                    { '$RolePermission.role_key$': constants.ROLE_KEYS.BUSINESS_ADMIN },
                    { '$RolePermission.role_key$': constants.ROLE_KEYS.ADMIN }
                ]
            };
            const admins = await commonQuery.findAllRecords(User, adminFilters, {
                include: [{ model: RolePermission, as: 'RolePermission', attributes: [] }],
                attributes: ['id'],
                raw: true
            }, transaction);

            admins.forEach(a => userIds.add(a.id));
        }

        return [...userIds];
    } catch (err) {
        console.error("❌ Error in getApproversForOutDutyRequest:", err.message);
        if (err.sql) console.error("Failed SQL:", err.sql);
        if (err.parent) console.error("Parent Error:", err.parent);
        throw err;
    }
};

const sendApprovalNotifications = async (outDutyRequest, employee, actionType, transaction) => {
    try {
        const userIds = await getApproversForOutDutyRequest(outDutyRequest.employee_id, outDutyRequest.current_out_duty_level, transaction);
        if (!userIds || userIds.length === 0) return;

        const employeeName = employee ? employee.first_name : "An employee";
        const startDateStr = formatDateTime(outDutyRequest.start_date, 'DD MMM YYYY');
        const endDateStr = formatDateTime(outDutyRequest.end_date, 'DD MMM YYYY');

        let title = "";
        let message = "";
        let statusCode = 0;

        if (actionType === "CREATE") {
            title = "New Out Duty Request Pending Approval";
            message = `${employeeName} has requested out duty from ${startDateStr} to ${endDateStr}.`;
            statusCode = 0;
        } else if (actionType === "UPDATE") {
            title = "Out Duty Request Updated";
            message = `${employeeName} has updated their out duty request from ${startDateStr} to ${endDateStr}.`;
            statusCode = 0;
        } else if (actionType === "CANCEL") {
            title = "Out Duty Request Cancelled";
            message = `${employeeName} has cancelled their out duty request from ${startDateStr} to ${endDateStr}.`;
            statusCode = 1; // Warning / Cancelled
        }

        for (const userId of userIds) {
            // Avoid notifying the employee themselves about their own action
            const user = await commonQuery.findOneRecord(User, { id: userId }, { attributes: ["employee_id"] }, transaction);
            if (user && user.employee_id === outDutyRequest.employee_id) {
                continue;
            }

            await notificationService.createNotification({
                user_id: userId,
                title,
                message,
                type: "OUT_DUTY",
                reference_id: outDutyRequest.id,
                status_code: statusCode,
                company_id: outDutyRequest.company_id,
                branch_id: outDutyRequest.branch_id
            }, transaction);
        }
    } catch (err) {
        console.error("❌ Error sending approval level notifications:", err.message);
        if (err.sql) console.error("Failed SQL:", err.sql);
        throw err;
    }
};


exports.create = async (req, res) => {
    const transaction = await sequelize.transaction({
        logging: (sql) => {
            console.log("\x1b[33m📝 [OUT DUTY TRANSACTION SQL]:\x1b[0m", sql);
        }
    });
    try {

        const requiredFields = {
            employee_id: "Employee ID",
            start_date: "Start Date",
            end_date: "End Date",
            total_days: "Total Days",
        };

        if (!req.body.employee_id) {
            req.body.employee_id = req.user.employee_id
        }

        await ensureOutDutyRequestSynced(req.tenantPrefix);

        const errors = await validateRequest(req.body, requiredFields, {}, transaction);

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        // Check Employee's Attendance Template Settings
        const employee = await commonQuery.findOneRecord(Employee, req.body.employee_id, {
            include: [
                { model: EmployeeAttendanceTemplate, as: "employeeAttendanceTemplate", where: { status: 0 }, required: false },
                { model: AttendanceTemplate, as: "attendanceTemplate", required: false }
            ]
        }, transaction);

        const template = employee?.employeeAttendanceTemplate || employee?.attendanceTemplate;
        if (template && template.enble_out_duty === false) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, { message: "Out Duty requests are disabled for this employee's template." });
        }

        // Check if out_duty_approval_level is null, then set approval_status to 3 (APPROVED) directly
        let approvalStatus = constants.OUT_DUTY_STATUS.PENDING; // Default to pending
        if (template && template.out_duty_approval_level === null) {
            approvalStatus = constants.OUT_DUTY_STATUS.APPROVED; // Set to approved (3)
        }

        let { start_date, end_date, start_session, end_session } = req.body;
        const employee_id = req.body.employee_id;

        // 0=Full Day, 1=Session 1, 2=Session 2
        start_session = parseInt(start_session) || 0;
        end_session = parseInt(end_session) || 0;

        // Check for Overlapping Out Duty Requests
        const overlap = await commonQuery.findOneRecord(OutDutyRequest, {
            employee_id,
            approval_status: { [Op.notIn]: [constants.OUT_DUTY_STATUS.REJECTED, constants.OUT_DUTY_STATUS.CANCELLED, constants.OUT_DUTY_STATUS.DELETED] },
            status: 0,
            [Op.or]: [
                { start_date: { [Op.between]: [start_date, end_date] } },
                { end_date: { [Op.between]: [start_date, end_date] } },
                { [Op.and]: [{ start_date: { [Op.lte]: start_date } }, { end_date: { [Op.gte]: end_date } }] }
            ]
        }, {}, transaction);

        if (overlap) {
            await transaction.rollback();
            return res.error("OVERLAP", { message: `Selected dates overlap with an existing out-duty request (${formatDateTime(overlap.start_date)} to ${formatDateTime(overlap.end_date)})` });
        }

        const outDutyRequest = await commonQuery.createRecord(
            OutDutyRequest,
            { ...req.body, start_session, end_session, approval_status: approvalStatus, current_out_duty_level: 1, approval_history: [] },
            transaction
        )

        if (approvalStatus === constants.OUT_DUTY_STATUS.APPROVED) {
            await generatePunchesAndRebuild(outDutyRequest, req.user ? req.user.id : (outDutyRequest.user_id || 0), transaction);
        }

        // Notify approval level users
        await sendApprovalNotifications(outDutyRequest, employee, "CREATE", transaction);

        if (approvalStatus === constants.OUT_DUTY_STATUS.APPROVED) {
            const start = dayjs(start_date);
            const end = dayjs(end_date);
            const diff = end.diff(start, 'day');
            const todayStr = dayjs().format('YYYY-MM-DD');
            for (let i = 0; i <= diff; i++) {
                const targetDate = start.add(i, 'day').format('YYYY-MM-DD');
                if (targetDate <= todayStr) {
                    await rebuildAttendanceDay(employee_id, targetDate, { user_id: req.user?.id }, transaction);
                }
            }
        }

        await transaction.commit();
        return res.success(constants.SUCCESS, { message: "Out Duty request created successfully" });
    }
    catch (err) {
        await transaction.rollback();
        console.error("❌ Controller Error in OutDutyRequest.create:", err.message);
        if (err.sql) {
            console.error("Failed SQL Query in transaction:", err.sql);
        }
        if (err.parent) {
            console.error("Database details:", err.parent);
        }
        return handleError(err, res, req);
    }
}

exports.getAll = async (req, res) => {
    try {

        const fieldConfig = [
            ["employee_id", true, true],
            ["start_date", true, true],
            ["end_date", true, true],
            ["total_days", false, true],
        ];

        // Add date filtering based on payload
        let whereClause = {};
        const leaveFilter = req.body?.leave_filter;

        if (leaveFilter) {
            const today = dayjs().toDate();

            switch (leaveFilter) {
                case 'previous':
                    // Previous: ended before today
                    whereClause.end_date = { [Op.lt]: today };
                    break;
                case 'upcoming':
                    // Upcoming: ends today or later
                    whereClause.end_date = { [Op.gte]: today };
                    break;
            }
        }

        const employeeWhere = { status: { [Op.in]: [0, 1, 2] } };

        let isOwnRequest = req.body.employee_id && (req.body.employee_id == req.user.employee_id);

        if (!req.user.is_super_admin && !req.user.is_admin && !isOwnRequest) {
            employeeWhere[Op.or] = [
                { attendance_supervisor: req.user.id },
                { reporting_manager: req.user.id }
            ];
        }

        const data = await commonQuery.fetchPaginatedData(
            OutDutyRequest,
            { ...req.body },
            fieldConfig,
            {
                include: [
                    {
                        model: Employee,
                        as: "employee",
                        attributes: ["id", "first_name", "employee_code"],
                        where: employeeWhere,
                        required: true
                    },
                    {
                        model: User,
                        as: "approvedBy",
                        attributes: ["id", "user_name"],
                        required: false
                    }
                ]
            },
            isOwnRequest ? { applyHierarchy: false } : true, // requireTenantFields
            'created_at', // dateField
            whereClause // customWhere
        );

        data.items = await Promise.all((data?.items || []).map(async row => {
            const raw = row.get ? row.get({ plain: true }) : row;
            if (raw.approval_status === constants.OUT_DUTY_STATUS.PENDING || raw.approval_status === constants.OUT_DUTY_STATUS.PARTIALLY_APPROVED) {
                const pendingDetails = await resolvePendingApprovers(raw, "OUT_DUTY");
                raw.pending_with = pendingDetails.pending_with;
            } else {
                raw.pending_with = [];
            }
            return raw;
        }));

        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
}

// Get Single Request Details
exports.getById = async (req, res) => {
    try {
        const { id } = req.params;
        const outDutyRequest = await commonQuery.findOneRecord(OutDutyRequest, { id }, {
            include: [
                {
                    model: Employee,
                    as: "employee",
                    attributes: ["id", "first_name", "employee_code"],
                    include: [
                        { model: EmployeeAttendanceTemplate, as: "employeeAttendanceTemplate", where: { status: 0 }, required: false },
                        { model: AttendanceTemplate, as: "attendanceTemplate", required: false }
                    ],
                    required: false
                },
                {
                    model: User,
                    as: "approvedBy",
                    attributes: ["id", "user_name"],
                    required: false
                }
            ]
        });

        if (!outDutyRequest) return res.error(constants.NOT_FOUND);

        const raw = outDutyRequest.get ? outDutyRequest.get({ plain: true }) : outDutyRequest;

        // Add approver name if available
        raw.approved_by = raw.approvedBy?.user_name || null;

        const employee = raw.employee || {};
        const template = employee.employeeAttendanceTemplate || employee.attendanceTemplate;

        const totalLevels = template ? (template.out_duty_approval_level || 1) : 1;
        let levelConfigs = template ? (template.out_duty_approval_config || []) : [];
        if (typeof levelConfigs === 'string') {
            try { levelConfigs = JSON.parse(levelConfigs); } catch (e) { levelConfigs = []; }
        }
        if (!Array.isArray(levelConfigs)) levelConfigs = [];
        const approvers = await commonQuery.findAllRecords(User, { status: 0 });

        raw.approval_history = (raw.approval_history || []).map(h => {
            const user = approvers.find(u => u.id === (h.approved_by || h.by));
            return {
                ...h,
                user_name: user ? user.user_name : null
            };
        });

        const history = raw.approval_history;
        const timeline = [];

        for (let i = 1; i <= totalLevels; i++) {
            const levelConfig = levelConfigs.find(l => l.level === i) || {};
            const levelHistory = history.find(h => h.level === i);
            let stageStatus = "UPCOMING";
            let actionPersonnel = "-";

            if (i < raw.current_out_duty_level) {
                stageStatus = "COMPLETED";
                const user = approvers.find(u => u.id === (levelHistory?.approved_by || levelHistory?.by));
                if (user) actionPersonnel = user.user_name;
            } else if (i === raw.current_out_duty_level) {
                if (raw.approval_status === constants.OUT_DUTY_STATUS.REJECTED || raw.approval_status === constants.OUT_DUTY_STATUS.CANCELLED) {
                    stageStatus = levelHistory ? "REJECTED" : "CANCELLED";
                } else if (raw.approval_status === constants.OUT_DUTY_STATUS.APPROVED) {
                    stageStatus = "COMPLETED";
                } else {
                    stageStatus = "PENDING";
                }
            }

            timeline.push({
                level: i,
                status: stageStatus,
                required_role: levelConfig.type,
                personnel: actionPersonnel,
                label: levelConfig.label || `Level ${i}`,
                history: levelHistory || null
            });
        }

        raw.timeline = timeline;
        raw.next_action_at_level = totalLevels === raw.current_out_duty_level &&
            [constants.OUT_DUTY_STATUS.APPROVED, constants.OUT_DUTY_STATUS.REJECTED, constants.OUT_DUTY_STATUS.CANCELLED].includes(Number(raw.approval_status))
            ? null : raw.current_out_duty_level;

        if (raw.approval_status === constants.OUT_DUTY_STATUS.PENDING || raw.approval_status === constants.OUT_DUTY_STATUS.PARTIALLY_APPROVED) {
            const pendingDetails = await resolvePendingApprovers(raw, "OUT_DUTY");
            raw.pending_with = pendingDetails.pending_with;
        } else {
            raw.pending_with = [];
        }

        return res.ok(raw);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// Update Out Duty Request
exports.update = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.params;
        const requiredFields = {
            start_date: "Start Date",
            end_date: "End Date",
            total_days: "Total Days",
        };

        const errors = await validateRequest(req.body, requiredFields, {}, transaction);
        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        const outDutyRequest = await commonQuery.findOneRecord(OutDutyRequest, { id }, {}, transaction);
        if (!outDutyRequest || outDutyRequest.status === 2) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        if (outDutyRequest.approval_status !== constants.OUT_DUTY_STATUS.PENDING && outDutyRequest.approval_status !== constants.OUT_DUTY_STATUS.PARTIALLY_APPROVED) {
            await transaction.rollback();
            return res.error("INVALID_OPERATION", { message: "Only pending or partially approved requests can be updated" });
        }

        let { start_date, end_date, start_session, end_session } = req.body;
        const employee_id = outDutyRequest.employee_id;

        start_session = parseInt(start_session) || 0;
        end_session = parseInt(end_session) || 0;
        const requestedTotal = parseFloat(req.body.total_days || 0);

        // Check Employee's Attendance Template Settings
        const employee = await commonQuery.findOneRecord(Employee, employee_id, {
            include: [
                { model: EmployeeAttendanceTemplate, as: "employeeAttendanceTemplate", where: { status: 0 }, required: false },
                { model: AttendanceTemplate, as: "attendanceTemplate", required: false }
            ]
        }, transaction);

        const template = employee?.employeeAttendanceTemplate || employee?.attendanceTemplate;
        if (template && template.enble_out_duty === false) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, { message: "Out Duty requests are disabled for this employee's template." });
        }

        // Check for Overlapping Out Duty Requests (excluding current request)
        const overlap = await commonQuery.findOneRecord(OutDutyRequest, {
            employee_id,
            id: { [Op.ne]: id },
            approval_status: { [Op.notIn]: [constants.OUT_DUTY_STATUS.REJECTED, constants.OUT_DUTY_STATUS.CANCELLED, constants.OUT_DUTY_STATUS.DELETED] },
            status: 0,
            [Op.or]: [
                { start_date: { [Op.between]: [start_date, end_date] } },
                { end_date: { [Op.between]: [start_date, end_date] } },
                { [Op.and]: [{ start_date: { [Op.lte]: start_date } }, { end_date: { [Op.gte]: end_date } }] }
            ]
        }, {}, transaction);

        if (overlap) {
            await transaction.rollback();
            return res.error("OVERLAP", { message: `Selected dates overlap with an existing out-duty request (${formatDateTime(overlap.start_date)} to ${formatDateTime(overlap.end_date)})` });
        }

        const PUT = {
            ...req.body,
            start_session,
            end_session
        };

        await commonQuery.updateRecordById(OutDutyRequest, id, PUT, transaction);
        const updatedRequest = await commonQuery.findOneRecord(OutDutyRequest, { id }, {}, transaction);
        const employeeForNotify = await commonQuery.findOneRecord(Employee, employee_id, {}, transaction);
        await sendApprovalNotifications(updatedRequest, employeeForNotify, "UPDATE", transaction);

        await transaction.commit();
        return res.success("OUT_DUTY_UPDATED");
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Get Pending Approvals
exports.getPendingApprovals = async (req, res) => {
    try {
        // Fetch all pending out-duty requests with employee and template details
        const requests = await commonQuery.fetchPaginatedData(
            OutDutyRequest,
            req.body,
            [
                ["employee.first_name", true, true],
            ],
            {
                include: [
                    {
                        model: Employee,
                        as: "employee",
                        attributes: ["id", "first_name", "employee_code", "reporting_manager", "attendance_supervisor"],
                        include: [
                            { model: EmployeeAttendanceTemplate, as: "employeeAttendanceTemplate", where: { status: 0 }, required: false },
                            { model: AttendanceTemplate, as: "attendanceTemplate", required: false }
                        ]
                    },
                    {
                        model: User,
                        as: "approvedBy",
                        attributes: ["id", "user_name"],
                        required: false
                    }
                ]
            },
            true,
            'created_at',
            {
                approval_status: { [Op.in]: [constants.OUT_DUTY_STATUS.PENDING, constants.OUT_DUTY_STATUS.PARTIALLY_APPROVED] },
                status: 0
            }
        );

        // Apply authorization logic - only return requests user can approve
        const pendingForUser = [];
        for (const request of requests.items) {
            const employee = request.employee;
            if (!employee) continue;

            const template = employee?.employeeAttendanceTemplate || employee?.attendanceTemplate;
            const currentLevel = request.current_out_duty_level;
            let parsedConfig = template ? (template.out_duty_approval_config || {}) : {};
            if (typeof parsedConfig === 'string') {
                try { parsedConfig = JSON.parse(parsedConfig); } catch (e) { parsedConfig = {}; }
            }
            let config = Array.isArray(parsedConfig) ? parsedConfig : (parsedConfig.approval_config || []);
            if (!Array.isArray(config)) config = [];
            let currentStage = config.find(c => c.level === currentLevel);
            if (!currentStage) currentStage = { type: "ANYONE" };

            // Reset authorization for each request to prevent cross-contamination
            const isOwnRequest = (request.employee_id === req.user.employee_id);
            const isAuthorized = isUserAuthorizedForStage({
                user: req.user,
                employee,
                stageType: currentStage.type,
                isOwnRequest
            });

            console.log("Request", request.id, "Authorized:", isAuthorized);

            if (isAuthorized) {
                const raw = request.get({ plain: true });
                raw.approved_by_name = raw.approvedBy?.user_name || null;

                // Resolve pending approver details
                const pendingDetails = await resolvePendingApprovers(raw, "OUT_DUTY");
                raw.pending_with = pendingDetails.pending_with;

                pendingForUser.push(raw);
            }
        }

        return res.ok(pendingForUser);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// Update Status (Approve/Reject)
exports.updateStatus = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.params;
        const { approval_status, remarks } = req.body;

        const outDutyRequest = await commonQuery.findOneRecord(OutDutyRequest, { id }, {
            include: [{ model: Employee, as: "employee" }]
        }, transaction);
        if (!outDutyRequest) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        let maxLevel = 1;
        if (approval_status === constants.OUT_DUTY_STATUS.APPROVED) {
            const employee = await commonQuery.findOneRecord(Employee, outDutyRequest.employee_id, {
                include: [
                    { model: EmployeeAttendanceTemplate, as: "employeeAttendanceTemplate", where: { status: 0 }, required: false },
                    { model: AttendanceTemplate, as: "attendanceTemplate", required: false }
                ]
            }, transaction);

            const template = employee?.employeeAttendanceTemplate || employee?.attendanceTemplate;
            maxLevel = template ? (template.out_duty_approval_level || 1) : 1;
        }

        const isApproved = approval_status === constants.OUT_DUTY_STATUS.APPROVED;
        const historyItem = {
            level: outDutyRequest.current_out_duty_level,
            action: isApproved ? "APPROVED" : "REJECTED",
            by: req.user.id,
            at: new Date(),
            remarks: remarks || ""
        };

        const { newStatus, newLevel, updatedHistory } = getNextApprovalState({
            targetStatus: approval_status,
            currentLevel: outDutyRequest.current_out_duty_level,
            totalLevels: maxLevel,
            isSuperAdmin: req.user.is_super_admin,
            approvalHistory: outDutyRequest.approval_history || [],
            statusMapping: {
                APPROVED: constants.OUT_DUTY_STATUS.APPROVED,
                PARTIALLY_APPROVED: constants.OUT_DUTY_STATUS.PARTIALLY_APPROVED,
                REJECTED: constants.OUT_DUTY_STATUS.REJECTED,
                CANCELLED: constants.OUT_DUTY_STATUS.CANCELLED
            },
            historyItem,
            bypassOptions: {
                attachToPreviousItem: true
            }
        });

        await commonQuery.updateRecordById(OutDutyRequest, id, {
            approval_status: newStatus,
            current_out_duty_level: newLevel,
            approval_history: updatedHistory,
            approved_by: req.user.id,
            approval_remark: remarks || ""
        }, transaction);

        // Send Notification to Employee
        const user = await commonQuery.findOneRecord(User, { employee_id: outDutyRequest.employee_id }, {}, transaction);
        if (user) {
            await notificationService.createNotification({
                user_id: user.id,
                title: newStatus === constants.OUT_DUTY_STATUS.APPROVED ? "Out Duty Approved" : (newStatus === constants.OUT_DUTY_STATUS.REJECTED ? "Out Duty Rejected" : "Out Duty Status Updated"),
                message: newStatus === constants.OUT_DUTY_STATUS.APPROVED
                    ? `Your Out Duty request from ${formatDateTime(outDutyRequest.start_date, 'DD MMM')} to ${formatDateTime(outDutyRequest.end_date, 'DD MMM')} has been approved.`
                    : `Your Out Duty request has been ${newStatus === constants.OUT_DUTY_STATUS.REJECTED ? 'rejected' : 'updated'}. ${remarks ? 'Remarks: ' + remarks : ''}`,
                type: "OUT_DUTY",
                reference_id: id,
                status_code: newStatus === constants.OUT_DUTY_STATUS.REJECTED ? 2 : 0,
                company_id: req.user.company_id,
                branch_id: req.user.branch_id
            }, transaction);
        }

        if (newStatus === constants.OUT_DUTY_STATUS.PARTIALLY_APPROVED) {
            const rawRequest = outDutyRequest.get ? outDutyRequest.get({ plain: true }) : outDutyRequest;
            await sendApprovalNotifications({
                ...rawRequest,
                current_out_duty_level: newLevel
            }, outDutyRequest.employee, "CREATE", transaction);
        }

        if (newStatus === constants.OUT_DUTY_STATUS.APPROVED) {
            await generatePunchesAndRebuild(outDutyRequest, req.user.id, transaction);
        }
        // if (
        //     Number(newStatus) === constants.OUT_DUTY_STATUS.APPROVED ||
        //     Number(newStatus) === constants.OUT_DUTY_STATUS.REJECTED ||
        //     Number(newStatus) === constants.OUT_DUTY_STATUS.CANCELLED
        // ) {
        //     const start = dayjs(outDutyRequest.start_date);
        //     const end = dayjs(outDutyRequest.end_date);
        //     const diff = end.diff(start, 'day');
        //     const todayStr = dayjs().format('YYYY-MM-DD');
        //     for (let i = 0; i <= diff; i++) {
        //         const targetDate = start.add(i, 'day').format('YYYY-MM-DD');
        //         if (targetDate <= todayStr) {
        //             await rebuildAttendanceDay(outDutyRequest.employee_id, targetDate, { user_id: req.user?.id }, transaction);
        //         }
        //     }
        // }

        await transaction.commit();
        return res.success(constants.UPDATED);
    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Cancel Out Duty Request
exports.cancelLeave = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.params;
        const employeeId = req.user.employee_id;

        // 1. Fetch Request
        const outDutyRequest = await commonQuery.findOneRecord(OutDutyRequest, { id }, {}, transaction);
        if (!outDutyRequest || outDutyRequest.status === 2) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        // 2. Authorization Check (Only owner can cancel via this API)
        if (outDutyRequest.employee_id !== employeeId && !req.user.is_super_admin) {
            await transaction.rollback();
            return res.error("UNAUTHORIZED", { message: "You can only cancel your own out duty requests" });
        }

        // 3. Status Check
        if (
            Number(outDutyRequest.approval_status) === constants.OUT_DUTY_STATUS.CANCELLED ||
            Number(outDutyRequest.approval_status) === constants.OUT_DUTY_STATUS.REJECTED
        ) {
            await transaction.rollback();
            return res.error("INVALID_OPERATION", { message: `Request is already processed` });
        }

        // 4. Update Status to Cancelled
        await commonQuery.updateRecordById(OutDutyRequest, id, {
            approval_status: constants.OUT_DUTY_STATUS.CANCELLED
        }, transaction);

        const updatedRequest = await commonQuery.findOneRecord(OutDutyRequest, { id }, {}, transaction);
        const employee = await commonQuery.findOneRecord(Employee, employeeId, {}, transaction);
        await sendApprovalNotifications(updatedRequest, employee, "CANCEL", transaction);

        const start = dayjs(outDutyRequest.start_date);
        const end = dayjs(outDutyRequest.end_date);
        const diff = end.diff(start, 'day');
        const todayStr = dayjs().format('YYYY-MM-DD');
        for (let i = 0; i <= diff; i++) {
            const targetDate = start.add(i, 'day').format('YYYY-MM-DD');
            if (targetDate <= todayStr) {
                await rebuildAttendanceDay(outDutyRequest.employee_id, targetDate, { user_id: req.user?.id }, transaction);
            }
        }

        await transaction.commit();
        return res.success(constants.UPDATED);
    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};

/**
 * Get Out Duty Summary (History)
 * Grouped by Month for History
 */
exports.getOutDutySummary = async (req, res) => {
    try {
        let { employee_id } = req.body;
        if (!employee_id) {
            employee_id = req.user.employee_id;
        }

        if (!employee_id) {
            return res.error(constants.VALIDATION_ERROR, "Employee ID is required");
        }

        let isOwnRequest = employee_id == req.user.employee_id;

        // 1. Fetch Out Duty Requests for History (Ordered by date)
        const history = await commonQuery.findAllRecords(OutDutyRequest, {
            employee_id,
            status: 0
        }, {
            include: [
                // Include approver user so we can show name in history
                {
                    model: User,
                    as: "approvedBy",
                    attributes: ["id", "user_name"],
                    required: false
                }
            ],
            order: [["start_date", "DESC"]]
        }, null, isOwnRequest ? { applyHierarchy: false } : true);

        // 2. Group History by Month
        const groupedHistory = [];
        history.forEach(outDuty => {
            const monthYear = formatDateTime(outDuty.start_date, "MMM, YYYY");
            let group = groupedHistory.find(g => g.month_label === monthYear);

            if (!group) {
                group = {
                    month_label: monthYear,
                    total_days: 0,
                    out_duties: []
                };
                groupedHistory.push(group);
            }

            group.total_days += parseFloat(outDuty.total_days || 0);

            const start = dayjs(outDuty.start_date);
            const end = dayjs(outDuty.end_date);
            const dateRange = `${formatDateTime(outDuty.start_date, "D MMM, ddd")} - ${formatDateTime(outDuty.end_date, "D MMM, ddd")}`;

            const statusMap = {
                [constants.OUT_DUTY_STATUS.PENDING]: "PENDING",
                [constants.OUT_DUTY_STATUS.PARTIALLY_APPROVED]: "PARTIALLY APPROVED",
                [constants.OUT_DUTY_STATUS.APPROVED]: "APPROVED",
                [constants.OUT_DUTY_STATUS.REJECTED]: "REJECTED",
                [constants.OUT_DUTY_STATUS.CANCELLED]: "CANCELLED",
                [constants.OUT_DUTY_STATUS.DELETED]: "DELETED",
            };

            const colorMap = {
                [constants.OUT_DUTY_STATUS.APPROVED]: "#10B981",
                [constants.OUT_DUTY_STATUS.REJECTED]: "#EF4444",
                [constants.OUT_DUTY_STATUS.PENDING]: "#F59E0B",
                [constants.OUT_DUTY_STATUS.PARTIALLY_APPROVED]: "#3B82F6",
                [constants.OUT_DUTY_STATUS.CANCELLED]: "#6B7280",
                [constants.OUT_DUTY_STATUS.DELETED]: "#9CA3AF",
            };

            group.out_duties.push({
                id: outDuty.id,
                applied_date: outDuty.createdAt,
                date_range: dateRange,
                duration_display: `${parseFloat(outDuty.total_days).toFixed(1)} Days | Out Duty`,
                reason: outDuty.reason || "",
                status_id: outDuty.approval_status,
                status: statusMap[outDuty.approval_status],
                status_color: colorMap[outDuty.approval_status] || "#F59E0B",
                approved_by: outDuty.approvedBy?.user_name || null,
                approval_remark: outDuty.approval_remark || "",
                start_from_time: outDuty.start_from_time || null,
                start_to_time: outDuty.start_to_time || null,
                end_from_time: outDuty.end_from_time || null,
                end_to_time: outDuty.end_to_time || null
            });
        });

        // Calculate totals
        let totalUsed = 0;
        history.forEach(outDuty => {
            totalUsed += parseFloat(outDuty.total_days || 0);
        });

        return res.ok({
            out_duty_summary: {
                total_days_text: `${totalUsed.toFixed(1)} Days`,
                total_requests: history.length
            },
            out_duty_history: groupedHistory
        });

    } catch (err) {
        return handleError(err, res, req);
    }
};

// Delete Out Duty Requests
exports.delete = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const requiredFields = {
            ids: "Select Data"
        };

        const errors = await validateRequest(req.body, requiredFields, {}, transaction);
        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }
        let { ids } = req.body; // Accept array of ids

        // Validate that ids is an array and not empty
        if (!Array.isArray(ids) || ids.length === 0) {
            await transaction.rollback();
            return res.error(constants.INVALID_ID);
        }

        const deleted = await commonQuery.hardDeleteRecords(OutDutyRequest, ids, transaction);
        if (!deleted) {
            await transaction.rollback();
            return res.error(constants.ALREADY_DELETED);
        }
        await transaction.commit();
        return res.success(constants.DELETED);
    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};

const generatePunchesAndRebuild = async (outDutyRequest, userId, transaction) => {
    const { getOrCreateAttendanceDay, rebuildAttendanceDay } = require("../../helpers/attendanceHelper");
    const { AttendancePunch } = require("../../models");

    let currentDate = dayjs(outDutyRequest.start_date);
    const endDate = dayjs(outDutyRequest.end_date);

    while (currentDate.isBefore(endDate) || currentDate.isSame(endDate)) {
        const dateStr = currentDate.format("YYYY-MM-DD");
        let dayRecord = null;

        // For start date, if start_session is 3 (Time), generate IN/OUT punches
        if (dateStr === outDutyRequest.start_date && outDutyRequest.start_session === 3) {
            dayRecord = await getOrCreateAttendanceDay(outDutyRequest.employee_id, dateStr, {
                company_id: outDutyRequest.company_id,
                branch_id: outDutyRequest.branch_id,
                user_id: userId
            }, transaction);

            if (outDutyRequest.start_from_time) {
                const inTime = dayjs(`${dateStr} ${outDutyRequest.start_from_time}`).toDate();
                const punchExists = await commonQuery.findOneRecord(AttendancePunch, {
                    employee_id: outDutyRequest.employee_id,
                    day_id: dayRecord.id,
                    punch_type: "IN",
                    punch_time: inTime
                }, {}, transaction, false, {});

                if (!punchExists) {
                    await commonQuery.createRecord(AttendancePunch, {
                        employee_id: outDutyRequest.employee_id,
                        day_id: dayRecord.id,
                        punch_type: "IN",
                        punch_time: inTime,
                        user_id: userId,
                        company_id: outDutyRequest.company_id || 0,
                        branch_id: outDutyRequest.branch_id || 0
                    }, transaction);
                }
            }

            if (outDutyRequest.start_to_time) {
                const outTime = dayjs(`${dateStr} ${outDutyRequest.start_to_time}`).toDate();
                const punchExists = await commonQuery.findOneRecord(AttendancePunch, {
                    employee_id: outDutyRequest.employee_id,
                    day_id: dayRecord.id,
                    punch_type: "OUT",
                    punch_time: outTime
                }, {}, transaction, false, {});

                if (!punchExists) {
                    await commonQuery.createRecord(AttendancePunch, {
                        employee_id: outDutyRequest.employee_id,
                        day_id: dayRecord.id,
                        punch_type: "OUT",
                        punch_time: outTime,
                        user_id: userId,
                        company_id: outDutyRequest.company_id || 0,
                        branch_id: outDutyRequest.branch_id || 0
                    }, transaction);
                }
            }
        }

        // For end date, if end_session is 3 (Time), generate IN/OUT punches
        if (dateStr === outDutyRequest.end_date && outDutyRequest.end_session === 3) {
            if (!dayRecord) {
                dayRecord = await getOrCreateAttendanceDay(outDutyRequest.employee_id, dateStr, {
                    company_id: outDutyRequest.company_id,
                    branch_id: outDutyRequest.branch_id,
                    user_id: userId
                }, transaction);
            }

            if (outDutyRequest.end_from_time) {
                const inTime = dayjs(`${dateStr} ${outDutyRequest.end_from_time}`).toDate();
                const punchExists = await commonQuery.findOneRecord(AttendancePunch, {
                    employee_id: outDutyRequest.employee_id,
                    day_id: dayRecord.id,
                    punch_type: "IN",
                    punch_time: inTime
                }, {}, transaction, false, {});

                if (!punchExists) {
                    await commonQuery.createRecord(AttendancePunch, {
                        employee_id: outDutyRequest.employee_id,
                        day_id: dayRecord.id,
                        punch_type: "IN",
                        punch_time: inTime,
                        user_id: userId,
                        company_id: outDutyRequest.company_id || 0,
                        branch_id: outDutyRequest.branch_id || 0
                    }, transaction);
                }
            }

            if (outDutyRequest.end_to_time) {
                const outTime = dayjs(`${dateStr} ${outDutyRequest.end_to_time}`).toDate();
                const punchExists = await commonQuery.findOneRecord(AttendancePunch, {
                    employee_id: outDutyRequest.employee_id,
                    day_id: dayRecord.id,
                    punch_type: "OUT",
                    punch_time: outTime
                }, {}, transaction, false, {});

                if (!punchExists) {
                    await commonQuery.createRecord(AttendancePunch, {
                        employee_id: outDutyRequest.employee_id,
                        day_id: dayRecord.id,
                        punch_type: "OUT",
                        punch_time: outTime,
                        user_id: userId,
                        company_id: outDutyRequest.company_id || 0,
                        branch_id: outDutyRequest.branch_id || 0
                    }, transaction);
                }
            }
        }

        // Rebuild the day record to recalculate status based on the generated punches and/or out duty requests
        await rebuildAttendanceDay(outDutyRequest.employee_id, dateStr, {
            user_id: userId,
            company_id: outDutyRequest.company_id,
            branch_id: outDutyRequest.branch_id
        }, transaction);

        currentDate = currentDate.add(1, 'day');
    }
};