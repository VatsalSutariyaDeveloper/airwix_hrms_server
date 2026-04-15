const { ExpenseType } = require("../../models");
const { sequelize, validateRequest, commonQuery, handleError } = require("../../helpers");
const { constants } = require("../../helpers/constants");


// Create a new expense type master record
exports.create = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const requiredFields = {
            name: "Name",
        };

        const errors = await validateRequest(req.body, requiredFields, {
            uniqueCheck: [
                {
                    model: ExpenseType,
                    fields: ["name"],
                }
            ]
        }, transaction);

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        await commonQuery.createRecord(ExpenseType, req.body, transaction);
        await transaction.commit();
        return res.success(constants.CREATED);

    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Get all expense type records
exports.getAll = async (req, res) => {
    try {
        const fieldConfig = [
            ["name", true, true],
            ["description", true, true]
        ];

        const data = await commonQuery.fetchPaginatedData(
            ExpenseType,
            {...req.body},
            fieldConfig,
        );

        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// Get By Id
exports.getById = async (req, res) => {
    try {
        const record = await commonQuery.findOneRecord(ExpenseType, req.params.id);
        if (!record || record.status === 2) return res.error(constants.NOT_FOUND);
        return res.ok(record);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// Update expense type record by ID
exports.update = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const requiredFields = {
            name: "Name",
        };

        const errors = await validateRequest(
            req.body,
            requiredFields,
            {
                uniqueCheck: [
                    {
                        model: ExpenseType,
                        fields: ["name"],
                        excludeId: req.params.id,
                    }
                ]
            },
            transaction
        );

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }
        
        const updated = await commonQuery.updateRecordById(ExpenseType, req.params.id, req.body, transaction);
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

// Soft delete expense type records by ID
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

        const deleted = await commonQuery.softDeleteById(ExpenseType, ids, transaction);
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
            ExpenseType,
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


exports.dropdownList = async (req, res) => {
    try {
        const fieldConfig = [
            ["name", true, true],
            ["description", true, true],
        ];
        const result = await commonQuery.fetchPaginatedData(
            ExpenseType,
            { ...req.body },
            fieldConfig,
            {
                attributes: ['id', 'name', 'description']
            }
        );

        return res.ok(result);
    } catch (err) {
        return handleError(err, res, req);
    }
};
