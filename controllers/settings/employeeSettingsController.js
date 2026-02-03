const { handleError, commonQuery, constants, sequelize, validateRequest } = require("../../helpers");
const { EmployeeSettings } = require("../../models");


exports.create = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const POST = req.body;
        
        const requiredFields = {
            settings_name: "Settings Name",
            settings_value: "Settings Value",
        };

        const errors = await validateRequest(POST, requiredFields, {
            uniqueCheck: {
                model: EmployeeSettings,
                fields: ["settings_name"],
            },
        }, transaction);

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        await commonQuery.createRecord(EmployeeSettings, POST, transaction);
        await transaction.commit();
        return res.success(constants.CREATED);

    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};

exports.getAll = async (req, res) => {
    try {
        const POST = req.body;
        const fieldConfig = [
            ["settings_name", true, true],
        ];

        const data = await commonQuery.fetchPaginatedData(
            EmployeeSettings,
            { ...POST, status: 0 },
            fieldConfig,
        );

        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.update = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const POST = req.body;

        const requiredFields = {
            settings_name: "Settings Name",
            settings_value: "Settings Value",
        };

        const errors = await validateRequest(POST, requiredFields, {}, transaction);

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        // Find the record by settings_name
        const existingRecord = await commonQuery.findOneRecord(EmployeeSettings, {
            settings_name: POST.settings_name,
            status: 0
        }, {}, transaction);

        if (!existingRecord) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND, { message: "Settings record not found" });
        }

        // Update the found record
        await commonQuery.updateRecordById(EmployeeSettings, existingRecord.id, POST, transaction);
        await transaction.commit();
        return res.success(constants.UPDATED);
    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};
