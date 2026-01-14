const { CompanySettingsMaster, CompanyConfigration, CompanyMaster } = require("../../models");
const { validateRequest, commonQuery, handleError, sequelize, constants } = require("../../helpers");

const ALLOWED_GROUPS = ['GENERAL', 'PRODUCT', 'INVENTORY', 'SALES', 'PURCHASE', 'BARCODE', 'EMAIL']; // Add your groups

// -------------------------------------------------------------------------
//  INTERNAL HELPER FUNCTION (Not Exported)
// -------------------------------------------------------------------------
async function syncSettingsToAllCompanies(transaction) {
    // 1. Fetch all Master Settings
    const masterSettings = await CompanySettingsMaster.findAll({
        where: { status: 0 },
        raw: true,
        transaction
    });

    if (!masterSettings.length) return { count: 0, companies: 0 };

    // 2. Fetch all Active Companies
    const companies = await CompanyMaster.findAll({
        where: { status: 0 },
        attributes: ['id', 'user_id'],
        raw: true,
        transaction
    });

    let totalAdded = 0;

    // 3. Loop companies and add missing settings
    for (const company of companies) {
        // Get current keys for this company
        const existingConfig = await CompanyConfigration.findAll({
            where: { company_id: company.id },
            attributes: ['setting_key'],
            raw: true,
            transaction
        });

        const existingKeys = new Set(existingConfig.map(c => c.setting_key));

        // Filter what is missing
        const missingSettings = masterSettings.filter(
            ms => !existingKeys.has(ms.setting_key)
        );

        if (missingSettings.length > 0) {
            const newEntries = missingSettings.map(ms => ({
                company_id: company.id,
                user_id: company.user_id,
                branch_id: 0, // Default to 0 or Main Branch
                setting_key: ms.setting_key,
                setting_value: ms.default_value !== null ? ms.default_value : "",
                status: 0
            }));

            await CompanyConfigration.bulkCreate(newEntries, { transaction });
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
        await commonQuery.createRecord(CompanySettingsMaster, req.body, transaction);

        // B. Automatically Sync to all existing companies
        await syncSettingsToAllCompanies(transaction);

        await transaction.commit();
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
  const data = await commonQuery.fetchPaginatedData(
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
    
    const result = await commonQuery.findOneRecord(
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
  try {
    const { id } = req.params;

    const result = await commonQuery.updateRecordById(
        CompanySettingsMaster, 
        { id }, 
        req.body
    );

    if (!result) return res.error(constants.COMPANY_SETTING_MASTER_NOT_FOUND);

    return res.success(constants.COMPANY_SETTING_MASTER_UPDATED);

  } catch (err) {
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

    const deleted = await commonQuery.softDeleteById(CompanySettingsMaster, ids, transaction);
    if (!deleted) {
      await transaction.rollback();
      return res.error(constants.ALREADY_DELETED);
    }
    await transaction.commit();
    return res.success(constants.COMPANY_SETTING_MASTER_DELETED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

