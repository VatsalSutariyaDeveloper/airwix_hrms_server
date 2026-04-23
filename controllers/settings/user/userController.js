const { User, RolePermission, CompanyMaster, UserCompanyRoles, Employee, BranchMaster } = require("../../../models");
const { sequelize, Op, validateRequest, commonQuery, uploadFile, deleteFile, handleError, constants, ENTITIES, getCompanySubscription, } = require("../../../helpers");
const { updateDocumentUsedLimit } = require("../../../helpers/functions/commonFunctions");
const bcrypt = require("bcrypt");
const nodemailer = require("nodemailer");
const crypto = require("crypto");
const path = require("path");
const { clearUserCache } = require("../../../helpers/permissionCache");
const { getContext } = require("../../../utils/requestContext");

const ENTITY = ENTITIES.USER.NAME;

/**
 * Generate token & hash for password setup or forgot password
 */
function generatePasswordToken() {
  const rawToken = crypto.randomBytes(64).toString("hex");
  const hashedToken = crypto
    .createHash("sha256")
    .update(rawToken)
    .digest("hex");
  const expires = Date.now() + 60 * 60 * 1000; // 1 hour
  return { rawToken, hashedToken, expires };
}

/**
 * Send password email (setup or forgot)
 */
async function sendPasswordEmail(user, rawToken, req, type = "setup") {
  try {
    const url = `${process.env.FRONTEND_URL}auth/reset-password/${rawToken}`;

    const transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: parseInt(process.env.EMAIL_PORT, 10),
      secure: false,
      auth: {
        user: process.env.EMAIL_USERNAME,
        pass: process.env.EMAIL_PASSWORD,
      },
    });

    const subject =
      type === "setup" ? "Set up your password" : "Reset your password";
    const actionText = type === "setup" ? "Set Password" : "Reset Password";
    const introText =
      type === "setup"
        ? "Your account has been created successfully. Please set your password to get started."
        : "We received a request to reset your password. Click below to proceed.";

    const html = `
      <div style="font-family: Arial, sans-serif; background:#f4f6f8; padding:20px;">
        <table align="center" cellpadding="0" cellspacing="0" width="100%" 
          style="max-width:600px; background:#ffffff; border-radius:8px; overflow:hidden; box-shadow:0 2px 5px rgba(0,0,0,0.1);">
          <tr>
            <td style="padding:20px; text-align:center; background:#2563eb; color:#ffffff; font-size:20px; font-weight:bold;">
              ERP App
            </td>
          </tr>
          <tr>
            <td style="padding:30px; font-size:15px; color:#333;">
              <p style="margin:0 0 15px;">Hello <strong>${user.name || "User"
      }</strong>,</p>
              <p style="margin:0 0 20px;">${introText}</p>
              <div style="text-align:center; margin:30px 0;">
                <a href="${url}" 
                  style="background:#2563eb; color:#ffffff; text-decoration:none; padding:12px 24px; border-radius:6px; font-weight:bold; display:inline-block;">
                  ${actionText}
                </a>
              </div>
              <p style="margin:0 0 15px;">Or copy & paste this link into your browser:</p>
              <p style="word-break:break-all; color:#2563eb;">${url}</p>
              <p style="margin-top:30px; color:#777; font-size:13px;">
                If you didn’t request this, please ignore this email. <br/>
                This link is valid for <strong>1 hour</strong>.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:15px; text-align:center; background:#f4f6f8; font-size:12px; color:#777;">
              © ${new Date().getFullYear()} ERP App. All rights reserved.
            </td>
          </tr>
        </table>
      </div>
    `;

    await transporter.sendMail({
      from: `"ERP App" <${process.env.EMAIL_USER}>`,
      to: user.email,
      subject,
      html,
    });
  } catch (err) {
    console.error("Failed to send email:", err);
    throw new Error("Email service failed. Please try again later.");
  }
}

/**
 * Send password setup email (first-time account creation)
 */
async function sendPasswordSetupEmail(user, req, transaction) {
  const { rawToken, hashedToken, expires } = generatePasswordToken();
  user.reset_password_token = hashedToken;
  user.reset_password_expires = expires;
  await user.save({ transaction });
  await sendPasswordEmail(user, rawToken, req, "setup");
}

/**
 * Send forgot password email
 */
