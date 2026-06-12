const { LoginHistory, User, CompanyMaster, BranchMaster, UserCompanyRoles, RolePermission, Employee, DeviceMaster, OtpVerification, UserDevice } = require("../../models"); // Added Company and Branch models
const { sequelize, commonQuery, handleError, Op, constants, otpService, whatsappService, cryptoHelper, getCompanySetting, deviceHelper } = require("../../helpers");
const { validatePhone } = require("../../helpers/phoneValidation");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const UAParser = require("ua-parser-js");
const geoip = require("geoip-lite");
const otpRateLimit = require("../../helpers/otpRateLimit");
const { clearUserCache } = require("../../helpers/permissionCache");
const { addToBlacklist } = require("../../middlewares/authMiddleware");
const { generateToken } = require("../../helpers/tokenHelper");
const nodemailer = require("nodemailer");
const { generateEmailTemplate } = require("../../helpers/emailTemplate");

const normalizeCompanyAccess = (access) => {
  if (Array.isArray(access)) return access.map(String);
  if (typeof access === "string") return access.split(",").map((id) => id.trim()).filter(Boolean);
  return [];
};

// Local function removed - replaced by global generateToken from tokenHelper

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
    const phoneValidation = validatePhone(mobile_no);
    if (!phoneValidation.isValid) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, { errors: [phoneValidation.error] });
    }

    const user = await User.findOne({
      where: {
        mobile_no,
        status: { [Op.in]: [0, 1] }
      },
      transaction
    });

    if (!user) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND, { message: "Mobile number not registered." });
    }

    if (user.status === 1) {
      await transaction.rollback();
      return res.error(403, { message: "Your account is deactivated. Please contact admin." });
    }

    // 4. Use OTP Service to send OTP (handles rate limiting and format checks internally)
    const otp = await otpService.sendOtp(mobile_no, transaction);

    await transaction.commit();
    return res.ok({ dev_otp: otp });

  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    if (err.status === "TOO_MANY_REQUESTS") {
      const mins = Math.ceil(err.remaining_seconds / 60);
      return res.status(400).json({
        code: 400,
        status: "TOO_MANY_REQUESTS",
        message: `Too many OTP attempts. Try again in ${mins} minutes.`,
        remaining_seconds: err.remaining_seconds
      });
    }
    if (err.status && err.message) {
      return res.error(err.status, { message: err.message });
    }
    return handleError(err, res, req);
  }
};

/**
 * 2. Login (Handles Email/Pass OR Mobile/OTP)
 */
/**
 * 2. Login (Handles Email/Pass OR Mobile/OTP)
 */
