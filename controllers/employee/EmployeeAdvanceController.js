const { EmployeeAdvance, Employee, PaymentHistory, User } = require("../../models");
const { sequelize, validateRequest, commonQuery, handleError, Op, formatDateTime } = require("../../helpers");
const { constants } = require("../../helpers/constants");
const { createNotification } = require("../../services/notificationService");

exports.create = async (req, res) => {
    const transaction = await sequelize.transaction();
    const POST = req.body;
    try {
        const requiredFields = {
            employee_id: "Employee",
            month: "Month",
            year: "Year",
            amount: "Amount",
            payment_date: "Payment Date",
            payment_mode: "Payment Mode",
        };

        const errors = await validateRequest(POST, requiredFields, {}, transaction);

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        const advance = await commonQuery.createRecord(EmployeeAdvance, POST, transaction);

        const paymentHistoryData = {
            employee_id: POST.employee_id,
            ref_id: advance.id,
            payment_date: POST.payment_date,
            amount: POST.amount,
            payment_mode: POST.payment_mode,
            month: POST.month,
            year: POST.year
        };

        await commonQuery.createRecord(PaymentHistory, paymentHistoryData, transaction);

        // 💸 Send Notification to Employee
        try {
            const targetUser = await commonQuery.findOneRecord(User, { employee_id: POST.employee_id }, {}, transaction);
            if (targetUser) {
                await createNotification({
                    user_id: targetUser.id,
                    title: "Advance Payment Received",
                    message: `An advance payment of ₹${POST.amount} has been recorded for you for the period ${POST.month}/${POST.year}.`,
                    type: "PAYROLL",
                    reference_id: advance.id,
                    status_code: 0,
                    company_id: req.user.company_id,
                    branch_id: POST.branch_id
                }, transaction);
            }
        } catch (notifyErr) {
            console.error("Advance Notification Error:", notifyErr.message);
        }

        await transaction.commit();
        return res.success(constants.CREATED);

    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};

exports.getAll = async (req, res) => {
    try {
        const fieldConfig = [
            ["month", true, true],
            ["year", true, true],
            ["payment_date", true, true],
            ["amount", true, true],
            ["employee_name", true, true]
        ];

        const data = await commonQuery.fetchPaginatedData(
            EmployeeAdvance,
            req.body,
            fieldConfig,
            {
                include: [
                    {
                        model: Employee,
                        as: "employee",
                        required: false,
                        attributes: [],
                        where: { status: { [Op.in]: [0, 1, 2] } },
                    }
                ],
                attributes: [
                    "id", 
                    "employee_id", 
                    "month", 
                    "year",
                    "payment_date", 
                    "amount", 
                    "payment_mode",
                    "adjusted_in_payroll",
                    "status",
                    "branch_id",
                   ["employee.first_name", "employee_name"],
                ]
            },
        );

        // Get monthly totals
        const monthlyTotals = await commonQuery.findAllRecords(
            EmployeeAdvance,
            { status: { [Op.ne]: 2 } }, // Exclude cancelled records
            {
                attributes: [
                    "month",
                    "year",
                    [sequelize.fn('SUM', sequelize.col('amount')), 'total_amount'],
                    [sequelize.fn('COUNT', sequelize.col('id')), 'count']
                ],
                group: ['month', 'year'],
                order: [['year', 'DESC'], ['month', 'DESC']]
            }
        );

        // Create a map of month-year to totals
        const totalsMap = {};
        monthlyTotals.forEach(total => {
            const key = `${total.year}-${total.month.toString().padStart(2, '0')}`;
            totalsMap[key] = {
                total_amount: total.dataValues.total_amount,
                count: total.dataValues.count
            };
        });

        // Attach monthly totals to each record
        if (data.items && Array.isArray(data.items)) {
            data.items.forEach(record => {
                // Format Payment Date
                if (record.payment_date) {
                    const formattedDate = formatDateTime(record.payment_date);
                    if (record.dataValues) {
                        record.dataValues.payment_date = formattedDate;
                    } else {
                        record.payment_date = formattedDate;
                    }
                }

                if (record.month && record.year) {
                    const key = `${record.year}-${record.month.toString().padStart(2, '0')}`;
                    if (totalsMap[key]) {
                        if (record.dataValues) {
                            record.dataValues.monthly_total = totalsMap[key];
                        } else {
                            record.monthly_total = totalsMap[key];
                        }
                    }
                }
            });
        }

        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};
// Get By Id
exports.getById = async (req, res) => {
    try {
        const record = await commonQuery.findOneRecord(EmployeeAdvance, req.params.id);
        if (!record || record.status === 2) return res.error(constants.NOT_FOUND);
        
        // Format Payment Date
        if (record.payment_date) {
            if (record.dataValues) {
                record.dataValues.payment_date = formatDateTime(record.payment_date);
            } else {
                record.payment_date = formatDateTime(record.payment_date);
            }
        }
        
        return res.ok(record);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// Update record by ID
exports.update = async (req, res) => {
    const transaction = await sequelize.transaction();
    const POST = req.body;
    try {
        const requiredFields = {
            employee_id: "Employee",
            month: "Month",
            year: "Year",
            amount: "Amount",
            payment_date: "Payment Date",
            payment_mode: "Payment Mode",
        };
        const errors = await validateRequest(
            POST,
            requiredFields,
            {},
            transaction
        );

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }
        const updated = await commonQuery.updateRecordById(EmployeeAdvance, req.params.id, POST, transaction);
        if (!updated || updated.status === 2) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }
        const paymentHistoryData = {
            employee_id: POST.employee_id,
            ref_id: updated.id,
            payment_date: POST.payment_date,
            amount: POST.amount,
            payment_mode: POST.payment_mode,
            month: POST.month,
            year: POST.year
        };

        const paymentHistory = await commonQuery.updateRecordById(PaymentHistory, {ref_id: updated.id}, paymentHistoryData, transaction);

        if (!paymentHistory || paymentHistory.status === 2) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }
        await transaction.commit();
        return res.success(constants.UPDATED);
    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};

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

        const deleted = await commonQuery.softDeleteById(EmployeeAdvance, ids, transaction);
        if (!deleted) {
            await transaction.rollback();
            return res.error(constants.ALREADY_DELETED);
        }

        const paymentHistoryDeleted = await commonQuery.softDeleteById(PaymentHistory, { ref_id: ids }, transaction);
        if (!paymentHistoryDeleted) {
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

// Update Status 
exports.updateStatus = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {

        const { status, ids } = req.body;   

        const requiredFields = {
            ids: "Select Any One Data",
            status: "Select Status"
        };

        const errors = await validateRequest(req.body, requiredFields, {}, transaction);
        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        if (!Array.isArray(ids) || ids.length === 0) {
            await transaction.rollback();
            return res.error(constants.INVALID_ID);
        }

        const updated = await commonQuery.updateRecordById(
            EmployeeAdvance,
            ids,
            { status },
            transaction
        );

        if (!updated || updated.status === 2) {
            if (!transaction.finished) await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        const paymentHistoryUpdated = await commonQuery.updateRecordById(
            PaymentHistory,
            { ref_id: ids },
            { status },
            transaction
        );

        if (!paymentHistoryUpdated || paymentHistoryUpdated.status === 2) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        await transaction.commit();
        return res.success(constants.UPDATED);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Get dropdown list of active designation masters
// exports.dropdownList = async (req, res) => {
//     try {
//         const fieldConfig = [
//             ["payment_date", true, true],
//             ["amount", true, true]
//         ];
//         const result = await commonQuery.fetchPaginatedData(
//             EmployeeAdvance,
//             { ...req.body, status: 0 },
//             fieldConfig,
//             {
//                 attributes: ['id', 'employee_id', 'amount', 'payment_date']
//             }
//         );

//         return res.ok(result);
//     } catch (err) {
//         return handleError(err, res, req);
//     }
// };

exports.advanceView = async (req, res) => {
    try {
        const { employee_id, month, year } = req.body;
        
        if (!employee_id) {
            return res.error(constants.INVALID_ID);
        }
        
        let whereCondition = { employee_id };
        if (month && year) {
            whereCondition = {
                [Op.and]: [
                    { employee_id },
                    { month },
                    { year }
                ]
            };
        }

        const advance = await commonQuery.fetchPaginatedData(
            EmployeeAdvance,
            req.body,
            [],
            {
                include: [
                    { model: Employee, as: 'employee', attributes: [] },
                    { model: PaymentHistory, as: 'paymentHistory', attributes: [] }
                ],
                attributes: ['id', 'employee_id', 'month', 'year', 'amount', 'payment_date', 'payment_mode', 'notes', 'status']
            },
            true,
            'createdAt',
            whereCondition
        );

        // Format Payment Date
        if (advance.items && Array.isArray(advance.items)) {
            advance.items.forEach(record => {
                if (record.payment_date) {
                    const formattedDate = formatDateTime(record.payment_date);
                    if (record.dataValues) {
                        record.dataValues.payment_date = formattedDate;
                    } else {
                        record.payment_date = formattedDate;
                    }
                }
            });
        }

        const total_amount = await commonQuery.sumRecords(EmployeeAdvance, 'amount', whereCondition);
        
        
       return res.ok({ ...advance, total_amount });
    } catch (err) {
        return handleError(err, res, req);
    }
};
