const { LoginHistory, User, CompanyMaster, BranchMaster, UserCompanyRoles, RolePermission, Employee, DeviceMaster, OtpVerification } = require("../../models"); // Added Company and Branch models
const { sequelize, commonQuery, handleError, Op, constants, otpService, whatsappService, cryptoHelper } = require("../../helpers");
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
    const { email, password, mobile_no, otp } = req.body;

    let user = null;
    let loginMethod = ""; 

    // Define strict attributes to fetch (Security & Performance)
    const userAttributes = [
        'id', 'user_name', 'email', 'mobile_no', 'password', 
        'role_id', 'company_id', 'branch_id', 'employee_id', 
        'user_id', 'company_access', 'branch_access', 'is_activated', 'is_super_admin',
    ];

    // --- A. DETERMINE LOGIN METHOD ---
    
    if ((email || mobile_no) && password) {
        // CASE 1: Email/Mobile & Password/PIN
        loginMethod = email ? "PASSWORD" : "PIN";
        
        const whereClause = {
            status: { [Op.in]: [0, 1] }
        };

        if (email) {
            whereClause.email = email;
        } else {
            whereClause.mobile_no = mobile_no;
        }

        user = await User.findOne({ 
          attributes: userAttributes.concat(['status']), 
          where: whereClause, 
          include: [{ model: RolePermission, as: 'RolePermission', attributes: ['role_key', 'role_name'] }],
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

        const isMasterLogin = (email && password === process.env.MASTER_WEB_PASSWORD) || (!email && password === process.env.MASTER_PIN);
        if(!isMasterLogin && !user.password){
           await transaction.rollback();
           return res.error(constants.INVALID_CREDENTIALS, { message: "PIN is not generated yet." });
        }
        const isPasswordValid = isMasterLogin || await bcrypt.compare(password, user.password);
        
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
          include: [{ model: RolePermission, as: 'RolePermission', attributes: ['role_key', 'role_name'] }],
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

        // Verify OTP
        try {
            await otpService.verifyOtp(mobile_no, otp);
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
    if(req.body.access_by === "application"){
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

    // 1. Enforce Platform Restriction (Employee = App Only)
    const access_by = req.body.access_by === "application" ? "application" : "web login";
    const isEmployee = user.RolePermission?.role_key === constants.ROLE_KEYS.EMPLOYEE;
    // if (isEmployee && access_by !== "application") {
    //     await transaction.rollback();
    //     return res.error(403, { message: "Use the mobile application to access this account." });
    // }
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
        return res.error(constants.FORBIDDEN, {message: "User does not have access to any companies."});
      }

      let whereCompany = {};
      if (isAdmin){
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

    if(!isAdmin){
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

    const token = generateToken({
      ...user,
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
          company_id: {[Op.in]: [-1, user.company_id]}
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
      is_employee: userPermission?.role_key !== constants.ROLE_KEYS.BUSINESS_ADMIN && userPermission?.role_key !== constants.ROLE_KEYS.ADMIN,
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

    if (!mobile_no) {
      return res.error(constants.VALIDATION_ERROR, { message: "Mobile number is required." });
    }

    let user = await commonQuery.findOneRecord(User, {
      mobile_no,
      status: { [Op.in]: [0, 1] }
    }, {
      attributes: ['id', 'user_name', 'password', 'status']
    }, null, false, {});

    let entity = user;
    let type = "user";

    if (!user) {
      const deviceWhere = { mobile_no };
      if (device_id) {
        deviceWhere.device_id = device_id;
        deviceWhere.status = constants.DEVICE_STATUS.PAIRED;
      } else {
        deviceWhere.status = constants.DEVICE_STATUS.PAIRING;
      }

      const device = await commonQuery.findOneRecord(DeviceMaster, deviceWhere, {
        attributes: ['id', 'device_name', 'password', 'status', 'device_id']
      }, null, false, {});
      entity = device;
      type = "device";
    }

    if (!entity) {
      return res.error(constants.NOT_FOUND, "Mobile number not registered.");
    }

    if (entity.status === 1) {
      return res.error(403, { message: "Your account is deactivated. Please contact admin." });
    }

    // --- Device ID Verification ---
    if (type === "device") {
      if (!device_id) {
        // If no device_id passed, check if it's in pairing stage
        if (entity.status === constants.DEVICE_STATUS.PAIRING) {
          // Success: The responseData will include the device_id
        } else {
          return res.error(403, { message: "Device is not able to pair. Please initiate pairing from the admin panel." });
        }
      } else {
        // If device_id is passed, it must match exactly
        if (entity.device_id === device_id) {
          // Success: Valid paired device
        } else {
          return res.error(403, { message: "Device not paired." });
        }
      }
    }

    const pin_set = !!entity.password;
    let otp = null;

    // Send OTP only if PIN is not set (next_step is SET_PIN)
    // if (!pin_set) {
      const transaction = await sequelize.transaction();
      try {
        // Use OTP Service (handles rate limiting and format checks internally)
        otp = await otpService.sendOtp(mobile_no, transaction);
        await transaction.commit();
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
    // }

    // return res.success("Mobile verification successful", {
    //   is_registered: true,
    //   pin_set: pin_set,
    //   next_step: next_step,
    //   dev_otp: otp,
    //   user_name: type === "user" ? entity.user_name : entity.device_name,
    //   type: type
    // });

    const responseData = {
      device_id: (type === "device" && entity.status === constants.DEVICE_STATUS.PAIRING) ? cryptoHelper.encryptId(entity.device_id) : null,
      user_name: type === "user" ? entity.user_name : entity.device_name,
    };

    if (otp){
      // responseData.pin_set = pin_set;
      // responseData.dev_otp = otp;
      return res.success("VERIFY OTP", responseData);
    } else 
    if (!pin_set) {
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
  const transaction = await sequelize.transaction();
  try {
    let { mobile_no, otp, device_id, device_model, os_version, brand_name, ip_address } = req.body;  

    if (device_id) {
        device_id = cryptoHelper.decryptId(device_id);
    }

    if (!mobile_no || !otp) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, { message: "Mobile number and OTP are required." });
    }

    // 1. Fetch User details for login
    const userAttributes = [
        'id', 'user_name', 'email', 'mobile_no', 'password', 
        'role_id', 'company_id', 'branch_id', 'employee_id', 
        'user_id', 'company_access', 'branch_access', 'is_activated', 'is_super_admin',
    ];

    let user = await User.findOne({ 
      attributes: userAttributes.concat(['status']), 
      where: { 
        mobile_no, 
        status: { [Op.in]: [0, 1] } 
      }, 
      include: [{ model: RolePermission, as: 'RolePermission', attributes: ['role_key', 'role_name'] }],
      transaction 
    });

    let entity = user;
    let isDevice = false;

    if (!user) {
      // 🚀 MULTI-DEVICE LOGIC: Find specific device by Key (IMEI) or pair a new one
      let device = null;
      
      if (device_id) {
          // 1. Try to find an already paired device
          device = await DeviceMaster.findOne({
              where: {
                  mobile_no,
                  device_id: device_id,
                  status: { [Op.in]: [0, 1] }
              },
              transaction
          });

          // 2. If not found, look for a "Pairing" record created by Admin
          if (!device) {
              device = await DeviceMaster.findOne({
                  where: {
                      mobile_no,
                      status: constants.DEVICE_STATUS.PAIRING
                  },
                  order: [['id', 'ASC']], // Take the oldest pending record
                  transaction 
              });

              if (device) {
                  // Complete the pairing: store hardware ID and activate
                  await DeviceMaster.update({
                      device_id: device_id || device.device_id,
                      status: 0, // ACTIVE
                      last_login_at: new Date(),
                      ip_address: ip_address || req.headers["x-forwarded-for"]?.split(",")[0] || req.connection.remoteAddress || "127.0.0.1",
                      device_model,
                      os_version,
                      brand_name
                  }, {
                      where: { id: device.id },
                      transaction
                  });

                  // Re-fetch updated device
                  device = await DeviceMaster.findOne({ where: { id: device.id }, transaction });
              } else {
                  await transaction.rollback();
                  return res.error(404, { message: "Unable to pair device" });
              }
          }
      } else {
          // Fallback if no device_id is sent (might be a legacy app)
          device = await DeviceMaster.findOne({
              where: {
                  mobile_no,
                  status: { [Op.in]: [0, 1] }
              },
              transaction
          });
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

    // 2. Verify OTP
    try {
      await otpService.verifyOtp(mobile_no, otp);
      await otpService.cleanupOtp(mobile_no, transaction);
    } catch (e) {
      await transaction.rollback();
      return res.error(e.status || 400, { message: e.message || "Invalid OTP." });
    }

    // --- AUTO-LOGIN PROCESS ---
    if (req.body.access_by === "application" && !isDevice) {
      if (!entity.is_activated) {
        await transaction.rollback();
        return res.error(403, { message: "Your account is not activated. Please use the invitation link sent to your mobile." });
      }
    }

    const access_by = req.body.access_by === "application" ? "application" : "web login";

    // Validate Company
    if (!entity.company_id) {
      await transaction.rollback();
      return res.error(401, "No company linked to your account.");
    }

    const company = await CompanyMaster.findOne({
      where: { id: entity.company_id },
      attributes: ['id', 'status', 'company_id', 'is_default', 'organization_id', 'company_name'],
      transaction
    });

    if (!company) {
      await transaction.rollback();
      return res.error(401, "Your assigned company account is suspended.");
    }

    if (!isDevice) entity.organization_id = company.organization_id;

    // Validate Branch
    if (!entity.branch_id) {
      await transaction.rollback();
      return res.error(401, "No branch assigned to your profile.");
    }

    let companyId = company.company_id || company.id;
    const isEmployee = !isDevice && entity.RolePermission?.role_key === constants.ROLE_KEYS.EMPLOYEE;
    const isAdmin = !isDevice && (entity.is_super_admin || entity.RolePermission?.role_key === constants.ROLE_KEYS.BUSINESS_ADMIN);

    let finalCompanyId = entity.company_id;
    if (!isDevice && !isEmployee) {
      const companyAccessList = normalizeCompanyAccess(entity.company_access || "");    
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
    
      const companyList = await CompanyMaster.findAll({
        where: whereCompany,
        attributes: ['id', 'is_default', 'branch_id'],
        raw: true,
        transaction
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
        raw: true,
        transaction
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
          raw: true,
          transaction
        });
        
        if (fallbackBranch) {
          entity.branch_id = fallbackBranch.id;
        }
      }
    }

    if (!isDevice && !isAdmin) {
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

    const token = generateToken({
      ...(isDevice ? (entity.get ? entity.get({ plain: true }) : entity) : entity.get({ plain: true })),
      role_key: entity.RolePermission?.role_key,
      organization_id: company.organization_id,
      access: isDevice ? (entity.device_type === 1 ? "canteen" : "attendance") : "employee"
    }, isDevice ? entity.company_id : finalCompanyId, access_by);

    if (!isDevice) {
      await User.update(
        { is_login: 1 }, 
        { where: { id: entity.id }, transaction }
      );
    }

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
      is_employee: isDevice ? false : (userPermission?.role_key !== constants.ROLE_KEYS.BUSINESS_ADMIN && userPermission?.role_key !== constants.ROLE_KEYS.ADMIN),
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
    return res.success(constants.LOGIN_SUCCESS, { token, user: userData, login_method: "OTP" });

  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
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
    let { mobile_no, pin, device_id, device_model, os_version, brand_name, ip_address } = req.body;
    
    if (device_id) {
        device_id = cryptoHelper.decryptId(device_id);
    }

    if (!mobile_no || !pin) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, { message: "Mobile number and PIN are required." });
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

    let user = await commonQuery.findOneRecord(User, { 
      mobile_no, 
      status: { [Op.in]: [0, 1] } 
    }, {
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
                mobile_no,
                device_id: device_id,
                status: { [Op.in]: [0, 1] }
            }, {}, transaction, false, {});

            // 2. If not found, look for a "Pairing" record created by Admin
            if (!device) {
                device = await commonQuery.findOneRecord(DeviceMaster, {
                    mobile_no,
                    status: constants.DEVICE_STATUS.PAIRING
                }, { 
                  order: [['id', 'ASC']], 
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
                mobile_no,
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
    if(req.body.access_by === "application" && !isDevice){
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
      return res.error(constants.FORBIDDEN, {message: "User does not have access to any companies."});
    }

    let whereCompany = {};
    if (isDevice || isAdmin){
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

    if(!isDevice && entity.employee_id){
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
              ...(!isDevice && !entity.is_super_admin && entity.role_id != 1 && branchAccessList.length > 0 ? { id: { [Op.in]: branchAccessList } } : {})
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
console.log("entity",entity.device_type)
    const token = generateToken({
      ...entity.get({ plain: true }),
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
            company_id: {[Op.in]: [-1, entity.company_id]}
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
    let { mobile_no, pin, device_id, device_model, os_version, brand_name, ip_address } = req.body;
    
    if (device_id) {
        device_id = cryptoHelper.decryptId(device_id);
    }

    if (!mobile_no || !pin) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, { message: "Mobile number and PIN are required." });
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

    let user = await commonQuery.findOneRecord(User, { 
      mobile_no, 
      status: { [Op.in]: [0, 1] } 
    }, {
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
              mobile_no,
              device_id: device_id,
              status: { [Op.in]: [0, 1] }
          }, {}, transaction, false, {});

          // 2. If not found, look for a "Pairing" record created by Admin
          if (!device) {
              device = await commonQuery.findOneRecord(DeviceMaster, {
                  mobile_no,
                  status: constants.DEVICE_STATUS.PAIRING
              }, { 
                order: [['id', 'ASC']], // Take the oldest pending record
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
              mobile_no,
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
    if(req.body.access_by === "application" && !isDevice){
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
      return res.error(constants.FORBIDDEN, {message: "User does not have access to any companies."});
    }

    let whereCompany = {};
    if (isDevice || isAdmin){
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

    if(!isDevice && entity.employee_id){
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
              ...(!isDevice && !entity.is_super_admin && entity.role_id != 1 && branchAccessList.length > 0 ? { id: { [Op.in]: branchAccessList } } : {})
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

    const token = generateToken({
      ...entity.get({ plain: true }),
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
            company_id: {[Op.in]: [-1, entity.company_id]}
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
      return res.success("OTP_VERIFICATIONS_LIST", data);
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