async function sendForgotPasswordEmail(user, req) {
  const { rawToken, hashedToken, expires } = generatePasswordToken();
  user.reset_password_token = hashedToken;
  user.reset_password_expires = expires;
  await user.save();
  await sendPasswordEmail(user, rawToken, req, "forgot");
}

/**
 * Create User and Send Password Setup Link
 */
exports.create = async (req, res) => {
  const { company_id } = getContext();
  const transaction = await sequelize.transaction();
  try {
    // const companyPlan = await getCompanySubscription(company_id);
    // if (companyPlan.users_limit <= companyPlan.used_users) {
    //   await transaction.rollback();
    //   return res.error(constants.LIMIT_EXCEEDED, constants.USER_LIMIT_REACHED);
    // }

    // Base required fields
    const requiredFields = {
      user_name: "User Name",
      login_type: "Login Type",
    };

    if (!req.body.role_id && !req.body.role_key) {
      requiredFields.role_id = "Role";
    }

    // Conditionally add required fields based on login_type
    const loginType = parseInt(req.body.login_type) || 1;

    if (loginType === 1) {
      requiredFields.mobile_no = "Mobile No";
    } else if (loginType === 2) {
      requiredFields.email = "Email";
      requiredFields.password = "Password";
    }

    const uniqueCheckFields = [];
    if (req.body.email) uniqueCheckFields.push("email");
    if (req.body.mobile_no) uniqueCheckFields.push("mobile_no");

    const errors = await validateRequest(req.body, requiredFields, {
      uniqueCheck: uniqueCheckFields.length > 0 ? {
        model: User,
        fields: uniqueCheckFields,
      } : undefined,
    }, transaction);

    if (errors) {
      await transaction.rollback();
      return res.error("VALIDATION_ERROR", { errors });
    }

    // Resolve role_id from role_key if role_id is not provided
    if (!req.body.role_id && req.body.role_key) {
      const role = await commonQuery.findOneRecord(RolePermission, { role_key: req.body.role_key }, {}, transaction, false, { company_id: true });
      if (!role) {
        await transaction.rollback();
        return res.error("NOT_FOUND", "Specified role key not found.");
      }
      req.body.role_id = role.id;
    }

    // Handle profile image upload
    if (req.files?.profile_image) {
      // Create a new request object with only the profile image
      const profileReq = {
        ...req,
        files: {
          profile_image: Array.isArray(req.files.profile_image)
            ? req.files.profile_image
            : [req.files.profile_image],
        },
      };
      const result = await uploadFile(
        profileReq,
        res,
        constants.USER_IMG_FOLDER,
        transaction
      );
      if (result.profile_image) {
        req.body.profile_image = result.profile_image;
      }
    }

    // Handle signature upload
    if (req.files?.authorized_signature) {
      // Create a new request object with only the signature
      const signatureReq = {
        ...req,
        files: {
          authorized_signature: Array.isArray(req.files.authorized_signature)
            ? req.files.authorized_signature
            : [req.files.authorized_signature],
        },
      };
      const result = await uploadFile(
        signatureReq,
        res,
        constants.USER_SIGN_IMG_FOLDER,
        transaction
      );
      if (result.authorized_signature) {
        req.body.authorized_signature = result.authorized_signature;
      }
    }
    const permission = await commonQuery.findOneRecord(
      RolePermission,
      req.body.role_id,
      {},
      transaction,
      false,
      { company_id: true }
    );
    req.body.permission = permission.permissions;

    // Hash password if provided (for login_type = 2)
    if (req.body.password) {
      const salt = await bcrypt.genSalt(10);
      req.body.password = await bcrypt.hash(req.body.password, salt);
    }

    // Generate Activation Code
    req.body.activation_code = crypto.randomBytes(20).toString("hex");
    req.body.is_activated = true;

    const newUser = await commonQuery.createRecord(User, req.body, transaction);

    // await commonQuery.createRecord(UserCompanyRoles, {
    //   user_id: newUser.id,
    //   role_id: req.body.role_id,
    //   branch_id: req.user.branch_id,
    //   company_id: req.user.company_id,
    //   permissions: req.body.permission,
    //   status: 0
    // }, transaction);

    await updateDocumentUsedLimit(req.user.company_id, 'users', 1, transaction);

    await transaction.commit();

    const activationLink = `${process.env.FRONTEND_URL || 'https://yourhrms.com/'}activate?code=${req.body.activation_code}`;

    return res.success(constants.CREATED, {
      user: {
        id: newUser.id,
        user_name: newUser.user_name,
        email: newUser.email,
        mobile_no: newUser.mobile_no,
        activation_code: req.body.activation_code,
        activation_link: activationLink
      }
    });
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

const { tokenHelper } = require("../../../helpers");

/**
 * Verify token (GET) - Updated to support Direct "Magic" Login
 */
exports.verifySetupToken = async (req, res) => {
  try {
    const { token } = req.params;

    // Hash the token from URL
    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    const user = await commonQuery.findOneRecord(User, {
      reset_password_token: hashedToken,
      reset_password_expires: { [Op.gt]: new Date() },
    }, {
      include: [
        {
          model: RolePermission,
          as: "RolePermission",
          attributes: ["role_name", "permissions"]
        }
      ]
    }, null, false, false);

    if (!user) {
      return res.status(400).json({
        code: 400,
        status: "INVALID_OR_EXPIRED",
        message: "Invitation link is invalid or has expired",
      });
    }

    return res.json({
      code: 200,
      status: "SUCCESS",
      message: "Token verified successfully",
      data: {
        user_name: user.user_name,
        email: user.email,
        mobile_no: user.mobile_no
      },
    });
  } catch (err) {
    return handleError(err, res, req);
  }
};


exports.assignRole = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { user_id, role_id, field_name } = req.body;

    const requiredFields = {};
    if (!req.body.role_id && !req.body.role_key) {
      requiredFields.role_id = "Role ID";
    }

    const errors = await validateRequest(req.body, requiredFields, {}, null);

    if (errors) {
      await transaction.rollback();
      return res.error("VALIDATION_ERROR", errors);
    }

    let permission;
    if (req.body.role_key) {
      permission = await commonQuery.findOneRecord(
        RolePermission,
        { role_key: req.body.role_key },
        {},
        transaction,
        false,
        { company_id: true }
      );
    } else {
      permission = await commonQuery.findOneRecord(
        RolePermission,
        { p_role_id: role_id },
        {},
        transaction,
        false,
        { company_id: true }
      );
    }

    const userData = await commonQuery.updateRecordById(User, user_id, {
      role_id: permission.id,
      permissions: permission.permissions,
      branch_access: req.body.branch_access,
      mobile_no: req.body.mobile_no,
      email: req.body.email
    }, transaction);

    if(userData.employee_id){
      await commonQuery.updateRecordById(
        Employee,
        userData.employee_id,
        { 
          ...(field_name === 'is_attendance_supervisor' && { is_attendance_supervisor: false }),
          ...(field_name === 'is_reporting_manager' && { is_reporting_manager: false }),  
        },
        transaction,
        true
      );
    }

    if (!userData) {
      await transaction.rollback();
      return res.error("USER_NOT_UPDATED");
    }

    await transaction.commit();
    return res.success(constants.UPDATED);

  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

/**
 * Verify PIN setup token (GET)
 * Checks if the token is valid and not expired.
 */
exports.verifyPinToken = async (req, res) => {
    try {
        const { token } = req.params;

        const user = await commonQuery.findOneRecord(User, {
            pin_setup_token: token,
            pin_setup_expires: { [Op.gt]: new Date() },
        }, {
            attributes: ["id", "user_name", "mobile_no", "email"]
        }, null, false, false);

        if (!user) {
            return res.status(400).json({
                code: 400,
                status: "INVALID_OR_EXPIRED",
                message: "PIN setup link is invalid or has expired",
            });
        }

        return res.json({
            code: 200,
            status: "SUCCESS",
            data: {
                user_name: user.user_name,
                mobile_no: user.mobile_no,
                email: user.email
            },
        });
    } catch (err) {
        return handleError(err, res, req);
    }
};

/**
 * Setup PIN (POST)
 * Finalizes the PIN setup using the token.
 */
exports.setupPin = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { token, pin } = req.body;

        if (!token || !pin) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, { message: "Token and PIN are required." });
        }

        if (!/^[0-9]{4}$/.test(pin)) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, { message: "PIN must be exactly 4 digits." });
        }

        const user = await commonQuery.findOneRecord(User, {
            pin_setup_token: token,
            pin_setup_expires: { [Op.gt]: new Date() },
        }, {}, transaction, false, false);

        if (!user) {
            await transaction.rollback();
            return res.status(400).json({
                code: 400,
                status: "INVALID_OR_EXPIRED",
                message: "Token is invalid or has expired",
            });
        }

        // Hash PIN
        const salt = await bcrypt.genSalt(10);
        const hashedPin = await bcrypt.hash(pin, salt);

        await commonQuery.updateRecordById(User, user.id, {
            password: hashedPin,
            pin_setup_token: null,
            pin_setup_expires: null,
            is_activated: true,
            status: 0
        }, transaction);

        await transaction.commit();

        return res.json({
            code: 200,
            status: "SUCCESS",
            message: "PIN has been set successfully. You can now login.",
        });
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

