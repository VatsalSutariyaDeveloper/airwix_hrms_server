const { CompanyConfigration, CompanyMaster } = require("../../../models");
const { sequelize, validateRequest, commonQuery, handleError, reloadCompanySettingsCache, Op } = require("../../../helpers");
const { ENTITIES } = require("../../../helpers/constants");

const ENTITY = ENTITIES.COMPANY_CONFIGRATION.NAME;

// Create setting(s)
exports.create = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const requiredFields = { company_id: "Company" };
    const errors = await validateRequest(req.body, requiredFields, {
      uniqueCheck: {
          model: CompanyConfigration,
          fields: ["company_id"]
      }
    }, transaction);

    if (errors) {
      await transaction.rollback();
      return res.error("VALIDATION_ERROR", { errors });
    }
    
    const commonData = {
      user_id: req.body.user_id,
      branch_id: req.body.branch_id,
      company_id: req.body.company_id,
    };

    if (!req.body.company_configration || !Array.isArray(req.body.company_configration)) {
      return res.error("VALIDATION_ERROR", { message: "company_configration must be an array" });
    }

    // Bulk insert
    const result = await commonQuery.bulkCreate(
      CompanyConfigration,
      req.body.company_configration,
      commonData,
      transaction
    );

    await transaction.commit();
    return res.success("CREATE", ENTITY, result);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Get all active settings for a company
