const { CompanySettingsMaster, CompanySettings, CompanyMaster } = require("../../../models");
const { validateRequest, adminCommonQuery, handleError, sequelize, constants, clearAllCompaniesCache } = require("../../../helpers");

const ALLOWED_GROUPS = ['GENERAL', 'PRODUCT', 'INVENTORY', 'SALES', 'PURCHASE', 'BARCODE', 'EMAIL', 'PAYROLL']; // Add your groups

// -------------------------------------------------------------------------
//  INTERNAL HELPER FUNCTION (Not Exported)
// -------------------------------------------------------------------------
function parseDefaultValue(val, inputType) {
  if (val === null || val === undefined) return "";
  const str = String(val).trim();
  if (inputType === "SWITCH") {
    return str === "1" || str === "true";
  }
  if (str === "true") return true;
  if (str === "false") return false;
  if (!isNaN(str) && str !== "") return Number(str);
  try {
    return JSON.parse(str);
  } catch (e) {
    return str;
  }
}

async function syncSettingsToAllCompanies(transaction) {
    // 1. Fetch all Master Settings
    const masterSettings = await adminCommonQuery.findAllRecords(CompanySettingsMaster, {
        status: 0
    }, {
        raw: true
    }, transaction, false);

    if (!masterSettings.length) return { count: 0, companies: 0 };

    // 2. Fetch all Active Companies
    const companies = await adminCommonQuery.findAllRecords(CompanyMaster, {
        status: 0
    }, {
        attributes: ['id', 'user_id'],
        raw: true
    }, transaction, false);

    let totalAdded = 0;

    // 3. Loop companies and add missing settings
    for (const company of companies) {
        // Get current keys for this company
        const existingConfig = await adminCommonQuery.findAllRecords(CompanySettings, {
            company_id: company.id 
        }, {
            attributes: ['settings_name'],
            raw: true
        }, transaction, false);

        const existingKeys = new Set(existingConfig.map(c => c.settings_name));

        // Filter what is missing
        const missingSettings = masterSettings.filter(
            ms => !existingKeys.has(ms.setting_key)
        );

        if (missingSettings.length > 0) {
            const newEntries = missingSettings.map(ms => ({
                company_id: company.id,
                user_id: company.user_id,
                settings_name: ms.setting_key,
                settings_value: parseDefaultValue(ms.default_value, ms.input_type),
                status: 0
            }));

            await adminCommonQuery.bulkCreate(CompanySettings, newEntries, {}, transaction);
            totalAdded += newEntries.length;
        }
    }

    return { count: totalAdded, companies: companies.length };
}

// -------------------------------------------------------------------------
//  EXPORTED CONTROLLER METHODS
// -------------------------------------------------------------------------

/**
 * 1. Create a new Setting Definition AND Sync to all companies
 */
exports.create = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const requiredFields = { 
            setting_key: "Setting Key", 
            setting_label: "Setting Label", 
            setting_group: "Group"
        };

        const errors = await validateRequest(req.body, requiredFields, {
            uniqueCheck: { 
                model: CompanySettingsMaster, 
                fields: ["setting_key"] 
            }
        }, transaction);

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        if (req.body.setting_group && !ALLOWED_GROUPS.includes(req.body.setting_group)) {
             await transaction.rollback();
             return res.error(constants.VALIDATION_ERROR, { errors: [`Invalid Group. Allowed: ${ALLOWED_GROUPS.join(", ")}`] });
        }

        // A. Create the Master Record
        await adminCommonQuery.createRecord(CompanySettingsMaster, req.body, transaction);

        // B. Automatically Sync to all existing companies
        await syncSettingsToAllCompanies(transaction);

        await transaction.commit();
        clearAllCompaniesCache();
        return res.success(constants.COMPANY_SETTING_MASTER_CREATED);

    } catch (err) {
      console.error("Error in create company setting:", err);
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

/**
 * 2. Separate Endpoint: Manually Sync settings
 */
exports.syncNewSettings = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const result = await syncSettingsToAllCompanies(transaction);
        
        await transaction.commit();
        return res.success("UPDATE", "SYNC_SETTINGS", { 
            message: `Sync complete. Added ${result.count} new configurations across ${result.companies} companies.` 
        });

    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

exports.getAll = async (req, res) => {

  // key, isSearchable, isSortable
  const fieldConfig = [
    ["setting_key", true, true],
    ["setting_group", true, true],
    ["setting_value", false, true],
  ];

  // Call reusable function
  const data = await adminCommonQuery.fetchPaginatedData(
    CompanySettingsMaster,
    req.body,
    fieldConfig,
    {},
    false
  );
  
  return res.ok(data);
};

exports.getById = async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await adminCommonQuery.findOneRecord(
        CompanySettingsMaster, 
        { id }, 
        null, 
        null, 
        false, 
        false 
    );
    
    if (!result) return res.error(constants.COMPANY_SETTING_MASTER_NOT_FOUND);
    
    return res.ok(result);
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.update = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { id } = req.params;

    // Fetch the old setting record to get the old setting_key
    const oldSetting = await CompanySettingsMaster.findByPk(id, { transaction });
    if (!oldSetting) {
      await transaction.rollback();
      return res.error(constants.COMPANY_SETTING_MASTER_NOT_FOUND);
    }

    const oldKey = oldSetting.setting_key;
    const newKey = req.body.setting_key;

    const result = await adminCommonQuery.updateRecordById(
        CompanySettingsMaster, 
        { id }, 
        req.body,
        transaction
    );

    if (!result) {
      await transaction.rollback();
      return res.error(constants.COMPANY_SETTING_MASTER_NOT_FOUND);
    }

    // If setting_key has changed, update matching settings_name fields in CompanySettings
    if (newKey && oldKey && newKey !== oldKey) {
      await CompanySettings.update(
        { settings_name: newKey },
        {
          where: { settings_name: oldKey },
          transaction
        }
      );
    }

    await transaction.commit();
    clearAllCompaniesCache();
    return res.success(constants.COMPANY_SETTING_MASTER_UPDATED);

  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Soft delete by IDs
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

    const { ids } = req.body; 

    // Validate that ids is an array and not empty
    if (!Array.isArray(ids) || ids.length === 0) {
      await transaction.rollback();
      return res.error(constants.INVALID_INPUT);
    }

    // Find the settings keys for the deleted IDs to sync deletion
    const { Op } = require("sequelize");
    const settingsToDelete = await CompanySettingsMaster.findAll({
      where: {
        id: { [Op.in]: ids }
      },
      transaction,
      raw: true
    });

    const keysToDelete = settingsToDelete.map(s => s.setting_key);

    const deleted = await adminCommonQuery.softDeleteById(CompanySettingsMaster, ids, transaction);
    if (!deleted) {
      await transaction.rollback();
      return res.error(constants.ALREADY_DELETED);
    }

    // Soft delete corresponding records in CompanySettings for all companies
    if (keysToDelete.length > 0) {
      await CompanySettings.update(
        { status: 2 },
        {
          where: {
            settings_name: { [Op.in]: keysToDelete }
          },
          transaction
        }
      );
    }

    await transaction.commit();
    clearAllCompaniesCache();
    return res.success(constants.COMPANY_SETTING_MASTER_DELETED);
  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};