/**
 * Set password (POST)
 */
exports.setPassword = async (req, res) => {
    try {
        const { token, password } = req.body;
        const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

        const user = await commonQuery.findOneRecord(User, {
            reset_password_token: hashedToken,
            reset_password_expires: { [Op.gt]: new Date() },
        }, {}, null, false, false);

        if (!user) {
            return res.status(400).json({
                code: 400,
                status: "INVALID_OR_EXPIRED",
                message: "Token is invalid or has expired",
            });
        }

        // Hash password
        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(password, salt);
        user.reset_password_token = null;
        user.reset_password_expires = null;
        await user.save();

        return res.json({
            code: 200,
            status: "SUCCESS",
            message: "Password has been set successfully",
        });
    } catch (err) {
        return handleError(err, res, req);
    }
};

/**
 * Forgot Password Request (POST)
 */
exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    const user = await commonQuery.findOneRecord(User, { email }, {}, null, false, false);
    if (!user) {
      return res.status(404).json({
        code: 404,
        status: "NOT_FOUND",
        message: "Email not registered",
      });
    }

    await sendForgotPasswordEmail(user, req);

    return res.json({
      code: 200,
      status: "SUCCESS",
      message: "Password reset email sent",
    });
  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * Update User
 */
exports.update = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    // ✅ Decide validation fields
    let requiredFields;
    let validateOptions;

    // const isUserPermissionUpdate =
    //   req.body.user_permission !== undefined &&
    //   req.body.user_permission !== null;

    // if (isUserPermissionUpdate) {
    //   // Validate only permission-related fields
    //   requiredFields = {
    //     user_permission: "User Permission",
    //   };
    //   validateOptions = {};
    // } else {
    // Normal user update
    requiredFields = {
      user_name: "User Name",
      role_id: "Role",
    };

    // Conditionally add required fields based on login_type
    const loginType = parseInt(req.body.login_type) || 1;

    if (loginType === 1) {
      requiredFields.mobile_no = "Mobile No";
    } else if (loginType === 2) {
      requiredFields.email = "Email";
      // password optional in update
    }

    // Determine unique check fields based on what's being provided
    const uniqueCheckFields = [];
    if (req.body.email) uniqueCheckFields.push("email");
    if (req.body.mobile_no) uniqueCheckFields.push("mobile_no");

    validateOptions = {
      uniqueCheck: uniqueCheckFields.length > 0 ? {
        model: User,
        fields: uniqueCheckFields,
        excludeId: req.params.id,
      } : undefined,
    };
    // }

    // ✅ Validate request
    const errors = await validateRequest(
      req.body,
      requiredFields,
      validateOptions,
      transaction
    );
    if (errors) {
      await transaction.rollback();
      return res.error("VALIDATION_ERROR", { errors });
    }

    // ✅ Fetch existing user
    const existing = await commonQuery.findOneRecord(
      User,
      req.params.id,
      {},
      transaction
    );
    if (!existing || existing.status === 2) {
      await transaction.rollback();
      return res.error("NOT_FOUND");
    }

    // ✅ Profile image remove/update
    if (
      req.body.remove_profile_image === "true" ||
      req.body.profile_image === ""
    ) {
      if (existing.profile_image) {
        await deleteFile(req, res, constants.USER_IMG_FOLDER, existing.profile_image);
        req.body.profile_image = null;
      }
    } else if (req.files?.profile_image) {
      const profileReq = {
        ...req,
        files: {
          profile_image: Array.isArray(req.files.profile_image)
            ? req.files.profile_image
            : [req.files.profile_image],
        },
      };
      const result = await uploadFile(
        profileReq,
        res,
        constants.USER_IMG_FOLDER,
        transaction,
        existing.profile_image
      );
      if (result.profile_image) {
        req.body.profile_image = result.profile_image;
      }
    }

    // ✅ Signature remove/update
    if (
      req.body.remove_authorized_signature === "true" ||
      req.body.authorized_signature === ""
    ) {
      if (existing.authorized_signature) {
        await deleteFile(
          req,
          res,
          constants.USER_SIGN_IMG_FOLDER,
          existing.authorized_signature,
          transaction
        );
        req.body.authorized_signature = null;
      }
    } else if (req.files?.authorized_signature) {
      const signatureReq = {
        ...req,
        files: {
          authorized_signature: Array.isArray(req.files.authorized_signature)
            ? req.files.authorized_signature
            : [req.files.authorized_signature],
        },
      };
      const result = await uploadFile(
        signatureReq,
        res,
        constants.USER_SIGN_IMG_FOLDER,
        transaction,
        existing.authorized_signature
      );
      if (result.authorized_signature) {
        req.body.authorized_signature = result.authorized_signature;
      }
    }

    // ✅ Permission handling
    // if (isUserPermissionUpdate) {
    //   // Save user_permission exactly as it is
    //   req.body.permission = req.body.user_permission;
    // } else if (req.body.permission) {
    //   // Save permission directly if provided
    //   req.body.permission = req.body.permission;
    // } else if (req.body.role_id) {
    //   // If role_id given, load role permissions
    //   const permission = await commonQuery.findOneRecord(
    //     RolePermission,
    //     req.body.role_id,
    //     transaction
    //   );
    //   req.body.permission = permission?.permissions || [];
    // }

    // ✅ Hash password if updated
    if (req.body.password) {
      const salt = await bcrypt.genSalt(10);
      req.body.password = await bcrypt.hash(req.body.password, salt);
    }

    // ✅ Update user
    const updated = await commonQuery.updateRecordById(
      User,
      req.params.id,
      { 
        ...req.body, 
        employee_id: req.body.employee_id || existing.employee_id,
      },
      transaction,
      true
    );

    if(updated.employee_id && req.body.role_id){
      const selectedRole = await commonQuery.findOneRecord(RolePermission, req.body.role_id, {}, transaction, false, { company_id: true });
      if (selectedRole) {
        await commonQuery.updateRecordById(
          Employee,
          updated.employee_id,
          { 
            is_attendance_supervisor: selectedRole.role_key === constants.ROLE_KEYS.ATTENDANCE_SUPERVISOR,
            is_reporting_manager: selectedRole.role_key === constants.ROLE_KEYS.REPORTING_MANAGER,
          },
          transaction,
          true
        );
      }
    }

    // ✅ Sync UserCompanyRoles if permissions or role changed
    // if (req.body.permission) {
    //   const branchId = req.body.branch_id || existing.branch_id;
    //   const companyId = req.body.company_id || existing.company_id;
    //   const roleId = req.body.role_id || existing.role_id;

    //   const userCompanyRole = await commonQuery.findOneRecord(
    //     UserCompanyRoles,
    //     { user_id: req.params.id, branch_id: branchId, company_id: companyId },
    //     {},
    //     transaction
    //   );

    //   const permissions = req.body.permission.join(",");

    //   if (userCompanyRole) {
    //     await commonQuery.updateRecordById(
    //       UserCompanyRoles,
    //       userCompanyRole.id,
    //       {
    //         role_id: roleId,
    //         permissions: permissions,
    //       },
    //       transaction
    //     );
    //   } else {
    //     await commonQuery.createRecord(
    //       UserCompanyRoles,
    //       {
    //         user_id: req.params.id,
    //         role_id: roleId,
    //         branch_id: branchId,
    //         company_id: companyId,
    //         permissions: permissions,
    //         status: 0,
    //       },
    //       transaction
    //     );
    //   }
    // }

    clearUserCache(req.params.id);

    await transaction.commit();
    return res.success(constants.UPDATED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};


