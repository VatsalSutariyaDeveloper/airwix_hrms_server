const { DeviceMaster, Employee, User } = require("../../models");
const { sequelize, validateRequest, commonQuery, handleError, cryptoHelper } = require("../../helpers");
const { constants } = require("../../helpers/constants");
const { OS } = require("ua-parser-js/enums");

const STATUS = constants.DEVICE_STATUS;

// Create a new device master record
exports.create = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const requiredFields = {
            device_name: "Device Name",
            mobile_no: "Mobile No",
            // device_id: "Device ID",
            // ip_address: "IP Address",
        };

        const errors = await validateRequest(req.body, requiredFields, {
            uniqueCheck: [
                {
                    model: DeviceMaster,
                    fields: ["device_name"],
                },
                {
                    model: Employee,
                    fields: ["mobile_no"],
                    excludeCompany: true,
                    excludeBranch: true
                },
                {
                    model: User,
                    fields: ["mobile_no"],
                    excludeCompany: true,
                    excludeBranch: true
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
            ['device_id', true, true],
            ['last_login_at', true, true],
            ['brand_name', true, true],
            ['device_model', true, true],
            ['os_version', true, true]
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
                        model: Employee,
                        fields: ["mobile_no"],
                        excludeCompany: true,
                        excludeBranch: true
                    },
                    {
                        model: User,
                        fields: ["mobile_no"],
                        excludeCompany: true,
                        excludeBranch: true
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

/**
 * Get all devices associated with the logged-in user's mobile number
 */
exports.getMyDevices = async (req, res) => {
    try {
        const devices = await commonQuery.findAllRecords(DeviceMaster, {
            mobile_no: req.user.mobile_no,
            status: { [Op.ne]: 2 }
        }, {
            order: [['last_login_at', 'DESC']]
        });
        return res.ok(devices);
    } catch (err) {
        return handleError(err, res, req);
    }
};

/**
 * Unpair a device (Clear its IMEI so it can be re-paired)
 */
exports.unpairDevice = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.params;
        const updated = await commonQuery.updateRecordById(DeviceMaster, id, {
            device_id: null,
            ip_address: null,
            last_login_at: null,
            os_version:null,
            brand_name:null,
            device_model:null,
            status: constants.DEVICE_STATUS.UNPAIRED // Unpaired
        }, transaction);

        if (!updated) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND, "Device not found or access denied.");
        }

        await transaction.commit();
        return res.success("Device unpaired successfully. It can now be paired with a new physical device.");
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

/**
 * Initiate Device Pairing
 * Generates a unique Device ID and sets status to PAIRING
 */
exports.pairDevice = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.params;

        // Generate a unique device ID (e.g., DEV-6A7F21)
        const generateDeviceId = () => {
            const randomStr = Math.random().toString(36).substring(2, 6).toUpperCase();
            return `DEV-${Date.now()}${randomStr}`;
        };

        let newDeviceId;
        let isUnique = false;
        let attempts = 0;

        while (!isUnique && attempts < 10) {
            newDeviceId = generateDeviceId();
            const existing = await commonQuery.findOneRecord(DeviceMaster, { device_id: newDeviceId }, {}, transaction);
            if (!existing) isUnique = true;
            attempts++;
        }

        if (!isUnique) {
            await transaction.rollback();
            return res.error(constants.SERVER_ERROR, "Failed to generate a unique Device ID. Please try again.");
        }

        const updated = await commonQuery.updateRecordById(DeviceMaster, id, {
            device_id: newDeviceId,
            status: STATUS.PAIRING
        }, transaction);

        if (!updated) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND, "Device not found.");
        }

        await transaction.commit();
        return res.success("Pairing initiated. Use the generated Device ID to pair your terminal.", {
            device_id: cryptoHelper.encryptId(newDeviceId),
            status: "PAIRING"
        });
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};
