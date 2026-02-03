const { DesignationMaster } = require("../../models");
const { sequelize, validateRequest, commonQuery, handleError } = require("../../helpers");
const { constants } = require("../../helpers/constants");

// Create a new bank master record
exports.create = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const requiredFields = {
            designation_name: "Designation Name"
        };

        const errors = await validateRequest(req.body, requiredFields, {
            uniqueCheck: {
                model: DesignationMaster,
                fields: ["designation_name"],
            }
        }, transaction);

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        await commonQuery.createRecord(DesignationMaster, req.body, transaction);
        await transaction.commit();
        return res.success(constants.DESIGNATION_MASTER_CREATED);
    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Get all active shift records
exports.getAll = async (req, res) => {
    try {
        const fieldConfig = [
            ["designation_name", true, true],
        ];

        const data = await commonQuery.fetchPaginatedData(
            DesignationMaster,
            req.body,
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
        const record = await commonQuery.findOneRecord(DesignationMaster, req.params.id);
        if (!record || record.status === 2) return res.error(constants.NOT_FOUND);
        return res.ok(record);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// Update shift record by ID
exports.update = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const requiredFields = {
            designation_name: "Designation Name",
        };

        const errors = await validateRequest(
            req.body,
            requiredFields,
            {
                uniqueCheck: {
                    model: DesignationMaster,
                    fields: ["designation_name"],
                    excludeId: req.params.id,
                }
            },
            transaction
        );

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }
        const updated = await commonQuery.updateRecordById(DesignationMaster, req.params.id, req.body, transaction);
        if (!updated || updated.status === 2) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }
        await transaction.commit();
        return res.success(constants.DESIGNATION_MASTER_UPDATED);
    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Soft delete a shift record by ID
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

        // Validate that ids is an array and not empty
        if (!Array.isArray(ids) || ids.length === 0) {
            await transaction.rollback();
            return res.error(constants.INVALID_ID);
        }

        const deleted = await commonQuery.softDeleteById(DesignationMaster, ids, transaction);
        if (!deleted) {
            await transaction.rollback();
            return res.error(constants.ALREADY_DELETED);
        }
        await transaction.commit();
        return res.success(constants.DESIGNATION_MASTER_DELETED);
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

        // Validate that ids is an array and not empty
        if (!Array.isArray(ids) || ids.length === 0) {
            await transaction.rollback();
            return res.error(constants.INVALID_ID);
        }

        // Update only the status field by id
        const updated = await commonQuery.updateRecordById(
            DesignationMaster,
            ids,
            { status },
            transaction
        );

        if (!updated || updated.status === 2) {
            if (!transaction.finished) await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        await transaction.commit();
        return res.success(constants.DESIGNATION_MASTER_UPDATED);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Get dropdown list of active designation masters
exports.dropdownList = async (req, res) => {
    try {
        const fieldConfig = [
            ["designation_name", true, true],
        ];

        const result = await commonQuery.fetchPaginatedData(
            DesignationMaster,
            { ...req.body, status: 0 },
            fieldConfig
        );

        return res.ok(result);
    } catch (err) {
        return handleError(err, res, req);
    }
};