/**
 * Get All Users
 */
exports.getAll = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const organization_id = req.user.organization_id;
    console.log(req.user);
    let extraFilters = {
      [Op.and]: [
        {
          [Op.or]: [
            { company_id: company_id },
            sequelize.where(
              sequelize.literal(`'${company_id}' = ANY(string_to_array("company_access", ','))`),
              true
            )
          ]
        }
      ]
    };

    if (req.body.filter?.role === "business-admin") {
      if (organization_id) {
        const orgCompanies = await commonQuery.findAllRecords(
          CompanyMaster,
          { organization_id, status: 0 },
          { attributes: ["id"] },
          null,
          {}
        );

        const organizationCompanyIds = orgCompanies.map(c => c.id);

        extraFilters[Op.and].push({
          [Op.or]: [
            { is_super_admin: true, '$RolePermission.role_key$': constants.ROLE_KEYS.BUSINESS_ADMIN, company_id: { [Op.in]: organizationCompanyIds } },
            { '$RolePermission.role_key$': constants.ROLE_KEYS.ADMIN, company_id: company_id, branch_id: req.user.branch_id }
          ]
        });
      } else {
        extraFilters[Op.and].push({
          '$RolePermission.role_key$': { [Op.in]: [constants.ROLE_KEYS.BUSINESS_ADMIN, constants.ROLE_KEYS.ADMIN] },
          company_id: company_id,
          branch_id: req.user.branch_id
        });
      }
    } else if (req.body.filter?.role_key) {
      // Direct role_key filtering (used for Attendance Supervisor, Reporting Manager, etc.)
      extraFilters[Op.and].push({
        '$RolePermission.role_key$': req.body.filter.role_key,
        company_id: company_id,
        branch_id: req.user.branch_id
      });
    } else if (req.body.filter?.role === "employee" || !req.body.filter?.role_key) {
      // Show everyone EXCEPT Business Admin and Admin for the main tab
      extraFilters[Op.and].push({
        '$RolePermission.role_key$': { 
          [Op.notIn]: [constants.ROLE_KEYS.BUSINESS_ADMIN, constants.ROLE_KEYS.ADMIN] 
        },
        company_id: company_id,
        branch_id: req.user.branch_id
      });
    } else {
      extraFilters[Op.and].push({
        company_id: company_id,
        branch_id: req.user.branch_id
      });
    }
    // else if (!req.user.is_super_admin) {
    //   // Apply basic branch/company restriction for other views
    //   const security = { company_id: company_id };
    //   if (req.user.branch_id && req.user.branch_id !== 0 && req.user.branch_id !== "0") {
    //     security.branch_id = req.user.branch_id;
    //   } else if (req.user.branch_access) {
    //     const branches = req.user.branch_access.split(",").map(id => parseInt(id.trim())).filter(id => !isNaN(id));
    //     if (branches.length > 0) security.branch_id = { [Op.in]: branches };
    //   }
    //   extraFilters[Op.and].push(security);
    // }

    if (req.body.filter) {
      delete req.body.filter.role;
      delete req.body.filter.role_key;
    }
    const fieldConfig = [
      ["user_name", true, false],
      ["Employee.employee_code", true, false],
      ["User.email", true, false],
      ["User.mobile_no", true, false],
    ];
    const data = await commonQuery.fetchPaginatedData(
      User,
      req.body,
      fieldConfig,
      {
        include: [
          {
            model: RolePermission,
            as: "RolePermission",
            attributes: [],
            required: false,
          },
          {
            model: Employee,
            as: "Employee",
            attributes: [],
            required: false,
          },
          {
            model: BranchMaster,
            as: "Branch",
            attributes: [],
            required: false,
          },
        ],
        attributes: [
          "id",
          "role_id",
          "user_name",
          "email",
          "mobile_no",
          "status",
          "profile_image",
          "is_super_admin",
          "authorized_signature",
          "branch_id",
          "createdAt",
          [sequelize.col("RolePermission.role_name"), "role_name"],
          [sequelize.col("Branch.branch_name"), "branch_name"],
          [sequelize.col("Employee.first_name"), "first_name"],
          [sequelize.col("Employee.employee_code"), "employee_code"],
        ],
      },
      {},
      "createdAt",
      extraFilters
    );

    return res.ok(data);
  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * Get Users
 */
