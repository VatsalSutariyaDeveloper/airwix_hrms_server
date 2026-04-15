const { Reimbursement, Employee, ExpenseType, sequelize, AttendanceTemplate, EmployeeAttendanceTemplate } = require("../../models");
const { validateRequest, commonQuery, handleError, uploadFile, fileExists, formatDateTime } = require("../../helpers");
const { constants } = require("../../helpers/constants");
const dayjs = require("dayjs");
const { Op } = require("sequelize");



// Create a Reimbursement Request
exports.create = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const POST = req.body;
        const requiredFields = {
            employee_id: "Employee ID",
            expense_type: "Expense Type",
            amount: "Amount",
            date: "Date",
        };

        if (!req.body.employee_id && req.user.employee_id) {
            req.body.employee_id = req.user.employee_id;
        }

        const errors = await validateRequest(req.body, requiredFields, {}, transaction);
        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        // Validate expense_type exists
        // const expenseType = await commonQuery.findOneRecord(ExpenseType, POST.expense_type, {}, transaction);
        // if (!expenseType) {
        //     await transaction.rollback();
        //     return res.error(constants.NOT_FOUND, { message: "Expense type not found" });
        // }

        // Handle File Upload
        if (req.files && Object.keys(req.files).length > 0) {
            const savedFiles = await uploadFile(req, res, constants.REIMBURSEMENT_DOC_FOLDER, transaction);
            if (savedFiles.bills_docs) {
                POST.bills_docs = savedFiles.bills_docs;
            }
        }

        await commonQuery.createRecord(Reimbursement, {
            ...POST,
            approval_status: constants.REIMBURSEMENT_APPROVAL_STATUS.PENDING,
            current_level: 1,
            approval_history: []
        }, transaction);

        await transaction.commit();
        return res.success(constants.CREATED);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Get All Requests (Paginated)
