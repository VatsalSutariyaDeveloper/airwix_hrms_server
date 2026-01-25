const { LeaveRequest, LeaveBalance, LeaveTemplate, LeaveTemplateCategory, Employee, User, sequelize } = require("../../../models");
const { validateRequest, commonQuery, handleError } = require("../../../helpers");
const { constants } = require("../../../helpers/constants");
const { Op } = require("sequelize");

/**
 * Controller for managing Leave Requests and Balance Deductions.
 */

// 1. Create a Leave Request (and Reserve Balance)
exports.create = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const requiredFields = {
            employee_id: "Employee ID",
            leave_category_id: "Leave Category",
            start_date: "Start Date",
            end_date: "End Date",
            total_days: "Total Days",
        };

        const errors = await validateRequest(req.body, requiredFields, {}, transaction);
        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        const { employee_id, leave_category_id, total_days, company_id } = req.body;
        const currentYear = new Date(req.body.start_date).getFullYear();

        // Fetch category to check if it represents a paid leave
        const category = await commonQuery.findOneRecord(LeaveTemplateCategory, { id: leave_category_id }, {}, transaction);
        if (!category) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND, { message: "Leave category not found" });
        }

        // Check if balance exists
        let balance = await commonQuery.findOneRecord(LeaveBalance, {
            employee_id,
            leave_category_id,
            year: currentYear,
            status: 0
        }, {}, transaction);

        if (!balance) {
            await transaction.rollback();
            return res.error("BALANCE_NOT_FOUND", { message: "No leave balance found for this category/year" });
        }

        if (category.is_paid) {
            // -- PAID LEAVE LOGIC --
            if (parseFloat(balance.pending_leaves) < parseFloat(total_days)) {
                await transaction.rollback();
                return res.error("INSUFFICIENT_BALANCE", { message: `Insufficient balance. Available: ${balance.pending_leaves}` });
            }

            // Deduct from pending
            await commonQuery.updateRecordById(LeaveBalance, balance.id, {
                pending_leaves: parseFloat(balance.pending_leaves) - parseFloat(total_days),
                used_leaves: parseFloat(balance.used_leaves) + parseFloat(total_days)
            }, transaction);
        } else {
            // -- UNPAID LEAVE (LOP) LOGIC --
            // 1. If no balance record exists for LOP, create one with 0 allocation
            // if (!balance) {
            //     balance = await commonQuery.createRecord(LeaveBalance, {
            //         employee_id,
            //         leave_template_id: category.leave_template_id,
            //         leave_category_id,
            //         year: currentYear,
            //         allocated_leaves: 0,
            //         carry_forward_leaves: 0,
            //         pending_leaves: 0,
            //         used_leaves: 0,
            //         status: 0,
            //         company_id: company_id || req.user.company_id
            //     }, transaction);
            // }

            // 2. Simply increment used_leaves (pending stays 0 or unchanged)
            await commonQuery.updateRecordById(LeaveBalance, balance.id, {
                used_leaves: parseFloat(balance.used_leaves) + parseFloat(total_days)
            }, transaction);
        }

        // Create Leave Request
        const leaveRequest = await commonQuery.createRecord(LeaveRequest, {
            ...req.body,
            approval_status: "PENDING",
            current_level: 1,
            approval_history: []
        }, transaction);

        await transaction.commit();
        return res.success("LEAVE_REQUESTED", leaveRequest);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

