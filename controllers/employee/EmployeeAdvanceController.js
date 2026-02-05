const { EmployeeAdvance, Employee, PaymentHistory } = require("../../models");
const { sequelize, validateRequest, commonQuery, handleError, Op } = require("../../helpers");
const { constants } = require("../../helpers/constants");

exports.create = async (req, res) => {
    const transaction = await sequelize.transaction();
    const POST = req.body;
    try {
        const requiredFields = {
            employee_id: "Employee",
            payroll_month: "Payroll Month",
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
        };

        await commonQuery.createRecord(PaymentHistory, paymentHistoryData, transaction);
        await transaction.commit();
        return res.success(constants.EMPLOYEE_ADVANCE_CREATED);

    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};

exports.getAll = async (req, res) => {
    try {
        const fieldConfig = [
            ["payroll_month", true, true],
            ["payment_date", true, true],
            ["amount", true, true]
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
                    }
                ],
                attributes: [
                    "id", 
                    "employee_id", 
                    "payroll_month", 
                    "payment_date", 
                    "amount", 
                    "payment_mode",
                    "adjusted_in_payroll",
                    "status",
                    "employee.first_name"
                ]
            },
        );

        // Get monthly totals
        const monthlyTotals = await EmployeeAdvance.findAll({
            attributes: [
                "payroll_month",
                [sequelize.fn('SUM', sequelize.col('amount')), 'total_amount'],
                [sequelize.fn('COUNT', sequelize.col('id')), 'count']
            ],
            where: { status: { [Op.ne]: 2 } }, // Exclude cancelled records
            group: ['payroll_month'],
            order: [['payroll_month', 'DESC']]
        });

        // Create a map of payroll_month to totals
        const totalsMap = {};
        monthlyTotals.forEach(total => {
            totalsMap[total.payroll_month] = {
                total_amount: total.dataValues.total_amount,
                count: total.dataValues.count
            };
        });

        // Attach monthly totals to each record
        if (data.items && Array.isArray(data.items)) {
            data.items.forEach(record => {
                if (record.payroll_month && totalsMap[record.payroll_month]) {
                    record.dataValues.monthly_total = totalsMap[record.payroll_month];
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
        return res.ok(record);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// Update record by ID
exports.update = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        // Only validate fields sent in request
        const requiredFields = {
            employee_id: "Employee",
            payroll_month: "Payroll Month",
            amount: "Amount",
            payment_date: "Payment Date",
        };
        const errors = await validateRequest(
            req.body,
            requiredFields,
            {},
            transaction
        );

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }
        const updated = await commonQuery.updateRecordById(EmployeeAdvance, req.params.id, req.body, transaction);
        if (!updated || updated.status === 2) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }
        await transaction.commit();
        return res.success(constants.EMPLOYEE_ADVANCE_UPDATED);
    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Soft delete a record by ID
exports.delete = async (req, res) => {
    const transaction = await sequelize.transaction();
    //multiple delete
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

        const deleted = await commonQuery.softDeleteById(EmployeeAdvance, ids, transaction);
        if (!deleted) {
            await transaction.rollback();
            return res.error(constants.ALREADY_DELETED);
        }
        await transaction.commit();
        return res.success(constants.EMPLOYEE_ADVANCE_DELETED);
    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};
// Update Status 
exports.updateStatus = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {

        const { status, ids } = req.body; // expecting status in request body

        const requiredFields = {
            ids: "Select Any One Data",
            status: "Select Status"
        };

        const errors = await validateRequest(req.body, requiredFields, {}, transaction);
        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        // Validate that ids is an array and not empty
        if (!Array.isArray(ids) || ids.length === 0) {
            await transaction.rollback();
            return res.error(constants.INVALID_ID);
        }

        // Update only the status field by id
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

        await transaction.commit();
        return res.success(constants.EMPLOYEE_ADVANCE_UPDATED);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Get dropdown list of active designation masters
// exports.dropdownList = async (req, res) => {
//     try {
//         const fieldConfig = [
//             ["payroll_month", true, true],
//             ["payment_date", true, true],
//             ["amount", true, true]
//         ];
//         const result = await commonQuery.fetchPaginatedData(
//             EmployeeAdvance,
//             { ...req.body, status: 0 },
//             fieldConfig,
//             {
//                 attributes: ['id', 'employee_id', 'payroll_month', 'amount', 'payment_date']
//             }
//         );

//         return res.ok(result);
//     } catch (err) {
//         return handleError(err, res, req);
//     }
// };

exports.update = async (req, res) => {
    const transaction = await sequelize.transaction();
    const POST = req.body;
    try {
        const requiredFields = {
            employee_id: "Employee",
            payroll_month: "Payroll Month",
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
        };

        const paymentHistory = await commonQuery.updateRecordById(PaymentHistory, updated.id, paymentHistoryData, transaction);

        if (!paymentHistory || paymentHistory.status === 2) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }
        await transaction.commit();
        return res.success(constants.EMPLOYEE_ADVANCE_UPDATED);
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
        return res.success(constants.EMPLOYEE_ADVANCE_DELETED);
    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};

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
        return res.success(constants.EMPLOYEE_ADVANCE_UPDATED);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

exports.view = async (req, res) => {
    try {
        const { employee_id } = req.body;
        
        if (!employee_id) {
            return res.error(constants.INVALID_ID);
        }
        
        const advances = await EmployeeAdvance.findAll({
            where: { employee_id },
            include: [
                {
                    model: Employee,
                    as: 'employee',
                    attributes: ['id', 'employee_code', 'first_name', 'mobile_no']
                },
                {
                    model: PaymentHistory,
                    as: 'paymentHistory',
                    attributes: ['id', 'ref_id', 'amount', 'payment_date', 'payment_mode', 'status']
                }
            ]
        });
        
       return res.ok(advances);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getAllPaymentHistory = async (req, res) => {
    try {
        const fieldConfig = [
            ["payroll_month", true, true],
            ["payment_date", true, true],
            ["amount", true, true]
        ];

        const data = await commonQuery.fetchPaginatedData(
            PaymentHistory,
            req.body,
            fieldConfig,
            {
                include: [
                    { model: Employee, as: 'employee', attributes: ['id', 'employee_code', 'first_name', 'mobile_no'] }
                ]
            }
        );
        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};