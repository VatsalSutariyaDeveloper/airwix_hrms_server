const { LoginHistory, User, CompanyMaster, UserCompanyRoles, RolePermission } = require("../../models"); // Added Company and Branch models
const { sequelize, commonQuery, handleError, Op, constants, otpService } = require("../../helpers");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const UAParser = require("ua-parser-js");
const geoip = require("geoip-lite");
const otpRateLimit = require("../../helpers/otpRateLimit");
const { clearUserCache } = require("../../helpers/permissionCache");

const normalizeCompanyAccess = (access) => {
  if (Array.isArray(access)) return access.map(String);
  if (typeof access === "string") return access.split(",").map((id) => id.trim()).filter(Boolean);
  return [];
};

const generateToken = (user, companyId, access_by = "web login") => {
  return jwt.sign(
    {
      id: user.id,
      role_id: user.role_id,
      branch_id: user.branch_id,
      company_id: companyId,
      access_by: access_by
    },
    process.env.JWT_SECRET || "your_jwt_secret",
    { expiresIn: "1d" }
  );
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

    // const branch = await commonQuery.findOneRecord(
    //   BranchMaster,
    //   { id: user.branch_id },
    //   {},
    //   transaction, false, false
    // );
    // if (!branch) {
    //   await transaction.rollback();
    //   return res.error(401, "Your assigned branch is inactive.");
    // }

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

    const access_by = req.body.access_by === "application" ? "application" : "web login";

    const token = generateToken(user, defaultCompanyId, access_by);

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
    }, { include: [ { model: RolePermission, as: "role", attributes: ["role_name", "permissions"] } ], attributes: ['permissions'] }, transaction, false, false);

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
      role_name: userPermission?.role?.role_name,
      permission: userPermission?.permissions ? userPermission?.role?.permissions : user.permissions,
      is_login: 1,
      user_id: user.user_id,
      branch_id: user.branch_id,
      company_id: defaultCompanyId,
    };

    clearUserCache(user.user_id);

    await transaction.commit();
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
  try {
    // Get user data for activity logging
    const user = await commonQuery.findOneRecord(
      User,
      { id: req.user.id },
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