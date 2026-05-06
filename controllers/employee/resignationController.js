const {
    Employee,
    User,
    EmployeeResignation,
    ResignationTemplate,
    EmployeeLeaveBalance,
    EmployeeAdvance,
    ResignationReason,
    BranchMaster,
    DesignationMaster,
    Department,
    RolePermission
} = require("../../models");

const {
    validateRequest,
    commonQuery,
    handleError,
    constants,
    sequelize,
    Op,
    formatDateTime
} = require("../../helpers");
const dayjs = require("dayjs");
const emailService = require("../../services/emailService");
const notificationService = require("../../services/notificationService");

/**
 * Controller for Managing Employee Resignations & Exit Lifecycle
 */


// =========================================================================
// 1. EMPLOYEE RESIGNATIONS
// =========================================================================

/**
 * Submit Resignation (Employee Portal)
 */
exports.submitResignation = async (req, res) => {    
    const transaction = await sequelize.transaction();
    try {
        const employeeId = req.user.employee_id || req.body.employee_id;
        if (!employeeId) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, { message: "Employee ID is required" });
        }

        // 1. Check if already resigned
        const existing = await commonQuery.findOneRecord(EmployeeResignation, {
            employee_id: employeeId,
            approval_status: { [Op.in]: [0, 1, 3] }, // Pending, Partially Approved, or Approved
            status: 0
        }, {}, transaction);

        if (existing) {
            await transaction.rollback();
            return res.error("ALREADY_RESIGNED", { message: "An active resignation request already exists for this employee." });
        }

        const employee = await commonQuery.findOneRecord(Employee, employeeId, {
            include: [
                { model: ResignationTemplate, as: 'resignationTemplate' },
                { model: User, as: 'manager', attributes: ['email'] },
                { model: User, as: 'supervisor', attributes: ['email'] }
            ]
        }, transaction);    
        
        if (!employee) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        // 1b. Check if Resignation Policy is assigned
        if (!employee.resignation_template_id) {
            await transaction.rollback();
            return res.error("POLICY_NOT_ASSIGNED", { message: "No resignation policy assigned. Please contact HR." });
        }

        const template = employee.resignationTemplate;

        // 2. Calculate notice period (Employee's manual days takes precedence over Policy days)
        const resignationDate = req.body.resignation_date || dayjs().format('YYYY-MM-DD');
        const noticeDays = (employee.notice_period_days > 0) ? employee.notice_period_days : (template ? template.notice_period_days : 0);

        const defaultLWD = dayjs(resignationDate).add(noticeDays, 'day').format('YYYY-MM-DD');

        const POST = {
            ...req.body,
            employee_id: employeeId,
            submitted_by: req.user.id,
            resignation_date: resignationDate,
            preferred_lwd: req.body.preferred_lwd || defaultLWD,
            approval_status: constants.RESIGNATION_APPROVAL_STATUS.PENDING,
            current_level: 1,
            approval_history: []
        };

        const result = await commonQuery.createRecord(EmployeeResignation, POST, transaction);

        // 3. Mark Employee as On Notice
        await commonQuery.updateRecordById(Employee, employeeId, {
            is_on_notice: true,
            resignation_status: 1
        }, transaction);

        // 4. Send Email Notification
        try {
            // Fetch reason name if resignation_reason_id is provided
            let reasonName = req.body.reason_description; // Fallback to manual reason text
            if (req.body.resignation_reason_id) {
                const reasonRecord = await commonQuery.findOneRecord(ResignationReason, req.body.resignation_reason_id, { attributes: ['reason_name'] }, transaction);
                if (reasonRecord) reasonName = reasonRecord.reason_name;
            }

            // Get Admin and Super Admin emails
            const admins = await User.findAll({
                where: {
                    company_id: employee.company_id,
                    status: 0,
                    [Op.or]: [
                        { is_super_admin: true },
                        { '$RolePermission.role_key$': constants.ROLE_KEYS.ADMIN },
                        { '$RolePermission.role_key$': constants.ROLE_KEYS.BUSINESS_ADMIN }
                    ]
                },
                include: [{ model: RolePermission, as: 'RolePermission', attributes: [] }],
                attributes: ['email'],
                transaction
            });

            const recipients = [];
            if (employee.supervisor?.email) recipients.push(employee.supervisor.email);
            if (employee.manager?.email) recipients.push(employee.manager.email);

            admins.forEach(admin => {
                if (admin.email) recipients.push(admin.email);
            });

            // Remove duplicates and employee's own email
            const uniqueRecipients = [...new Set(recipients)].filter(email => email && email !== employee.email);

            if (uniqueRecipients.length > 0 || employee.email) {
                await emailService.sendResignationNotification({
                    companyId: employee.company_id,
                    employeeName: employee.first_name,
                    employeeEmail: employee.email,
                    resignationDate: resignationDate,
                    preferredLWD: POST.preferred_lwd,
                    reason: reasonName,
                    recipients: uniqueRecipients
                });
            }
        } catch (emailErr) {
            console.error("Resignation email failed:", emailErr);
            // We continue even if email fails to avoid blocking the submission
        }

        await transaction.commit();
        return res.success("RESIGNATION_SUBMITTED", result);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

