const { User, CompanyMaster, ModuleMaster, ModuleEntityMaster, CountryMaster, CurrencyMaster, StateMaster, CompanyConfigration, UserCompanyRoles, Permission, BranchMaster, EmployeeSettings, RolePermission } = require("../../../models");
const { sequelize, commonQuery, handleError, Op, constants, getCompanySubscription } = require("../../../helpers");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const { getContext } = require("../../../utils/requestContext.js");
const { clearUserCache } = require("../../../helpers/permissionCache.js");
const { generateToken } = require("../../../helpers/tokenHelper");

const normalizeCompanyAccess = (access) => {
  if (Array.isArray(access)) return access.map(String);
  if (typeof access === "string") return access.split(",").map((id) => id.trim()).filter(Boolean);
  return [];
};

const normalizeBranchAccess = (access) => {
  if (Array.isArray(access)) return access.map(String);
  if (typeof access === "string") return access.split(",").map((id) => id.trim()).filter(Boolean);
  return [];
};

exports.sessionData = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { user_id, company_id, branch_id } = getContext();

    // 1. Validate Company (Standard Sequelize)
    const record = await CompanyMaster.findOne({
        where: { id: company_id },
        attributes: ['id', 'company_id', 'organization_id'],
        transaction
    });

    if (!record) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND, { message: "Invalid or missing company record." });
    }

    let orgId = record.organization_id;

    // 2. Fetch User & Access Logic (Standard Sequelize)
    const userData = await User.findOne({
      where: { id: user_id },
      attributes: ['id', 'user_name', 'email', 'role_id', 'is_super_admin', 'mobile_no', 'profile_image', 'company_access', 'branch_access', 'is_login', 'status', 'branch_id', 'company_id', 'employee_id'],
      include: [{ 
          model: RolePermission, 
          as: "RolePermission", 
          attributes: ["permissions", "role_key"],
          required: false 
      }],
      transaction
    });
    
    if (!userData) {
        await transaction.rollback();
        return res.error(constants.USER_NOT_FOUND);
    }

    const isAdmin = userData.is_super_admin || userData.RolePermission?.role_key === constants.ROLE_KEYS.BUSINESS_ADMIN || userData.RolePermission?.role_key === constants.ROLE_KEYS.ADMIN;

    const companyAccessList = normalizeCompanyAccess(userData.company_access || "");
    if (!isAdmin && companyAccessList.length === 0) {
      await transaction.rollback();
      return res.error(constants.FORBIDDEN, { message: "User does not have access to any companies." });
    }
    
    // Check if user has a role assigned for this specific company/branch
    if (!userData.RolePermission?.permissions && !isAdmin) {
      await transaction.rollback();
      return res.error(constants.FORBIDDEN, { message: "User does not have a role assigned in this company." });
    }

    let where = {};
    if (isAdmin) {
      where = {
        organization_id: orgId,
        status: { [Op.ne]: 2 }
      };
    } else {
      where = { id: { [Op.in]: companyAccessList }, status: { [Op.ne]: 2 } };
    }

    // 3. Fetch Core Data (Parallel - Standard Sequelize)
    const [companyList, sidebarModuleList, companySettings, allPermissions, branchList, employeeSettings, totalCompanyBranches] = await Promise.all([
      // A. Company List
      CompanyMaster.findAll({
        where: where,
        include: [
          { model: CountryMaster, as: 'country', attributes: ['country_name'], required: false },
          { model: StateMaster, as: 'state', attributes: ['state_name'], required: false },
        ],
        order: [['id', 'ASC']],
        nest: true,
        // raw: false // Sequelize defaults to instances, which calls toJSON() later
        transaction
      }),

      // B. Sidebar Modules (Hierarchical)
      ModuleMaster.findAll({
        where: { status: 0 },
        attributes: ["id", "module_name", "cust_module_name", "module_icon_name", "module_url", "priority"],
        include: [{ 
            model: ModuleEntityMaster, 
            as: "entities", 
            required: false, 
            where: { status: 0, entity_visiblity: 1 }, 
            attributes: ["id", "entity_name", "cust_entity_name", "entity_icon_name", "entity_url", "priority"] 
        }],
        order: [
            ["priority", "ASC"], 
            [{ model: ModuleEntityMaster, as: 'entities' }, 'priority', 'ASC']
        ],
        transaction
      }),

      // C. Configuration
      CompanyConfigration.findAll({
          where: { company_id, status: 0 },
          transaction
      }),
      
      // D. Permissions
      Permission.findAll({
        attributes: ['id', 'action', 'module_id', 'entity_id'],
        include: [
          { model: ModuleMaster, as: 'module', attributes: ['module_name'] },
          { model: ModuleEntityMaster, as: 'entity', attributes: ['entity_name', 'cust_entity_name'] }
        ],
        transaction
      }),

      // E. Branch List
      BranchMaster.findAll({ 
          where: { 
              company_id: record.id, 
              status: 0,
              ...(!isAdmin && normalizeBranchAccess(userData.branch_access).length > 0 ? {
                  id: { [Op.in]: normalizeBranchAccess(userData.branch_access) }
              } : {})
          },
          attributes: ['id', 'branch_name', 'city', 'country_id', 'state_id'],
          order: [["id", "ASC"]],
          transaction
      }),

          // F. Employee Settings
      EmployeeSettings.findAll({
          where: { 
              company_id: company_id, 
              status: 0 
          },
          attributes: ['id', 'settings_name', 'settings_value'],
          transaction
      }),

      // G. Total Branches Count
      BranchMaster.count({
          where: { company_id: record.id, status: 0 },
          transaction
      })
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
      const companyData = company.toJSON(); // Standard Sequelize method
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
        permission: userData.RolePermission?.permissions ?? null, 
        branch_access: userData.branch_access || "",
        profile_image_url: userData.profile_image ? `${process.env.FILE_SERVER_URL}${constants.USER_IMG_FOLDER}${userData.profile_image}` : null 
    };

    delete enrichedUserData.RolePermission;
    
    // Find Current Company
    // Force Number conversion to fix string vs int issues
    const companyIndex = companyList.findIndex(c => Number(c.id) === Number(company_id));
    const currentCompany = companyIndex !== -1 ? enrichedCompanyList[companyIndex] : enrichedCompanyList[0];

    // Currency
    let currencyDetails = null;
    if (currentCompany.currency_id) {
      // Standard Sequelize findOne
      const currencyData = await CurrencyMaster.findOne({ 
          where: { id: settingsObject.default_currency || 67 },
          transaction
      });
      
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
        if (p.action && (p.action.toLowerCase() === 'view' || p.action.toLowerCase() === 'read')) {
            const modKey = formatKey(p.module ? p.module.module_name : '');
            const entKey = formatKey(p.entity ? (p.entity.cust_entity_name || p.entity.entity_name) : '');
            const actKey = formatKey(p.action);
            const permString = `${modKey}.${entKey}.${actKey}`;
            
            if(p.entity_id) {
                entityPermissionMap[p.entity_id] = permString;
            }
        }
      });
    }

    // --- SUBSCRIPTION & ACCESS FILTERING ---
    let finalSubscriptionData = await getCompanySubscription(company_id);
    let companyAllowedEntityIds = [];
    if (finalSubscriptionData && finalSubscriptionData.allowed_module_ids) {
        companyAllowedEntityIds = normalizeCompanyAccess(finalSubscriptionData.allowed_module_ids);
    }

    const removalEntity = [];
    const toBool = val => val === true || val === 'true';
    if (!toBool(settingsObject.enable_multi_branch)) removalEntity.push(constants.BRANCH_ENTITY_ID);
    if (!toBool(settingsObject.enable_multi_godown)) removalEntity.push(constants.GODOWN_ENTITY_ID, constants.ADMINISATOR_GODOWN_ENTITY_ID);

    const plainSidebarModuleList = sidebarModuleList.map(item => item.get({ plain: true }));
    
    const filteredSidebarModuleList = plainSidebarModuleList.map(module => {
        const filteredEntities = (module.entities || []).filter(entity => {
            if (removalEntity.includes(entity.id)) return false;
            return true;
        }).map(entity => {
            return {
                ...entity,
                permission: entityPermissionMap[entity.id] || null
            };
        });

        return { ...module, entities: filteredEntities };
    }).filter(module => {
        if (module.module_name === 'Administration' && process.env.NODE_ENV !== 'local') {
            return false;
        }
        
        // Keep the module if it has at least one visible entity
        return module.entities.length > 0;
    });

    let planStatus = "active";
    // if (finalSubscriptionData) {
    //     if (currentCompany.status === 3) {
    //         planStatus = "account_suspended";
    //     } else if (finalSubscriptionData.status === 0) {
    //         planStatus = "active";
    //     } else if (finalSubscriptionData.status === 1) {
    //          planStatus = "expired";
    //     }
    // }
    if (!finalSubscriptionData) {
        finalSubscriptionData = {};
    }
    finalSubscriptionData.status = 0;
    finalSubscriptionData.users_limit = 100000;
    finalSubscriptionData.companies_limit = 100000;

    let currentBranch = null;
    if (branchList && branchList.length > 0) {
        if (branch_id === 0) {
            currentBranch = { id: 0, branch_name: "All Branches" };
        } else if (branch_id) {
            currentBranch = branchList.find(b => b.id === branch_id);
        }
        
        if (!currentBranch) {
            currentBranch = branchList[0];
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
      planStatus: planStatus,
      branch_list: branchList, 
      branch: currentBranch,
      total_company_branches: totalCompanyBranches,
      employeeSettings: employeeSettings || []
    };

    await transaction.commit();
    return res.ok(sessionData);

  } catch (err) {
    console.error("Session Data Error:", err);
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};