// 2. Get All Requests (Paginated)
exports.getAll = async (req, res) => {
    try {
        const fieldConfig = [
            ["approval_status", true, true],
            ["employee_id", true, false],
        ];

        const data = await commonQuery.fetchPaginatedData(
            LeaveRequest,
            req.body,
            fieldConfig,
            {
                include: [
                    { 
                        model: Employee, 
                        as: "employee", 
                        attributes: ["first_name", "employee_code"],
                        include: [{ model: LeaveTemplate, as: "leaveTemplate", attributes: ["approval_levels"] }]
                    },
                    { model: LeaveTemplateCategory, as: "category", attributes: ["leave_category_name"] }
                ]
            }
        );

        // Add a "progression" summary for the UI
        data.rows = data?.rows?.map(row => {
            const raw = row.get({ plain: true });
            const total = raw.employee?.leaveTemplate?.approval_levels || 1;
            raw.tracking_summary = `${raw.approval_status} (Stage ${raw.current_level} of ${total})`;
            return raw;
        });

        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// 3. Get By ID
exports.getById = async (req, res) => {
    try {
        const record = await commonQuery.findOneRecord(LeaveRequest, { id: req.params.id }, {
            include: [
                { 
                    model: Employee, 
                    as: "employee",
                    include: [
                        { model: Employee, as: "manager", attributes: ["id", "first_name", "employee_code"] },
                        { model: Employee, as: "supervisor", attributes: ["id", "first_name", "employee_code"] },
                        { model: LeaveTemplate, as: "leaveTemplate" }
                    ],
                    attributes: ["id", "first_name", "employee_code", "reporting_manager", "attendance_supervisor"]
                },
                { model: LeaveTemplateCategory, as: "category", attributes: ["leave_category_name"] }
            ]
        });

        if (!record || record.status === 2) return res.error(constants.NOT_FOUND);

        const raw = record.get({ plain: true });
        const template = raw.employee?.leaveTemplate;
        const config = template?.approval_config || [];
        const history = raw.approval_history || [];

        // Fetch Usernames for History
        const approverIds = history.map(h => h.approved_by || h.by).filter(id => id);
        const approvers = await commonQuery.findAllRecords(User, { id: { [Op.in]: approverIds } }, {
            attributes: ["id", "user_name"]
        });

        // Construct Timeline
        const timeline = [];
        const totalLevels = template?.approval_levels || 1;

        for (let i = 1; i <= totalLevels; i++) {
            const levelConfig = config.find(c => c.level === i) || { level: i, type: "ADMIN" };
            const levelHistory = history.find(h => h.level === i);

            let stageStatus = "UPCOMING";
            let actionPersonnel = levelConfig.type; // Default to role name
            
            // Resolve specific personnel if possible
            if (levelConfig.type === 'REPORTING_MANAGER' && raw.employee?.manager) {
                actionPersonnel = raw.employee.manager.first_name;
            } else if (levelConfig.type === 'ATTENDANCE_SUPERVISOR' && raw.employee?.supervisor) {
                actionPersonnel = raw.employee.supervisor.first_name;
            }

            if (i < raw.current_level) {
                stageStatus = "COMPLETED";
                const user = approvers.find(u => u.id === (levelHistory?.approved_by || levelHistory?.by));
                if (user) actionPersonnel = user.user_name;
            } else if (i === raw.current_level) {
                if (raw.approval_status === "REJECTED" || raw.approval_status === "CANCELLED") {
                    stageStatus = levelHistory ? "REJECTED" : "CANCELLED";
                } else if (raw.approval_status === "APPROVED") {
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
        raw.next_action_at_level = totalLevels === raw.current_level && (raw.approval_status === "APPROVED" || raw.approval_status === "REJECTED" || raw.approval_status === "CANCELLED") ? null : raw.current_level;

        return res.ok(raw);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// 4. Update Approval Status (Finalize or Restore Balance)
exports.updateStatus = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.params;
        const { approval_status, approved_by } = req.body; // APPROVED, REJECTED, CANCELLED

        const leaveRequest = await commonQuery.findOneRecord(LeaveRequest, { id }, {}, transaction);
        if (!leaveRequest || leaveRequest.status === 2) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        const oldStatus = leaveRequest.approval_status;
        if (oldStatus !== "PENDING" && oldStatus !== "PARTIALLY_APPROVED") {
            await transaction.rollback();
            return res.error("INVALID_OPERATION", { message: "Only pending or partially approved requests can be updated" });
        }

        // Fetch Employee and Template to check approval configuration
        const employee = await commonQuery.findOneRecord(Employee, { id: leaveRequest.employee_id }, {
            include: [{ model: LeaveTemplate, as: "leaveTemplate" }]
        }, transaction);

        if (!employee || !employee.leaveTemplate) {
             await transaction.rollback();
             return res.error("TEMPLATE_NOT_FOUND", { message: "Employee has no leave template assigned" });
        }

        const template = employee.leaveTemplate;
        const currentLevel = leaveRequest.current_level;
        const totalLevels = template.approval_levels || 1;
        const config = template.approval_config || [];

        // --- AUTHORIZATION CHECK ---
        // Basic Authorization: Check if user has the right role/permission for this level
        // In a real system, we would check req.user.role vs config[currentLevel-1].type
        // For Level 1 "Anyone", we usually allow Supervisor, Manager, or Admin.
        
        // --- PROCESS APPROVAL ---
        if (approval_status === "APPROVED") {
            // Update History
            const history = leaveRequest.approval_history || [];
            history.push({
                level: currentLevel,
                approved_by: req.user?.id,
                approved_at: new Date(),
                action: "APPROVED"
            });

            const updateData = {
                approval_history: history
            };

            if (currentLevel < totalLevels && !req.user?.is_super_admin) {
                // Not final level and not super admin
                updateData.approval_status = "PARTIALLY_APPROVED";
                updateData.current_level = currentLevel + 1;
            } else {
                // Final level reached OR Super Admin Bypass
                updateData.approval_status = "APPROVED";
                updateData.approved_by = approved_by || req.user?.id;
                
                // Record bypass detail in history if it was a super admin
                if (req.user?.is_super_admin && currentLevel < totalLevels) {
                    if (history.length > 0) {
                        history[history.length - 1].note = "Bypassed remaining levels via Super Admin";
                    }
                    updateData.approval_history = history;
                    updateData.current_level = totalLevels;
                }
            }
            await commonQuery.updateRecordById(LeaveRequest, leaveRequest.id, updateData, transaction);
        } 
        else if (approval_status === "REJECTED" || approval_status === "CANCELLED") {
            // Restore Balance logic
            const balance = await commonQuery.findOneRecord(LeaveBalance, {
                employee_id: leaveRequest.employee_id,
                leave_category_id: leaveRequest.leave_category_id,
                year: new Date(leaveRequest.start_date).getFullYear()
            }, {}, transaction);

            if (balance) {
                // Fetch category to see if it's paid
                const category = await commonQuery.findOneRecord(LeaveTemplateCategory, { id: leaveRequest.leave_category_id }, { transaction });
                
                const balanceUpdate = {
                    used_leaves: parseFloat(balance.used_leaves) - parseFloat(leaveRequest.total_days)
                };

                if (category && category.is_paid) {
                    balanceUpdate.pending_leaves = parseFloat(balance.pending_leaves) + parseFloat(leaveRequest.total_days);
                }
                
                await commonQuery.updateRecordById(LeaveBalance, balance.id, balanceUpdate, transaction);
            }

            // Record rejection/cancellation in history
            const history = leaveRequest.approval_history || [];
            history.push({
                level: currentLevel,
                action: approval_status,
                by: req.user?.id,
                at: new Date()
            });

            await commonQuery.updateRecordById(LeaveRequest, leaveRequest.id, {
                approval_status: approval_status,
                approved_by: approved_by || req.user?.id,
                approval_history: history
            }, transaction);
        }

        await transaction.commit();
        return res.success("STATUS_UPDATED", { id: leaveRequest.id, approval_status });
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

// 5. Get Employee Balance
exports.getEmployeeBalance = async (req, res) => {
    try {
        const { employeeId } = req.params;
        const currentYear = new Date().getFullYear();

        const balances = await commonQuery.findAllRecords(LeaveBalance, {
            employee_id: employeeId,
            year: currentYear,
            status: 0
        }, {
            include: [
                { model: LeaveTemplateCategory, as: "category", attributes: ["leave_category_name"] }
            ]
        });

        return res.ok(balances);
    } catch (err) {
        return handleError(err, res, req);
    }
};

/**
 * 6. Get Pending Approvals for the Logged-in User (Level-wise)
 * Returns requests that the current user is authorized to approve at their level.
 */
exports.getPendingApprovals = async (req, res) => {
    try {
        const userId = req.user.id;
        const employeeId = req.user.employee_id; // The employee_id linked to the logged-in user

        // 1. Fetch all requests that are not finalized
        const requests = await commonQuery.findAllRecords(LeaveRequest, {
            approval_status: { [Op.in]: ["PENDING", "PARTIALLY_APPROVED"] },
            status: 0
        }, {
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
                }
            ],
        });

        // 2. Fetch templates for these requests to check approval config
        // (Optimization: In a high-traffic app, use a join or map-reduce)
        const pendingForUser = [];

        for (const request of requests) {
            const employee = request.employee;
            // The initial query already includes employee.leaveTemplate
            if (!employee || !employee.leaveTemplate) continue;

            const template = employee.leaveTemplate;
            const currentLevel = request.current_level;
            const config = template.approval_config || [];

            // Find config for the current stage
            const currentStage = config.find(c => c.level === currentLevel);
            if (!currentStage) continue;
            let isAuthorized = false;
            if(req.user.is_super_admin){
                isAuthorized = true;
            } else {
                // Check authorization based on stage type
                switch (currentStage.type) {
                case 'REPORTING_MANAGER':
                    if (employee.reporting_manager === employeeId && req.user.is_reporting_manager) isAuthorized = true;
                    break;
                case 'ATTENDANCE_SUPERVISOR':
                    if (employee.attendance_supervisor === employeeId && req.user.is_attendance_supervisor) isAuthorized = true;
                    break;
                case 'ADMIN':
                    if (req.user.is_admin) isAuthorized = true;
                    break;
                case 'EMPLOYER':
                    // For now, assume if they are hit this endpoint and aren't a manager, 
                    // we check if they have admin access (isApp access in your system)
                    // You might want to check req.user.role specifically here
                    isAuthorized = true; 
                    break;
                case 'ANYONE':
                    // Anyone of Reporting Manager, Supervisor, Admin, etc.
                    if (employee.reporting_manager === employeeId || 
                        employee.attendance_supervisor === employeeId) {
                        isAuthorized = true;
                    }
                    break;
                }
            }
            if (isAuthorized) {
                pendingForUser.push(request);
            }
        }

        return res.ok(pendingForUser);
    } catch (err) {
        return handleError(err, res, req);
    }
};