/**
 * Handle Approval/Rejection Action (Multi-level)
 */
exports.handleAction = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.params;
        const { approval_status, remarks, approved_lwd } = req.body;

        const resignation = await commonQuery.findOneRecord(EmployeeResignation, id, {
            include: [{
                model: Employee,
                as: 'employee',
                attributes: ['id', 'first_name', 'employee_code', 'reporting_manager', 'attendance_supervisor', 'resignation_template_id', 'email', 'company_id'],
                include: [{ model: ResignationTemplate, as: 'resignationTemplate' }]
            }]
        }, transaction);

        if (!resignation) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        // 1. Authorization Check
        const currentLevel = resignation.current_level;
        const employee = resignation.employee;
        const template = employee?.resignationTemplate;
        const config = template?.approval_config || [];
        const totalLevels = template?.approval_levels || 1;
        const currentStage = config.find(c => c.level === currentLevel) || { type: "ANYONE" };

        if (!isUserAuthorizedForResignation(req.user, resignation.employee, currentStage)) {
            await transaction.rollback();
            return res.error(constants.PERMISSION_DENIED, { message: "You are not authorized to approve this request at the current level." });
        }

        // 2. Process Action
        const history = resignation.approval_history || [];
        const actionType = approval_status === constants.RESIGNATION_APPROVAL_STATUS.APPROVED ? "APPROVED" : "REJECTED";

        history.push({
            level: currentLevel,
            action: actionType,
            by: req.user.id,
            user_name: req.user.user_name,
            at: new Date(),
            remarks
        });

        if (approval_status === constants.RESIGNATION_APPROVAL_STATUS.APPROVED) {
            const updateData = { approval_history: history };
            const isSuperAdmin = req.user.role_key === constants.ROLE_KEYS.BUSINESS_ADMIN && req.user.is_super_admin;

            if (isSuperAdmin || currentLevel >= totalLevels) {
                // Final Approval (Super Admin override or last level reached)
                updateData.approval_status = constants.RESIGNATION_APPROVAL_STATUS.APPROVED;
                updateData.current_level = totalLevels;
                updateData.approved_lwd = approved_lwd || resignation.preferred_lwd;

                // Update employee status
                await commonQuery.updateRecordById(Employee, resignation.employee_id, {
                    exit_date: updateData.approved_lwd,
                    status: constants.STATUS_EMPLOYEE_EXIT,
                    resignation_status: 2
                }, transaction);
            } else {
                // Move to next level
                updateData.approval_status = constants.RESIGNATION_APPROVAL_STATUS.PARTIALLY_APPROVED;
                updateData.current_level = currentLevel + 1;
            }

            await commonQuery.updateRecordById(EmployeeResignation, id, updateData, transaction);

            // Notification logic
            try {
                const nextLevel = updateData.current_level;
                const nextStage = config.find(c => c.level === nextLevel) || { type: "ANYONE" };

                // Get recipients for current and next stage stakeholders
                const currentRecipients = await getResignationStakeholderEmails(resignation.employee, currentStage, transaction);
                const nextRecipients = nextLevel <= totalLevels ? await getResignationStakeholderEmails(resignation.employee, nextStage, transaction) : [];

                const uniqueRecipients = [...new Set([...currentRecipients, ...nextRecipients])].filter(email => email && email !== resignation.employee.email);

                await emailService.sendResignationActionNotification({
                    companyId: resignation.employee.company_id,
                    employeeName: resignation.employee.first_name,
                    employeeEmail: resignation.employee.email,
                    resignationDate: resignation.resignation_date,
                    action: "APPROVED",
                    actionBy: req.user.user_name,
                    remarks: remarks,
                    level: currentLevel,
                    totalLevels: totalLevels,
                    nextLevelApprovers: nextLevel <= totalLevels ? nextStage : null,
                    approvedLWD: updateData.approved_lwd,
                    recipients: uniqueRecipients
                });
            } catch (emailErr) {
                console.error("Resignation approval email failed:", emailErr);
            }

            // Employee Notification
            const user = await commonQuery.findOneRecord(User, { employee_id: resignation.employee_id }, {}, transaction);
            if (user) {
                await notificationService.createNotification({
                    user_id: user.id,
                    title: updateData.approval_status === constants.RESIGNATION_APPROVAL_STATUS.APPROVED ? "Resignation Approved" : "Resignation Partially Approved",
                    message: updateData.approval_status === constants.RESIGNATION_APPROVAL_STATUS.APPROVED
                        ? `Your resignation has been approved. Your Last Working Day is ${formatDateTime(updateData.approved_lwd)}.`
                        : `Your resignation request has been moved to the next approval level (Stage ${updateData.current_level}).`,
                    type: "RESIGNATION",
                    reference_id: id,
                    status_code: 0,
                    company_id: req.user.company_id,
                    branch_id: req.user.branch_id
                }, transaction);
            }
        } else if (approval_status === constants.RESIGNATION_APPROVAL_STATUS.REJECTED) {
            await commonQuery.updateRecordById(EmployeeResignation, id, {
                approval_status: constants.RESIGNATION_APPROVAL_STATUS.REJECTED,
                approval_history: history
            }, transaction);

            // Notification logic
            try {
                const recipients = await getResignationStakeholderEmails(resignation.employee, { type: "ANYONE" }, transaction);

                await emailService.sendResignationActionNotification({
                    companyId: resignation.employee.company_id,
                    employeeName: resignation.employee.first_name,
                    employeeEmail: resignation.employee.email,
                    resignationDate: resignation.resignation_date,
                    action: "REJECTED",
                    actionBy: req.user.user_name,
                    remarks: remarks,
                    level: currentLevel,
                    totalLevels: totalLevels,
                    nextLevelApprovers: null,
                    approvedLWD: null,
                    recipients: recipients
                });
            } catch (emailErr) {
                console.error("Resignation rejection email failed:", emailErr);
            }

            // Revert Employee Status
            await commonQuery.updateRecordById(Employee, resignation.employee_id, {
                is_on_notice: false,
                resignation_status: 0
            }, transaction);

            // Employee Notification
            const user = await commonQuery.findOneRecord(User, { employee_id: resignation.employee_id }, {}, transaction);
            if (user) {
                await notificationService.createNotification({
                    user_id: user.id,
                    title: "Resignation Rejected",
                    message: `Your resignation request has been rejected. Remarks: ${remarks || "No remarks provided."}`,
                    type: "RESIGNATION",
                    reference_id: id,
                    status_code: 2,
                    company_id: req.user.company_id,
                    branch_id: req.user.branch_id
                }, transaction);
            }
        }

        await transaction.commit();
        return res.success("ACTION_COMPLETED");
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

