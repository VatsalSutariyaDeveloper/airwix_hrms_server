const { LeaveRequest, EmployeeLeaveBalance, LeaveTemplate, LeaveTemplateCategory, Employee, User, sequelize } = require("../../../models");
const { validateRequest, commonQuery, handleError } = require("../../../helpers");
const { constants } = require("../../../helpers/constants");
const { Op } = require("sequelize");
const { rebuildAttendanceDay } = require("../../../helpers/attendanceHelper");
const dayjs = require("dayjs");

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

        const { employee_id, leave_category_id, total_days, start_date, end_date } = req.body;
        const currentYear = new Date(start_date).getFullYear();

        // 1. Fetch employee to get cycle information or custom template data
        const employee = await commonQuery.findOneRecord(Employee, employee_id, {}, transaction);
        if (!employee) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND, { message: "Employee not found" });
        }

        // Check for Overlapping Leaves
        const overlap = await commonQuery.findOneRecord(LeaveRequest, {
            employee_id,
            approval_status: { [Op.ne]: "REJECTED" },
            status: 0,
            [Op.or]: [
                {
                    start_date: { [Op.between]: [start_date, end_date] }
                },
                {
                    end_date: { [Op.between]: [start_date, end_date] }
                },
                {
                    [Op.and]: [
                        { start_date: { [Op.lte]: start_date } },
                        { end_date: { [Op.gte]: end_date } }
                    ]
                }
            ]
        }, {}, transaction);

        if (overlap) {
            await transaction.rollback();
            return res.error("OVERLAP", { message: `Selected dates overlap with an existing leave request (${overlap.start_date} to ${overlap.end_date})` });
        }

        // 2. Fetch specific employee balance record
        const balance = await commonQuery.findOneRecord(EmployeeLeaveBalance, {
            employee_id,
            leave_category_id,
            year: currentYear,
            status: 0
        }, {}, transaction);

        if (!balance) {
            await transaction.rollback();
            return res.error("BALANCE_NOT_FOUND", { message: "No leave balance found for this category/year" });
        }

        const isPaid = balance.is_paid;

        if (isPaid) {
            // -- PAID LEAVE LOGIC --
            if (parseFloat(balance.pending_leaves) < parseFloat(total_days)) {
                await transaction.rollback();
                return res.error("INSUFFICIENT_BALANCE", { message: `Insufficient balance. Available: ${balance.pending_leaves}` });
            }

            // Deduct from pending
            await commonQuery.updateRecordById(EmployeeLeaveBalance, balance.id, {
                pending_leaves: parseFloat(balance.pending_leaves) - parseFloat(total_days),
                used_leaves: parseFloat(balance.used_leaves) + parseFloat(total_days)
            }, transaction);
        } else {
            // -- UNPAID LEAVE (LOP) LOGIC --
            // Simply increment used_leaves (pending stays 0 or unchanged)
            await commonQuery.updateRecordById(EmployeeLeaveBalance, balance.id, {
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

// 3. Get Single Request Details
exports.getById = async (req, res) => {
    try {
        const { id } = req.params;
        const leaveRequest = await commonQuery.findOneRecord(LeaveRequest, { id }, {
            include: [
                { model: Employee, as: "employee", attributes: ["first_name", "employee_code", "leave_template"] },
                { model: LeaveTemplateCategory, as: "category" }
            ]
        });

        if (!leaveRequest) return res.error(constants.NOT_FOUND);

        const raw = leaveRequest.get({ plain: true });
        const template = await commonQuery.findOneRecord(LeaveTemplate, raw.employee.leave_template, {}, {});
        const totalLevels = template ? template.approval_levels : 1;
        const levelConfigs = template ? (template.levels || []) : [];
        const approvers = await commonQuery.findAllRecords(User, { status: 0 });

        const history = raw.approval_history || [];
        const timeline = [];

        for (let i = 1; i <= totalLevels; i++) {
            const levelConfig = levelConfigs.find(l => l.level === i) || {};
            const levelHistory = history.find(h => h.level === i);
            let stageStatus = "UPCOMING";
            let actionPersonnel = "-";

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

// 4. Update Status (Approve/Reject)
exports.updateStatus = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.params;
        const { approval_status, approved_by } = req.body;

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

        if (approval_status === "APPROVED") {
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
                updateData.approval_status = "PARTIALLY_APPROVED";
                updateData.current_level = currentLevel + 1;
            } else {
                updateData.approval_status = "APPROVED";
                updateData.approved_by = approved_by || req.user?.id;
                
                if (req.user?.is_super_admin && currentLevel < totalLevels) {
                    if (history.length > 0) history[history.length - 1].note = "Bypassed remaining levels via Super Admin";
                    updateData.approval_history = history;
                    updateData.current_level = totalLevels;
                }
            }
            await commonQuery.updateRecordById(LeaveRequest, leaveRequest.id, updateData, transaction);

            if (updateData.approval_status === "APPROVED") {
                const start = dayjs(leaveRequest.start_date);
                const end = dayjs(leaveRequest.end_date);
                const diff = end.diff(start, 'day');
                for (let i = 0; i <= diff; i++) {
                    const targetDate = start.add(i, 'day').format('YYYY-MM-DD');
                    await rebuildAttendanceDay(leaveRequest.employee_id, targetDate, { user_id: req.user?.id }, transaction);
                }
            }
        } 
        else if (approval_status === "REJECTED" || approval_status === "CANCELLED") {
            const balance = await commonQuery.findOneRecord(EmployeeLeaveBalance, {
                employee_id: leaveRequest.employee_id,
                leave_category_id: leaveRequest.leave_category_id,
                year: new Date(leaveRequest.start_date).getFullYear()
            }, {}, transaction);

            if (balance) {
                const balanceUpdate = {
                    used_leaves: parseFloat(balance.used_leaves) - parseFloat(leaveRequest.total_days)
                };
                if (balance.is_paid) {
                    balanceUpdate.pending_leaves = parseFloat(balance.pending_leaves) + parseFloat(leaveRequest.total_days);
                }
                await commonQuery.updateRecordById(EmployeeLeaveBalance, balance.id, balanceUpdate, transaction);
            }

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

// 6. Get Pending Approvals
exports.getPendingApprovals = async (req, res) => {
    try {
        const userId = req.user.id;
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
