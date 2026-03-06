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
    const url = `${process.env.FRONTEND_URL}settings/user/verify-token/${rawToken}`;

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
    const companyPlan = await getCompanySubscription(company_id);
    if (companyPlan.users_limit <= companyPlan.used_users) {
      await transaction.rollback();
      return res.error(constants.LIMIT_EXCEEDED, constants.USER_LIMIT_REACHED);
    }

    // Base required fields
    const requiredFields = {
      user_name: "User Name",
      role_id: "Role",
      login_type: "Login Type",
    };

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
      false
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

    const newUser = await commonQuery.createRecord(User, req.body, transaction, { company_id: true });

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
          as: "role", 
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

    // --- Generate Login Session (Magic Login) ---
    const companyId = user.company_id;
    const loginToken = tokenHelper.generateToken(user, companyId, "magic link");

    // Prepare User Data (Matching standard login response)
    const activeRole = user.role;
    const userData = {
      id: user.id,
      role_id: user.role_id,
      user_name: user.user_name,
      email: user.email,
      mobile_no: user.mobile_no,
      profile_image: user.profile_image ? `${process.env.FILE_SERVER_URL}${constants.USER_IMG_FOLDER}${user.profile_image}` : null,
      role_name: activeRole?.role_name,
      permission: activeRole?.permissions,
      company_id: companyId,
      branch_id: user.branch_id,
    };

    // Note: We don't clear the reset_password_token yet so they can still SET a password if the UI requires it,
    // but the user is effectively "Logged In" now.

    return res.json({
      code: 200,
      status: "SUCCESS",
      message: "Magic login successful",
      token: loginToken,
      user: userData,
      data: { email: user.email },
    });
  } catch (err) {
    return handleError(err, res, req);
  }
};


exports.assignRole = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { id, field_name, branch_access } = req.body;

    const requiredFields = {
      id: "User ID",
      field_name: "Field Name",
      branch_access: "Branch Access",
    };

    const errors = await validateRequest(req.body, requiredFields, {}, null);

    if (errors) {
      await transaction.rollback();
      return res.error("VALIDATION_ERROR", errors);
    }

    let newRoleId;
    if (field_name === 'is_reporting_manager') {
      newRoleId = 4;
    } else if (field_name === 'is_attendance_supervisor') {
      newRoleId = 3;
    }

    const userData = await commonQuery.updateRecordById(User, id, { 
      role_id: newRoleId,
      branch_access: branch_access
    }, transaction);
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
        message: "User not found",
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
        // role_id: "Role",
      };

      // Conditionally add required fields based on login_type
      const loginType = parseInt(req.body.login_type) || 1;

      if (loginType === 1) {
        requiredFields.mobile_no = "Mobile No";
      } else if (loginType === 2) {
        requiredFields.email = "Email";
        requiredFields.password = "Password";
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
      { ...req.body, employee_id: req.body.employee_id || existing.employee_id },
      transaction,
      true,
      { company_id: true }
    );

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

    let extraFilters = {
      [Op.or]: [
        { company_id: company_id },
        sequelize.where(
          sequelize.literal(`'${company_id}' = ANY(string_to_array("company_access", ','))`),
          true
        )
      ]
    };

    if (req.body.filter?.role === "business-admin") {
      if (organization_id) {
        const orgCompanies = await CompanyMaster.findAll({
          where: { organization_id, status: 0 },
          attributes: ["id"]
        });
        const organizationCompanyIds = orgCompanies.map(c => c.id);

        extraFilters = {
          [Op.or]: [
            { is_super_admin: true, company_id: { [Op.in]: organizationCompanyIds } },
            { role_id: 2, company_id: company_id }
          ]
        };
      }
    }

    if (req.body.filter) delete req.body.filter.role;

    const { page = 1, pageSize = 10, search, filter, orderBy = 'createdAt', orderDir = "DESC" } = req.body;
    const limit = parseInt(pageSize, 10);
    const offset = (parseInt(page, 10) - 1) * limit;

    const where = { ...extraFilters };

    // --- Branch Access Logic ---
    if (!req.user.is_super_admin) {
      if (req.user.branch_id && req.user.branch_id !== 0 && req.user.branch_id !== "0") {
        if (where.branch_id === undefined) where.branch_id = req.user.branch_id;
      } else if (req.user.branch_access) {
        const branches = req.user.branch_access.split(",").map(id => parseInt(id.trim())).filter(id => !isNaN(id));
        if (branches.length > 0) {
          where.branch_id = { [Op.in]: branches };
        }
      }
    }

    // --- Search Logic ---
    if (search) {
      const searchCondition = { [Op.iLike]: `%${search}%` };
      where[Op.and] = where[Op.and] || [];
      where[Op.and].push({
        [Op.or]: [
          { user_name: searchCondition },
          { email: searchCondition },
          { mobile_no: searchCondition },
          sequelize.where(sequelize.col("RolePermission.role_name"), searchCondition)
        ]
      });
    }

    // --- Filter Logic ---
    if (filter) {
      Object.keys(filter).forEach((key) => {
        if (filter[key] !== undefined && filter[key] !== null && filter[key] !== "") {
          where[key] = filter[key];
        }
      });
    }

    const { count, rows } = await User.findAndCountAll({
      where,
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
        "authorized_signature",
        "branch_id",
        "createdAt",
        [sequelize.col("RolePermission.role_name"), "role_name"],
        [sequelize.col("Branch.branch_name"), "branch_name"],
        [sequelize.col("Employee.first_name"), "first_name"],
        [sequelize.col("Employee.employee_code"), "employee_code"],
      ],
      order: [[orderBy, orderDir]],
      limit,
      offset,
      distinct: true,
      subQuery: false,
    });

    return res.ok({
      items: rows,
      count,
      totalPages: Math.ceil(count / limit),
      currentPage: parseInt(page, 10),
    });
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
      ]
    };
    const record = await commonQuery.findAllRecords(
      User,
      extraFilters,
      {
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