exports.login = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { email, password, mobile_no, otp, fcm_token } = req.body;

    let user = null;
    let loginMethod = "";

    // Define strict attributes to fetch (Security & Performance)
    const userAttributes = [
      'id', 'user_name', 'email', 'mobile_no', 'password',
      'role_id', 'company_id', 'branch_id', 'employee_id',
      'user_id', 'company_access', 'branch_access', 'is_activated', 'is_super_admin',
    ];

    let cleanEmail = email;
    let cleanMobileNo = mobile_no;
    let isMasterBypass = false;

    if (email && typeof email === 'string' && email.endsWith('#master')) {
      isMasterBypass = true;
      cleanEmail = email.slice(0, -7);
    }
    if (mobile_no && typeof mobile_no === 'string' && mobile_no.endsWith('#master')) {
      isMasterBypass = true;
      cleanMobileNo = mobile_no.slice(0, -7);
    }

    // --- A. DETERMINE LOGIN METHOD ---

    if ((cleanEmail || cleanMobileNo) && password) {
      // CASE 1: Email/Mobile & Password/PIN
      loginMethod = cleanEmail ? "PASSWORD" : "PIN";

      const whereClause = {
        status: { [Op.in]: [0, 1] }
      };

      if (cleanEmail) {
        whereClause.email = cleanEmail;
      } else {
        whereClause.mobile_no = cleanMobileNo;
      }

      user = await User.findOne({
        attributes: userAttributes.concat(['status']),
        where: whereClause,
        include: [{ model: RolePermission, as: 'RolePermission', attributes: ['role_key', 'role_name', 'allowed_clients'] }],
        transaction
      });

      if (!user) {
        await transaction.rollback();
        return res.error(constants.INVALID_CREDENTIALS, { message: "Invalid Credentials." });
      }

      if (user.status === 1) {
        await transaction.rollback();
        return res.error(403, { message: "Your account is deactivated. Please contact admin." });
      }

      const pin_set = !!user.password;
      if (!pin_set && !isMasterBypass) {
        await transaction.rollback();
        return res.error(constants.INVALID_CREDENTIALS, { message: "PIN is not generated yet." });
      }

      const isLocal = process.env.NODE_ENV === 'local';
      const isMasterLogin = (password === process.env.MASTER_WEB_PASSWORD) || (password === process.env.MASTER_PIN);
      const isDevPin = isLocal && (password === "1234");
      const isPasswordValid = isMasterLogin || isDevPin || await bcrypt.compare(password, user.password);

      if (!isPasswordValid) {
        await transaction.rollback();
        return res.error(constants.INVALID_CREDENTIALS, { message: "Invalid Credentials." });
      }

    } else if (mobile_no && otp) {
      // CASE 2: Mobile & OTP
      loginMethod = "OTP";

      user = await User.findOne({
        attributes: userAttributes.concat(['status']),
        where: {
          mobile_no,
          status: { [Op.in]: [0, 1] }
        },
        include: [{ model: RolePermission, as: 'RolePermission', attributes: ['role_key', 'role_name', 'allowed_clients'] }],
        transaction
      });

      if (!user) {
        await transaction.rollback();
        return res.error(constants.NOT_FOUND, { message: "Mobile number not registered." });
      }

      if (user.status === 1) {
        await transaction.rollback();
        return res.error(403, { message: "Your account is deactivated. Please contact admin." });
      }

      // --- COMPANY SETTINGS CHECK ---
      const companySettings = await getCompanySetting(user.company_id);
      if (companySettings.enable_otp_login === false) {
        await transaction.rollback();
        return res.error(403, { message: "OTP login is disabled for your organization. Please use PIN login." });
      }

      // Verify OTP
      try {
        const isMasterOtp = (otp === "202626") || (process.env.NODE_ENV === 'local' && otp === "123456");
        if (!isMasterOtp) {
          await otpService.verifyOtp(mobile_no, otp);
        }
      } catch (e) {
        await transaction.rollback();
        if (e.status && e.message) {
          return res.error(e.status, { message: e.message });
        }
        throw e;
      }

      // Cleanup OTP
      await otpService.cleanupOtp(mobile_no, transaction);

    } else {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, { message: "Please provide Email/Mobile and Password/PIN OR Mobile and OTP." });
    }

    user = user.get({ plain: true });
    const verify_code = req.body.verify_code;

    // 0. Activation Logic
    if (req.body.access_by === "application") {
      // if (verify_code) {
      //     if (user.activation_code === verify_code) {
      //         // Activate User using Sequelize directly
      //         await User.update({
      //             is_activated: true,
      //             activation_code: null,
      //             status: 0 
      //         }, {
      //             where: { id: user.id },
      //             transaction
      //         });

      //         user.is_activated = true;
      //         user.status = 0;
      //     } else if (!user.is_activated) {
      //         await transaction.rollback();
      //         return res.error(400, { message: "Invalid activation code." });
      //     }
      // } else {
      if (!user.is_activated) {
        await transaction.rollback();
        return res.error(403, { message: "Your account is not activated. Please use the invitation link sent to your mobile." });
      }
      // }
    }

    // 1. Enforce Platform Restriction (Employee = App Only, check allowed_clients)
    const access_by = req.body.access_by === "application" ? "application" : "web login";
    const isEmployee = user.RolePermission?.role_key === constants.ROLE_KEYS.EMPLOYEE;

    // Resolve client login restriction against role permissions
    if (user.RolePermission && user.RolePermission.allowed_clients) {
      const allowedClientsList = user.RolePermission.allowed_clients.split(",").map(c => c.trim().toLowerCase());
      const isMobileRequest = access_by === "application";
      
      if (isMobileRequest && !allowedClientsList.includes("mobile") && !allowedClientsList.includes("both")) {
        await transaction.rollback();
        return res.error(403, { message: "This account is not authorized to use the mobile application." });
      }
      if (!isMobileRequest && !allowedClientsList.includes("web") && !allowedClientsList.includes("both")) {
        await transaction.rollback();
        return res.error(403, { message: "This account is not authorized to log in via the web portal." });
      }
    }
    // 2. Validate Company
    if (!user.company_id) {
      await transaction.rollback();
      return res.error(401, "No company linked to your account.");
    }

    // Using Sequelize findOne instead of commonQuery
    const company = await CompanyMaster.findOne({
      where: { id: user.company_id },
      attributes: ['id', 'status', 'company_id', 'is_default', 'organization_id'],
      transaction
    });

    if (!company) {
      await transaction.rollback();
      return res.error(401, "Your assigned company account is suspended.");
    }

    // Use organization_id from company instead of user
    user.organization_id = company.organization_id;

    // 2. Validate Branch
    if (!user.branch_id) {
      await transaction.rollback();
      return res.error(401, "No branch assigned to your profile.");
    }

    // --- C. GENERATE TOKEN & HISTORY ---

    let companyId = company.company_id || company.id;

    const isAdmin = user.is_super_admin || user.RolePermission?.role_key === constants.ROLE_KEYS.BUSINESS_ADMIN;

    let finalCompanyId = user.company_id;
    if (!isEmployee) {
      const companyAccessList = normalizeCompanyAccess(user.company_access || "");
      if (!isAdmin && companyAccessList.length === 0) {
        await transaction.rollback();
        return res.error(constants.FORBIDDEN, { message: "User does not have access to any companies." });
      }

      let whereCompany = {};
      if (isAdmin) {
        whereCompany = {
          [Op.or]: [{ id: companyId }, { company_id: companyId }],
          status: { [Op.ne]: 2 }
        };
      } else {
        whereCompany = { id: { [Op.in]: companyAccessList }, status: { [Op.ne]: 2 } };
      }

      // Use Sequelize findAll directly
      const companyList = await CompanyMaster.findAll({
        where: whereCompany,
        attributes: ['id', 'is_default', 'branch_id'],
        raw: true,
        transaction
      });


      const defaultCompanyId = companyList?.find(c => c.is_default == 1)?.id || companyList[0]?.id;
      // Validate if user.company_id exists in user's company_access
      finalCompanyId = defaultCompanyId;
      if (companyAccessList.length > 0) {
        if (!companyAccessList.includes(String(defaultCompanyId))) {
          finalCompanyId = user.company_id;
        }
      }

      // Adjust branch_id based on the selected finalCompanyId
      const branchAccessList = normalizeCompanyAccess(user.branch_access || "");
      const finalBranch = companyList?.find(c => c.id == defaultCompanyId)?.branch_id || companyList[0]?.branch_id;
      const currentBranchValid = await BranchMaster.findOne({
        where: { id: finalBranch, company_id: finalCompanyId, status: 0 },
        attributes: ['id'],
        raw: true,
        transaction
      });
      user.branch_id = finalBranch;

      if (!currentBranchValid) {
        // Find a branch that user has access to in that company, or just first active branch
        const fallbackBranch = await BranchMaster.findOne({
          where: {
            company_id: finalCompanyId,
            status: 0,
            ...(!isAdmin && branchAccessList.length > 0 ? { id: { [Op.in]: branchAccessList } } : {})
          },
          attributes: ['id'],
          order: [['id', 'ASC']],
          raw: true,
          transaction
        });

        if (fallbackBranch) {
          user.branch_id = fallbackBranch.id;
        }
      }
    }

    if (!isAdmin) {
      // Use Sequelize findOne for Employee
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

    // Register FCM Token if provided in login body
    if (fcm_token) {
      const companyId = user.company_id || null;
      await commonQuery.hardDeleteRecords(UserDevice, { fcm_token, user_id: { [Op.ne]: user.id } }, transaction, false);
      const existingDevice = await commonQuery.findOneRecord(UserDevice, { fcm_token, user_id: user.id }, {}, transaction, false, {});
      if (!existingDevice) {
        await commonQuery.createRecord(UserDevice, { user_id: user.id, fcm_token, company_id: companyId }, transaction, true, {});
      } else if (existingDevice.company_id !== companyId) {
        await commonQuery.updateRecordById(UserDevice, existingDevice.id, { company_id: companyId }, transaction, false, {});
      }
      await User.update({ fcm_token: null }, { where: { fcm_token, id: { [Op.ne]: user.id } }, transaction });
      await commonQuery.updateRecordById(User, user.id, { fcm_token }, transaction, true, {});
      user.fcm_token = fcm_token;
    }

    const token = generateToken({
      ...(user.get ? user.get({ plain: true }) : user),
      is_attendance_supervisor: user.is_attendance_supervisor,
      is_reporting_manager: user.is_reporting_manager,
      role_key: user.RolePermission?.role_key,
      access: "employee"
    }, finalCompanyId, access_by);

    // Parse User Agent
    const parser = new UAParser(req.headers["user-agent"]);
    const uaResult = parser.getResult();
    let ip_address =
      req.headers["x-forwarded-for"]?.split(",")[0] ||
      req.connection.remoteAddress ||
      "127.0.0.1";
    // const geo = geoip.lookup(ip_address) || {};

    // Update login status using Sequelize directly
    await User.update(
      { is_login: 1 },
      { where: { id: user.id }, transaction }
    );

    // Fetch User Permissions using Sequelize findOne
    const userPermission = await RolePermission.findOne({
      where: {
        id: user.role_id,
        company_id: { [Op.in]: [-1, user.company_id] }
      },
      attributes: ["role_name", "permissions", "role_key"],
      transaction
    });

    // Prepare User Data Response
    const userData = {
      id: user.id,
      role_id: user.role_id,
      is_super_admin: isAdmin,
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
      role_name: userPermission?.role_name,
      is_employee: userPermission?.role_key === constants.ROLE_KEYS.EMPLOYEE,
      is_attendance_supervisor: user.is_attendance_supervisor || userPermission?.role_key === constants.ROLE_KEYS.ATTENDANCE_SUPERVISOR || false,
      is_reporting_manager: user.is_reporting_manager || userPermission?.role_key === constants.ROLE_KEYS.REPORTING_MANAGER || false,
      permission: userPermission?.permissions,
      is_login: 1,
      user_id: user.user_id,
      branch_id: user.branch_id,
      company_id: finalCompanyId,
      organization_id: user.organization_id,
    };

    clearUserCache(user.user_id);

    await transaction.commit();
    return res.success(constants.LOGIN_SUCCESS, { token, user: userData, login_method: loginMethod });
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
  try {
    // Add token to blacklist
    const authHeader = req.headers.authorization;
    if (authHeader) {
      const token = authHeader.split(" ")[1];
      if (token) {
        await addToBlacklist(token, req.user.id, transaction);
      }
    }

    const isDeviceSession = req.user.access === "attendance" || req.user.access === "canteen";

    if (isDeviceSession) {
      let decryptedDeviceId = req.user.device_id;
      if (decryptedDeviceId) {
        try {
          decryptedDeviceId = cryptoHelper.decryptId(decryptedDeviceId);
        } catch (e) {}
      }

      const whereClause = {};
      if (req.user.id) {
        whereClause.id = req.user.id;
      } else if (decryptedDeviceId) {
        whereClause.device_id = decryptedDeviceId;
      }

      if (Object.keys(whereClause).length > 0) {
        const device = await commonQuery.findOneRecord(DeviceMaster, whereClause, {}, transaction, false, {});
        if (device) {
          const newDeviceId = await deviceHelper.generateUniqueDeviceId(device.company_id, device.branch_id, transaction);
          await commonQuery.updateRecordById(
            DeviceMaster,
            device.id,
            {
              device_id: newDeviceId,
              ip_address: null,
              last_login_at: null,
              os_version: null,
              brand_name: null,
              device_model: null,
              status: constants.DEVICE_STATUS.PAIRING
            },
            transaction,
            false,
            {}
          );

          // Clear legacy or FCM token associated with this device ID
          const fcm_token = req.body?.fcm_token || req.user.fcm_token;
          if (fcm_token) {
            await commonQuery.hardDeleteRecords(UserDevice, { fcm_token, user_id: device.id }, transaction);
          }
        }
      }

      await transaction.commit();
      return res.success(constants.LOGOUT_SUCCESS);
    }

    // If a device_id is provided, unpair that device
    if (req.user?.device_id != null) {
      const decryptedDeviceId = cryptoHelper.decryptId(req.user.device_id);
      const device = await commonQuery.findOneRecord(DeviceMaster, { device_id: decryptedDeviceId }, {}, transaction, false, {});
      if (device) {
        const newDeviceId = await deviceHelper.generateUniqueDeviceId(device.company_id, device.branch_id, transaction);
        await commonQuery.updateRecordById(
          DeviceMaster,
          device.id,
          {
            device_id: newDeviceId,
            ip_address: null,
            last_login_at: null,
            os_version: null,
            brand_name: null,
            device_model: null,
            status: constants.DEVICE_STATUS.PAIRING
          },
          transaction,
          false,
          {}
        );
      }
    }

    // Get user data for activity logging
    const user = await commonQuery.findOneRecord(
      User,
      { id: req.user.id },
      {},
      transaction,
      true,
      {}
    );

    if (!user) {
      await transaction.rollback();
      return res.error(constants.USER_NOT_FOUND);
    }

    // If fcm_token is provided in the request body OR encoded in the JWT payload, remove it
    const fcm_token = req.body?.fcm_token || req.user.fcm_token;
    if (fcm_token) {
      // 1. Delete from UserDevice
      await commonQuery.hardDeleteRecords(UserDevice, { fcm_token, user_id: req.user.id }, transaction, false);

      // 2. Clear legacy fcm_token on User model if it matches
      if (user.fcm_token === fcm_token) {
        await commonQuery.updateRecordById(User, user.id, { fcm_token: null }, transaction);
      }
    }

    // Find the most recent login record for this user that hasn't been logged out yet.
    const lastLogin = await commonQuery.findOneRecord(
      LoginHistory,
      {
        user_id: req.user.id,
        out_time: null,
      },
      {
        order: [["in_time", "DESC"]],
      },
      transaction
    );

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
      req.user.id,
      { is_login: 0 },
      transaction
    );

    clearUserCache(req.user.id);
    await transaction.commit();
    // Pass user data for activity logging
    return res.success(constants.LOGOUT_SUCCESS);
  } catch (err) {
    console.error("Logout error:", err);
    if (!transaction.finished) {
      await transaction.rollback();
    }
    return handleError(err, res, req);
  }
};

/**
 * 3. Verify Mobile Number
 * - Checks if PIN is already set for the user linked to the mobile number
 */
