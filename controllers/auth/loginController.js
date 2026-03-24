const { LoginHistory, User, CompanyMaster, BranchMaster, UserCompanyRoles, RolePermission, Employee, DeviceMaster } = require("../../models"); // Added Company and Branch models
const { sequelize, commonQuery, handleError, Op, constants, otpService } = require("../../helpers");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const UAParser = require("ua-parser-js");
const geoip = require("geoip-lite");
const otpRateLimit = require("../../helpers/otpRateLimit");
const { clearUserCache } = require("../../helpers/permissionCache");
const { addToBlacklist } = require("../../middlewares/authMiddleware");
const { generateToken } = require("../../helpers/tokenHelper");

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
    const indianMobileRegex = /^[6-9]\d{9}$/;
    if (!mobile_no || !indianMobileRegex.test(mobile_no)) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, { errors: ["Invalid mobile number."] });
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

        const isPasswordValid = await bcrypt.compare(password, user.password);
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
    // if (user.role_id === 5 && access_by !== "application") {
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

    const companyAccessList = normalizeCompanyAccess(user.company_access || "");    
    if (!user.is_super_admin && user.role_id != 1 && companyAccessList.length === 0) {
      await transaction.rollback();
      return res.error(constants.FORBIDDEN, {message: "User does not have access to any companies."});
    }

    let whereCompany = {};
    if (user.is_super_admin || user.role_id == 1){
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
    let finalCompanyId = defaultCompanyId;
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
            ...(!user.is_super_admin && user.role_id != 1 && branchAccessList.length > 0 ? { id: { [Op.in]: branchAccessList } } : {})
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

    if(!user.is_super_admin && user.role_id != 1){
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
      attributes: ["role_name", "permissions"],
      transaction 
    });

    // Prepare User Data Response
    const userData = {
      id: user.id,
      role_id: user.role_id,
      is_super_admin: user.is_super_admin || user.role_id == 1,
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
      is_employee: user.role_id === 5,
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
    const { mobile_no } = req.body;
    
    if (!mobile_no) {
      return res.error(constants.VALIDATION_ERROR, { message: "Mobile number is required." });
    }

    let user = await User.findOne({
      where: { 
        mobile_no, 
        status: { [Op.in]: [0, 1] } 
      }
    });

    let entity = user;
    if (!user) {
      const device = await DeviceMaster.findOne({
        where: { 
          mobile_no, 
          status: { [Op.in]: [0, 1] } 
        }
      });
      entity = device;
    }
    
    if (!entity) {
      return res.error(constants.NOT_FOUND, "Mobile number not registered.");
    }

    if (entity.status === 1) {
      return res.error(403, { message: "Your account is deactivated. Please contact admin." });
    }

    if (!entity.password) {
      return res.success("SET PIN");
    } else {
      return res.success("ENTER PIN");
    }

  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * 4. Generate/Set PIN
 * - Sets the PIN in the password field for the user and logs them in
 */
exports.generatePin = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { mobile_no, pin } = req.body;

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

    let user = await User.findOne({
      attributes: userAttributes.concat(['status']),
      where: { 
        mobile_no, 
        status: { [Op.in]: [0, 1] } 
      },
      transaction
    });

    let entity = user;
    let isDevice = false;
    if (!user) {
      const device = await DeviceMaster.findOne({
        where: { 
          mobile_no, 
          status: { [Op.in]: [0, 1] } 
        },
        transaction
      });
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
        where: { id: entity.id }, transaction 
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
    if (!isDevice && entity.role_id === 5 && access_by !== "application") {
        await transaction.rollback();
        return res.error(403, { message: "Use the mobile application to access this account." });
    }

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
    
    if (!isDevice && !entity.is_super_admin && entity.role_id != 1 && companyAccessList.length === 0) {
      await transaction.rollback();
      return res.error(constants.FORBIDDEN, {message: "User does not have access to any companies."});
    }

    let whereCompany = {};
    if (isDevice || entity.is_super_admin || entity.role_id == 1){
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
      organization_id: company.organization_id,
      access: isDevice ? "attendance device" : "employee"
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
      is_super_admin: isDevice ? false : (entity.is_super_admin || entity.role_id == 1),
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
      access: isDevice ? "attendance device" : "employee"
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
    const { mobile_no, pin } = req.body;

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

    let user = await User.findOne({ 
      attributes: userAttributes.concat(['status']),
      where: { 
        mobile_no, 
        status: { [Op.in]: [0, 1] } 
      }, 
      transaction 
    });

    let entity = user;
    let isDevice = false;
    if (!user) {
      const device = await DeviceMaster.findOne({
        where: { 
          mobile_no, 
          status: { [Op.in]: [0, 1] } 
        }, 
        transaction 
      });
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

    const isPinValid = await bcrypt.compare(pin, entity.password);
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
    if (!isDevice && entity.role_id === 5 && access_by !== "application") {
        await transaction.rollback();
        return res.error(403, { message: "Use the mobile application to access this account." });
    }

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
    
    if (!isDevice && !entity.is_super_admin && entity.role_id != 1 && companyAccessList.length === 0) {
      await transaction.rollback();
      return res.error(constants.FORBIDDEN, {message: "User does not have access to any companies."});
    }

    let whereCompany = {};
    if (isDevice || entity.is_super_admin || entity.role_id == 1){
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
      organization_id: company.organization_id,
      access: isDevice ? "attendance device" : "employee"
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
      is_super_admin: isDevice ? false : (entity.is_super_admin || entity.role_id == 1),
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
      access: isDevice ? "attendance device" : "employee"
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
 * 6. Verify PIN
 * - Verify if the provided PIN is correct for the mobile number
 */
exports.verifyPin = async (req, res) => {
    try {
        const { mobile_no, pin } = req.body;

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
            entity = await DeviceMaster.findOne({
                where: { 
                    mobile_no, 
                    status: { [Op.in]: [0, 1] } 
                }
            });
        }

        if (!entity) {
            return res.error(constants.NOT_FOUND, { message: "Mobile number not registered." });
        }

        if (entity.status === 1) {
            return res.error(403, { message: "Your account is deactivated. Please contact admin." });
        }

        if (!entity.password) {
            return res.error(constants.VALIDATION_ERROR, { message: "PIN not set. Please set your PIN first." });
        }

        const isPinValid = await bcrypt.compare(pin, entity.password);
        if (!isPinValid) {
            return res.error(constants.INVALID_CREDENTIALS, { message: "Invalid Credentials." });
        }

        return res.success("PIN Verified Successfully");
    } catch (err) {
        return handleError(err, res, req);
    }
};

