const { CompanyConfigration, CompanySettingsMaster } = require("../../../models");
const { sequelize, commonQuery, handleError, reloadCompanySettingsCache } = require("../../../helpers");
const { ENTITIES } = require("../../../helpers/constants");

const ENTITY = ENTITIES.COMPANY_CONFIGRATION.NAME;

// Get all active settings for a company
exports.getAll = async (req, res) => {
  try {
    const where = { status: 0 };
    if (req.query.company_id) where.company_id = req.query.company_id;

    const result = await commonQuery.findAllRecords(CompanyConfigration, where, null, null, false);
    return res.ok(result);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Get all settings by company_id
exports.getById = async (req, res) => {
  try {
    const where = {
      company_id: req.params.id,
      status: 0,
    };

    const records = await commonQuery.findAllRecords(CompanyConfigration, where, null, null, false);
    
    if (!records || !records.length) return res.error("NOT_FOUND");

    return res.ok(records);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Get all settings by company_id and group
exports.getByGroup = async (req, res) => {
  try {
    const { id, group } = req.params; // Capture both parameters

    const where = {
      company_id: id,
      status: 0,
    };

     const fieldConfig = [
      ["setting_key", true, true],
      ["setting_value", true, true],
      ["company_settings.setting_label", true, true]
    ];

    const result = await commonQuery.fetchPaginatedData(
      CompanyConfigration, 
      {...req.body, ...where},
      fieldConfig, 
      {
        include: [
          {
            model: CompanySettingsMaster,
            as: "company_settings",
            attributes: [], 
            where: { setting_group: group },
            required: true 
          }
        ],
        attributes: ['setting_key','setting_value','company_settings.setting_label', 'company_settings.description', 'company_settings.input_type', 'company_settings.options', 'company_settings.default_value'], 
      }, 
      false
    );

    return res.ok(result);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Bulk Upsert (fast update or insert)
exports.update = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { id } = req.params; // company_id
     
    const settingsToUpdate = req.body.company_configration;

    if (!settingsToUpdate || !Array.isArray(settingsToUpdate)) {
      await transaction.rollback();
      return res.error("VALIDATION_ERROR", { message: "company_configration must be an array" });
    }

    const commonData = {
      user_id: req.body.user_id,
      branch_id: req.body.branch_id,
      company_id: id,
    };
    
      await Promise.all(settingsToUpdate.map(setting =>
        commonQuery.updateRecordById(
          CompanyConfigration,
          { company_id: id, setting_key: setting.setting_key },
          { 
            setting_value: setting.setting_value,
            user_id: commonData.user_id,
            branch_id: commonData.branch_id,
          },
          transaction
        )
      ));

    await transaction.commit();
    reloadCompanySettingsCache(id);

    return res.success("UPSERT", ENTITY, req.body.company_configration);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Soft delete setting by company_id + key
exports.delete = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { id } = req.params;

    const deleted = await commonQuery.softDeleteById(
      CompanyConfigration,
      {
        company_id: id,
        // setting_key: key,
      },
      {},
      transaction
    );

    if (!deleted) {
      await transaction.rollback();
      return res.error("ALREADY_DELETED");
    }

    await transaction.commit();
    return res.success("DELETE", ENTITY);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};
