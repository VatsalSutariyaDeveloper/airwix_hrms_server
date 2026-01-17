const { User, CompanyMaster, ModuleMaster, ModuleEntityMaster, CountryMaster, CurrencyMaster, StateMaster, CompanyConfigration, UserCompanyRoles, Permission,} = require("../../../models");
const { sequelize, commonQuery, handleError, Op, constants, getCompanySubscription } = require("../../../helpers");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const { getContext } = require("../../../utils/requestContext.js");

const normalizeCompanyAccess = (access) => {
  if (Array.isArray(access)) return access.map(String);
  if (typeof access === "string") return access.split(",").map((id) => id.trim()).filter(Boolean);
  return [];
};

/**
 * Login Session Data Pass (Optimized)
 */
exports.sessionData = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const ctx = getContext();
    const { companyId: company_id, userId: user_id, branchId: branch_id } = ctx;

    // 1. Validate Company
    const record = await commonQuery.findOneRecord(
      CompanyMaster,
      company_id,
      { attributes: ['id', 'company_id'] },
      null, false, false
    );

    if (!record) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND, { message: "Invalid or missing company record." });
    }

    let companyId = record.company_id || record.id;

    // 2. Fetch User & Access Logic
    const userData = await commonQuery.findOneRecord(
      User,
      user_id,
      {
        include: [{ 
            model: UserCompanyRoles, 
            as: "ComapanyRole", 
            where: { company_id, branch_id }, 
            attributes: ["permissions"],
            required: false 
        }]
      },
      null, false, false
    );
    if (!userData) {
        await transaction.rollback();
        return res.error(constants.USER_NOT_FOUND);
    }

    const companyAccessList = normalizeCompanyAccess(userData.company_access || "");
    if (userData.role_id != 1 && companyAccessList.length === 0) {
      await transaction.rollback();
      return res.error(constants.FORBIDDEN, { message: "User does not have access to any companies." });
    }
    
    // Check if user has a role assigned for this specific company/branch (unless bypassed or Super Admin)
    if (!userData.ComapanyRole?.[0]?.permissions && process.env.BYPASS_PERMISSION !== "true" && userData.role_id != 1) {
      await transaction.rollback();
      return res.error("FORBIDDEN", { message: "User does not have a role assigned in this company." });
    }

    let where = {};
    if (userData.role_id == 1) {
      where = {
        [Op.or]: [{ id: companyId }, { company_id: companyId }],
        status: { [Op.ne]: 2 }
      };
    } else {
      where = { id: { [Op.in]: companyAccessList }, status: { [Op.ne]: 2 } };
    }

    // 3. Fetch Core Data (Parallel)
    const [companyList, sidebarModuleList, companySettings, allPermissions] = await Promise.all([
      // A. Company List
      commonQuery.findAllRecords(CompanyMaster, where, {
        include: [
          { model: CountryMaster, as: 'country', attributes: ['country_name'], required: false },
          { model: StateMaster, as: 'state', attributes: ['state_name'], required: false },
        ],
        raw: false, nest: true
      }, null, false, false),

      // B. Sidebar Modules (Hierarchical)
      commonQuery.findAllRecords(ModuleMaster, { status: 0 }, {
        attributes: ["id", "module_name", "cust_module_name", "module_icon_name", "module_url", "priority"],
        include: [{ 
            model: ModuleEntityMaster, 
            as: "entities", 
            required: false, 
            where: { status: 0 }, 
            attributes: ["id", "entity_name", "cust_entity_name", "entity_icon_name", "entity_url", "priority"] 
        }],
        order: [["priority", "ASC"], [{ model: ModuleEntityMaster, as: 'entities' }, 'priority', 'ASC']],
      }, null, false, false),

      // C. Configuration
      commonQuery.findAllRecords(CompanyConfigration, { company_id, status: 0 }, {}, null, false),
      
      // D. Permissions (For generating constants)
      commonQuery.findAllRecords(Permission, {}, {
        attributes: ['id', 'action', 'module_id', 'entity_id'],
        include: [
          { model: ModuleMaster, as: 'module', attributes: ['module_name'] },
          { model: ModuleEntityMaster, as: 'entity', attributes: ['entity_name', 'cust_entity_name'] }
        ]
      }, null, false, false)
    ]);

    // Validate Data
    if (!companyList || companyList.length === 0) {
        await transaction.rollback();
        return res.error(constants.NOT_FOUND, { message: "No associated companies found." });
    }

    // Settings Object
    const settingsObject = {};
    if (companySettings && Array.isArray(companySettings)) {
      for (const setting of companySettings) settingsObject[setting.setting_key] = setting.setting_value;
    }

    // Enrich Company List
    const enrichedCompanyList = companyList.map(company => {
      const companyData = company.toJSON();
      const countryName = companyData.country ? companyData.country.country_name : null;
      const stateName = companyData.state ? companyData.state.state_name : null;
      delete companyData.country; delete companyData.state;
      return { 
          ...companyData, 
          country_name: countryName, 
          state_name: stateName, 
          logo_image_url: companyData.logo_image ? `${process.env.FILE_SERVER_URL}${constants.COMPANY_LOGO_IMG_FOLDER}${companyData.logo_image}` : null 
      };
    });

    // Enrich User
    const userJson = userData.toJSON();
    const enrichedUserData = { 
        ...userJson, 
        permission: userData.ComapanyRole?.[0]?.permissions ?? userData.permission, 
        profile_image_url: userData.profile_image ? `${process.env.FILE_SERVER_URL}${constants.USER_IMG_FOLDER}${userData.profile_image}` : null 
    };
    
    // Find Current Company
    const companyIndex = companyList.findIndex(c => c.id === company_id);
    const currentCompany = companyIndex !== -1 ? enrichedCompanyList[companyIndex] : enrichedCompanyList[0];

    // Currency
    let currencyDetails = null;
    if (currentCompany.currency_id) {
      const currencyData = await commonQuery.findOneRecord(CurrencyMaster, { id: settingsObject.default_currency || 67 }, {}, null, false, false); // Default to INR if missing
      if (currencyData) {
        currencyDetails = { 
            currency_id: currencyData.id, 
            currency_name: currencyData.currency_name, 
            currency_symbol: currencyData.currency_symbol, 
            currency_rate: currencyData.currency_rate, 
            currency_code: currencyData.currency_code 
        };
      }
    }

    // --- PERMISSION MAP GENERATION ---
    const formatKey = (str) => str ? str.toUpperCase().replace(/[^A-Z0-9]/g, '_') : 'UNKNOWN';
    const entityPermissionMap = {};

    if (allPermissions && allPermissions.length > 0) {
      allPermissions.forEach(p => {
        // We look for 'VIEW' or 'READ' to link the Sidebar Item to a Permission
        if (p.action && (p.action.toLowerCase() === 'view' || p.action.toLowerCase() === 'read')) {
            const modKey = formatKey(p.module ? p.module.module_name : '');
            const entKey = formatKey(p.entity ? (p.entity.cust_entity_name || p.entity.entity_name) : '');
            const actKey = formatKey(p.action);
            
            // Format: MODULE.ENTITY.ACTION
            const permString = `${modKey}.${entKey}.${actKey}`;
            
            if(p.entity_id) {
                entityPermissionMap[p.entity_id] = permString;
            }
        }
      });
    }

    // --- SUBSCRIPTION & ACCESS FILTERING ---
    
    // 1. Get Consolidated Subscription (Plan + Addons)
    const finalSubscriptionData = await getCompanySubscription(companyId);
    
    // 2. Parse Allowed Module IDs (Company License)
    let companyAllowedEntityIds = [];
    if (finalSubscriptionData && finalSubscriptionData.allowed_module_ids) {
        companyAllowedEntityIds = normalizeCompanyAccess(finalSubscriptionData.allowed_module_ids);
    }

    // 3. Define System Removal Flags (Feature Toggles)
    const removalEntity = [];
    const toBool = val => val === true || val === 'true';
    if (!toBool(settingsObject.enable_multi_branch)) removalEntity.push(constants.BRANCH_ENTITY_ID); // e.g. 5
    if (!toBool(settingsObject.enable_multi_godown)) removalEntity.push(constants.GODOWN_ENTITY_ID, constants.ADMINISATOR_GODOWN_ENTITY_ID);

    // 4. Filter Sidebar (Hierarchy)
    const plainSidebarModuleList = sidebarModuleList.map(item => item.get({ plain: true }));
    
    const filteredSidebarModuleList = plainSidebarModuleList.map(module => {
        // Filter Entities within the Module
        const filteredEntities = (module.entities || []).filter(entity => {
            // A. Check System Feature Flags
            if (removalEntity.includes(entity.id)) return false;
            
            // B. Check Company License (Subscription)
            if (companyAllowedEntityIds && !companyAllowedEntityIds.includes(String(entity.id)) && process.env.BYPASS_PERMISSION !== "true") {
                return false;
            }
            return true;
        }).map(entity => {
            // Inject Permission String
            return {
                ...entity,
                permission: entityPermissionMap[entity.id] || null
            };
        });

        return { ...module, entities: filteredEntities };
    }).filter(module => module.entities.length > 0); // Remove empty modules

    // --- PLAN STATUS CALCULATION ---
    let planStatus = "no_plan";
    if (finalSubscriptionData) {
        if (currentCompany.status === 3) {
            planStatus = "account_suspended";
        } else if (finalSubscriptionData.status === 0) {
            planStatus = "active";
        } else if (finalSubscriptionData.status === 1) {
             // Check if within grace period (logic can be expanded based on your needs)
             planStatus = "expired";
        }
    }

    const sessionData = {
      company_list: enrichedCompanyList,
      company: currentCompany,
      user: enrichedUserData,
      sidebarModule: filteredSidebarModuleList,
      currency: currencyDetails,
      settings: settingsObject,
      companySubscription: finalSubscriptionData,
      planStatus: planStatus
    };

    await transaction.commit();
    return res.ok(sessionData);

  } catch (err) {
    console.error("Session Data Error:", err);
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};