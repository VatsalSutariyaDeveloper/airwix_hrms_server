const { Reimbursement, ReimbursementItem, Employee, ExpenseType, sequelize, AttendanceTemplate, EmployeeAttendanceTemplate, CompanySettings, PaymentHistory, User, CompanyMaster } = require("../../models");
const { validateRequest, commonQuery, handleError, uploadFile, fileExists, formatDateTime, deleteFile } = require("../../helpers");
const { constants } = require("../../helpers/constants");
const dayjs = require("dayjs");
const { Op } = require("sequelize");
const { resolvePendingApprovers, getNextApprovalState, isUserAuthorizedForStage } = require("../../helpers/approvalHelper");
const path = require("path");
const fs = require("fs");
const pdfService = require("../../helpers/functions/pdfService");



// Helper to parse comma-separated bills_docs and generate array of verified URLs
const getBillsDocsUrls = (bills_docs) => {
    if (!bills_docs) return [];
    return bills_docs.split(',').map(f => {
        return fileExists(constants.REIMBURSEMENT_DOC_FOLDER, f)
            ? `${process.env.FILE_SERVER_URL}${constants.REIMBURSEMENT_DOC_FOLDER}${f}`
            : null;
    }).filter(Boolean);
};

const getReimbursementApprovalMeta = async (companyId, currentLevel, user, transaction = null) => {
    const setting = await commonQuery.findOneRecord(CompanySettings, {
        company_id: companyId,
        settings_name: "reimbursement_approval_config"
    }, {}, transaction, false, false);

    let config = setting?.settings_value || [];
    if (typeof config === "string") {
        try { config = JSON.parse(config); } catch (e) { config = []; }
    }

    const totalLevels = Array.isArray(config) && config.length > 0 ? config.length : 1;
    const isFinalApprovalStage = Number(currentLevel || 1) >= totalLevels;
    const requiresPaymentTypeOnApproval = Boolean(user?.is_super_admin) || isFinalApprovalStage;

    return { totalLevels, isFinalApprovalStage, requiresPaymentTypeOnApproval, config };
};