exports.dropdownList = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const extraFilters = {
      [Op.or]: [
        { company_id: company_id },
        sequelize.where(
          sequelize.literal(`'${company_id}' = ANY(string_to_array("company_access", ','))`),
          true
        )
      ],
      [Op.and]: [
        { '$RolePermission.role_key$': { [Op.notIn]: [constants.ROLE_KEYS.BUSINESS_ADMIN, constants.ROLE_KEYS.ADMIN, constants.ROLE_KEYS.ATTENDANCE_SUPERVISOR, constants.ROLE_KEYS.REPORTING_MANAGER] } },
        { company_id: company_id },
        { branch_id: req.user.branch_id }
      ]
    };
    const record = await commonQuery.findAllRecords(
      User,
      extraFilters,
      {
        include: [{ model: RolePermission, as: 'RolePermission', attributes: [] }],
        attributes: ["id", "user_name", "email", "mobile_no", "role_id"],
        order: [["user_name", "ASC"]],
      }
    );
    return res.ok(record);
  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * Get User by ID
 */
exports.getById = async (req, res) => {
  try {
    const record = await commonQuery.findOneRecord(User, req.params.id, {
      include: [
        {
          model: Employee,
          as: "Employee",
          required: false
        }
      ]
    });

    if (!record || record.status === 2) return res.error("NOT_FOUND");

    const userData = record.toJSON(); // convert to plain object
    const baseUrl = process.env.FILE_SERVER_URL || "";

    userData.profile_image_url = userData.profile_image ? `${process.env.FILE_SERVER_URL}${constants.USER_IMG_FOLDER}${userData.profile_image}` : null;

    // Construct authorized signature URL with proper path joining
    if (userData.authorized_signature) {
      // Extract just the filename from the stored path
      let filename = path.basename(userData.authorized_signature);

      // If the filename already contains a path, extract just the filename
      if (filename.includes("\\") || filename.includes("/")) {
        filename = path.basename(filename);
      }

      // Construct the URL
      userData.authorized_signature_url = `${baseUrl}/uploads/signatures/users/${filename}`;
    } else {
      userData.authorized_signature_url = null;
    }

    return res.ok(userData);
  } catch (err) {
    console.error("Error in getById:", err);
    return handleError(err, res, req);
  }
};

