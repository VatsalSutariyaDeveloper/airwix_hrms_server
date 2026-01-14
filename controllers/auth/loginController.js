const { LoginHistory, User, CompanyMaster, BranchMaster, ModuleMaster, ModuleEntityMaster, CountryMaster, CurrencyMaster, StateMaster, CompanyConfigration, CompanySubscription, SubscriptionPlan, UserCompanyRoles, Permission,} = require("../../models"); // Added Company and Branch models
const { sequelize, commonQuery, handleError, Op, constants, otpService, getCompanySubscription } = require("../../helpers");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const UAParser = require("ua-parser-js");
const geoip = require("geoip-lite");
const otpRateLimit = require("../../helpers/otpRateLimit");
const moment = require('moment');
const { clearUserCache } = require("../../helpers/permissionCache");
const { createOrUpdateNotification } = require("../../helpers/functions/commonFunctions");
const { getContext } = require("../../utils/requestContext.js");

const normalizeCompanyAccess = (access) => {
  if (Array.isArray(access)) return access.map(String);
  if (typeof access === "string") return access.split(",").map((id) => id.trim()).filter(Boolean);
  return [];
};

/**
 * 1. Send OTP for Login
 * - Checks if user EXISTS (Unlike registration, where user must NOT exist)
 * - Uses otpService
 */
exports.sendLoginOtp = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { mobile_no } = req.body;
    
    // 1. Validate Mobile Format
    const indianMobileRegex = /^[6-9]\d{9}$/;
    if (!mobile_no || !indianMobileRegex.test(mobile_no)) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, { errors: ["Invalid mobile number."] });
    }

    // 2. Check User Exists (Must exist for login)
    const user = await commonQuery.findOneRecord(User, { mobile_no, status: 0 }, {}, transaction);
    
    if (!user) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND, { message: "Mobile number not registered." });
    }

    // 3. Check OTP Rate Limit
    const limitCheck = await otpRateLimit.checkRateLimit(mobile_no);
    
    if (!limitCheck.allowed) {
      const mins = Math.ceil(limitCheck.remaining_seconds / 60);
      await transaction.rollback();

      return res.status(400).json({
        code: 400,
        status: "TOO_MANY_REQUESTS",
        message: `Too many OTP attempts. Try again in ${mins} minutes.`,
        remaining_seconds: limitCheck.remaining_seconds
      });
    }

    // Increase attempt count
    await otpRateLimit.increaseAttempt(mobile_no);

    // 4. Use OTP Service
    const otp = await otpService.sendOtp(mobile_no, transaction);

    await transaction.commit();
    return res.ok({ dev_otp: otp });

  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};

/**
 * 2. Login (Handles Email/Pass OR Mobile/OTP)
 */
