const { DeviceMaster } = require("../../models");
const { sequelize, validateRequest, commonQuery, handleError } = require("../../helpers");
const { constants } = require("../../helpers/constants");

// Create a new bank master record
exports.create = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const requiredFields = {
            device_name: "Device Name",
            model_name: "Model Name",
            access_by: "access_by",
        };

        const errors = await validateRequest(req.body, requiredFields, {
            uniqueCheck: {
                model: DeviceMaster,
                fields: ["device_name", "model_name"],
                excludeId: req.params.id,
            }
        }, transaction);

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        const device_master = await commonQuery.createRecord(DeviceMaster, req.body, transaction);
        await transaction.commit();
        return res.success(constants.DEVICE_MASTER_CREATED, device_master);

    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Get all active shift records
exports.getAll = async (req, res) => {
    try {
        const fieldConfig = [
            ["device_name", true, true],
            ["model_name", true, true],
        ];

        const data = await commonQuery.fetchPaginatedData(
            DeviceMaster,
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
        const record = await commonQuery.findOneRecord(DeviceMaster, req.params.id);
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
        // Only validate fields sent in request
        const fieldLabels = {
            device_name: "Device Name",
            model_name: "Model Name",
            access_by: "Access By"
        };

        const requiredFields = {};

        Object.keys(fieldLabels).forEach(key => {
            if (req.body[key] !== undefined) {
                requiredFields[key] = fieldLabels[key];
            }
        });

        const errors = await validateRequest(
            req.body,
            requiredFields,
            {
                uniqueCheck: {
                    model: DeviceMaster,
                    fields: ["device_name", "model_name"],
                    excludeId: req.params.id,
                }
            },
            transaction
        );

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }
        const updated = await commonQuery.updateRecordById(DeviceMaster, { id: req.params.id }, req.body, transaction);
        if (!updated || updated.status === 2) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }
        await transaction.commit();
        return res.success(constants.DEVICE_MASTER_UPDATED, updated);
    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Soft delete a shift record by ID
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

        //normalize ids
        if (Array.isArray(ids) && typeof ids[0] === "string") {
            ids = ids[0]
                .split(",")
                .map(id => parseInt(id.trim()))
                .filter(Boolean);
        }

        // Validate that ids is an array and not empty
        if (!Array.isArray(ids) || ids.length === 0) {
            await transaction.rollback();
            return res.error(constants.INVALID_ID);
        }

        const deleted = await commonQuery.softDeleteById(DeviceMaster, ids, transaction);
        if (!deleted) {
            await transaction.rollback();
            return res.error(constants.ALREADY_DELETED);
        }
        await transaction.commit();
        return res.success(constants.DEVICE_MASTER_DELETED);
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
        // console.log("ID And Status:", ids, status);

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

        // Validate that status is provided and valid (0,1,2 as per your definition)
        if (![0, 1, 2].includes(status)) {
            await transaction.rollback();
            return res.error(constants.INVALID_STATUS);
        }

        // Update only the status field by id
        const updated = await commonQuery.updateRecordById(
            DeviceMaster,
            ids,
            { status },
            transaction
        );

        if (!updated || updated.status === 2) {
            if (!transaction.finished) await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        await transaction.commit();
        return res.success(constants.DEVICE_MASTER_UPDATED);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};
