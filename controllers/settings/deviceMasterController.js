const { DeviceMaster } = require("../../models");
const { sequelize, validateRequest, commonQuery, handleError } = require("../../helpers");
const { constants } = require("../../helpers/constants");

const STATUS = {
    ACTIVE: 0,
    INACTIVE: 1,
    DELETED: 2,
    PENDING_APPROVAL: 3
};

// Create a new device master record
exports.create = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const requiredFields = {
            device_name: "Device Name",
            mobile_no: "Mobile No",
            // imei_number: "IMEI Number",
            // ip_address: "IP Address",
        };

        const errors = await validateRequest(req.body, requiredFields, {
            uniqueCheck: [
                {
                    model: DeviceMaster,
                    fields: ["device_name"],
                },
                {
                    model: DeviceMaster,
                    fields: ["mobile_no", "imei_number"],
                    excludeCompany: true,
                    excludeBranch: true,
                }
            ]
        }, transaction);

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        const device_master = await commonQuery.createRecord(DeviceMaster, req.body, transaction);
        await transaction.commit();
        return res.success(constants.CREATED, device_master);

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
            ["ip_address", true, true],
            ['imei_number', true, true]
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
        const requiredFields = {
            device_name: "Device Name",
            mobile_no: "Mobile No",
            // _number: "IMEI Number",
            // ip_address: "IP Address",
        };

        const errors = await validateRequest(
            req.body,
            requiredFields,
            {
                uniqueCheck: [
                    {
                        model: DeviceMaster,
                        fields: ["device_name"],
                        excludeId: req.params.id,
                    },
                    {
                        model: DeviceMaster,
                        fields: ["mobile_no", "imei_number"],
                        excludeId: req.params.id,
                        excludeCompany: true,
                        excludeBranch: true,
                    }
                ]
            },
            transaction
        );

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }
        const updated = await commonQuery.updateRecordById(DeviceMaster, req.params.id, req.body, transaction);
        if (!updated || updated.status === 2) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }
        await transaction.commit();
        return res.success(constants.UPDATED, updated);
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
        return res.success(constants.UPDATED);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Get dropdown list of active device masters
exports.dropdownList = async (req, res) => {
    try {
        const result = await commonQuery.findAllRecords(DeviceMaster, { status: 0 });
        return res.ok(result);
    } catch (err) {
        return handleError(err, res, req);
    }
};