exports.login = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { email, password, mobile_no, otp } = req.body;

    let user = null;
    let loginMethod = ""; // "PASSWORD" or "OTP"

    // --- A. DETERMINE LOGIN METHOD ---
    
    if (email && password) {
        // CASE 1: Email & Password
        loginMethod = "PASSWORD";
        user = await commonQuery.findOneRecord(User, { email, status: 0 }, {}, transaction, false, false);
        
        if (!user) {
            await transaction.rollback();
            return res.error(constants.INVALID_CREDENTIALS);
        }

        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
            await transaction.rollback();
            return res.error(constants.INVALID_CREDENTIALS);
        }

    } else if (mobile_no && otp) {
        // CASE 2: Mobile & OTP
        loginMethod = "OTP";
        
        // 1. Find User
        user = await commonQuery.findOneRecord(User, { mobile_no, status: 0 }, {}, transaction, false, false);
        if (!user) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND, { message: "Mobile number not registered." });
        }

        // 2. Verify OTP using Service
        try {
            await otpService.verifyOtp(mobile_no, otp);
        } catch (e) {
            await transaction.rollback();
            // Pass the custom status/message from otpService directly
            if (e.status && e.message) {
                return res.error(e.status, { message: e.message });
            }
            throw e; // Unexpected errors go to main catch
        }

        // 3. Cleanup OTP (Security)
        await otpService.cleanupOtp(mobile_no, transaction);

    } else {
        await transaction.rollback();
        return res.error(constants.VALIDATION_ERROR, { message: "Please provide Email/Password OR Mobile/OTP." });
    }

    // --- B. COMMON LOGIN CHECKS (Company, Branch, etc.) ---

    // 1. Validate Company
    if (!user.company_id) {
      await transaction.rollback();
      return res.error(401, "No company linked to your account.");
    }

    const company = await commonQuery.findOneRecord(
      CompanyMaster,
      { id: user.company_id },
      {},
      transaction, false, false
    );
    if (!company) {
      await transaction.rollback();
      return res.error(401, "Your assigned company account is suspended.");
    }

    // 2. Validate Branch
    if (!user.branch_id) {
      await transaction.rollback();
      return res.error(401, "No branch assigned to your profile.");
    }

    const branch = await commonQuery.findOneRecord(
      BranchMaster,
      { id: user.branch_id },
      {},
      transaction, false, false
    );
    if (!branch) {
      await transaction.rollback();
      return res.error(401, "Your assigned branch is inactive.");
    }

    // --- C. GENERATE TOKEN & HISTORY ---

    const record = await commonQuery.findOneRecord(
        CompanyMaster, 
        user.company_id,
        { attributes: ['id', 'company_id'] },
        transaction, false, false
    );
    
    if (!record) {
        return res.error(constants.NOT_FOUND, { message : "Invalid or missing company record."});
    }

    let companyId = record.company_id || record.id;

    const companyAccessList = normalizeCompanyAccess(user.company_access || "");
    if (user.role_id != 1 && companyAccessList.length === 0) {
      return res.error(constants.FORBIDDEN, {message: "User does not have access to any companies."});
    }

    let where = {};
    if (user.role_id == 1){
      where = {
        [Op.or]: [{ id: companyId }, { company_id: companyId }],
        status: { [Op.ne]: 2 }
      };
    } else {
      where = { id: { [Op.in]: companyAccessList }, status: { [Op.ne]: 2 } };
    }

    const companyList = await commonQuery.findAllRecords(CompanyMaster, where, {raw: true}, null, false);
    const defaultCompanyId = companyList?.find(c => c.is_default == 1)?.id || companyList[0]?.id;

    const token = jwt.sign(
      {
        id: user.id,
        role_id: user.role_id,
        branch_id: user.branch_id,
        company_id: defaultCompanyId
      },
      process.env.JWT_SECRET || "your_jwt_secret",
      { expiresIn: "1d" }
    );

    // Parse User Agent
    const parser = new UAParser(req.headers["user-agent"]);
    const uaResult = parser.getResult();
    let ip_address =
      req.headers["x-forwarded-for"]?.split(",")[0] ||
      req.connection.remoteAddress ||
      "127.0.0.1";
    const geo = geoip.lookup(ip_address) || {};

    const loginHistoryData = {
      user_id: user.id,
      in_time: new Date(),
      ip_address,
      browser: uaResult.browser.name || "Unknown",
      browser_version: uaResult.browser.version || "Unknown",
      os: uaResult.os.name || "Unknown",
      city: geo.city || null,
      state: geo.region || null,
      country: geo.country || null,
      latitude: geo.ll?.[0]?.toString() || null,
      longitude: geo.ll?.[1]?.toString() || null,
      branch_id: user.branch_id || 0,
      company_id: defaultCompanyId || 0,
    };
    
    await commonQuery.createRecord(LoginHistory, loginHistoryData, transaction, false);

    await commonQuery.updateRecordById(User, user.id, { is_login: 1 }, transaction, false, false);

    const userPermission = await commonQuery.findOneRecord(UserCompanyRoles, { 
      user_id: user.id, role_id: user.role_id, company_id: user.company_id, branch_id: user.branch_id 
    }, {}, transaction, false, false);

    // Prepare User Data
    const userData = {
      id: user.id,
      role_id: user.role_id,
      user_name: user.user_name,
      email: user.email,
      mobile_no: user.mobile_no,
      address: user.address,
      city_id: user.city_id,
      state_id: user.state_id,
      country_id: user.country_id,
      pincode: user.pincode,
      user_key: user.user_key,
      profile_image: user.profile_image ? `${process.env.FILE_SERVER_URL}${constants.USER_IMG_FOLDER}${user.profile_image}` : null,
      authorized_signature: user.authorized_signature,
      report_to: user.report_to,
      role_id: user.role_id,
      permission: userPermission?.permissions ?? user.permissions,
      is_login: 1,
      user_id: user.user_id,
      branch_id: user.branch_id,
      company_id: defaultCompanyId,
    };

    clearUserCache(user.user_id);

    await transaction.commit();
    // return res.success("LOGIN_SUCCESS", ENTITY, { token, user: userData, login_method: loginMethod });
    return res.ok({ token, user: userData, login_method: loginMethod });
  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};