exports.getAll = async (req, res) => {
    try {
        const fieldConfig = [
            ["approval_status", true, true],
            ["employee.first_name", true, false],
            ["employee.employee_code", true, false],
        ];

        const data = await commonQuery.fetchPaginatedData(
            Reimbursement,
            req.body,
            fieldConfig,
            {
                include: [
                    {
                        model: Employee,
                        as: "employee",
                        attributes: ["first_name", "employee_code"],
                    },
                    { 
                        model: ExpenseType, 
                        as: "expenseType", 
                        attributes: ["name"] 
                    }
                ],
                order: [['created_at', 'DESC']]
            }
        );

        // Add document URL
        data.items = data?.items?.map(row => {
            const raw = row.get ? row.get({ plain: true }) : row;
            if (raw.bills_docs) {
                const exists = fileExists(constants.REIMBURSEMENT_DOC_FOLDER, raw.bills_docs);
                raw.bills_docs_url = exists ? `${process.env.FILE_SERVER_URL}${constants.REIMBURSEMENT_DOC_FOLDER}${raw.bills_docs}` : null;
            } else {
                raw.bills_docs_url = null;
            }
            return raw;
        });

        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// Get Single Request Details
exports.getById = async (req, res) => {
    try {
        const { id } = req.params;
        const reimbursement = await commonQuery.findOneRecord(Reimbursement, { id }, {
            include: [
                { model: Employee, as: "employee", attributes: ["first_name", "employee_code"] },
                { model: ExpenseType, as: "expenseType", attributes: ["name"] }
            ]
        });

        if (!reimbursement) return res.error(constants.NOT_FOUND);

        const raw = reimbursement.get({ plain: true });

        // Add document URL
        if (raw.bills_docs) {
            const exists = fileExists(constants.REIMBURSEMENT_DOC_FOLDER, raw.bills_docs);
            raw.bills_docs_url = exists ? `${process.env.FILE_SERVER_URL}${constants.REIMBURSEMENT_DOC_FOLDER}${raw.bills_docs}` : null;
        } else {
            raw.bills_docs_url = null;
        }

        return res.ok(raw);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// Update Reimbursement Request
exports.update = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const POST = req.body;
        const { id } = req.params;
        const reimbursement = await commonQuery.findOneRecord(Reimbursement, { id }, {}, transaction);
        if (!reimbursement || reimbursement.status === 2) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        if (reimbursement.approval_status !== constants.REIMBURSEMENT_APPROVAL_STATUS.PENDING && reimbursement.approval_status !== constants.REIMBURSEMENT_APPROVAL_STATUS.PARTIALLY_APPROVED) {
            await transaction.rollback();
            return res.error("INVALID_OPERATION", { message: "Only pending or partially approved requests can be updated" });
        }

        if (req.files && Object.keys(req.files).length > 0) {
            const savedFiles = await uploadFile(req, res, constants.REIMBURSEMENT_DOC_FOLDER, transaction);
            if (savedFiles.bills_docs) POST.bills_docs = savedFiles.bills_docs;
        }

        await commonQuery.updateRecordById(Reimbursement, id, POST, transaction);
        await transaction.commit();
        return res.success(constants.UPDATED);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Update Status (Approve/Reject)
exports.updateStatus = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.params;
        const { approval_status, approval_remark, approved_by } = req.body;

        // 1. Fetch Reimbursement Record
        const reimbursement = await commonQuery.findOneRecord(Reimbursement, { id }, {}, transaction);
        if (!reimbursement || reimbursement.status === 2) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        const oldStatus = reimbursement.approval_status;
        if (oldStatus !== constants.REIMBURSEMENT_APPROVAL_STATUS.PENDING && oldStatus !== constants.REIMBURSEMENT_APPROVAL_STATUS.PARTIALLY_APPROVED) {
            await transaction.rollback();
            return res.error("INVALID_OPERATION", { message: "Only pending or partially approved requests can be updated" });
        }

        // 2. Fetch Employee with Template for Level Config
        const employee = await commonQuery.findOneRecord(Employee, { id: reimbursement.employee_id }, {
            include: [
                { model: AttendanceTemplate, as: "attendanceTemplate" },
                { model: EmployeeAttendanceTemplate, as: "employeeAttendanceTemplate" }
            ]
        }, transaction);

        if (!employee) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND, { message: "Employee not found" });
        }

        // 3. Determine Total Levels
        // Check Employee-specific template first, then global template
        let totalLevels = 1;
        if (employee.employeeAttendanceTemplate) {
            totalLevels = employee.employeeAttendanceTemplate.reimbursement_approval_level || 1;
        } else if (employee.attendanceTemplate) {
            totalLevels = employee.attendanceTemplate.reimbursement_approval_level || 1;
        }

        const currentLevel = reimbursement.current_level;
        const history = reimbursement.approval_history || [];

        // 4. Handle Approval Logic
        if (String(approval_status) === String(constants.REIMBURSEMENT_APPROVAL_STATUS.APPROVED) || approval_status === "APPROVED") {
            history.push({
                level: currentLevel,
                approved_by: req.user?.id,
                approved_at: new Date(),
                action: "APPROVED",
                remark: approval_remark
            });

            const updateData = {
                approval_history: history,
                approval_remark: approval_remark || ""
            };

            // Partial vs Final Approval
            if (currentLevel < totalLevels && !req.user?.is_super_admin) {
                updateData.approval_status = constants.REIMBURSEMENT_APPROVAL_STATUS.PARTIALLY_APPROVED;
                updateData.current_level = currentLevel + 1;
            } else {
                updateData.approval_status = constants.REIMBURSEMENT_APPROVAL_STATUS.APPROVED;
                updateData.approved_by = approved_by || req.user?.id;

                if (req.user?.is_super_admin && currentLevel < totalLevels) {
                    if (history.length > 0) history[history.length - 1].note = "Bypassed remaining levels via Super Admin";
                    updateData.approval_history = history;
                    updateData.current_level = totalLevels;
                }
            }

            await commonQuery.updateRecordById(Reimbursement, reimbursement.id, updateData, transaction);
        }        // 6. Handle Rejection / Cancellation
        else if (
            String(approval_status) === String(constants.REIMBURSEMENT_APPROVAL_STATUS.REJECTED) ||
            String(approval_status) === String(constants.REIMBURSEMENT_APPROVAL_STATUS.CANCELLED) ||
            approval_status === "REJECTED" ||
            approval_status === "CANCELLED"
        ) {
            history.push({
                level: currentLevel,
                action: approval_status,
                by: req.user?.id,
                at: new Date(),
                remark: approval_remark
            });

            const targetStatus = (approval_status === "REJECTED" || Number(approval_status) === constants.REIMBURSEMENT_APPROVAL_STATUS.REJECTED) 
                ? constants.REIMBURSEMENT_APPROVAL_STATUS.REJECTED 
                : constants.REIMBURSEMENT_APPROVAL_STATUS.CANCELLED;

            await commonQuery.updateRecordById(Reimbursement, reimbursement.id, {
                approval_status: targetStatus,
                approval_remark: approval_remark || "",
                approval_history: history
            }, transaction);
        }

        await transaction.commit();
        return res.success("STATUS_UPDATED", { id: reimbursement.id, approval_status });
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};


// Cancel Reimbursement Request (by Employee)
exports.cancelReimbursement = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.params;
        const employeeId = req.user.employee_id;

        // 1. Fetch Request
        const reimbursement = await commonQuery.findOneRecord(Reimbursement, { id }, {}, transaction);
        if (!reimbursement || reimbursement.status === 2) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        // 2. Authorization Check (Only owner can cancel via this API)
        if (reimbursement.employee_id !== employeeId && !req.user.is_super_admin) {
            await transaction.rollback();
            return res.error("UNAUTHORIZED", { message: "You can only cancel your own reimbursement requests" });
        }

        // 3. Status Check
        const currentStatus = Number(reimbursement.approval_status);
        if (
            currentStatus === constants.REIMBURSEMENT_APPROVAL_STATUS.CANCELLED ||
            currentStatus === constants.REIMBURSEMENT_APPROVAL_STATUS.REJECTED
        ) {
            await transaction.rollback();
            return res.error("INVALID_OPERATION", { message: `Request is already processed` });
        }

        // 3.5. Prevent cancelling an already-past approved request
        if (
            currentStatus === constants.REIMBURSEMENT_APPROVAL_STATUS.APPROVED &&
            dayjs(reimbursement.date).isBefore(dayjs().startOf('day'))
        ) {
            await transaction.rollback();
            return res.error("INVALID_OPERATION", { message: "Cannot cancel an approved request for a past date" });
        }

        // 4. Update Status
        const history = reimbursement.approval_history || [];
        history.push({
            level: reimbursement.current_level,
            action: "CANCELLED",
            by: req.user?.id,
            at: new Date(),
            note: "Cancelled by user"
        });

        await commonQuery.updateRecordById(Reimbursement, id, {
            approval_status: constants.REIMBURSEMENT_APPROVAL_STATUS.CANCELLED,
            approval_history: history
        }, transaction);

        await transaction.commit();
        return res.success(constants.CANCELLED);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};



