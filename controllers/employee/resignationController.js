const { 
    Employee, 
    User, 
    EmployeeResignation, 
    ResignationTemplate, 
    EmployeeLeaveBalance, 
    EmployeeAdvance,
    ResignationReason
} = require("../../models");

const { 
    validateRequest, 
    commonQuery, 
    handleError, 
    constants,
    sequelize,
    Op
} = require("../../helpers");
const dayjs = require("dayjs");

/**
 * Controller for Managing Employee Resignations & Exit Lifecycle
 */

// =========================================================================
// 1. RESIGNATION TEMPLATES (CRUD)
// =========================================================================

exports.createTemplate = async (req, res) => {
    try {
        const requiredFields = { 
            template_name: "Template Name",
            approval_levels: "Approval Levels"
        };
        const errors = await validateRequest(req.body, requiredFields);
        if (errors) return res.error(constants.VALIDATION_ERROR, errors);

        if (req.body.approval_levels > 0 && (!req.body.approval_config || !req.body.approval_config.length)) {
            return res.error(constants.VALIDATION_ERROR, { message: "Approval configuration is required for multi-level approval." });
        }

        const record = await commonQuery.createRecord(ResignationTemplate, req.body);
        return res.success(constants.CREATED, record);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getAllTemplates = async (req, res) => {
    try {
        const data = await commonQuery.findAllRecords(ResignationTemplate, { status: 0 });
        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getTemplateById = async (req, res) => {
    try {
        const record = await commonQuery.findOneRecord(ResignationTemplate, req.params.id);
        if (!record) return res.error(constants.NOT_FOUND);
        return res.ok(record);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.updateTemplate = async (req, res) => {
    try {
        if (req.body.approval_levels > 0 && (!req.body.approval_config || !req.body.approval_config.length)) {
            return res.error(constants.VALIDATION_ERROR, { message: "Approval configuration is required for multi-level approval." });
        }
        const record = await commonQuery.updateRecordById(ResignationTemplate, req.params.id, req.body);
        return res.success(constants.UPDATED, record);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.deleteTemplate = async (req, res) => {
    try {
        await commonQuery.softDeleteById(ResignationTemplate, req.params.id);
        return res.success(constants.DELETED);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// =========================================================================
// 2. EMPLOYEE RESIGNATIONS
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
            include: [{ model: ResignationTemplate, as: 'resignationTemplate' }]
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
                attributes: ['id', 'first_name', 'employee_code', 'reporting_manager', 'attendance_supervisor', 'resignation_template_id']
            }]
        }, transaction);

        if (!resignation) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        // 1. Authorization Check
        const templateId = resignation.employee.resignation_template_id;
        const template = await commonQuery.findOneRecord(ResignationTemplate, templateId, {}, transaction);
        
        const config = template ? (template.approval_config || []) : [];
        const totalLevels = template ? template.approval_levels : 1;
        const currentLevel = resignation.current_level;

        let currentStage = config.find(c => c.level === currentLevel);
        if (!currentStage) currentStage = { type: "ANYONE" };

        let isAuthorized = false;
        if (req.user.is_super_admin) {
            isAuthorized = true;
        } else {
            switch (currentStage.type) {
                case 'REPORTING_MANAGER':
                    if (resignation.employee.reporting_manager === req.user.employee_id) isAuthorized = true;
                    break;
                case 'ATTENDANCE_SUPERVISOR':
                    if (resignation.employee.attendance_supervisor === req.user.employee_id) isAuthorized = true;
                    break;
                case 'ADMIN':
                    if (req.user.is_admin || req.user.role_id === constants.BUSINESS_ADMIN_ROLE_ID || req.user.role_id === constants.ADMIN_ROLE_ID) isAuthorized = true;
                    break;
                case 'ANYONE':
                    if (resignation.employee.reporting_manager === req.user.employee_id ||
                        resignation.employee.attendance_supervisor === req.user.employee_id ||
                        req.user.is_admin) {
                        isAuthorized = true;
                    }
                    break;
            }
        }

        if (!isAuthorized) {
            await transaction.rollback();
            return res.error(constants.PERMISSION_DENIED, { message: "You are not authorized to approve this request at the current level." });
        }

        // 2. Process Action
        if (approval_status === constants.RESIGNATION_APPROVAL_STATUS.APPROVED) {
            const history = resignation.approval_history || [];
            history.push({
                level: currentLevel,
                action: "APPROVED",
                by: req.user.id,
                user_name: req.user.user_name,
                at: new Date(),
                remarks
            });

            const updateData = { approval_history: history };

            if (currentLevel < totalLevels) {
                // Move to next level
                updateData.approval_status = constants.RESIGNATION_APPROVAL_STATUS.PARTIALLY_APPROVED;
                updateData.current_level = currentLevel + 1;
            } else {
                // Final Approval
                updateData.approval_status = constants.RESIGNATION_APPROVAL_STATUS.APPROVED;
                updateData.approved_lwd = approved_lwd || resignation.preferred_lwd;
                
                // Update Employee Final Details
                await commonQuery.updateRecordById(Employee, resignation.employee_id, {
                    exit_date: updateData.approved_lwd,
                    status: 1, // Set Inactive
                    resignation_status: 2 // Exited
                }, transaction);
            }

            await commonQuery.updateRecordById(EmployeeResignation, id, updateData, transaction);
        } else if (approval_status === constants.RESIGNATION_APPROVAL_STATUS.REJECTED) {
            const history = resignation.approval_history || [];
            history.push({
                level: currentLevel,
                action: "REJECTED",
                by: req.user.id,
                user_name: req.user.user_name,
                at: new Date(),
                remarks
            });

            await commonQuery.updateRecordById(EmployeeResignation, id, {
                approval_status: constants.RESIGNATION_APPROVAL_STATUS.REJECTED,
                approval_history: history
            }, transaction);

            // Revert Employee Status
            await commonQuery.updateRecordById(Employee, resignation.employee_id, {
                is_on_notice: false,
                resignation_status: 0
            }, transaction);
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
        const requests = await commonQuery.findAllRecords(EmployeeResignation, {
            approval_status: { [Op.in]: [constants.RESIGNATION_APPROVAL_STATUS.PENDING, constants.RESIGNATION_APPROVAL_STATUS.PARTIALLY_APPROVED] },
            status: 0
        }, {
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

        for (const request of requests) {
            const employee = request.employee;
            if (!employee) continue;

            const template = employee.resignationTemplate;
            const currentLevel = request.current_level;
            const config = template ? (template.approval_config || []) : [];

            let currentStage = config.find(c => c.level === currentLevel);
            if (!currentStage) currentStage = { type: "ANYONE" };
            
            let isAuthorized = false;
            if (req.user.is_super_admin) {
                isAuthorized = true;
            } else {
                switch (currentStage.type) {
                    case 'REPORTING_MANAGER':
                        if (employee.reporting_manager === req.user.employee_id) isAuthorized = true;
                        break;
                    case 'ATTENDANCE_SUPERVISOR':
                        if (employee.attendance_supervisor === req.user.employee_id) isAuthorized = true;
                        break;
                    case 'ADMIN':
                        if (req.user.is_admin || req.user.role_id === constants.BUSINESS_ADMIN_ROLE_ID || req.user.role_id === constants.ADMIN_ROLE_ID) isAuthorized = true;
                        break;
                    case 'ANYONE':
                        if (employee.reporting_manager === req.user.employee_id ||
                            employee.attendance_supervisor === req.user.employee_id ||
                            req.user.is_admin) {
                            isAuthorized = true;
                        }
                        break;
                }
            }

            if (isAuthorized) {
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
        const fieldConfig = [
            ["employee.first_name", true, true],
            ["employee.employee_code", true, true],
            ["approval_status", true, false],
        ];

        const data = await commonQuery.fetchPaginatedData(
            EmployeeResignation,
            req.body,
            fieldConfig,
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

exports.getResignationById = async (req, res) => {
    try {
        const record = await commonQuery.findOneRecord(EmployeeResignation, req.params.id, {
            include: [
                { 
                    model: Employee, 
                    as: 'employee',
                    include: [{ model: ResignationTemplate, as: 'resignationTemplate' }]
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
            order: [['createdAt', 'DESC']]
        });
        return res.ok(record);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getTemplateDropdown = async (req, res) => {
    try {
        const companyId = req.user.company_id;
        const data = await commonQuery.findAllRecords(ResignationTemplate, { 
            status: 0,
            company_id: companyId 
        }, {
            attributes: ['id', 'template_name']
        });
        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getReasonDropdown = async (req, res) => {
    try {
        const companyId = req.user.company_id;
        const data = await commonQuery.findAllRecords(ResignationReason, { 
            status: 0,
            company_id: companyId 
        }, {
            attributes: ['id', 'reason_name']
        });
        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};
