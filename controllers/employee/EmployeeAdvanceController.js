const { EmployeeAdvance, Employee } = require("../../models");
const { sequelize, validateRequest, commonQuery, handleError, Op } = require("../../helpers");
const { constants } = require("../../helpers/constants");
// Create a new record
exports.create = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const requiredFields = {
            employee_id: "Employee",
            payroll_month: "Payroll Month",
            amount: "Amount",
            payment_date: "Payment Date",
        };

        const errors = await validateRequest(req.body, requiredFields, {}, transaction);

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        await commonQuery.createRecord(EmployeeAdvance, { ...req.body }, transaction);
        await transaction.commit();
        return res.success(constants.EMPLOYEE_ADVANCE_CREATED);

    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Get all active records
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
                        attributes: [["first_name", "employee_name"]],
                        where: { status: { [Op.ne]: 2 } },
                    }
                ],
                raw: true,
                nest: false,   // IMPORTANT
                subQuery: false,
            }
        );
           data.items = data.items.map(item => {
            const employeeName = item["employee.employee_name"] || "";
            // remove unwanted keys
            delete item["employee.employee_name"];
            // ❌ remove ids from response
            delete item.employee_id;

            return {
                ...item,
                employee_name: employeeName,
            };
        });

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