// Create a Reimbursement Request
exports.create = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const POST = req.body;
        let items = POST.items;
        if (items && !Array.isArray(items)) {
            items = [items];
        }

        if (!POST.employee_id && req.user.employee_id) {
            POST.employee_id = req.user.employee_id;
        }

        if (!items || !Array.isArray(items) || items.length === 0) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, { items: "At least one expense item is required" });
        }

        let totalAmount = 0;
        let itemErrors = {};

        // Prepare items and calculate total
        for (let i = 0; i < items.length; i++) {
            let item = items[i];
            if (typeof item === 'string') {
                try { item = JSON.parse(item); items[i] = item; } catch (e) { }
            }

            if (!item.expense_type) itemErrors[`items[${i}].expense_type`] = "Expense Type is required";
            if (!item.amount || parseFloat(item.amount) <= 0) itemErrors[`items[${i}].amount`] = "Amount must be greater than zero";

            if (Object.keys(itemErrors).length === 0) {
                totalAmount += parseFloat(item.amount);
            }
        }

        if (Object.keys(itemErrors).length > 0) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, itemErrors);
        }

        // Upload all files first to get the saved filenames
        let savedFiles = {};
        if (req.files && Object.keys(req.files).length > 0) {
            const filesArray = Array.isArray(req.files) ? req.files : Object.values(req.files).flat();
            for (const file of filesArray) {
                const tempReq = { file };
                const saved = await uploadFile(tempReq, res, constants.REIMBURSEMENT_DOC_FOLDER, transaction);
                const filename = saved[file.fieldname];
                if (filename) {
                    if (savedFiles[file.fieldname]) {
                        savedFiles[file.fieldname] += ',' + filename;
                    } else {
                        savedFiles[file.fieldname] = filename;
                    }
                }
            }
        }

        // Create Parent
        const reimbursement = await commonQuery.createRecord(Reimbursement, {
            employee_id: POST.employee_id,
            total_amount: totalAmount,
            date: new Date(), // Set claim date as today
            expense_date: POST.expense_date || null, // Explicitly save parent expense_date
            description: POST.description || "",
            approval_status: constants.REIMBURSEMENT_APPROVAL_STATUS.PENDING,
            current_level: 1,
            approval_history: []
        }, transaction);

        // Map files and insert items
        for (let i = 0; i < items.length; i++) {
            const item = items[i];

            const fileKey = `items[${i}][bills_docs]`;
            const fallbackFileKey = `items[${i}].bills_docs`;
            let uploadedFile = savedFiles[fileKey] || savedFiles[fallbackFileKey] || savedFiles[`bills_docs_${i}`] || savedFiles[`bills_docs[${i}]`];

            if (!uploadedFile) {
                await transaction.rollback();
                return res.error(constants.VALIDATION_ERROR, { [`items[${i}].receipt`]: "Receipt is required for this expense item" });
            }

            await commonQuery.createRecord(ReimbursementItem, {
                reimbursement_id: reimbursement.id,
                expense_type: item.expense_type,
                amount: parseFloat(item.amount),
                expense_date: POST.expense_date || null,
                description: item.description || "",
                bills_docs: uploadedFile,
                user_id: req.user?.id
            }, transaction);
        }

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

        let isOwnRequest = req.body.employee_id && (req.body.employee_id == req.user.employee_id);

        const data = await commonQuery.fetchPaginatedData(
            Reimbursement,
            req.body,
            fieldConfig,
            {
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
                    },
                    {
                        model: ReimbursementItem,
                        as: "items",
                        include: [
                            { model: ExpenseType, as: "expenseType", attributes: ["name"] }
                        ]
                    },
                    {
                        model: User,
                        as: "approvedBy",
                        attributes: ["id", "user_name"]
                    }
                ],
                order: [['created_at', 'DESC']]
            },
            isOwnRequest ? { applyHierarchy: false } : true // requireTenantFields
        );

        // Add document URL
        data.items = await Promise.all((data?.items || []).map(async row => {
            const raw = row.get ? row.get({ plain: true }) : row;
            raw.bills_docs_url = getBillsDocsUrls(raw.bills_docs);

            if (raw.items && Array.isArray(raw.items)) {
                raw.items = raw.items.map(child => {
                    child.bills_docs_url = getBillsDocsUrls(child.bills_docs);
                    return child;
                });
            }

            // Resolve pending approver details
            if (raw.approval_status === constants.REIMBURSEMENT_APPROVAL_STATUS.PENDING || raw.approval_status === constants.REIMBURSEMENT_APPROVAL_STATUS.PARTIALLY_APPROVED) {
                const pendingDetails = await resolvePendingApprovers(raw, "REIMBURSEMENT");
                raw.pending_with = pendingDetails.pending_with;
            } else {
                raw.pending_with = [];
            }

            const approvalMeta = await getReimbursementApprovalMeta(raw.company_id, raw.current_level, req.user);
            raw.total_approval_levels = approvalMeta.totalLevels;
            raw.is_final_approval_stage = approvalMeta.isFinalApprovalStage;
            raw.requires_payment_type_on_approval = approvalMeta.requiresPaymentTypeOnApproval;

            if (raw.payment_type === 2) {
                const paymentHistory = await commonQuery.findOneRecord(PaymentHistory, {
                    ref_id: raw.id,
                    payment_type: "Reimbursement"
                });
                raw.payment_mode = paymentHistory ? paymentHistory.payment_mode : null;
            }

            return raw;
        }));

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
                { model: Employee, as: "employee", attributes: ["first_name", "employee_code", "reporting_manager", "attendance_supervisor", "company_id"] },
                { model: ExpenseType, as: "expenseType", attributes: ["name"] },
                {
                    model: ReimbursementItem,
                    as: "items",
                    include: [{ model: ExpenseType, as: "expenseType", attributes: ["name"] }]
                },
                { model: User, as: "approvedBy", attributes: ["id", "user_name"] }
            ]
        });

        if (!reimbursement) return res.error(constants.NOT_FOUND);

        const raw = reimbursement.get({ plain: true });

        // Add document URL
        raw.bills_docs_url = getBillsDocsUrls(raw.bills_docs);

        if (raw.items && Array.isArray(raw.items)) {
            raw.items = raw.items.map(child => {
                child.bills_docs_url = getBillsDocsUrls(child.bills_docs);
                return child;
            });
        }

        // Applied date (date request was submitted) — same as summary endpoint
        raw.applied_date = raw.createdAt;

        // Actual expense date — stored directly on the parent record
        raw.expense_date = raw.expense_date || null;

        // Resolve pending approver details
        if (raw.approval_status === constants.REIMBURSEMENT_APPROVAL_STATUS.PENDING || raw.approval_status === constants.REIMBURSEMENT_APPROVAL_STATUS.PARTIALLY_APPROVED) {
            const pendingDetails = await resolvePendingApprovers(raw, "REIMBURSEMENT");
            raw.pending_with = pendingDetails.pending_with;
        } else {
            raw.pending_with = [];
        }

        const approvalMeta = await getReimbursementApprovalMeta(raw.company_id, raw.current_level, req.user);
        raw.total_approval_levels = approvalMeta.totalLevels;
        raw.is_final_approval_stage = approvalMeta.isFinalApprovalStage;
        raw.requires_payment_type_on_approval = approvalMeta.requiresPaymentTypeOnApproval;

        if (raw.payment_type === 2) {
            const paymentHistory = await commonQuery.findOneRecord(PaymentHistory, {
                ref_id: raw.id,
                payment_type: "Reimbursement"
            });
            raw.payment_mode = paymentHistory ? paymentHistory.payment_mode : null;
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
        let items = POST.items;
        if (items && !Array.isArray(items)) {
            items = [items];
        }

        const reimbursement = await commonQuery.findOneRecord(Reimbursement, { id }, {}, transaction);
        if (!reimbursement || reimbursement.status === 2) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        if (reimbursement.approval_status !== constants.REIMBURSEMENT_APPROVAL_STATUS.PENDING && reimbursement.approval_status !== constants.REIMBURSEMENT_APPROVAL_STATUS.PARTIALLY_APPROVED) {
            await transaction.rollback();
            return res.error("INVALID_OPERATION", { message: "Only pending or partially approved requests can be updated" });
        }

        if (!items || !Array.isArray(items) || items.length === 0) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, { items: "At least one expense item must remain" });
        }

        let itemErrors = {};
        const incomingIds = new Set();
        for (let i = 0; i < items.length; i++) {
            let item = items[i];
            if (typeof item === 'string') {
                try { item = JSON.parse(item); items[i] = item; } catch (e) { }
            }
            if (!item.expense_type) itemErrors[`items[${i}].expense_type`] = "Expense Type is required";
            if (!item.amount || parseFloat(item.amount) <= 0) itemErrors[`items[${i}].amount`] = "Amount must be greater than zero";


            if (item.id) incomingIds.add(Number(item.id));
        }

        if (Object.keys(itemErrors).length > 0) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, itemErrors);
        }

        // Fetch existing items
        const existingItems = await commonQuery.findAllRecords(ReimbursementItem, { reimbursement_id: id }, {}, transaction);
        const existingItemsMap = new Map();
        existingItems.forEach(i => existingItemsMap.set(i.id, i));

        const toDeleteIds = [];
        for (const existing of existingItems) {
            if (!incomingIds.has(existing.id)) {
                toDeleteIds.push(existing.id);

                // Also delete physical files for the removed item
                if (existing.bills_docs) {
                    const oldFiles = existing.bills_docs.split(',').filter(Boolean);
                    for (const oldFile of oldFiles) {
                        await deleteFile(req, res, constants.REIMBURSEMENT_DOC_FOLDER, oldFile);
                    }
                }
            }
        }

        if (toDeleteIds.length > 0) {
            await commonQuery.softDeleteById(ReimbursementItem, toDeleteIds, transaction);
        }

        let savedFiles = {};
        if (req.files && Object.keys(req.files).length > 0) {
            const filesArray = Array.isArray(req.files) ? req.files : Object.values(req.files).flat();
            for (const file of filesArray) {
                const tempReq = { file };
                const saved = await uploadFile(tempReq, res, constants.REIMBURSEMENT_DOC_FOLDER, transaction);
                const filename = saved[file.fieldname];
                if (filename) {
                    if (savedFiles[file.fieldname]) {
                        savedFiles[file.fieldname] += ',' + filename;
                    } else {
                        savedFiles[file.fieldname] = filename;
                    }
                }
            }
        }

        let totalAmount = 0;

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const fileKey = `items[${i}][bills_docs]`;
            const fallbackFileKey = `items[${i}].bills_docs`;
            let uploadedFile = savedFiles[fileKey] || savedFiles[fallbackFileKey] || savedFiles[`bills_docs_${i}`] || savedFiles[`bills_docs[${i}]`];

            if (item.id) {
                const itemId = Number(item.id);
                const existing = existingItemsMap.get(itemId);

                if (!existing) {
                    await transaction.rollback();
                    return res.error("INVALID_OPERATION", { message: `Item ID ${itemId} does not exist in this reimbursement` });
                }

                let keptFiles = [];
                if (item.existing_bills !== undefined) {
                    const existingArr = Array.isArray(item.existing_bills) ? item.existing_bills : [item.existing_bills];
                    keptFiles = existingArr.map(url => url.split('/').pop()).filter(Boolean);
                } else if (existing.bills_docs) {
                    // Fallback if existing_bills wasn't sent
                    keptFiles = existing.bills_docs.split(',');
                }

                // Delete physical files that were removed from the array
                if (existing.bills_docs) {
                    const oldFiles = existing.bills_docs.split(',').filter(Boolean);
                    for (const oldFile of oldFiles) {
                        if (!keptFiles.includes(oldFile)) {
                            await deleteFile(req, res, constants.REIMBURSEMENT_DOC_FOLDER, oldFile);
                        }
                    }
                }

                if (uploadedFile) {
                    keptFiles.push(...uploadedFile.split(','));
                }

                const finalReceipt = keptFiles.length > 0 ? keptFiles.join(',') : null;

                await commonQuery.updateRecordById(ReimbursementItem, itemId, {
                    expense_type: item.expense_type,
                    amount: parseFloat(item.amount),
                    expense_date: item.expense_date,
                    description: item.description || "",
                    bills_docs: finalReceipt
                }, transaction);

                totalAmount += parseFloat(item.amount);
            } else {
                if (!uploadedFile) {
                    await transaction.rollback();
                    return res.error(constants.VALIDATION_ERROR, { [`items[${i}].receipt`]: "Receipt is required for new expense item" });
                }

                await commonQuery.createRecord(ReimbursementItem, {
                    reimbursement_id: id,
                    expense_type: item.expense_type,
                    amount: parseFloat(item.amount),
                    expense_date: item.expense_date,
                    description: item.description || "",
                    bills_docs: uploadedFile,
                    user_id: req.user?.id
                }, transaction);

                totalAmount += parseFloat(item.amount);
            }
        }

        const parentUpdate = {};
        if (POST.description !== undefined) parentUpdate.description = POST.description;
        if (POST.payment_type !== undefined) parentUpdate.payment_type = POST.payment_type;
        parentUpdate.total_amount = totalAmount;
        if (POST.expense_date !== undefined) parentUpdate.expense_date = POST.expense_date;

        await commonQuery.updateRecordById(Reimbursement, id, parentUpdate, transaction);

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
        const { approval_status, remarks: approval_remark, approved_by, payment_type, payment_mode } = req.body;

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

        const currentLevel = reimbursement.current_level;
        const approvalMeta = await getReimbursementApprovalMeta(employee.company_id, currentLevel, req.user, transaction);
        const totalLevels = approvalMeta.totalLevels;
        const history = reimbursement.approval_history || [];

        const isApproved = String(approval_status) === String(constants.REIMBURSEMENT_APPROVAL_STATUS.APPROVED) || approval_status === "APPROVED";
        const historyItem = isApproved ? {
            level: currentLevel,
            approved_by: req.user?.id,
            approved_at: new Date(),
            action: "APPROVED",
            remark: approval_remark
        } : {
            level: currentLevel,
            action: approval_status,
            by: req.user?.id,
            at: new Date(),
            remark: approval_remark
        };

        const { newStatus, newLevel, updatedHistory } = getNextApprovalState({
            targetStatus: approval_status,
            currentLevel,
            totalLevels,
            isSuperAdmin: req.user?.is_super_admin,
            approvalHistory: reimbursement.approval_history || [],
            statusMapping: {
                APPROVED: constants.REIMBURSEMENT_APPROVAL_STATUS.APPROVED,
                PARTIALLY_APPROVED: constants.REIMBURSEMENT_APPROVAL_STATUS.PARTIALLY_APPROVED,
                REJECTED: constants.REIMBURSEMENT_APPROVAL_STATUS.REJECTED,
                CANCELLED: constants.REIMBURSEMENT_APPROVAL_STATUS.CANCELLED
            },
            historyItem
        });

        // 4. Handle Approval Logic
        if (isApproved) {
            const updateData = {
                approval_history: updatedHistory,
                approval_remark: approval_remark || "",
                approval_status: newStatus,
                current_level: newLevel
            };

            if (approvalMeta.requiresPaymentTypeOnApproval && payment_type !== undefined) {
                updateData.payment_type = payment_type;
            }

            if (newStatus === constants.REIMBURSEMENT_APPROVAL_STATUS.APPROVED) {
                updateData.approved_by = approved_by || req.user?.id;

                const finalPaymentType = payment_type !== undefined ? Number(payment_type) : reimbursement.payment_type;
                if (![1, 2].includes(Number(finalPaymentType))) {
                    await transaction.rollback();
                    return res.error(constants.VALIDATION_ERROR, { payment_type: "Payment method is required for final approval" });
                }
                // Create PaymentHistory entry for instant payment (payment_type = 2)
                if (finalPaymentType === 2) {
                    const finalPaymentMode = payment_mode || "Bank";
                    if (!["Cash", "Bank"].includes(finalPaymentMode)) {
                        await transaction.rollback();
                        return res.error(constants.VALIDATION_ERROR, { payment_mode: "Invalid payment mode" });
                    }

                    const reimbursementDate = dayjs(reimbursement.date);
                    await commonQuery.createRecord(PaymentHistory, {
                        employee_id: reimbursement.employee_id,
                        ref_id: reimbursement.id,
                        month: reimbursementDate.month() + 1,
                        year: reimbursementDate.year(),
                        payment_date: dayjs().format('YYYY-MM-DD'),
                        amount: reimbursement.total_amount,
                        payment_type: "Reimbursement",
                        payment_mode: finalPaymentMode,
                        status: 1, // Adjusted/Paid
                        company_id: reimbursement.company_id || req.user?.company_id,
                        branch_id: reimbursement.branch_id || req.user?.branch_id || 0,
                        user_id: req.user?.id || reimbursement.user_id || 0
                    }, transaction);
                }
            }

            await commonQuery.updateRecordById(Reimbursement, reimbursement.id, updateData, transaction);
        }        // 6. Handle Rejection / Cancellation
        else {
            await commonQuery.updateRecordById(Reimbursement, reimbursement.id, {
                approval_status: newStatus,
                approval_remark: approval_remark || "",
                approval_history: updatedHistory
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
                },
                {
                    model: ReimbursementItem,
                    as: "items",
                    include: [{ model: ExpenseType, as: "expenseType", attributes: ["name"] }]
                }
            ],
            order: [['created_at', 'DESC']]
        });

        const pendingForUser = [];

        for (const request of requests) {
            const employee = request.employee;
            if (!employee) continue;

            const currentLevel = request.current_level || 1;
            const approvalMeta = await getReimbursementApprovalMeta(request.company_id, currentLevel, req.user);
            const config = approvalMeta.config || [];

            const currentStage = config.find(c => Number(c.level) === Number(currentLevel)) || {
                type: currentLevel > 1 ? "ADMIN" : "ANYONE",
                label: `Level ${currentLevel}`
            };

            let stageType = (currentStage.type || "ANYONE").toString().toUpperCase();
            if (stageType === "3") stageType = "REPORTING_MANAGER";
            if (stageType === "4") stageType = "ATTENDANCE_SUPERVISOR";

            const isOwnRequest = (request.employee_id === req.user.employee_id);
            const isAuthorized = isUserAuthorizedForStage({
                user: req.user,
                employee,
                stageType: stageType,
                isOwnRequest
            });

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

                raw.bills_docs_url = getBillsDocsUrls(raw.bills_docs);

                if (raw.items && Array.isArray(raw.items)) {
                    raw.items = raw.items.map(child => {
                        child.bills_docs_url = getBillsDocsUrls(child.bills_docs);
                        return child;
                    });
                }

                // Resolve pending approver details
                const pendingDetails = await resolvePendingApprovers(raw, "REIMBURSEMENT");
                raw.pending_with = pendingDetails.pending_with;

                const approvalMeta = await getReimbursementApprovalMeta(raw.company_id, raw.current_level, req.user);
                raw.total_approval_levels = approvalMeta.totalLevels;
                raw.is_final_approval_stage = approvalMeta.isFinalApprovalStage;
                raw.requires_payment_type_on_approval = approvalMeta.requiresPaymentTypeOnApproval;

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

        // Soft delete associated PaymentHistory entries for these reimbursements
        await commonQuery.softDeleteById(PaymentHistory, { ref_id: ids, payment_type: "Reimbursement" }, transaction);

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

        let isOwnRequest = employee_id == req.user.employee_id;

        // 1. Fetch Reimbursement Requests for History (Ordered by date)
        const history = await commonQuery.findAllRecords(Reimbursement, {
            employee_id,
            status: 0
        }, {
            include: [
                {
                    model: Employee,
                    as: "employee",
                    attributes: ["id", "first_name", "employee_code", "reporting_manager", "attendance_supervisor"],
                    required: false
                },
                {
                    model: ExpenseType,
                    as: "expenseType",
                    attributes: ["name"],
                    required: false
                },
                {
                    model: ReimbursementItem,
                    as: "items",
                    include: [{ model: ExpenseType, as: "expenseType", attributes: ["name"], required: false }],
                    required: false
                }
            ],
            order: [["date", "DESC"]]
        }, null, isOwnRequest ? { applyHierarchy: false } : true);

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

            group.total_amount += parseFloat(reimbursement.total_amount || 0);

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

            let mappedItems = [];
            if (reimbursement.items && Array.isArray(reimbursement.items)) {
                mappedItems = reimbursement.items.map(child => {
                    const childRaw = child.get ? child.get({ plain: true }) : child;
                    childRaw.bills_docs_url = getBillsDocsUrls(childRaw.bills_docs);
                    return childRaw;
                });
            }

            const expenseDate = mappedItems.length ? mappedItems[0].expense_date : null;

            group.reimbursements.push({
                id: reimbursement.id,

                // Date when reimbursement request was submitted
                applied_date: reimbursement.createdAt,

                // Actual expense date
                expense_date: expenseDate,

                amount_display: `${parseFloat(reimbursement.total_amount).toFixed(2)}`,
                expense_type: reimbursement.expenseType?.name || "",
                description: reimbursement.description || "",
                status_id: reimbursement.approval_status,
                status: statusMap[reimbursement.approval_status],
                status_color: colorMap[reimbursement.approval_status] || "#F59E0B",
                approval_remark: reimbursement.approval_remark || "",
                items: mappedItems
            });
        });

        // Calculate totals
        let totalAmount = 0;
        history.forEach(reimbursement => {
            totalAmount += parseFloat(reimbursement.total_amount || 0);
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

// Generate Reimbursement Slip PDF
exports.generateSlipPdf = async (req, res) => {
    try {
        const { id } = req.body;
        if (!id) {
            return res.error("VALIDATION_ERROR", { message: "Reimbursement ID is required" });
        }

        // Fetch reimbursement detail
        const reimbursement = await commonQuery.findOneRecord(Reimbursement, { id }, {
            include: [
                { model: Employee, as: "employee", attributes: ["first_name", "employee_code", "reporting_manager", "attendance_supervisor", "company_id", "joining_date"] },
                { model: ExpenseType, as: "expenseType", attributes: ["name"] },
                {
                    model: ReimbursementItem,
                    as: "items",
                    include: [{ model: ExpenseType, as: "expenseType", attributes: ["name"] }]
                },
                { model: User, as: "approvedBy", attributes: ["id", "user_name"] }
            ]
        });

        if (!reimbursement) {
            return res.error("NOT_FOUND", { message: "Reimbursement request not found" });
        }

        const data = reimbursement.get({ plain: true });

        // Retrieve payment mode if direct payment
        if (data.payment_type === 2) {
            const ph = await commonQuery.findOneRecord(PaymentHistory, {
                ref_id: id,
                payment_type: "Reimbursement"
            });
            if (ph) {
                data.payment_mode = ph.payment_mode;
            }
        }

        // Format dates and fields for the template
        data.formattedAppliedOn = data.created_at || data.createdAt ? dayjs(data.created_at || data.createdAt).format('DD/MM/YYYY') : 'N/A';
        data.formattedPeriod = data.date ? dayjs(data.date).format('MMMM YYYY') : '';
        
        // Items list formatting dates
        data.formattedItems = (data.items || []).map(item => ({
            expenseType: item.expenseType || { name: "Reimbursement" },
            formattedDate: item.expense_date ? dayjs(item.expense_date).format('DD/MM/YYYY') : 'N/A',
            description: item.description,
            amount: item.amount
        }));
        
        if (data.formattedItems.length === 0) {
            data.formattedItems = [{
                expenseType: data.expenseType || { name: "Reimbursement" },
                formattedDate: data.expense_date ? dayjs(data.expense_date).format('DD/MM/YYYY') : (data.date ? dayjs(data.date).format('DD/MM/YYYY') : 'N/A'),
                description: data.description,
                amount: data.total_amount
            }];
        }

        // Fetch company details
        const companyId = data.employee?.company_id || data.company_id || req.user.company_id;
        const company = await CompanyMaster.findOne({ where: { id: companyId } });

        const formattedAddress = [
            company?.address,
            company?.address2,
            company?.city,
            company?.state_name,
            company?.pincode
        ].filter(Boolean).join(", ");

        const companyData = {
            company_name: company?.company_name || 'Airwix HRMS',
            address: formattedAddress,
            company_logo_url: company?.logo_image ? `${process.env.FILE_SERVER_URL}${constants.COMPANY_LOGO_IMG_FOLDER}${company.logo_image}` : null
        };

        const templatePath = path.join(process.cwd(), 'views', 'reimbursement', 'slip.ejs');
        const filename = `reimbursement_slip_${id}_${Date.now()}.pdf`;
        const outputDir = path.join(process.cwd(), 'uploads', 'reimbursements');

        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const outputPath = path.join(outputDir, filename);
        
        // Pass data to template
        await pdfService.generatePdfFromTemplate(templatePath, { data, companyData }, outputPath);

        const downloadLink = `${process.env.FILE_SERVER_URL}reimbursements/${filename}`;

        return res.ok({
            download_link: downloadLink,
            filename: filename
        });
    } catch (err) {
        return handleError(err, res, req);
    }
};