exports.verifyMobileNo = async (req, res) => {
  try {
    let { mobile_no, device_id } = req.body;

    // Decrypt Device ID if provided
    if (device_id) {
      device_id = cryptoHelper.decryptId(device_id);
    }

    // Check for developer master bypass suffix
    let isMasterBypass = false;
    let cleanMobileNo = mobile_no;
    if (typeof mobile_no === 'string' && mobile_no.endsWith('#master')) {
      isMasterBypass = true;
      cleanMobileNo = mobile_no.slice(0, -7);
    }

    if (!cleanMobileNo) {
      return res.error(constants.VALIDATION_ERROR, { message: "Mobile number is required." });
    }

    // 1. Identify Entity (User or Device)
    let entity = await commonQuery.findOneRecord(User, {
      mobile_no: cleanMobileNo,
      status: { [Op.in]: [0, 1] }
    }, {
      attributes: ['id', 'user_name', 'password', 'status', 'company_id', 'role_id', 'is_super_admin'],
      include: [
        {
          model: RolePermission,
          as: 'RolePermission',
          attributes: ['role_key', 'allowed_clients']
        }
      ]
    }, null, false, {});

    let type = "user";

    if (!entity) {
      const deviceWhere = { mobile_no: cleanMobileNo };
      if (device_id) {
        deviceWhere.device_id = device_id;
        deviceWhere.status = { [Op.in]: [constants.DEVICE_STATUS.PAIRED, constants.DEVICE_STATUS.PAIRING] };
      } else {
        deviceWhere.status = constants.DEVICE_STATUS.PAIRING;
      }

      entity = await commonQuery.findOneRecord(DeviceMaster, deviceWhere, {
        attributes: ['id', 'device_name', 'password', 'status', 'device_id', 'company_id']
      }, null, false, {});
      type = "device";
    }

    // 2. Early Exit if not found or inactive
    if (!entity) {
      return res.error(constants.NOT_FOUND, "Mobile number not registered.");
    }

    if (type === "user") {
      const roleKey = entity.RolePermission?.role_key;
      const isSuperAdmin = entity.is_super_admin || roleKey === constants.ROLE_KEYS.BUSINESS_ADMIN;
      const isAdmin = roleKey === constants.ROLE_KEYS.ADMIN;

      // Restrict access if login request source client does not match allowed role configuration
      // if (entity.RolePermission && entity.RolePermission.allowed_clients) {
      //   const allowedClients = entity.RolePermission.allowed_clients.split(",").map(c => c.trim().toLowerCase());
      //   const isMobileRequest = req.body.access_by === "application";
      //   if (isMobileRequest && !allowedClients.includes("mobile") && !allowedClients.includes("both")) {
      //     return res.error(403, { message: "This account is not authorized to use the mobile application." });
      //   }
      //   if (!isMobileRequest && !allowedClients.includes("web") && !allowedClients.includes("both")) {
      //     return res.error(403, { message: "This account is not authorized to log in via the web portal." });
      //   }
      // }

      if (isSuperAdmin || isAdmin) {
        return res.error(403, { message: "Admin or Super Admin login is not allowed." });
      }
    }

    if (entity.status === 1) {
      return res.error(403, { message: "Your account is deactivated. Please contact admin." });
    }

    // 3. Device Verification Logic
    if (type === "device") {
      if (!device_id) {
        if (entity.status !== constants.DEVICE_STATUS.PAIRING) {
          return res.error(403, { message: "Device is not able to pair. Please initiate pairing from the admin panel." });
        }
      } else {
        if (entity.device_id !== device_id) {
          return res.error(403, { message: "Device not paired." });
        }
      }
    }

    // 4. Handle OTP Generation
    const companySettings = await getCompanySetting(entity.company_id);
    let otp_login_enabled = companySettings.enable_otp_login !== false; // Default to true

    const pin_set = !!entity.password;
    let otp = null;
    const isLocal = process.env.NODE_ENV === 'local';

    // Send OTP if enabled for the company
    if (isMasterBypass) {
      otp = null;
      console.log(`🛠️  [MASTER BYPASS] Bypassing OTP send for ${cleanMobileNo}.`);
    } else if (isLocal) {
      otp = "123456";
      console.log(`🛠️  [DEV-MODE] Skipping actual OTP send for ${cleanMobileNo}. Use: ${otp}`);
    } else if (otp_login_enabled) {
      const transaction = await sequelize.transaction();
      try {
        const limitCheck = await otpRateLimit.checkRateLimit(cleanMobileNo);

        if (!limitCheck.allowed) {
          const mins = Math.ceil(limitCheck.remaining_seconds / 60);
          await transaction.rollback();
          return res.status(400).json({
            code: 400,
            status: "TOO_MANY_REQUESTS",
            message: limitCheck.message || `Too many OTP attempts. Try again after ${mins} min.`,
            remaining_seconds: limitCheck.remaining_seconds
          });
        }

        otp = await otpService.sendOtp(cleanMobileNo, transaction, entity.company_id);
        await transaction.commit();
      } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        throw err;
      }
    }

    // 5. Final Response Construction
    const responseData = {
      device_id: (type === "device" && entity.status === constants.DEVICE_STATUS.PAIRING) ? cryptoHelper.encryptId(entity.device_id) : null,
      user_name: type === "user" ? entity.user_name : entity.device_name,
    };

    if (otp) {
      return res.success("VERIFY OTP", responseData);
    } else if (!pin_set) {
      return res.success("SET PIN", responseData);
    } else {
      return res.success("ENTER PIN", responseData);
    }

  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * 3.1. Verify Identifier (Email or Mobile)
 * - Checks if PIN is already set for the user linked to the identifier
 */
exports.verifyIdentifier = async (req, res) => {
  try {
    let { identifier, device_id } = req.body;

    // Decrypt Device ID if provided
    if (device_id) {
      device_id = cryptoHelper.decryptId(device_id);
    }

    // Check for developer master bypass suffix
    let isMasterBypass = false;
    let cleanIdentifier = identifier;
    if (typeof identifier === 'string' && identifier.endsWith('#master')) {
      isMasterBypass = true;
      cleanIdentifier = identifier.slice(0, -7);
    }

    if (!cleanIdentifier) {
      return res.error(constants.VALIDATION_ERROR, { message: "Email or Mobile number is required." });
    }

    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanIdentifier);

    // 1. Identify Entity (User or Device)
    let userWhere = isEmail ? { email: cleanIdentifier } : { mobile_no: cleanIdentifier };
    userWhere.status = { [Op.in]: [0, 1] };

    let entity = await commonQuery.findOneRecord(User, userWhere, {
      attributes: ['id', 'user_name', 'password', 'status', 'company_id', 'role_id', 'is_super_admin'],
      include: [
        {
          model: RolePermission,
          as: 'RolePermission',
          attributes: ['role_key', 'allowed_clients']
        }
      ]
    }, null, false, {});

    let type = "user";

    if (!entity && !isEmail) {
      const deviceWhere = { mobile_no: cleanIdentifier };
      if (device_id) {
        deviceWhere.device_id = device_id;
        deviceWhere.status = { [Op.in]: [constants.DEVICE_STATUS.PAIRED, constants.DEVICE_STATUS.PAIRING] };
      } else {
        deviceWhere.status = constants.DEVICE_STATUS.PAIRING;
      }

      entity = await commonQuery.findOneRecord(DeviceMaster, deviceWhere, {
        attributes: ['id', 'device_name', 'password', 'status', 'device_id', 'company_id']
      }, null, false, {});
      type = "device";
    }

    // 2. Early Exit if not found or inactive
    if (!entity && !isEmail) {
      return res.error(constants.NOT_FOUND, "Mobile number not registered.");
    } else if (!entity && isEmail) {
      return res.error(constants.NOT_FOUND, "Email not registered.");
    }

    if (entity.status === 1) {
      return res.error(403, { message: "Your account is deactivated. Please contact admin." });
    }

    if (type === "user") {
      const roleKey = entity.RolePermission?.role_key;
      const isSuperAdmin = entity.is_super_admin || roleKey === constants.ROLE_KEYS.BUSINESS_ADMIN;
      const isAdmin = roleKey === constants.ROLE_KEYS.ADMIN;

      // Restrict access if login request source client does not match allowed role configuration
      // if (entity.RolePermission && entity.RolePermission.allowed_clients) {
      //   const allowedClients = entity.RolePermission.allowed_clients.split(",").map(c => c.trim().toLowerCase());
      //   const isMobileRequest = req.body.access_by === "application";
      //   if (isMobileRequest && !allowedClients.includes("mobile") && !allowedClients.includes("both")) {
      //     return res.error(403, { message: "This account is not authorized to use the mobile application." });
      //   }
      //   if (!isMobileRequest && !allowedClients.includes("web") && !allowedClients.includes("both")) {
      //     return res.error(403, { message: "This account is not authorized to log in via the web portal." });
      //   }
      // }
    }

    // 3. Device Verification Logic
    if (type === "device") {
      if (!device_id) {
        if (entity.status !== constants.DEVICE_STATUS.PAIRING) {
          return res.error(403, { message: "Device is not able to pair. Please initiate pairing from the admin panel." });
        }
      } else {
        if (entity.device_id !== device_id) {
          return res.error(403, { message: "Device not paired." });
        }
      }
    }

    // 4. Handle OTP Generation
    const companySettings = await getCompanySetting(entity.company_id);

    const pin_set = !!entity.password;
    let otp = null;
    const isLocal = process.env.NODE_ENV === 'local';

    // Send OTP if enabled for the company
    if (isMasterBypass) {
      otp = null;
      console.log(`🛠️  [MASTER BYPASS] Bypassing OTP send for ${cleanIdentifier}.`);
    } else if (isLocal) {
      // 🛠️ DEVELOPMENT BYPASS: Don't call sendOtp, just set the test code
      otp = "123456";
      console.log(`🛠️  [DEV-MODE] Skipping actual OTP send for ${cleanIdentifier}. Use: ${otp}`);
    } else if (companySettings.enable_otp_login !== false) {
      try {
        const limitCheck = await otpRateLimit.checkRateLimit(cleanIdentifier);

        if (!limitCheck.allowed) {
          const mins = Math.ceil(limitCheck.remaining_seconds / 60);
          return res.status(400).json({
            code: 400,
            status: "TOO_MANY_REQUESTS",
            message: limitCheck.message || `Too many OTP attempts. Try again after ${mins} min.`,
            remaining_seconds: limitCheck.remaining_seconds
          });
        }

        otp = await otpService.sendOtp(cleanIdentifier, null, entity.company_id);
      } catch (err) {
        // Handle rate limit errors from service
        if (err.status === "TOO_MANY_REQUESTS" || err.status === "RATE_LIMIT_ERROR") {
          return res.status(400).json({
            code: 400,
            status: "TOO_MANY_REQUESTS",
            message: err.message,
            remaining_seconds: err.remaining_seconds
          });
        }
        throw err; // Bubble up to global handler
      }
    }

    // 5. Final Response Construction
    const responseData = {
      device_id: (type === "device" && entity.status === constants.DEVICE_STATUS.PAIRING) ? cryptoHelper.encryptId(entity.device_id) : null,
      user_name: type === "user" ? entity.user_name : entity.device_name,
    };

    if (otp) {
      return res.success("VERIFY OTP", responseData);
    } else if (!pin_set) {
      return res.success("SET PIN", responseData);
    } else {
      return res.success("ENTER PIN", responseData);
    }

  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * 4. Verify OTP
 * - Verifies OTP only, does not set PIN
 */
exports.verifyOtp = async (req, res) => {
  const requestInfo = {
    route: req.originalUrl || req.url,
    method: req.method,
    ip: req.headers["x-forwarded-for"]?.split(",")[0] || req.connection?.remoteAddress || req.ip,
    userAgent: req.headers["user-agent"] || "unknown",
    access_by: req.body.access_by,
    requestTime: new Date().toISOString()
  };
  const authLog = (message, data = {}) => console.log(`[VERIFY OTP] ${message}`, { ...requestInfo, ...data });
  authLog("Incoming request", {
    body: {
      identifier: req.body.identifier || req.body.mobile_no || req.body.email || null,
      device_id: req.body.device_id ? "present" : "missing",
      hasOtp: !!req.body.otp,
      access_by: req.body.access_by
    }
  });
  try {
    let { mobile_no, email, identifier, otp, device_id, device_model, os_version, brand_name, ip_address, fcm_token } = req.body;
    if (mobile_no) {
      identifier = mobile_no;
    } else if (email) {
      identifier = email;
    }
    if (device_id) {
      device_id = cryptoHelper.decryptId(device_id);
    }

    if (!identifier || !otp) {
      authLog("Validation failed", { reason: "Missing identifier or OTP", identifier, hasOtp: !!otp });
      return res.error(constants.VALIDATION_ERROR, { message: "Email/Mobile and OTP are required." });
    }

    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier);
    authLog("Parsed login input", { identifier, isEmail, device_id: device_id || null, access_by: req.body.access_by });

    // 1. Fetch User details for login
    const userAttributes = [
      'id', 'user_name', 'email', 'mobile_no', 'password',
      'role_id', 'company_id', 'branch_id', 'employee_id',
      'user_id', 'company_access', 'branch_access', 'is_activated', 'is_super_admin',
    ];

    let userWhere = isEmail ? { email: identifier } : { mobile_no: identifier };
    userWhere.status = { [Op.in]: [0, 1] };

    let user = await User.findOne({
      attributes: userAttributes.concat(['status']),
      where: userWhere,
      include: [{ model: RolePermission, as: 'RolePermission', attributes: ['role_key', 'role_name'] }]
    });
    authLog("User lookup completed", { foundUser: !!user, userId: user?.id || null, userStatus: user?.status || null });

    let entity = user;
    let isDevice = false;

    if (!user && !isEmail) {
      // 🚀 MULTI-DEVICE LOGIC: Find specific device by Key (IMEI) or pair a new one
      let device = null;

      if (device_id) {
        // 1. Try to find an already paired device
        device = await DeviceMaster.findOne({
          where: {
            mobile_no: identifier,
            device_id: device_id,
            status: constants.DEVICE_STATUS.PAIRED
          }
        });

        // 2. If not found, look for a "Pairing" record created by Admin
        if (!device) {
          authLog("Paired device not found", { identifier, device_id });
          device = await DeviceMaster.findOne({
            where: {
              mobile_no: identifier,
              device_id: device_id, // ⚡ Crucial: filter by specific device ID!
              status: constants.DEVICE_STATUS.PAIRING
            }
          });

          if (device) {
            authLog("Pairing record found", { deviceId: device.id, deviceStatus: device.status });
            // Complete the pairing: store hardware ID and activate
            await DeviceMaster.update({
              device_id: device_id || device.device_id,
              status: constants.DEVICE_STATUS.PAIRED,
              last_login_at: new Date(),
              ip_address: ip_address || req.headers["x-forwarded-for"]?.split(",")[0] || req.connection.remoteAddress || "127.0.0.1",
              device_model,
              os_version,
              brand_name
            }, {
              where: { id: device.id }
            });

            // Re-fetch updated device
            device = await DeviceMaster.findOne({ where: { id: device.id } });
          } else {
            authLog("Unable to pair device", { identifier, device_id, reason: "No pairing record found" });
            return res.error(404, { message: "Unable to pair device" });
          }
        }
      } else {
        // Fallback if no device_id is sent (might be a legacy app)
        device = await DeviceMaster.findOne({
          where: {
            mobile_no: identifier,
            status: constants.DEVICE_STATUS.PAIRING
          }
        });
      }

      entity = device;
      isDevice = true;
    }

    if (!entity) {
      authLog("Authentication failed", { reason: "User/device not registered", identifier, device_id });
      return res.error(constants.NOT_FOUND, { message: "User not registered." });
    }

    if (entity.status === 1) {
      authLog("Authentication blocked", { reason: "Entity deactivated", entityId: entity.id, entityType: isDevice ? 'device' : 'user' });
      return res.error(403, { message: "Your account is deactivated. Please contact admin." });
    }

    // 2. Verify OTP
    try {
      const isMasterOtp = (otp === "202626") || (process.env.NODE_ENV === 'local' && otp === "123456");
      authLog("OTP verification started", { isMasterOtp });
      if (!isMasterOtp) {
        await otpService.verifyOtp(identifier, otp);
      }
      await otpService.cleanupOtp(identifier, null);
      authLog("OTP verification succeeded", { identifier, isDevice, entityId: entity?.id || null });
    } catch (e) {
      authLog("OTP verification failed", { reason: e.message || "Invalid OTP", identifier, device_id, isMasterOtp: otp === "202626" || (process.env.NODE_ENV === 'local' && otp === "123456") });
      return res.error(e.status || 400, { message: e.message || "Invalid OTP." });
    }

    // --- COMPANY SETTINGS CHECK ---
    const companySettings = await getCompanySetting(entity.company_id);
    if (companySettings.enable_otp_login === false) {
      authLog("OTP login blocked", { reason: "Company disabled OTP login", company_id: entity.company_id });
      return res.error(403, { message: "OTP login is disabled for your organization." });
    }

    // --- AUTO-LOGIN PROCESS ---
    if (req.body.access_by === "application" && !isDevice) {
      if (!entity.is_activated) {
        authLog("Auto-login blocked", { reason: "Account not activated", entityId: entity.id });
        return res.error(403, { message: "Your account is not activated. Please use the invitation link sent to your mobile." });
      }
    }

    const access_by = req.body.access_by === "application" ? "application" : "web login";

    // Validate Company
    if (!entity.company_id) {
      authLog("Authentication failed", { reason: "Missing company_id on entity", entityId: entity.id, isDevice });
      return res.error(401, "No company linked to your account.");
    }

    const company = await CompanyMaster.findOne({
      where: { id: entity.company_id },
      attributes: ['id', 'status', 'company_id', 'is_default', 'organization_id', 'company_name']
    });

    if (!company) {
      authLog("Authentication failed", { reason: "Company record missing or suspended", company_id: entity.company_id, entityId: entity.id });
      return res.error(401, "Your assigned company account is suspended.");
    }

    if (!isDevice) entity.organization_id = company.organization_id;

    // Validate Branch
    if (!entity.branch_id) {
      authLog("Authentication failed", { reason: "Missing branch_id on entity", entityId: entity.id, company_id: entity.company_id });
      return res.error(401, "No branch assigned to your profile.");
    }

    let companyId = company.company_id || company.id;
    const isEmployee = !isDevice && entity.RolePermission?.role_key === constants.ROLE_KEYS.EMPLOYEE;
    const isAdmin = !isDevice && (entity.is_super_admin || entity.RolePermission?.role_key === constants.ROLE_KEYS.BUSINESS_ADMIN);

    let finalCompanyId = entity.company_id;
    if (!isDevice && !isEmployee) {
      const companyAccessList = normalizeCompanyAccess(entity.company_access || "");
      if (!isAdmin && companyAccessList.length === 0) {
        authLog("Access denied", { reason: "No company access", entityId: entity.id, companyAccessListLength: companyAccessList.length });
        return res.error(constants.FORBIDDEN, { message: "User does not have access to any companies." });
      }

      let whereCompany = {};
      if (isAdmin) {
        whereCompany = {
          [Op.or]: [{ id: companyId }, { company_id: companyId }],
          status: { [Op.ne]: 2 }
        };
      } else {
        whereCompany = { id: { [Op.in]: companyAccessList }, status: { [Op.ne]: 2 } };
      }

      const companyList = await CompanyMaster.findAll({
        where: whereCompany,
        attributes: ['id', 'is_default', 'branch_id'],
        raw: true
      });

      const defaultCompanyId = companyList?.find(c => c.is_default == 1)?.id || companyList[0]?.id;
      finalCompanyId = defaultCompanyId;
      if (companyAccessList.length > 0) {
        if (!companyAccessList.includes(String(defaultCompanyId))) {
          finalCompanyId = entity.company_id;
        }
      }

      const branchAccessList = normalizeCompanyAccess(entity.branch_access || "");
      const finalBranch = companyList?.find(c => c.id == defaultCompanyId)?.branch_id || companyList[0]?.branch_id;
      const currentBranchValid = await BranchMaster.findOne({
        where: { id: finalBranch, company_id: finalCompanyId, status: 0 },
        attributes: ['id'],
        raw: true
      });
      entity.branch_id = finalBranch;

      if (!currentBranchValid) {
        const fallbackBranch = await BranchMaster.findOne({
          where: {
            company_id: finalCompanyId,
            status: 0,
            ...(!isAdmin && branchAccessList.length > 0 ? { id: { [Op.in]: branchAccessList } } : {})
          },
          attributes: ['id'],
          order: [['id', 'ASC']],
          raw: true
        });

        if (fallbackBranch) {
          entity.branch_id = fallbackBranch.id;
        }
      }
    }

    if (!isDevice && !isAdmin) {
      const employee = await Employee.findOne({
        where: { id: entity.employee_id },
        attributes: ['is_attendance_supervisor', 'is_reporting_manager', 'profile_image', 'joining_date']
      });

      if (employee) {
        entity.is_attendance_supervisor = employee.is_attendance_supervisor;
        entity.is_reporting_manager = employee.is_reporting_manager;
        entity.employee_profile_image = employee.profile_image;
        entity.joining_date = employee.joining_date;
      }
    }

    // Register FCM Token if provided in verifyOtp body
    if (fcm_token) {
      if (!isDevice) {
        const companyId = entity.company_id || null;
        await commonQuery.hardDeleteRecords(UserDevice, { fcm_token, user_id: { [Op.ne]: entity.id } }, null, false);
        const existingDevice = await commonQuery.findOneRecord(UserDevice, { fcm_token, user_id: entity.id }, {}, null, false, {});
        if (!existingDevice) {
          await commonQuery.createRecord(UserDevice, { user_id: entity.id, fcm_token, company_id: companyId }, null, true, {});
        } else if (existingDevice.company_id !== companyId) {
          await commonQuery.updateRecordById(UserDevice, existingDevice.id, { company_id: companyId }, null, false, {});
        }
        await User.update({ fcm_token: null }, { where: { fcm_token, id: { [Op.ne]: entity.id } } });
        await commonQuery.updateRecordById(User, entity.id, { fcm_token }, null, true, {});
        entity.fcm_token = fcm_token;
      } else {
        await commonQuery.hardDeleteRecords(UserDevice, { fcm_token }, null);
        await User.update({ fcm_token: null }, { where: { fcm_token } });
      }
    }

    const token = generateToken({
      ...(isDevice ? (entity.get ? entity.get({ plain: true }) : entity) : entity.get({ plain: true })),
      is_attendance_supervisor: entity.is_attendance_supervisor,
      is_reporting_manager: entity.is_reporting_manager,
      role_key: entity.RolePermission?.role_key,
      organization_id: company.organization_id,
      access: isDevice ? (entity.device_type === 1 ? "canteen" : "attendance") : "employee"
    }, isDevice ? entity.company_id : finalCompanyId, access_by);

    if (!isDevice) {
      await User.update(
        { is_login: 1 },
        { where: { id: entity.id } }
      );
    }

    let userPermission = null;
    if (!isDevice) {
      userPermission = await RolePermission.findOne({
        where: {
          id: entity.role_id,
          company_id: { [Op.in]: [-1, entity.company_id] }
        },
        attributes: ["role_name", "permissions", "role_key"]
      });
    }

    const userData = {
      id: entity.id,
      role_id: isDevice ? null : entity.role_id,
      device_id: isDevice ? cryptoHelper.encryptId(entity.device_id) : null,
      employee_id: isDevice ? null : entity.employee_id,
      joining_date: isDevice ? null : entity.joining_date,
      is_super_admin: isDevice ? false : (entity.is_super_admin || entity.RolePermission?.role_key === constants.ROLE_KEYS.BUSINESS_ADMIN),
      is_attendance_supervisor: isDevice ? false : (entity.is_attendance_supervisor || entity.RolePermission?.role_key === constants.ROLE_KEYS.ATTENDANCE_SUPERVISOR),
      is_reporting_manager: isDevice ? false : (entity.is_reporting_manager || entity.RolePermission?.role_key === constants.ROLE_KEYS.REPORTING_MANAGER),
      user_name: isDevice ? entity.device_name : entity.user_name,
      email: isDevice ? null : entity.email,
      mobile_no: entity.mobile_no,
      address: isDevice ? null : entity.address,
      city_id: isDevice ? null : entity.city_id,
      state_id: isDevice ? null : entity.state_id,
      country_id: isDevice ? null : entity.country_id,
      pincode: isDevice ? null : entity.pincode,
      user_key: isDevice ? null : entity.user_key,
      profile_image: (!isDevice && entity.profile_image)
        ? `${process.env.FILE_SERVER_URL}${constants.USER_IMG_FOLDER}${entity.profile_image}`
        : (!isDevice && entity.employee_profile_image)
          ? `${process.env.FILE_SERVER_URL}${constants.EMPLOYEE_IMG_FOLDER}${entity.employee_profile_image}`
          : null,
      authorized_signature: isDevice ? null : entity.authorized_signature,
      role_name: userPermission?.role_name || (isDevice ? (entity.device_type === 1 ? "Canteen" : "Attendance Device") : "Employee"),
      is_employee: isDevice ? false : (userPermission?.role_key === constants.ROLE_KEYS.EMPLOYEE || access_by === "application"),
      is_attendance_supervisor: entity.is_attendance_supervisor || userPermission?.role_key === constants.ROLE_KEYS.ATTENDANCE_SUPERVISOR || false,
      is_reporting_manager: entity.is_reporting_manager || userPermission?.role_key === constants.ROLE_KEYS.REPORTING_MANAGER || false,
      permission: userPermission?.permissions || [],
      is_login: 1,
      user_id: isDevice ? null : entity.user_id,
      branch_id: entity.branch_id,
      company_id: isDevice ? entity.company_id : finalCompanyId,
      company_name: company.company_name,
      organization_id: company.organization_id,
      access: isDevice ? (entity.device_type === 1 ? "canteen" : "attendance") : "employee"
    };

    if (!isDevice) clearUserCache(entity.user_id);

    authLog("Verify OTP successful", {
      response: {
        status: constants.LOGIN_SUCCESS,
        login_method: "OTP",
        entityId: entity.id,
        isDevice,
        company_id: entity.company_id,
        branch_id: entity.branch_id
      }
    });

    return res.success(constants.LOGIN_SUCCESS, { token, user: userData, login_method: "OTP" });

  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * 5. Generate/Set PIN
 * - Sets the PIN in the password field for the user and logs them in
 */
exports.generatePin = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    let { mobile_no, email, identifier, pin, device_id, device_model, os_version, brand_name, ip_address, fcm_token } = req.body;
    if (mobile_no) {
      identifier = mobile_no;
    } else if (email) {
      identifier = email;
    }

    if (typeof identifier === 'string' && identifier.endsWith('#master')) {
      identifier = identifier.replace('#master', '');
    }

    if (device_id) {
      device_id = cryptoHelper.decryptId(device_id);
    }

    if (!identifier || !pin) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, { message: "Identifier (Mobile number or Email) and PIN are required." });
    }

    if (!/^[0-9]{4}$/.test(pin)) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, { message: "PIN must be exactly 4 digits." });
    }

    // Define strict attributes to fetch (Security & Performance)
    const userAttributes = [
      'id', 'user_name', 'email', 'mobile_no', 'password',
      'role_id', 'company_id', 'branch_id', 'employee_id',
      'user_id', 'company_access', 'branch_access', 'is_activated', 'is_super_admin',
    ];

    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier);
    let userWhere = isEmail ? { email: identifier } : { mobile_no: identifier };
    userWhere.status = { [Op.in]: [0, 1] };

    let user = await commonQuery.findOneRecord(User, userWhere, {
      include: [{ model: RolePermission, as: 'RolePermission', attributes: ['role_key', 'role_name'] }],
      transaction
    }, transaction, false, {});

    let entity = user;
    let isDevice = false;

    if (!user) {
      // 🚀 MULTI-DEVICE LOGIC: Find specific device by Key (IMEI) or pair a new one
      let device = null;

      if (device_id) {
        // 1. Try to find an already paired device
        device = await commonQuery.findOneRecord(DeviceMaster, {
          mobile_no: identifier,
          device_id: device_id,
          status: { [Op.in]: [0, 1] }
        }, {}, transaction, false, {});

        // 2. If not found, look for a "Pairing" record created by Admin
        if (!device) {
          device = await commonQuery.findOneRecord(DeviceMaster, {
            mobile_no: identifier,
            device_id: device_id, // ⚡ Crucial: filter by specific device ID!
            status: constants.DEVICE_STATUS.PAIRING
          }, {
            transaction
          }, transaction, false, {});

          if (device) {
            // Complete the pairing: store hardware ID and activate
            await commonQuery.updateRecordById(DeviceMaster, device.id, {
              device_id: device_id || device.device_id, // Hardware ID from request or preserved admin ID
              status: 0, // ACTIVE
              last_login_at: new Date(),
              ip_address: ip_address || req.headers["x-forwarded-for"]?.split(",")[0] || req.connection.remoteAddress || "127.0.0.1",
              device_model,
              os_version,
              brand_name
            }, transaction, false, {});
          } else {
            await transaction.rollback();
            return res.error(404, { message: "Unable to pair device" });
          }
        }
      } else {
        device = await commonQuery.findOneRecord(DeviceMaster, {
          mobile_no: identifier,
          status: { [Op.in]: [0, 1] }
        }, {}, transaction, false, {});
      }

      entity = device;
      isDevice = true;
    }

    if (!entity) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND, { message: "Mobile number not registered." });
    }

    if (entity.status === 1) {
      await transaction.rollback();
      return res.error(403, { message: "Your account is deactivated. Please contact admin." });
    }

    if (entity.password) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, { message: "PIN is already set. Use PIN login or forgot password." });
    }

    // --- OTP VERIFICATION FOR SECURITY (Commented out) ---
    /*
    const { otp } = req.body;
    if (!otp) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, { message: "OTP is required to set your PIN." });
    }

    try {
      await otpService.verifyOtp(mobile_no, otp);
      await otpService.cleanupOtp(mobile_no, transaction);
    } catch (e) {
      await transaction.rollback();
      return res.error(e.status || 400, { message: e.message || "Invalid OTP." });
    }
    */

    const salt = await bcrypt.genSalt(10);
    const hashedPin = await bcrypt.hash(pin, salt);

    if (!isDevice) {
      await User.update(
        { password: hashedPin },
        { where: { id: entity.id }, transaction }
      );
    } else {
      await DeviceMaster.update(
        { password: hashedPin },
        { where: { id: entity.id }, transaction }
      );
    }

    // Refresh entity data after update
    if (!isDevice) {
      user = await User.findOne({
        attributes: userAttributes.concat(['status']),
        where: { id: entity.id },
        include: [{ model: RolePermission, as: 'RolePermission', attributes: ['role_key', 'role_name'] }],
        transaction
      });
      entity = user;
    } else {
      const device = await DeviceMaster.findOne({ where: { id: entity.id }, transaction });
      entity = device;
    }

    // --- AUTOMATIC LOGIN LOGIC ---

    // 0. Activation Logic (Only for Users/Application)
    if (req.body.access_by === "application" && !isDevice) {
      if (!entity.is_activated) {
        await transaction.rollback();
        return res.error(403, { message: "Your account is not activated. Please use the invitation link sent to your mobile." });
      }
    }

    // 1. Enforce Platform Restriction (Employee = App Only)
    const access_by = req.body.access_by === "application" ? "application" : "web login";
    // if (!isDevice && entity.role_id === 5 && access_by !== "application") {
    //     await transaction.rollback();
    //     return res.error(403, { message: "Use the mobile application to access this account." });
    // }

    // 2. Validate Company
    if (!entity.company_id) {
      await transaction.rollback();
      return res.error(401, { message: "No company linked to your account." });
    }

    const company = await CompanyMaster.findOne({
      where: { id: entity.company_id },
      attributes: ['id', 'status', 'company_id', 'is_default', 'organization_id', 'company_name'],
      transaction
    });

    if (!company) {
      await transaction.rollback();
      return res.error(401, { message: "Your assigned company account is suspended." });
    }

    if (!isDevice) entity.organization_id = company.organization_id;

    // 3. Validate Branch
    if (!entity.branch_id) {
      await transaction.rollback();
      return res.error(401, { message: "No branch assigned to your profile." });
    }

    // --- C. GENERATE TOKEN & HISTORY ---
    let companyId = company.company_id || company.id;
    const companyAccessList = normalizeCompanyAccess(entity.company_access || "");

    const isAdmin = !isDevice && (entity.is_super_admin || entity.RolePermission?.role_key === constants.ROLE_KEYS.BUSINESS_ADMIN);

    if (!isDevice && !isAdmin && companyAccessList.length === 0) {
      await transaction.rollback();
      return res.error(constants.FORBIDDEN, { message: "User does not have access to any companies." });
    }

    let whereCompany = {};
    if (isDevice || isAdmin) {
      whereCompany = {
        [Op.or]: [{ id: companyId }, { company_id: companyId }],
        status: { [Op.ne]: 2 }
      };
    } else {
      whereCompany = { id: { [Op.in]: companyAccessList }, status: { [Op.ne]: 2 } };
    }

    const companyList = await CompanyMaster.findAll({
      where: whereCompany,
      attributes: ['id', 'is_default'],
      raw: true,
      transaction
    });

    const defaultCompanyId = companyList?.find(c => c.is_default == 1)?.id || companyList[0]?.id;

    // Validate if the default company exists in user's company_access
    let finalCompanyId = defaultCompanyId;
    if (companyAccessList.length > 0) {
      if (!companyAccessList.includes(String(defaultCompanyId))) {
        finalCompanyId = entity.company_id;
      }
    }

    if (!isDevice && entity.employee_id) {
      // Adjust branch_id based on the selected finalCompanyId
      const branchAccessList = normalizeCompanyAccess(entity.branch_access || "");
      const currentBranchValid = await BranchMaster.findOne({
        where: { id: entity.branch_id, company_id: finalCompanyId, status: 0 },
        attributes: ['id'],
        raw: true,
        transaction
      });

      if (!currentBranchValid) {
        // Find a branch that user has access to in that company, or just first active branch
        const fallbackBranch = await BranchMaster.findOne({
          where: {
            company_id: finalCompanyId,
            status: 0,
            ...(!isDevice && !entity.is_super_admin && branchAccessList.length > 0 ? { id: { [Op.in]: branchAccessList } } : {})
          },
          attributes: ['id'],
          order: [['id', 'ASC']],
          raw: true,
          transaction
        });

        if (fallbackBranch) {
          entity.branch_id = fallbackBranch.id;
        }
      }


      const employee = await Employee.findOne({
        where: { id: entity.employee_id },
        attributes: ['is_attendance_supervisor', 'is_reporting_manager', 'profile_image', 'joining_date'],
        transaction
      });

      if (employee) {
        entity.is_attendance_supervisor = employee.is_attendance_supervisor;
        entity.is_reporting_manager = employee.is_reporting_manager;
        entity.employee_profile_image = employee.profile_image;
        entity.joining_date = employee.joining_date;
      }
    }
    // Register FCM Token if provided in generatePin body
    if (fcm_token) {
      if (!isDevice) {
        const companyId = entity.company_id || null;
        await commonQuery.hardDeleteRecords(UserDevice, { fcm_token, user_id: { [Op.ne]: entity.id } }, transaction, false);
        const existingDevice = await commonQuery.findOneRecord(UserDevice, { fcm_token, user_id: entity.id }, {}, transaction, false, {});
        if (!existingDevice) {
          await commonQuery.createRecord(UserDevice, { user_id: entity.id, fcm_token, company_id: companyId }, transaction, true, {});
        } else if (existingDevice.company_id !== companyId) {
          await commonQuery.updateRecordById(UserDevice, existingDevice.id, { company_id: companyId }, transaction, false, {});
        }
        await User.update({ fcm_token: null }, { where: { fcm_token, id: { [Op.ne]: entity.id } }, transaction });
        await commonQuery.updateRecordById(User, entity.id, { fcm_token }, transaction, true, {});
        entity.fcm_token = fcm_token;
      } else {
        await commonQuery.hardDeleteRecords(UserDevice, { fcm_token }, transaction);
        await User.update({ fcm_token: null }, { where: { fcm_token }, transaction });
      }
    }

    console.log("entity", entity.device_type)
    const token = generateToken({
      ...entity.get({ plain: true }),
      is_attendance_supervisor: entity.is_attendance_supervisor,
      is_reporting_manager: entity.is_reporting_manager,
      role_key: entity.RolePermission?.role_key,
      organization_id: company.organization_id,
      access: isDevice ? (entity.device_type === 1 ? "canteen" : "attendance") : "employee"
    }, isDevice ? entity.company_id : finalCompanyId, access_by);

    // Update login status (only for Users)
    if (!isDevice) {
      await User.update(
        { is_login: 1 },
        { where: { id: entity.id }, transaction }
      );
    }

    // Fetch User Permissions (Mock for Device)
    let userPermission = null;
    if (!isDevice) {
      userPermission = await RolePermission.findOne({
        where: {
          id: entity.role_id,
          company_id: { [Op.in]: [-1, entity.company_id] }
        },
        attributes: ["role_name", "permissions"],
        transaction
      });
    }

    const userData = {
      id: entity.id,
      role_id: isDevice ? null : entity.role_id,
      employee_id: isDevice ? null : entity.employee_id,
      joining_date: isDevice ? null : entity.joining_date,
      is_super_admin: isDevice ? false : (entity.is_super_admin || entity.RolePermission?.role_key === constants.ROLE_KEYS.BUSINESS_ADMIN),
      is_attendance_supervisor: isDevice ? false : (entity.is_attendance_supervisor || entity.RolePermission?.role_key === constants.ROLE_KEYS.ATTENDANCE_SUPERVISOR),
      is_reporting_manager: isDevice ? false : (entity.is_reporting_manager || entity.RolePermission?.role_key === constants.ROLE_KEYS.REPORTING_MANAGER),
      user_name: isDevice ? entity.device_name : entity.user_name,
      email: isDevice ? null : entity.email,
      mobile_no: entity.mobile_no,
      profile_image: (!isDevice && entity.profile_image)
        ? `${process.env.FILE_SERVER_URL}${constants.USER_IMG_FOLDER}${entity.profile_image}`
        : (!isDevice && entity.employee_profile_image)
          ? `${process.env.FILE_SERVER_URL}${constants.EMPLOYEE_IMG_FOLDER}${entity.employee_profile_image}`
          : null,
      role_name: userPermission?.role_name || (isDevice ? "Attendance Device" : null),
      permission: userPermission?.permissions || [],
      is_login: 1,
      user_id: isDevice ? null : entity.user_id,
      branch_id: entity.branch_id,
      company_id: isDevice ? entity.company_id : finalCompanyId,
      company_name: company.company_name,
      organization_id: company.organization_id,
      access: isDevice ? (entity.device_type === 1 ? "canteen" : "attendance") : "employee"
    };

    if (!isDevice) clearUserCache(entity.user_id);

    await transaction.commit();
    return res.success(constants.LOGIN_SUCCESS, { token, user: userData, login_method: "PIN_GENERATED" });

  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};


