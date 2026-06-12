const { EmployeeIncentive, Employee, IncentiveType, User } = require("../../models");
const { sequelize, validateRequest, commonQuery, handleError, Op } = require("../../helpers");
const { constants } = require("../../helpers/constants");
const { createNotification } = require("../../services/notificationService");

// Create a new record
exports.create = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const requiredFields = {
            employee_id: "Employee",
            incentive_type_id: "Incentive Type Id",
            month: "Month",
            year: "Year",
            amount: "Amount",
            incentive_date: "Incentive Date",
        };

        const errors = await validateRequest(req.body, requiredFields, {}, transaction);

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        const incentive = await commonQuery.createRecord(EmployeeIncentive, { ...req.body }, transaction);

        // 💸 Send Notification to Employee
        try {
            const targetUser = await commonQuery.findOneRecord(User, { employee_id: req.body.employee_id }, {}, transaction);
            if (targetUser) {
                const incentiveType = await commonQuery.findOneRecord(IncentiveType, req.body.incentive_type_id, {}, transaction);
                const typeName = incentiveType?.name || "Incentive";
                await createNotification({
                    user_id: targetUser.id,
                    title: `${typeName} Added`,
                    message: `A new ${typeName.toLowerCase()} of ₹${req.body.amount} has been recorded for you for the month ${req.body.month}/${req.body.year}.`,
                    type: "PAYROLL",
                    reference_id: incentive.id,
                    status_code: 0,
                    company_id: req.user.company_id,
                }, transaction);
            }
        } catch (notifyErr) {
            console.error("Incentive Notification Error:", notifyErr.message);
        }

        await transaction.commit();
        return res.success(constants.CREATED);

    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Get all active records
exports.getAll = async (req, res) => {
    try {
        const fieldConfig = [
            ["month", true, true],
            ["year", true, true],
            ["incentive_date", true, true],
            ["employee_name", true, true],
            ["incentive_type_name", true, true],
        ];

        const data = await commonQuery.fetchPaginatedData(
            EmployeeIncentive,
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
                    },
                    {
                        model: IncentiveType,
                        as: "incentiveType",
                        required: false,
                        attributes: [],
                        where: { status: { [Op.in]: [0, 1, 2] } },
                    },
                ],
                attributes:[
                    "id",
                    "employee_id",
                    "incentive_type_id",
                    "month",
                    "year",
                    "amount",
                    "incentive_date",
                    "notes",
                    "adjusted_in_payroll",
                    "status",
                    ["employee.first_name", "employee_name"],
                    ["incentiveType.name", "incentive_type_name"]

                ]
            }
        );

        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};
// Get By Id
exports.getById = async (req, res) => {
    try {
        const record = await commonQuery.findOneRecord(EmployeeIncentive, req.params.id);
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
            employee_id: "Employee Id",
            incentive_type_id: "incentive_type_id",
            month: "Month",
            year: "Year",
            amount: "Amount",
            incentive_date: "Incentive Date",
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
        const updated = await commonQuery.updateRecordById(EmployeeIncentive, req.params.id, req.body, transaction);
        if (!updated || updated.status === 2) {
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

        const deleted = await commonQuery.softDeleteById(EmployeeIncentive, ids, transaction);
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
            EmployeeIncentive,
            ids,
            { status },
            transaction
        );

        if (!updated || updated.status === 2) {
            if (!transaction.finished) await transaction.rollback();
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
//             ["month", true, true],
//             ["year", true, true],
//             ["incentive_date", true, true],
//         ];
//         const result = await commonQuery.fetchPaginatedData(
//             EmployeeIncentive,
//             { ...req.body, status: 0 },
//             fieldConfig,
//             {
//                 attributes: ['id', 'employee_id', 'incentive_type_id', 'month', 'year', 'amount', 'incentive_date']
//             }
//         );

//         return res.ok(result);
//     } catch (err) {
//         return handleError(err, res, req);
//     }
// };