/**
 * Get Pending Approvals for Resignation
 */
exports.getPendingApprovals = async (req, res) => {
    try {
        const fieldConfig = [
            ["employee_id", true, true],
            ["employee.first_name", true, true],
            ["employee.employee_code", true, true],
            ["approval_status", true, true],
            ["current_level", true, true],
            ["approval_history", true, false],
            ["approved_lwd", true, true],
            ["created_at", false, true],
        ];

        const result = await commonQuery.fetchPaginatedData(EmployeeResignation, req.body, fieldConfig, {
            include: [
                {
                    model: Employee,
                    as: "employee",
                    attributes: ["id", "first_name", "employee_code", "reporting_manager", "attendance_supervisor", "resignation_template_id"],
                    include: [{ model: ResignationTemplate, as: "resignationTemplate" }]
                },
                {
                    model: User,
                    as: "submitted_by",
                    attributes: ["user_name"]
                }
            ],
            order: [['createdAt', 'DESC']]
        });

        const pendingForUser = [];

        for (const request of result.items) {
            const employee = request.employee;
            if (!employee) continue;

            const template = employee.resignationTemplate;
            const currentLevel = request.current_level;
            const config = template?.approval_config || [];
            const currentStage = config.find(c => c.level === currentLevel) || { type: "ANYONE" };

            if (isUserAuthorizedForResignation(req.user, employee, currentStage)) {
                const raw = request.get({ plain: true });
                const total = template ? template.approval_levels : 1;
                raw.tracking_summary = `Stage ${raw.current_level} of ${total}`;
                pendingForUser.push(raw);
            }
        }

        return res.ok(pendingForUser);
    } catch (err) {
        return handleError(err, res, req);
    }
};

