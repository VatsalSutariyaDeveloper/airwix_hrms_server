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

        const company_id = req.user.company_id;
        const where = {
            company_id,
            status: 0,
        };

        if (requestedSettings && Array.isArray(requestedSettings) && requestedSettings.length > 0) {
            // Map keys to create an array
            const keys = requestedSettings.map(setting => setting.settings_name);

            // Sequelize automatically converts array to IN clause
            where.settings_name = keys;
        }

        const records = await commonQuery.findAllRecords(CompanySettings, where, { attributes: ['settings_name', 'settings_value'] }, null, { company_id: true });

        // Return empty array instead of error if no records found, so frontend can handle defaults
        return res.ok(records || []);
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

        for (const setting of settingsToUpdate) {
            const company_id = req.user.company_id;
            const updated = await commonQuery.updateRecordById(
                CompanySettings,
                { company_id, settings_name: setting.settings_name },
                {
                    settings_value: setting.settings_value,
                },
                transaction,
                false,
                { company_id: true }
            );

            if (!updated) {
                await commonQuery.createRecord(CompanySettings, {
                    company_id,
                    settings_name: setting.settings_name,
                    settings_value: setting.settings_value,
                    status: 0
                }, transaction, { company_id: true });
            }
        }

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
