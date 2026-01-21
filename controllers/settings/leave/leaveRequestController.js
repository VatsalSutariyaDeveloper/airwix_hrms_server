const { LeaveRequest, LeaveBalance, LeaveTemplateCategory, Employee, sequelize } = require("../../../models");
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

        const { employee_id, leave_category_id, total_days } = req.body;
        const currentYear = new Date(req.body.start_date).getFullYear();

        // Check if balance exists and is sufficient
        const balance = await LeaveBalance.findOne({
            where: {
                employee_id,
                leave_category_id,
                year: currentYear,
                status: 0
            },
            transaction
        });

        if (!balance) {
            await transaction.rollback();
            return res.error("BALANCE_NOT_FOUND", { message: "No leave balance found for this category/year" });
        }

        if (parseFloat(balance.pending_leaves) < parseFloat(total_days)) {
            await transaction.rollback();
            return res.error("INSUFFICIENT_BALANCE", { message: `Insufficient balance. Available: ${balance.pending_leaves}` });
        }

        // Create Leave Request
        const leaveRequest = await commonQuery.createRecord(LeaveRequest, {
            ...req.body,
            approval_status: "PENDING"
        }, transaction);

        // Reserve Balance (Deduct from pending)
        balance.pending_leaves = parseFloat(balance.pending_leaves) - parseFloat(total_days);
        balance.used_leaves = parseFloat(balance.used_leaves) + parseFloat(total_days);
        await balance.save({ transaction });

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
                    { model: Employee, as: "employee", attributes: ["first_name", "employee_code"] },
                    { model: LeaveTemplateCategory, as: "category", attributes: ["leave_category_name"] }
                ]
            }
        );

        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// 3. Get By ID
exports.getById = async (req, res) => {
    try {
        const record = await LeaveRequest.findByPk(req.params.id, {
            include: [
                { model: Employee, as: "employee" },
                { model: LeaveTemplateCategory, as: "category" }
            ]
        });
        if (!record || record.status === 2) return res.error(constants.NOT_FOUND);
        return res.ok(record);
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

        const leaveRequest = await LeaveRequest.findByPk(id, { transaction });
        if (!leaveRequest || leaveRequest.status === 2) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        const oldStatus = leaveRequest.approval_status;
        if (oldStatus !== "PENDING") {
            await transaction.rollback();
            return res.error("INVALID_OPERATION", { message: "Only pending requests can be updated" });
        }

        // If Rejected or Cancelled, restore balance
        if (approval_status === "REJECTED" || approval_status === "CANCELLED") {
            const balance = await LeaveBalance.findOne({
                where: {
                    employee_id: leaveRequest.employee_id,
                    leave_category_id: leaveRequest.leave_category_id,
                    year: new Date(leaveRequest.start_date).getFullYear()
                },
                transaction
            });

            if (balance) {
                balance.pending_leaves = parseFloat(balance.pending_leaves) + parseFloat(leaveRequest.total_days);
                balance.used_leaves = parseFloat(balance.used_leaves) - parseFloat(leaveRequest.total_days);
                await balance.save({ transaction });
            }
        }

        // Update Request Status
        leaveRequest.approval_status = approval_status;
        leaveRequest.approved_by = approved_by || req.user.id;
        await leaveRequest.save({ transaction });

        await transaction.commit();
        return res.success("STATUS_UPDATED", leaveRequest);
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

        const balances = await LeaveBalance.findAll({
            where: {
                employee_id: employeeId,
                year: currentYear,
                status: 0
            },
            include: [
                { model: LeaveTemplateCategory, as: "category", attributes: ["leave_category_name"] }
            ]
        });

        return res.ok(balances);
    } catch (err) {
        return handleError(err, res, req);
    }
};
