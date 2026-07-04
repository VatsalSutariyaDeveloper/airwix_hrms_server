const { User, CompanyMaster, ModuleMaster, ModuleEntityMaster, CountryMaster, CurrencyMaster, StateMaster, CompanyConfigration, UserCompanyRoles, Permission, BranchMaster, EmployeeSettings, RolePermission, Employee, CompanySettings, AttendanceTemplate, EmployeeAttendanceTemplate } = require("../../../models");
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
        attributes: ["role_key", "role_name"],
        required: false
      }],
      transaction
    });

    if (!userData) {
      await transaction.rollback();
      return res.error(constants.USER_NOT_FOUND);
    }

    const permissions = await commonQuery.findOneRecord(
      RolePermission,
      { role_key: userData.RolePermission.role_key, status: 0 },
      {
        attributes: ["permissions", "role_name"],
      },
      null,
      false,
      { company_id: true }
    );

    if (!permissions) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND, { message: `Your role (${userData.RolePermission.role_name}) not exist in this company. Please Contact Admin.` });
    }

    // Fetch employee data if employee_id exists
    let employeeData = null;
    if (userData.employee_id) {
      employeeData = await Employee.findOne({
        where: { id: userData.employee_id },
        attributes: ['id', 'profile_image', 'first_name', 'employee_code'],
        transaction
      });
    }

    const isAdmin = userData.is_super_admin || userData.RolePermission?.role_key === constants.ROLE_KEYS.BUSINESS_ADMIN;

    let companyAccessList = normalizeCompanyAccess(userData.company_access || "");
    if (userData.company_id && !companyAccessList.includes(String(userData.company_id))) {
      companyAccessList.push(String(userData.company_id));
    }

    if (!isAdmin && companyAccessList.length === 0) {
      await transaction.rollback();
      return res.error(constants.FORBIDDEN, { message: "User does not have access to any companies." });
    }

    // Check if user has a role assigned for this specific company/branch
    if (!permissions?.permissions && !isAdmin) {
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
    const [companyList, sidebarModuleList, companySettings, allPermissions, branchList, employeeSettings, totalCompanyBranches, companySettingsList] = await Promise.all([
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
        attributes: ["id", "module_name", "cust_module_name", "module_icon_name", "module_url", "priority", "platform_type"],
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
          status: 0,
          company_id: {
            [Op.in]: sequelize.literal(
              isAdmin
                ? `(SELECT id FROM company_master WHERE organization_id = ${orgId} AND status != 2)`
                : `(SELECT id FROM company_master WHERE id IN (${companyAccessList.map(Number).join(',') || 0}) AND status != 2)`
            )
          },
          ...(!isAdmin && normalizeBranchAccess(userData.branch_access).length > 0 ? {
            id: { [Op.in]: normalizeBranchAccess(userData.branch_access) }
          } : {})
        },
        attributes: ['id', 'branch_name', 'city', 'country_id', 'state_id', 'company_id'],
        order: [["id", "ASC"]],
        transaction
      }),

      // F. Employee Settings
      EmployeeSettings.findAll({
        where: {
          company_id: company_id,
          branch_id: branch_id,
          status: 0
        },
        attributes: ['id', 'settings_name', 'settings_value'],
        transaction
      }),

      // G. Total Branches Count
      BranchMaster.count({
        where: { company_id: record.id, status: 0 },
        transaction
      }),

      // H. Company Settings
      CompanySettings.findAll({
        where: {
          company_id: company_id,
          status: 0
        },
        attributes: ['id', 'settings_name', 'settings_value'],
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
      permission: permissions?.permissions ?? null,
      branch_access: userData.branch_access || "",
      profile_image_url: employeeData?.profile_image ? `${process.env.FILE_SERVER_URL}${constants.EMPLOYEE_IMG_FOLDER}${employeeData.profile_image}` : null,
      is_attendance_supervisor: userData.RolePermission.role_key === constants.ROLE_KEYS.ATTENDANCE_SUPERVISOR ? true : false,
      is_reporting_manager: userData.RolePermission.role_key === constants.ROLE_KEYS.REPORTING_MANAGER ? true : false,
      role_name: permissions?.role_name
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

          if (p.entity_id) {
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

    // Get the login client type from request token context (web vs application)
    const isMobileRequest = req.user && req.user.access_by === "application"; // access 'application' corresponds to mobile client tokens
    const filteredSidebarModuleList = plainSidebarModuleList.map(module => {
      // Filter by platform type at the module level
      const platform = (module.platform_type || "web").toLowerCase();
      if (isMobileRequest) {
        if (platform !== "mobile" && platform !== "both") {
          return { ...module, entities: [] };
        }
      } else {
        if (platform !== "web" && platform !== "both") {
          return { ...module, entities: [] };
        }
      }

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
      employee: employeeData,
      sidebarModule: filteredSidebarModuleList,
      currency: currencyDetails,
      settings: settingsObject,
      companySubscription: finalSubscriptionData,
      planStatus: planStatus,
      branch_list: branchList,
      branch: currentBranch,
      total_company_branches: totalCompanyBranches,
      employeeSettings: employeeSettings || [],
      company_settings: companySettingsList || [],
      selectedCompanyIds: req.user.selectedCompanyIds || (currentCompany ? [currentCompany.id] : [])
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
    const company_id = req.body.company_id;

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

    // 2. Validate Company (Standard Sequelize)
    const company = await CompanyMaster.findOne({
      where: {
        id: company_id,
        status: { [Op.ne]: 2 }
      },
      attributes: ['id', 'organization_id', 'company_id'],
      transaction
    });

    if (!company) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND, { message: "Selected company is inactive or not found." });
    }

    // 3. Validate Access
    const isAdminUser = user.is_super_admin || user.RolePermission?.role_key === constants.ROLE_KEYS.BUSINESS_ADMIN || user.RolePermission?.role_key === constants.ROLE_KEYS.ADMIN;
    const companyAccessList = normalizeCompanyAccess(user.company_access || "");
    if (!isAdminUser && !companyAccessList.includes(String(company_id)) && !companyAccessList.includes(String(company.company_id))) {
      await transaction.rollback();
      return res.error(constants.FORBIDDEN, { message: "You do not have access to this company." });
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
    
    // Fetch supervisor and manager flags
    if (user.employee_id) {
      const employee = await Employee.findOne({
        where: { id: user.employee_id },
        attributes: ['is_attendance_supervisor', 'is_reporting_manager'],
        transaction
      });
      if (employee) {
        user.is_attendance_supervisor = employee.is_attendance_supervisor;
        user.is_reporting_manager = employee.is_reporting_manager;
      }
    }

    let selected_company_ids = Array.isArray(req.body.selected_company_ids) 
      ? [...req.body.selected_company_ids] 
      : [];

    if (!selected_company_ids.includes(company_id) && !selected_company_ids.includes(String(company_id)) && !selected_company_ids.includes(Number(company_id))) {
      selected_company_ids.unshift(company_id);
    }

    const newToken = generateToken({
      ...(user.get ? user.get({ plain: true }) : user),
      role_key: user.RolePermission?.role_key,
      is_attendance_supervisor: user.is_attendance_supervisor,
      is_reporting_manager: user.is_reporting_manager,
      selectedCompanyIds: selected_company_ids
    }, company_id, "web login");

    clearUserCache(user.user_id || user.id);

    await transaction.commit();

    return res.ok({
      token: newToken,
      message: "Switched company successfully",
      current_company_id: company_id,
      current_branch_id: newBranchId,
      selected_company_ids
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
    
    // Fetch supervisor and manager flags
    if (user.employee_id) {
      const employee = await Employee.findOne({
        where: { id: user.employee_id },
        attributes: ['is_attendance_supervisor', 'is_reporting_manager'],
        transaction
      });
      if (employee) {
        user.is_attendance_supervisor = employee.is_attendance_supervisor;
        user.is_reporting_manager = employee.is_reporting_manager;
      }
    }

    const newToken = generateToken({
      ...(user.get ? user.get({ plain: true }) : user),
      role_key: user.RolePermission?.role_key,
      is_attendance_supervisor: user.is_attendance_supervisor,
      is_reporting_manager: user.is_reporting_manager
    }, company_id, "web login");

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

exports.getCompanySettingsData = async (req, res) => {
  try {
    const user = req.user

    // Fetch specific company settings
    const settings = await commonQuery.findAllRecords(CompanySettings, {
      settings_name: {
        [Op.in]: ['show_accuracy', 'punch_cooldown_seconds', 'leave_past_datelimit', 'face_accuracy_matcher_percentage', 'face_engine_version']
      },
      status: 0
    }, {
      attributes: ['settings_name', 'settings_value']
    }, null, { company_id: true });

    let enableOutDuty = false;
    let finesAllowed = true;
    let overtimeAllowed = true;

    // If user has employee_id, fetch enble_out_duty from EmployeeAttendanceTemplate
    if (user.employee_id) {
      const employeeAttendanceTemplate = await commonQuery.findOneRecord(EmployeeAttendanceTemplate, {
        employee_id: user.employee_id,
        status: 0
      }, {
        attributes: ['enble_out_duty', 'fines_allowed', 'overtime_allowed']
      });

      if (employeeAttendanceTemplate) {
        enableOutDuty = employeeAttendanceTemplate.enble_out_duty;
        finesAllowed = employeeAttendanceTemplate.fines_allowed;
        overtimeAllowed = employeeAttendanceTemplate.overtime_allowed;
      }
    }

    // Fetch full user role details and permissions to pass to frontend
    let userPermissions = null;
    let isAttendanceSupervisor = false;
    let isReportingManager = false;
    let roleKey = user.role_key || null;
    let allowedClients = "web";
    let mobileModules = [];

    if (user.id) {
      const fullUserData = await User.findOne({
        where: { id: user.id },
        include: [{
          model: RolePermission,
          as: "RolePermission",
          attributes: ["role_key", "role_name", "permissions", "allowed_clients"],
          required: false
        }]
      });

      if (fullUserData && fullUserData.RolePermission) {
        userPermissions = fullUserData.RolePermission.permissions;
        isAttendanceSupervisor = fullUserData.RolePermission.role_key === constants.ROLE_KEYS.ATTENDANCE_SUPERVISOR;
        isReportingManager = fullUserData.RolePermission.role_key === constants.ROLE_KEYS.REPORTING_MANAGER;
        roleKey = fullUserData.RolePermission.role_key;
        allowedClients = fullUserData.RolePermission.allowed_clients || "web";
      }

      // If user access is 'employee' (meaning mobile client), fetch and filter modules & entities
      if (user.access === "employee") {
        const rawModules = await ModuleMaster.findAll({
          where: { status: 0, platform_type: { [Op.in]: ['mobile', 'both'] } },
          attributes: ["id", "module_name", "cust_module_name", "module_icon_name", "module_url", "priority", "platform_type"],
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
          ]
        });

        // Parse permissions mapping
        const allPermissions = await Permission.findAll({
          attributes: ['id', 'action', 'module_id', 'entity_id'],
          include: [
            { model: ModuleMaster, as: 'module', attributes: ['module_name'] },
            { model: ModuleEntityMaster, as: 'entity', attributes: ['entity_name', 'cust_entity_name'] }
          ]
        });

        const formatKey = (str) => str ? str.toUpperCase().replace(/[^A-Z0-9]/g, '_') : 'UNKNOWN';
        const entityPermissionMap = {};
        allPermissions.forEach(p => {
          if (p.action && (p.action.toLowerCase() === 'view' || p.action.toLowerCase() === 'read')) {
            const modKey = formatKey(p.module ? p.module.module_name : '');
            const entKey = formatKey(p.entity ? (p.entity.cust_entity_name || p.entity.entity_name) : '');
            const actKey = formatKey(p.action);
            if (p.entity_id) {
              entityPermissionMap[p.entity_id] = `${modKey}.${entKey}.${actKey}`;
            }
          }
        });

        const plainModules = rawModules.map(item => item.get({ plain: true }));
        mobileModules = plainModules.map(module => {
          const platform = (module.platform_type || "web").toLowerCase();
          if (platform !== "mobile" && platform !== "both") {
            return { ...module, entities: [] };
          }

          const filteredEntities = (module.entities || []).map(entity => {
            return {
              ...entity,
              permission: entityPermissionMap[entity.id] || null
            };
          });
          return { ...module, entities: filteredEntities };
        }).filter(module => module.entities.length > 0);
      }
    }

    const faceEngineVersionSetting = settings.find(s => s.settings_name === 'face_engine_version');
    const faceEngineVersion = faceEngineVersionSetting ? faceEngineVersionSetting.settings_value : 'v1';

    const response = {
      settings: settings,
      face_engine_version: faceEngineVersion,
      enble_out_duty: enableOutDuty,
      fines_allowed: finesAllowed,
      overtime_allowed: overtimeAllowed,
      mobile_modules: mobileModules,
      user_permission: {
        permissions: userPermissions,
        is_attendance_supervisor: isAttendanceSupervisor || !!user.is_attendance_supervisor,
        is_reporting_manager: isReportingManager || !!user.is_reporting_manager,
        role_key: roleKey,
        allowed_clients: allowedClients
      }
    };

    return res.ok(response);

  } catch (err) {
    return handleError(err, res, req);
  }
};