exports.switchCompany = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { user_id } = getContext();
    const company_id = req.query.company_id;

    if (!company_id) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, { message: "Company ID is required." });
    }

    // 1. Fetch User (Standard Sequelize)
    const user = await User.findOne({
      where: { id: user_id, status: 0 },
      include: [{ model: RolePermission, as: 'RolePermission', attributes: ['role_key'] }],
      transaction
    });

    if (!user) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND, { message: "User not found." });
    }

    // 2. Validate Access
    const isAdminUser = user.is_super_admin || user.RolePermission?.role_key === constants.ROLE_KEYS.BUSINESS_ADMIN || user.RolePermission?.role_key === constants.ROLE_KEYS.ADMIN;
    const companyAccessList = normalizeCompanyAccess(user.company_access || "");
    if (!isAdminUser && !companyAccessList.includes(String(company_id))) {
      await transaction.rollback();
      return res.error(constants.FORBIDDEN, { message: "You do not have access to this company." });
    }

    // 3. Validate Company (Standard Sequelize)
    const company = await CompanyMaster.findOne({
      where: { 
        id: company_id, 
        status: { [Op.ne]: 2 } 
      },
      attributes: ['id', 'organization_id'],
      transaction
    });

    if (!company) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND, { message: "Selected company is inactive or not found." });
    }

    // --- Find a Valid Branch for the NEW Company (Standard Sequelize) ---
    const branchAccessList = normalizeBranchAccess(user.branch_access || "");

    const defaultBranch = await BranchMaster.findOne({
      where: { 
        company_id: company_id,
        status: { [Op.ne]: 2 },
        ...(!isAdminUser && branchAccessList.length > 0 ? {
          id: { [Op.in]: branchAccessList }
        } : {})
      },
      attributes: ['id'],
      transaction
    });

    const newBranchId = defaultBranch ? defaultBranch.id : 0;

    // 4. Generate New Token
    user.branch_id = newBranchId;
    user.organization_id = company.organization_id || null;
    const newToken = generateToken(user, company_id, "web login");

    clearUserCache(user.user_id || user.id);

    await transaction.commit();

    return res.ok({ 
      token: newToken, 
      message: "Switched company successfully",
      current_company_id: company_id,
      current_branch_id: newBranchId 
    });

  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};