exports.getAll = async (req, res) => {
  try {
    const where = { status: 0 };
    if (req.query.company_id) where.company_id = req.query.company_id;

    const result = await commonQuery.findAllRecords(CompanyConfigration, where, null, null, false);
    return res.success("FETCH", ENTITY, result);
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

    return res.success("FETCH", ENTITY, records);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Bulk Upsert (fast update or insert)
// Bulk Upsert - Now uses commonQuery and only updates changed values
exports.update = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { id } = req.params; // company_id
console.log("Updating company_configration for company_id:", id);
    if (!req.body.company_configration || !Array.isArray(req.body.company_configration)) {
      await transaction.rollback();
      return res.error("VALIDATION_ERROR", { message: "company_configration must be an array" });
    }

    const commonData = {
      user_id: req.body.user_id,
      branch_id: req.body.branch_id,
      company_id: id,
    };
    
    // --- STEP 0: Fetch System Defaults (company_id: -2) ---
    // This replaces fetching from DefaultCompanyConfigration
    const currentDefaults = await commonQuery.findAllRecords(
      CompanyConfigration,
      { company_id: -2, status: 0 },
      { attributes: ['setting_key', 'setting_value', 'description'] },
      transaction,
      false
    );
    const defaultKeys = new Set(currentDefaults.map(s => s.setting_key));


    // --- STEP 1: HANDLE TARGET COMPANY (Standard Upsert Logic) ---
    
    // 1. Fetch existing settings for the target company (id)
    console.log("Fetching existing settings for company_id:", id);
    const existingSettings = await commonQuery.findAllRecords(
      CompanyConfigration,
      { company_id: id },
      { raw: true },
      transaction,
      false     
    );
    console.log("Existing Settings: id", id);
    const settingsMap = new Map(existingSettings.map(s => [s.setting_key, s]));

    const settingsToCreate = [];
    const settingsToUpdate = [];
    const incomingSettingsMap = new Map(); // Store incoming settings for propagation check
    
    // 2. Separate incoming settings into 'create' and 'update' lists
    for (const setting of req.body.company_configration) {
      // console.log("Incoming Settings:", setting);
      incomingSettingsMap.set(setting.setting_key, setting);
      
      const existingSetting = settingsMap.get(setting.setting_key);
      // console.log("Existing Setting:", existingSetting);
      const rowPayload = {
          setting_key: setting.setting_key,
          setting_value: setting.setting_value,
          description: setting.description || null,
          status: 0,
      };
// console.log("Row Payload:", rowPayload);
      if (existingSetting) {
        // console.log("Setting exists, checking for updates...");
          // Case 1: The setting exists for the target company. Check if its value has changed.
          if (existingSetting.setting_value !== setting.setting_value) {
              settingsToUpdate.push(rowPayload);
          }
          // console.log("Settings to Update:", settingsToUpdate);
      } else {
        console.log("Setting does not exist, marking for creation...");
          // Case 2: The setting does not exist for the target company. It's new and should be created.
          settingsToCreate.push(rowPayload);
          console.log("Settings to Create:", settingsToCreate);
      }
      // console.log("Current Settings to Create:", settingsToCreate);
    }
// console.log("Settings to Create:", settingsToCreate);
    // 3. Bulk create new settings for the target company
    if (settingsToCreate.length > 0) {
      await commonQuery.bulkCreate(
        CompanyConfigration,
        settingsToCreate,
        commonData,
        transaction
      );
    }

    // 4. Update changed settings for the target company
    if (settingsToUpdate.length > 0) {
      await Promise.all(settingsToUpdate.map(setting =>
        commonQuery.updateRecordById(
          CompanyConfigration,
          { company_id: id, setting_key: setting.setting_key },
          { 
            setting_value: setting.setting_value,
            description: setting.description,
            user_id: commonData.user_id,
            branch_id: commonData.branch_id,
          },
          transaction
        )
      ));
    }
    
    
    // --- STEP 2: IDENTIFY AND PROPAGATE NEW SYSTEM-WIDE DEFAULTS ---

    // 5. Identify settings from the incoming payload that are NOT present in the -2 defaults
    const newDefaultsToCreate = [];
    for (const [key, setting] of incomingSettingsMap.entries()) {
      // If the setting key is new (not in -2 defaults), it becomes a new system default
      if (!defaultKeys.has(key)) {
        newDefaultsToCreate.push({
          setting_key: key,
          setting_value: setting.setting_value, // Use the value from the current company as the new default
          description: setting.description || null,
          status: 0,
        });
      }
    }
    
    if (newDefaultsToCreate.length > 0) {
      
      // 6. Bulk create new settings in CompanyConfigration with company_id = -2
      const defaultCommonData = {
          user_id: -2, // System User ID for default
          branch_id: -2, // System Branch ID for default
          company_id: -2, // System Company ID for default
      };
      
      await commonQuery.bulkCreate(
        CompanyConfigration,
        newDefaultsToCreate,
        defaultCommonData,
        transaction
      );
      
      // 7. Get all OTHER active companies (excluding the one being updated)
      const existingCompanies = await commonQuery.findAllRecords(
        CompanyMaster,
        { 
          id: { [Op.ne]: id }, // Exclude the current company ID
          status: 0 
        },
        { attributes: ['id'] },
        transaction,
        false
      );

      // 8. Propagate the new defaults to all OTHER companies
      for (const company of existingCompanies) {
        const companyId = company.id;
        const propagationPayload = newDefaultsToCreate.map(setting => ({
          setting_key: setting.setting_key,
          setting_value: setting.setting_value,
          description: setting.description,
          status: 0,
        }));
        
        // Use the current user's IDs for tracking who triggered the propagation
        await commonQuery.bulkCreate(
          CompanyConfigration,
          propagationPayload,
          { ...commonData, company_id: companyId },
          transaction
        );
      }
    }

    // --- STEP 3: FINISH ---

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

/**
 * Migration function to add new default settings to ALL existing companies.
 */
exports.migrateDefaults = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    // 1. Fetch all default settings (keys and values)
    const defaultSettings = await commonQuery.findAllRecords(
      DefaultCompanyConfigration,
      { status: 0 },
      false, 
      false, 
      { attributes: ['setting_key', 'setting_value', 'description'] },
      transaction,
      false
    );

    if (defaultSettings.length === 0) {
      await transaction.rollback();
      return res.success("MIGRATION_SKIP", "No active default settings found.");
    }

    const defaultKeys = defaultSettings.map(s => s.setting_key);

    // 2. Fetch all active companies
    const existingCompanies = await commonQuery.findAllRecords(
      CompanyMaster,
      { status: 0 },
      { attributes: ['id'] },
      transaction,
      false
    );
    
    let totalSettingsAdded = 0;
    
    // 3. Iterate through all companies
    for (const company of existingCompanies) {
      const companyId = company.id;
      
      // 4. Find the setting keys already present for this company
      const currentCompanySettings = await commonQuery.findAllRecords(
        CompanyConfigration,
        { company_id: companyId, status: 0 },
        { attributes: ['setting_key'] },
        transaction,
        false
      );

      const existingKeys = new Set(currentCompanySettings.map(s => s.setting_key));

      // 5. Identify new settings to be added
      const settingsToCreate = defaultSettings
        .filter(defaultSetting => !existingKeys.has(defaultSetting.setting_key))
        .map(setting => ({
            setting_key: setting.setting_key,
            setting_value: setting.setting_value,
            description: setting.description,
            status: 0,
        }));

      // 6. Bulk create only the missing new settings
      if (settingsToCreate.length > 0) {
        const commonData = {
          user_id: req.body.user_id || 1, // Use an Admin/System User ID
          branch_id: req.body.branch_id || null, 
          company_id: companyId,
        };
        
        await commonQuery.bulkCreate(
          CompanyConfigration,
          settingsToCreate,
          commonData,
          transaction
        );
        totalSettingsAdded += settingsToCreate.length;
      }
    }

    await transaction.commit();
    return res.success(
        "MIGRATION_SUCCESS", 
        `Successfully migrated defaults to ${existingCompanies.length} companies. ${totalSettingsAdded} total settings added.`
    );
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};