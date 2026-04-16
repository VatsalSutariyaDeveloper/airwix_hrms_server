const { handleError, commonQuery, constants, sequelize, validateRequest, reloadCompanySettingsCache } = require("../../helpers");
const { CompanySettings } = require("../../models");


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
                model: CompanySettings,
                fields: ["settings_name"],
            },
        }, transaction);

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        await commonQuery.createRecord(CompanySettings, POST, transaction);
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
            CompanySettings,
            { ...POST },
            fieldConfig,
        );

        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getById = async (req, res) => {
    try {
        const requestedSettings = req.body.company_settings;

        const where = {
            company_id: req.params.id,
            status: 0,
        };

        if (requestedSettings && Array.isArray(requestedSettings) && requestedSettings.length > 0) {
            // Map keys to create an array
            const keys = requestedSettings.map(setting => setting.settings_name);

            // Sequelize automatically converts array to IN clause
            where.settings_name = keys;
        }

        const records = await commonQuery.findAllRecords(CompanySettings, where, { attributes: ['settings_name', 'settings_value'] }, null, false);

        if (!records || !records.length) return res.error("NOT_FOUND");

        return res.ok(records);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.update = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const settingsToUpdate = req.body.company_settings;

        if (!settingsToUpdate || !Array.isArray(settingsToUpdate)) {
            await transaction.rollback();
            return res.error("VALIDATION_ERROR", { message: "company_settings must be an array" });
        }

        await Promise.all(settingsToUpdate.map(setting =>
            commonQuery.updateRecordById(
                CompanySettings,
                { company_id: req.user.company_id, settings_name: setting.settings_name },
                {
                    settings_value: setting.settings_value,
                },
                transaction
            )
        ));

        await transaction.commit();
        try {
            // Reload cache if the helper function exists
            reloadCompanySettingsCache(req.user.company_id);
        } catch (cacheErr) {
            console.error('Error reloading company settings cache:', cacheErr);
        }

        return res.success(constants.UPDATED);
    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};