/**
 * Delete User (Hard Delete)
 */
exports.delete = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const requiredFields = {
      ids: "Select Data",
    };

    const errors = await validateRequest(req.body, requiredFields, {}, transaction);
    if (errors) {
      await transaction.rollback();
      return res.error("VALIDATION_ERROR", { errors });
    }
    const { ids } = req.body; // Accept array of ids

    // Validate that ids is an array and not empty
    if (!Array.isArray(ids) || ids.length === 0) {
      await transaction.rollback();
      return res.error("INVALID_idS_ARRAY");
    }

    // Find all user records corresponding to the provided ids
    const recordsToDelete = await commonQuery.findAllRecords(
      User,
      { id: { [Op.in]: ids } },
      {},
      transaction,
      false
    );

    if (!recordsToDelete || recordsToDelete.length === 0) {
      await transaction.rollback();
      return res.error("NOT_FOUND");
    }

    // Loop through each record and delete its associated files
    for (const record of recordsToDelete) {
      clearUserCache(record.id);
      if (record.profile_image) {
        await deleteFile(req, res, constants.USER_IMG_FOLDER, record.profile_image);
      }
      if (record.authorized_signature) {
        await deleteFile(req, res, constants.USER_SIGN_IMG_FOLDER, record.authorized_signature);
      }
    }

    const deletedCount = await commonQuery.softDeleteById(
      User,
      ids,
      transaction
    );

    if (deletedCount === 0) {
      await transaction.rollback();
      return res.error("ALREADY_DELETED");
    }

    await transaction.commit();
    return res.success(constants.DELETED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Update Status of Module Master
exports.updateStatus = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { status, ids } = req.body; // expecting status in request body

    const requiredFields = {
      ids: "Select Any One Data",
      status: "Select Status",
    };

    const errors = await validateRequest(req.body, requiredFields, {}, transaction);
    if (errors) {
      await transaction.rollback();
      return res.error("VALIDATION_ERROR", { errors });
    }

    // Validate that ids is an array and not empty
    if (!Array.isArray(ids) || ids.length === 0) {
      await transaction.rollback();
      return res.error("INVALID_idS_ARRAY");
    }

    // Update only the status field by id
    const updated = await commonQuery.updateRecordById(
      User,
      ids,
      { status },
      transaction
    );

    if (!updated || updated.status === 2) {
      if (!transaction.finished) await transaction.rollback();
      return res.error("NOT_FOUND");
    }

    await transaction.commit();
    return res.success(constants.UPDATED);
  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};