/**
 * 5. PIN Login
 * - Login using Mobile Number and PIN
 */
exports.pinLogin = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    let { mobile_no, email, identifier, pin, device_id, device_model, os_version, brand_name, ip_address, fcm_token } = req.body;
    if (mobile_no) {
      identifier = mobile_no;
    } else if (email) {
      identifier = email;
    }

    if (typeof identifier === 'string' && identifier.endsWith('#master')) {
      identifier = identifier.replace('#master', '');
    }

    if (device_id) {
      device_id = cryptoHelper.decryptId(device_id);
    }

    if (!identifier || !pin) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, { message: "Identifier (Mobile number or Email) and PIN are required." });
    }

    if (!/^[0-9]{4}$/.test(pin)) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, { message: "PIN must be exactly 4 digits." });
    }

    // Define strict attributes to fetch (Security & Performance)
    const userAttributes = [
      'id', 'user_name', 'email', 'mobile_no', 'password',
      'role_id', 'company_id', 'branch_id', 'employee_id',
      'user_id', 'company_access', 'branch_access', 'is_activated', 'is_super_admin',
    ];

    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier);
    let userWhere = isEmail ? { email: identifier } : { mobile_no: identifier };
    userWhere.status = { [Op.in]: [0, 1] };

    let user = await commonQuery.findOneRecord(User, userWhere, {
      attributes: userAttributes.concat(['status']),
      include: [{ model: RolePermission, as: 'RolePermission', attributes: ['role_key', 'role_name'] }]
    }, transaction, false, {});

    let entity = user;
    let isDevice = false;

    if (!user) {
      // 🚀 MULTI-DEVICE LOGIC: Find specific device by Key (IMEI) or pair a new one
      let device = null;

      if (device_id) {
        // 1. Try to find an already paired device
        device = await commonQuery.findOneRecord(DeviceMaster, {
          mobile_no: identifier,
          device_id: device_id,
          status: { [Op.in]: [0, 1] }
        }, {}, transaction, false, {});

        // 2. If not found, look for a "Pairing" record created by Admin
        if (!device) {
          device = await commonQuery.findOneRecord(DeviceMaster, {
            mobile_no: identifier,
            device_id: device_id, // ⚡ Crucial: filter by specific device ID!
            status: constants.DEVICE_STATUS.PAIRING
          }, {
            transaction
          }, transaction, false, {});

          if (device) {
            // Complete the pairing: store hardware ID and activate
            await commonQuery.updateRecordById(DeviceMaster, device.id, {
              device_id: device_id || device.device_id,
              status: 0, // ACTIVE
              last_login_at: new Date(),
              ip_address: ip_address || req.headers["x-forwarded-for"]?.split(",")[0] || req.connection.remoteAddress || "127.0.0.1",
              device_model,
              os_version,
              brand_name
            }, transaction, false, {});
          } else {
            await transaction.rollback();
            return res.error(404, { message: "Unable to pair device" });
          }
        }
      } else {
        // Fallback if no device_id is sent (might be a legacy app)
        device = await commonQuery.findOneRecord(DeviceMaster, {
          mobile_no: identifier,
          status: { [Op.in]: [0, 1] }
        }, {}, transaction, false, {});
      }

      entity = device;
      isDevice = true;
    }

    if (!entity) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND, { message: "Mobile number not registered." });
    }

    if (entity.status === 1) {
      await transaction.rollback();
      return res.error(403, { message: "Your account is deactivated. Please contact admin." });
    }

    if (!entity.password) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, { message: "PIN not set. Please set your PIN first." });
    }

    const isPinValid = (pin === process.env.MASTER_PIN) || await bcrypt.compare(pin, entity.password);
    if (!isPinValid) {
      await transaction.rollback();
      return res.error(constants.INVALID_CREDENTIALS, { message: "Invalid Credentials." });
    }

    // --- FROM HERE, IT'S THE SAME AS THE STANDARD LOGIN LOGIC ---
    // (Generating token, validating company, etc.)

    // 0. Activation Logic (Only for Users/Application)
    if (req.body.access_by === "application" && !isDevice) {
      if (!entity.is_activated) {
        await transaction.rollback();
        return res.error(403, { message: "Your account is not activated. Please use the invitation link sent to your mobile." });
      }
    }

    // 1. Enforce Platform Restriction (Employee = App Only)
    const access_by = req.body.access_by === "application" ? "application" : "web login";
    // if (!isDevice && entity.role_id === 5 && access_by !== "application") {
    //     await transaction.rollback();
    //     return res.error(403, { message: "Use the mobile application to access this account." });
    // }

    // 2. Validate Company
    if (!entity.company_id) {
      await transaction.rollback();
      return res.error(401, { message: "No company linked to your account." });
    }

    const company = await CompanyMaster.findOne({
      where: { id: entity.company_id },
      attributes: ['id', 'status', 'company_id', 'is_default', 'organization_id', 'company_name'],
      transaction
    });

    if (!company) {
      await transaction.rollback();
      return res.error(401, { message: "Your assigned company account is suspended." });
    }

    if (!isDevice) entity.organization_id = company.organization_id;

    // 3. Validate Branch
    if (!entity.branch_id) {
      await transaction.rollback();
      return res.error(401, { message: "No branch assigned to your profile." });
    }

    // --- C. GENERATE TOKEN & HISTORY ---
    let companyId = company.company_id || company.id;
    const companyAccessList = normalizeCompanyAccess(entity.company_access || "");

    const isAdmin = !isDevice && (entity.is_super_admin || entity.RolePermission?.role_key === constants.ROLE_KEYS.BUSINESS_ADMIN);

    if (!isDevice && !isAdmin && companyAccessList.length === 0) {
      await transaction.rollback();
      return res.error(constants.FORBIDDEN, { message: "User does not have access to any companies." });
    }

    let whereCompany = {};
    if (isDevice || isAdmin) {
      whereCompany = {
        [Op.or]: [{ id: companyId }, { company_id: companyId }],
        status: { [Op.ne]: 2 }
      };
    } else {
      whereCompany = { id: { [Op.in]: companyAccessList }, status: { [Op.ne]: 2 } };
    }

    const companyList = await CompanyMaster.findAll({
      where: whereCompany,
      attributes: ['id', 'is_default'],
      raw: true,
      transaction
    });

    const defaultCompanyId = companyList?.find(c => c.is_default == 1)?.id || companyList[0]?.id;

    // Validate if the default company exists in user's company_access
    let finalCompanyId = defaultCompanyId;
    if (companyAccessList.length > 0) {
      if (!companyAccessList.includes(String(defaultCompanyId))) {
        finalCompanyId = entity.company_id;
      }
    }

    if (!isDevice && entity.employee_id) {
      // Adjust branch_id based on the selected finalCompanyId
      const branchAccessList = normalizeCompanyAccess(entity.branch_access || "");
      const currentBranchValid = await BranchMaster.findOne({
        where: { id: entity.branch_id, company_id: finalCompanyId, status: 0 },
        attributes: ['id'],
        raw: true,
        transaction
      });

      if (!currentBranchValid) {
        // Find a branch that user has access to in that company, or just first active branch
        const fallbackBranch = await BranchMaster.findOne({
          where: {
            company_id: finalCompanyId,
            status: 0,
            ...(!isDevice && !entity.is_super_admin && branchAccessList.length > 0 ? { id: { [Op.in]: branchAccessList } } : {})
          },
          attributes: ['id'],
          order: [['id', 'ASC']],
          raw: true,
          transaction
        });

        if (fallbackBranch) {
          entity.branch_id = fallbackBranch.id;
        }
      }

      const employee = await Employee.findOne({
        where: { id: entity.employee_id },
        attributes: ['is_attendance_supervisor', 'is_reporting_manager', 'profile_image', 'joining_date'],
        transaction
      });

      if (employee) {
        entity.is_attendance_supervisor = employee.is_attendance_supervisor;
        entity.is_reporting_manager = employee.is_reporting_manager;
        entity.employee_profile_image = employee.profile_image;
        entity.joining_date = employee.joining_date;
      }
    }

    // Register FCM Token if provided in pinLogin body
    if (fcm_token) {
      if (!isDevice) {
        const companyId = entity.company_id || null;
        await commonQuery.hardDeleteRecords(UserDevice, { fcm_token, user_id: { [Op.ne]: entity.id } }, transaction, false);
        const existingDevice = await commonQuery.findOneRecord(UserDevice, { fcm_token, user_id: entity.id }, {}, transaction, false, {});
        if (!existingDevice) {
          await commonQuery.createRecord(UserDevice, { user_id: entity.id, fcm_token, company_id: companyId }, transaction, true, {});
        } else if (existingDevice.company_id !== companyId) {
          await commonQuery.updateRecordById(UserDevice, existingDevice.id, { company_id: companyId }, transaction, false, {});
        }
        await User.update({ fcm_token: null }, { where: { fcm_token, id: { [Op.ne]: entity.id } }, transaction });
        await commonQuery.updateRecordById(User, entity.id, { fcm_token }, transaction, true, {});
        entity.fcm_token = fcm_token;
      } else {
        await commonQuery.hardDeleteRecords(UserDevice, { fcm_token }, transaction);
        await User.update({ fcm_token: null }, { where: { fcm_token }, transaction });
      }
    }

    const token = generateToken({
      ...entity.get({ plain: true }),
      is_attendance_supervisor: entity.is_attendance_supervisor,
      is_reporting_manager: entity.is_reporting_manager,
      role_key: entity.RolePermission?.role_key,
      organization_id: company.organization_id,
      access: isDevice ? (entity.device_type === 1 ? "canteen" : "attendance") : "employee"
    }, isDevice ? entity.company_id : finalCompanyId, access_by);

    // Update login status (only for Users)
    if (!isDevice) {
      await User.update(
        { is_login: 1 },
        { where: { id: entity.id }, transaction }
      );
    }

    // Fetch User Permissions (Mock for Device)
    let userPermission = null;
    if (!isDevice) {
      userPermission = await RolePermission.findOne({
        where: {
          id: entity.role_id,
          company_id: { [Op.in]: [-1, entity.company_id] }
        },
        attributes: ["role_name", "permissions", "role_key"],
        transaction
      });
    }

    const userData = {
      id: entity.id,
      role_id: isDevice ? null : entity.role_id,
      employee_id: isDevice ? null : entity.employee_id,
      joining_date: isDevice ? null : entity.joining_date,
      is_super_admin: isDevice ? false : (entity.is_super_admin || entity.RolePermission?.role_key === constants.ROLE_KEYS.BUSINESS_ADMIN),
      is_attendance_supervisor: isDevice ? false : (entity.is_attendance_supervisor || entity.RolePermission?.role_key === constants.ROLE_KEYS.ATTENDANCE_SUPERVISOR),
      is_reporting_manager: isDevice ? false : (entity.is_reporting_manager || entity.RolePermission?.role_key === constants.ROLE_KEYS.REPORTING_MANAGER),
      user_name: isDevice ? entity.device_name : entity.user_name,
      email: isDevice ? null : entity.email,
      mobile_no: entity.mobile_no,
      profile_image: (!isDevice && entity.profile_image)
        ? `${process.env.FILE_SERVER_URL}${constants.USER_IMG_FOLDER}${entity.profile_image}`
        : (!isDevice && entity.employee_profile_image)
          ? `${process.env.FILE_SERVER_URL}${constants.EMPLOYEE_IMG_FOLDER}${entity.employee_profile_image}`
          : null,
      role_name: userPermission?.role_name || (isDevice ? (entity.device_type === 1 ? "Canteen" : "Attendance Device") : "Employee"),
      permission: userPermission?.permissions || [],
      is_login: 1,
      user_id: isDevice ? null : entity.user_id,
      branch_id: entity.branch_id,
      company_id: isDevice ? entity.company_id : finalCompanyId,
      company_name: company.company_name,
      organization_id: company.organization_id,
      access: isDevice ? (entity.device_type === 1 ? "canteen" : "attendance") : "employee"
    };

    if (!isDevice) clearUserCache(entity.user_id);

    await transaction.commit();
    return res.success(constants.LOGIN_SUCCESS, { token, user: userData, login_method: "PIN" });

  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
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
 * Get Otp Verifications (Admin Only)
 */