/**
 * Calculate Pro-Rated F&F Preview
 */
exports.calculateFF = async (req, res) => {
    try {
        const { id } = req.params;
        const resignation = await commonQuery.findOneRecord(EmployeeResignation, id, {
            include: [{ model: Employee, as: 'employee' }]
        });

        if (!resignation) return res.error(constants.NOT_FOUND);

        const employee = resignation.employee;
        const lwd = resignation.approved_lwd || resignation.preferred_lwd;

        // 1. Leave Encashment Preview
        const leaveBalances = await commonQuery.findAllRecords(EmployeeLeaveBalance, {
            employee_id: employee.id,
            status: 0
        });

        const encashment = leaveBalances.map(lb => ({
            category: lb.leave_category_name,
            pending: lb.pending_leaves,
            is_paid: lb.is_paid
        })).filter(lb => lb.is_paid && lb.pending > 0);

        // 2. Recovery - Pending Advances
        const advances = await commonQuery.findAllRecords(EmployeeAdvance, {
            employee_id: employee.id,
            status: { [Op.in]: [1, 2] } // Approved or Partially Settle
        });

        const pendingAdvance = advances.reduce((sum, adv) => sum + (parseFloat(adv.remaining_amount) || 0), 0);

        // 3. Notice Pay Recovery / Waiver Logic
        const noticeDaysRequired = employee.notice_period_days || 0;
        const noticeDaysServed = dayjs(lwd).diff(dayjs(resignation.resignation_date), 'day');
        const gap = Math.max(0, noticeDaysRequired - noticeDaysServed);

        return res.ok({
            lwd,
            resignation_date: resignation.resignation_date,
            notice_metrics: {
                required: noticeDaysRequired,
                served: noticeDaysServed,
                gap: gap
            },
            earnings_preview: {
                leave_encashment: encashment,
                pro_rata_salary: "Estimated based on LWD"
            },
            recoveries_preview: {
                pending_advance: pendingAdvance,
                notice_pay_recovery: gap > 0 ? `Recovery for ${gap} days` : 0
            }
        });
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getAllResignations = async (req, res) => {
    try {
        const data = await commonQuery.findAllRecords(
            EmployeeResignation,
            {
                employee_id: req.body.employee_id ? req.body.employee_id : req.user.employee_id
            },
            {
                include: [
                    { model: Employee, as: 'employee', attributes: ['first_name', 'employee_code', 'joining_date'] },
                    { model: ResignationReason, as: 'reason_type' },
                    { model: User, as: 'submitted_by', attributes: ['user_name'] }
                ],
                order: [['createdAt', 'DESC']]
            }
        );
        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getResignationHistory = async (req, res) => {
    try {

        const fieldConfig = [
            ["approval_status", true, true],
            ["employee.first_name", true, false],
            ["employee.employee_code", true, false],
        ];

        // Add date filtering based on payload
        let whereClause = {};
        const leaveFilter = req.body?.leave_filter;

        if (leaveFilter) {
            const today = dayjs().toDate();

            switch (leaveFilter) {
                case 'previous':
                    // Previous: ended before today
                    whereClause.resignation_date = { [Op.lt]: today };
                    break;
                case 'upcoming':
                    // Upcoming: ends today or later
                    whereClause.resignation_date = { [Op.gte]: today };
                    break;
            }
        }

        const data = await commonQuery.fetchPaginatedData(
            EmployeeResignation,
            req.body,
            fieldConfig,
            {
                include: [
                    { model: Employee, as: 'employee', attributes: ['first_name', 'employee_code'] },
                    { model: ResignationReason, as: 'reason_type' },
                    { model: User, as: 'submitted_by', attributes: ['user_name'] }
                ],
                order: [['createdAt', 'DESC']]
            },
            true, // requireTenantFields
            'created_at', // dateField
            whereClause // customWhere
        );

        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// =========================================================================
// HELPER FUNCTIONS
// =========================================================================

/**
 * Check if a user is authorized to approve/reject at a given stage
 */
const isUserAuthorizedForResignation = (user, employee, stage) => {
    const isSuperAdmin = user.role_key === constants.ROLE_KEYS.BUSINESS_ADMIN && user.is_super_admin;
    if (isSuperAdmin) return true;

    const { type } = stage || { type: "ANYONE" };
    const employeeId = user.employee_id;
    const isAdmin = user.role_key === constants.ROLE_KEYS.ADMIN;

    switch (type) {
        case 'REPORTING_MANAGER':
            return employee.reporting_manager === employeeId;
        case 'ATTENDANCE_SUPERVISOR':
            return employee.attendance_supervisor === employeeId;
        case 'ADMIN':
            return isAdmin;
        case 'ANYONE':
            return employee.reporting_manager === employeeId || employee.attendance_supervisor === employeeId || isAdmin;
        default:
            return false;
    }
};

/**
 * Get stakeholder emails based on the stage configuration
 */
const getResignationStakeholderEmails = async (employee, stage, transaction) => {
    const emails = [];
    const { type } = stage || { type: "ANYONE" };

    if (type === 'REPORTING_MANAGER' || type === 'ANYONE') {
        if (employee.reporting_manager) {
            const manager = await commonQuery.findOneRecord(User, { id: employee.reporting_manager }, { attributes: ['email'] }, transaction);
            if (manager?.email) emails.push(manager.email);
        }
    }

    if (type === 'ATTENDANCE_SUPERVISOR' || type === 'ANYONE') {
        if (employee.attendance_supervisor) {
            const supervisor = await commonQuery.findOneRecord(User, { id: employee.attendance_supervisor }, { attributes: ['email'] }, transaction);
            if (supervisor?.email) emails.push(supervisor.email);
        }
    }

    if (type === 'ADMIN' || type === 'ANYONE') {
        const adminFilters = {
            [Op.or]: [
                { '$RolePermission.role_key$': constants.ROLE_KEYS.BUSINESS_ADMIN, is_super_admin: true },
                { '$RolePermission.role_key$': constants.ROLE_KEYS.ADMIN }
            ]
        };
        const admins = await commonQuery.findAllRecords(User, adminFilters, {
            include: [{ model: RolePermission, as: 'RolePermission', attributes: [] }],
            attributes: ['email'],
            raw: true
        }, transaction);

        admins.map(a => a.email).filter(Boolean).forEach(e => emails.push(e));
    }

    return [...new Set(emails)];
};

exports.getResignationById = async (req, res) => {
    try {
        const record = await commonQuery.findOneRecord(EmployeeResignation, req.params.id, {
            include: [
                {
                    model: Employee,
                    as: 'employee',
                    include: [
                        { model: ResignationTemplate, as: 'resignationTemplate' },
                        { model: Department, as: 'department', attributes: ['name'] },
                        { model: DesignationMaster, as: 'designation', attributes: ['designation_name'] },
                        { model: BranchMaster, as: 'branch', attributes: ['branch_name'] },
                    ]
                },
                { model: ResignationReason, as: 'reason_type' },
                { model: User, as: 'submitted_by', attributes: ['user_name'] }
            ]
        });
        return res.ok(record);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getMyResignation = async (req, res) => {
    try {
        const employeeId = req.user.employee_id;
        if (!employeeId) return res.error(constants.UNAUTHORIZED);

        const record = await commonQuery.findOneRecord(EmployeeResignation, {
            employee_id: employeeId,
            status: 0
        }, {
            include: [
                { model: ResignationReason, as: 'reason_type' }
            ],
            order: [['createdAt', 'DESC']]
        });
        return res.ok(record);
    } catch (err) {
        return handleError(err, res, req);
    }
};

/**
 * Delete Resignation Request(s)
 */
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
        let { ids } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) {
            await transaction.rollback();
            return res.error(constants.INVALID_ID);
        }
        const deleted = await commonQuery.softDeleteById(EmployeeResignation, { id: { [Op.in]: ids } }, transaction);
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