/**
 * Switch Branch (Updates Token)
 */
exports.switchBranch = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { user_id, company_id, organization_id } = getContext();
    const branch_id = req.query.branch_id;

    if (!branch_id) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, { message: "Branch ID is required." });
    }

    // 1. Fetch User with Role (Standard Sequelize)
    const user = await User.findOne({
        where: { id: user_id, status: 0 },
        include: [{ model: RolePermission, as: 'RolePermission', attributes: ['role_key'] }],
        transaction
    });

    if (!user) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND, { message: "User not found." });
    }

    let finalBranchId = branch_id;
    if (branch_id == 0) {
        finalBranchId = 0;
    } else {
        // 2. Validate Branch (Standard Sequelize)
        const branch = await BranchMaster.findOne({
            where: { 
                id: branch_id, 
                company_id: company_id, // Security check
                status: { [Op.ne]: 2 } 
            },
            transaction
        });

        if (!branch) {
          await transaction.rollback();
          return res.error(constants.NOT_FOUND, { message: "Branch not found or does not belong to this company." });
        }

        // 2.1 Validate Branch Access for non-super admins
        const isBranchAdmin = user.is_super_admin || user.RolePermission?.role_key === constants.ROLE_KEYS.BUSINESS_ADMIN || user.RolePermission?.role_key === constants.ROLE_KEYS.ADMIN;
        const branchAccessList = normalizeBranchAccess(user.branch_access || "");
        if (!isBranchAdmin && branchAccessList.length > 0 && !branchAccessList.includes(String(branch_id))) {
            await transaction.rollback();
            return res.error(constants.FORBIDDEN, { message: "You do not have access to this branch." });
        }
        finalBranchId = branch.id;
    }

    // 3. Generate New Token
    user.branch_id = finalBranchId;
    user.organization_id = organization_id || null;
    const newToken = generateToken(user, company_id, "web login");

    clearUserCache(user.user_id || user.id);

    await transaction.commit();

    return res.ok({ 
      token: newToken, 
      message: "Switched branch successfully",
      current_branch_id: finalBranchId 
    });

  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};