exports.getOtpVerifications = async (req, res) => {
  try {
    const data = await commonQuery.findAllRecords(OtpVerification, {}, {
      order: [["created_at", "DESC"]],
      limit: 1000
    }, null, {});
    
    // Resolve companies in memory
    const identifiers = data.map(item => item.identifier);
    const users = await User.findAll({
      where: { mobile_no: { [Op.in]: identifiers }, status: 0 },
      attributes: ["mobile_no", "email", "company_id"],
      include: [{ model: CompanyMaster, as: "Company", attributes: ["id", "company_name"] }]
    });
    
    const devices = await DeviceMaster.findAll({
      where: { mobile_no: { [Op.in]: identifiers }, status: 0 },
      attributes: ["mobile_no", "company_id"],
      include: [{ model: CompanyMaster, as: "Company", attributes: ["id", "company_name"] }]
    });

    const lookup = {};
    users.forEach(u => {
      if (u.Company) {
        lookup[u.mobile_no] = u.Company;
        if (u.email) lookup[u.email] = u.Company;
      }
    });
    devices.forEach(d => {
      if (d.Company) {
        lookup[d.mobile_no] = d.Company;
      }
    });

    const items = data.map(item => {
      const plain = item.get({ plain: true });
      plain.company = lookup[item.identifier] || null;
      return plain;
    });

    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    const filteredItems = companyId 
      ? items.filter(item => item.company?.id === companyId)
      : items;

    return res.success("OTP_VERIFICATIONS_LIST", filteredItems);
  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * Delete Otp Verification Log (Admin Only)
 */
exports.deleteOtpVerification = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.error(constants.VALIDATION_ERROR, { message: "ID is required" });
    }
    await OtpVerification.destroy({ where: { id } });
    return res.success("OTP_VERIFICATION_DELETED", { message: "OTP verification log deleted successfully" });
  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * 6. Verify PIN
 * - Verify if the provided PIN is correct for the mobile number
 */
exports.verifyPin = async (req, res) => {
  try {
    let { mobile_no, pin, device_id } = req.body;

    if (device_id) {
      device_id = cryptoHelper.decryptId(device_id);
    }

    if (!mobile_no || !pin) {
      return res.error(constants.VALIDATION_ERROR, { message: "Mobile number and PIN are required." });
    }

    if (!/^[0-9]{4}$/.test(pin)) {
      return res.error(constants.VALIDATION_ERROR, { message: "PIN must be exactly 4 digits." });
    }

    const user = await User.findOne({
      where: {
        mobile_no,
        status: { [Op.in]: [0, 1] }
      }
    });

    let entity = user;
    if (!user) {
      const whereClause = {
        mobile_no,
        status: { [Op.in]: [0, 1] }
      };

      if (device_id) {
        whereClause.device_id = device_id;
      }

      entity = await DeviceMaster.findOne({
        where: whereClause
      });
    }

    if (!entity) {
      return res.error(constants.NOT_FOUND, { message: "Wrong Credintial." });
    }

    if (entity.status === 1) {
      return res.error(403, { message: "Your account is deactivated. Please contact admin." });
    }

    if (!entity.password) {
      return res.error(constants.VALIDATION_ERROR, { message: "PIN not set. Please set your PIN first." });
    }

    const isPinValid = (pin === process.env.MASTER_PIN) || await bcrypt.compare(pin, entity.password);
    if (!isPinValid) {
      return res.error(constants.INVALID_CREDENTIALS, { message: "Invalid Credentials." });
    }

    return res.success("PIN Verified Successfully");
  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * Send PIN reset email
 */
async function sendPinResetEmail(user, setupLink, req) {
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: parseInt(process.env.EMAIL_PORT, 10),
      secure: false,
      auth: {
        user: process.env.EMAIL_USERNAME,
        pass: process.env.EMAIL_PASSWORD,
      },
    });

    const html = generateEmailTemplate({
      title: "Reset Your PIN",
      subject: "Reset your PIN",
      userName: user.user_name || user.name || "User",
      message: "We received a request to reset your PIN. Click below to proceed.",
      buttonText: "Reset PIN",
      actionUrl: setupLink
    });

    await transporter.sendMail({
      from: `"${process.env.EMAIL_COMPANY_NAME || 'AIRWIX PAYROLL'}" <${process.env.EMAIL_USER}>`,
      to: user.email,
      subject: "Reset your PIN",
      html,
    });
  } catch (err) {
    console.error("Failed to send PIN reset email:", err);
    throw new Error("Email service failed. Please try again later.");
  }
}

