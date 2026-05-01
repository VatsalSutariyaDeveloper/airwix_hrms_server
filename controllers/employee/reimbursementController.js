const { Reimbursement, Employee, ExpenseType, sequelize, AttendanceTemplate, EmployeeAttendanceTemplate, CompanySettings, PaymentHistory } = require("../../models");
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
            // payment_type: "Payment Type"
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
        const { approval_status, remarks: approval_remark, approved_by, payment_type } = req.body;

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

        // 2. Fetch Employee for company_id
        const employee = await commonQuery.findOneRecord(Employee, { id: reimbursement.employee_id }, {}, transaction);

        if (!employee) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND, { message: "Employee not found" });
        }

        // 3. Determine Total Levels from CompanySettings
        let totalLevels = 1;
        const approvalLevelSetting = await commonQuery.findOneRecord(CompanySettings, {
            settings_name: "reimbursement_approval_level",
        }, {}, transaction);

        if (approvalLevelSetting && approvalLevelSetting.settings_value) {
            totalLevels = approvalLevelSetting.settings_value;
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
                approval_remark: approval_remark || "",
                payment_type: payment_type
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

                // Create PaymentHistory entry for instant payment (payment_type = 2)
                if (reimbursement.payment_type === 2) {
                    const reimbursementDate = dayjs(reimbursement.date);
                    await commonQuery.createRecord(PaymentHistory, {
                        employee_id: reimbursement.employee_id,
                        ref_id: reimbursement.id,
                        month: reimbursementDate.month() + 1,
                        year: reimbursementDate.year(),
                        payment_date: dayjs().format('YYYY-MM-DD'),
                        amount: reimbursement.amount,
                        payment_type: "Reimbursement",
                        payment_mode: "Bank",
                        status: 1, // Adjusted/Paid
                    }, transaction);
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

exports.getReimbursementSummary = async (req, res) => {
    try {
        let { employee_id } = req.body;
        if (!employee_id) {
            employee_id = req.user.employee_id;
        }

        if (!employee_id) {
            return res.error(constants.VALIDATION_ERROR, "Employee ID is required");
        }

        // 1. Fetch Reimbursement Requests for History (Ordered by date)
        const history = await commonQuery.findAllRecords(Reimbursement, {
            employee_id,
            status: 0
        }, {
            include: [
                {
                    model: Employee,
                    as: "employee",
                    attributes: ["id", "first_name", "employee_code"],
                    required: false
                },
                {
                    model: ExpenseType,
                    as: "expenseType",
                    attributes: ["name"],
                    required: false
                }
            ],
            order: [["date", "DESC"]]
        });

        // 2. Group History by Month
        const groupedHistory = [];
        history.forEach(reimbursement => {
            const monthYear = formatDateTime(reimbursement.date, "MMM, YYYY");
            let group = groupedHistory.find(g => g.month_label === monthYear);

            if (!group) {
                group = {
                    month_label: monthYear,
                    total_amount: 0,
                    reimbursements: []
                };
                groupedHistory.push(group);
            }

            group.total_amount += parseFloat(reimbursement.amount || 0);

            const statusMap = {
                [constants.REIMBURSEMENT_APPROVAL_STATUS.PENDING]: "PENDING",
                [constants.REIMBURSEMENT_APPROVAL_STATUS.PARTIALLY_APPROVED]: "PARTIALLY APPROVED",
                [constants.REIMBURSEMENT_APPROVAL_STATUS.APPROVED]: "APPROVED",
                [constants.REIMBURSEMENT_APPROVAL_STATUS.REJECTED]: "REJECTED",
                [constants.REIMBURSEMENT_APPROVAL_STATUS.CANCELLED]: "CANCELLED",
            };

            const colorMap = {
                [constants.REIMBURSEMENT_APPROVAL_STATUS.APPROVED]: "#10B981",
                [constants.REIMBURSEMENT_APPROVAL_STATUS.REJECTED]: "#EF4444",
                [constants.REIMBURSEMENT_APPROVAL_STATUS.PENDING]: "#F59E0B",
                [constants.REIMBURSEMENT_APPROVAL_STATUS.PARTIALLY_APPROVED]: "#3B82F6",
                [constants.REIMBURSEMENT_APPROVAL_STATUS.CANCELLED]: "#6B7280",
            };

            group.reimbursements.push({
                id: reimbursement.id,
                date: formatDateTime(reimbursement.date, "D MMM, ddd"),
                amount_display: `${parseFloat(reimbursement.amount).toFixed(2)}`,
                expense_type: reimbursement.expenseType?.name || "",
                description: reimbursement.description || "",
                status_id: reimbursement.approval_status,
                status: statusMap[reimbursement.approval_status],
                status_color: colorMap[reimbursement.approval_status] || "#F59E0B",
                approval_remark: reimbursement.approval_remark || ""
            });
        });

        // Calculate totals
        let totalAmount = 0;
        history.forEach(reimbursement => {
            totalAmount += parseFloat(reimbursement.amount || 0);
        });

        return res.ok({
            reimbursement_summary: {
                total_amount_text: `${totalAmount.toFixed(2)}`,
                total_requests: history.length
            },
            reimbursement_history: groupedHistory
        });

    } catch (err) {
        return handleError(err, res, req);
    }
};