/**
 * Handle user logout
 */
exports.logout = async (req, res) => {
  const transaction = await sequelize.transaction();
  const userId = req.params.id;
  try {
    // Get user data for activity logging
    const user = await commonQuery.findOneRecord(
      User,
      { id: userId },
      transaction
    );

    if (!user) {
      await transaction.rollback();
      return res.error(constants.USER_NOT_FOUND);
    }

    // Find the most recent login record for this user that hasn'transaction been logged out yet.
    const lastLogin = await commonQuery.findOneRecord(
      LoginHistory,
      {
        user_id: userId,
        out_time: null,
      },
      {
        order: [["in_time", "DESC"]],
      },
      transaction
    );

    const commonData = {
      company_id: user.company_id,
      branch_id: user.branch_id,
      user_id: user.user_id,
    };

    // If an active session is found, update it with the logout time.
    if (lastLogin) {
      await commonQuery.updateRecordById(
        LoginHistory,
        lastLogin.id,
        {
          out_time: new Date(),
          status: 1,
        },
        transaction
      ); // Pass transaction
    }

    // Update the user's status to logged out (is_login: 0)
    await commonQuery.updateRecordById(
      User,
      userId,
      { is_login: 0 },
      transaction
    );

    clearUserCache(userId);
    await transaction.commit();
    // Pass user data for activity logging
    return res.success(constants.LOGOUT_SUCCESS);
  } catch (err) {
    console.error("Logout error:", err);
    if( !transaction.finished){
      await transaction.rollback();
    }
    return handleError(err, res, req);
  }
};

/**
 * Check OTP Rate Limit Status for a specific number
 */
exports.checkOtpRateLimit = async (req, res) => {
  try {
    const { mobile_no } = req.params;

    if (!mobile_no) {
      return res.error(constants.VALIDATION_ERROR, { message: "Mobile number is required" });
    }

    const info = await otpRateLimit.getBlockedNumberInfo(mobile_no);
    return res.success(constants.OTP_LIMIT_INFO, info);

  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * Get All Blocked Numbers (Admin Only)
 */
exports.getAllBlockedNumbers = async (req, res) => {
  try {
    const data = await otpRateLimit.getAllBlockedNumbers();
    return res.success(constants.BLOCKED_NUMBERS_LIST, data);

  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * Manually Reset OTP Limit for a number (Admin Only)
 */
exports.resetOtpLimit = async (req, res) => {
  try {
    const { mobile_no } = req.params;

    if (!mobile_no) {
      return res.error(constants.VALIDATION_ERROR, { message: "Mobile number is required" });
    }

    await otpRateLimit.resetAttempts(mobile_no);
    return res.success("OTP_LIMIT_RESET", {
      message: `OTP limit reset successfully for ${mobile_no}`
    });

  } catch (err) {
    return handleError(err, res, req);
  }
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
      { attributes: ['id', 'company_id'] }
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
      }
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
      }, null, false),

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
      }, null, false),

      // C. Configuration
      commonQuery.findAllRecords(CompanyConfigration, { company_id, status: 0 }, {}, null, false),
      
      // D. Permissions (For generating constants)
      commonQuery.findAllRecords(Permission, {}, {
        attributes: ['id', 'action', 'module_id', 'entity_id'],
        include: [
          { model: ModuleMaster, as: 'module', attributes: ['module_name'] },
          { model: ModuleEntityMaster, as: 'entity', attributes: ['entity_name', 'cust_entity_name'] }
        ]
      }, null, false)
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
      const currencyData = await commonQuery.findOneRecord(CurrencyMaster, { id: settingsObject.default_currency || 67 }); // Default to INR if missing
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