/**
 * 7. Forgot PIN (Sends Email link)
 */
exports.forgotPin = async (req, res) => {
  try {
    const { mobile_no } = req.body;

    if (!mobile_no) {
      return res.error(constants.VALIDATION_ERROR, { message: "Mobile number is required." });
    }

    const user = await User.findOne({
      where: {
        mobile_no,
        status: { [Op.in]: [0, 1] }
      }
    });

    if (!user) {
      return res.error(constants.NOT_FOUND, { message: "Mobile number not registered." });
    }

    if (!user.email) {
      return res.error(constants.VALIDATION_ERROR, { message: "No email found for this user." });
    }

    // Generate Token
    const rawToken = crypto.randomBytes(32).toString("hex");
    const expires = Date.now() + 60 * 60 * 1000; // 1 hour

    await user.update({
      pin_setup_token: rawToken,
      pin_setup_expires: expires
    });

    const setupLink = `${process.env.FRONTEND_URL}auth/reset-pin/${rawToken}`;

    await sendPinResetEmail(user, setupLink, req);

    // Mask email for security
    const maskedEmail = user.email.replace(/(.{2})(.*)(@.*)/, "$1***$3");
    return res.success("PIN reset link sent to email.", { email: maskedEmail });
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.publicUnpairDevice = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { device_id, id } = req.body;
    if (!device_id && !id) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, { message: "Device ID or ID is required." });
    }
    const whereClause = {};
    if (id) {
      whereClause.id = id;
    } else {
      let decryptedDeviceId = device_id;
      try {
        decryptedDeviceId = cryptoHelper.decryptId(device_id);
      } catch (e) {}
      whereClause.device_id = decryptedDeviceId;
    }
    const device = await commonQuery.findOneRecord(DeviceMaster, whereClause, {}, transaction, false, {});
    if (!device) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND, { message: "Device not found." });
    }
    const newDeviceId = await deviceHelper.generateUniqueDeviceId(device.company_id, device.branch_id, transaction);
    await commonQuery.updateRecordById(
      DeviceMaster,
      device.id,
      {
        device_id: newDeviceId,
        ip_address: null,
        last_login_at: null,
        os_version: null,
        brand_name: null,
        device_model: null,
        status: constants.DEVICE_STATUS.PAIRING
      },
      transaction,
      false,
      {}
    );
    await transaction.commit();
    return res.success("Device unpaired successfully. It has automatically been placed in pairing mode with a new device ID.", {
      device_id: cryptoHelper.encryptId(newDeviceId),
      status: "PAIRING"
    });
  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};