// Get Pending Approvals for Reimbursement
exports.getPendingApprovals = async (req, res) => {
    try {
        const requests = await commonQuery.findAllRecords(Reimbursement, {
            approval_status: { [Op.in]: [constants.REIMBURSEMENT_APPROVAL_STATUS.PENDING, constants.REIMBURSEMENT_APPROVAL_STATUS.PARTIALLY_APPROVED] },
            status: 0
        }, {
            include: [
                {
                    model: Employee,
                    as: "employee",
                    attributes: ["id", "first_name", "employee_code", "reporting_manager", "attendance_supervisor"],
                },
                { 
                    model: ExpenseType, 
                    as: "expenseType", 
                    attributes: ["name"] 
                }
            ],
            order: [['created_at', 'DESC']]
        });

        const pendingForUser = [];

        for (const request of requests) {
            const employee = request.employee;
            if (!employee) continue;

            let isAuthorized = false;
            if (req.user.is_super_admin) {
                isAuthorized = true;
            } else {
                // Simplified authorization logic for Reimbursement
                if (employee.reporting_manager === req.user.id ||
                    employee.attendance_supervisor === req.user.id ||
                    req.user.is_admin) {
                    isAuthorized = true;
                }
            }

            if (isAuthorized) {
                const raw = request.get({ plain: true });
                
                // Add Status Summary
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
                pendingForUser.push(raw);
            }
        }

        // Apply Search filter
        const search = req.body.search ? req.body.search.toLowerCase() : null;
        const filteredPending = search 
            ? pendingForUser.filter(item => {
                const searchString = `${item.employee?.first_name} ${item.employee?.employee_code} ${item.expenseType?.name} ${item.description} ${item.tracking_summary}`.toLowerCase();
                return searchString.includes(search);
            })
            : pendingForUser;

        return res.ok(filteredPending);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// Soft Delete

exports.delete = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) {
            await transaction.rollback();
            return res.error(constants.INVALID_ID);
        }

        const deleted = await commonQuery.softDeleteById(Reimbursement, ids, transaction);
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
