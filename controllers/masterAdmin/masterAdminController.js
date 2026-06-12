const { Op } = require("sequelize");
const { CompanyMaster, CompanySubscription, SubscriptionPlan, User, Organization } = require("../../models");
const { createConnectionByPrefix } = require("../../config/database");
const { handleError } = require("../../helpers");
const subscriptionController = require("../subscription/subscriptionController");

/**
 * Helper: get the root (non-tenant) sequelize instance
 */
function getRootSequelize() {
  return createConnectionByPrefix("");
}

// -----------------------------------------------------------
// 1. DASHBOARD STATS
// -----------------------------------------------------------
exports.getDashboardStats = async (req, res) => {
  try {
    const rootSeq = getRootSequelize();

    // Total companies
    const totalOrganizations = await Organization.count();
    const totalCompanies = await CompanyMaster.count();

    // Active subscriptions
    const activeSubs = await CompanySubscription.count({
      where: {
        status: 0,
        end_date: { [Op.gte]: new Date() },
      },
    });

    // Expired subscriptions
    const expiredSubs = await CompanySubscription.count({
      where: {
        [Op.or]: [
          { status: 1 },
          { end_date: { [Op.lt]: new Date() } },
        ],
      },
    });

    // Total revenue (sum of amount_paid on all subscriptions)
    const revenueResult = await CompanySubscription.findOne({
      attributes: [
        [rootSeq.fn("SUM", rootSeq.col("amount_paid")), "total_revenue"],
      ],
      raw: true,
    });
    const totalRevenue = parseFloat(revenueResult?.total_revenue || 0);

    // Total users
    const totalUsers = await User.count();

    // Companies registered in the last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const newCompanies = await CompanyMaster.count({
      where: { created_at: { [Op.gte]: thirtyDaysAgo } },
    });

    // Companies by status
    const activeCompanies = await CompanyMaster.count({
      where: { status: 0 },
    });
    const inactiveCompanies = await CompanyMaster.count({
      where: { status: 1 },
    });
    const suspendedCompanies = await CompanyMaster.count({
      where: { status: 2 },
    });

    // Recent 5 companies
    const recentCompanies = await CompanyMaster.findAll({
      attributes: ["id", "company_name", "email", "mobile_no", "status", "created_at"],
      order: [["created_at", "DESC"]],
      limit: 5,
      raw: true,
    });

    // Monthly revenue for the last 6 months
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const isPostgres = rootSeq.getDialect() === 'postgres';
    const dateFormatFn = isPostgres
      ? rootSeq.fn("TO_CHAR", rootSeq.col("created_at"), "YYYY-MM")
      : rootSeq.fn("DATE_FORMAT", rootSeq.col("created_at"), "%Y-%m");

    const monthlyRevenue = await CompanySubscription.findAll({
      attributes: [
        [dateFormatFn, "month"],
        [rootSeq.fn("SUM", rootSeq.col("amount_paid")), "revenue"],
        [rootSeq.fn("COUNT", rootSeq.col("id")), "count"],
      ],
      where: { created_at: { [Op.gte]: sixMonthsAgo } },
      group: [dateFormatFn],
      order: [[dateFormatFn, "ASC"]],
      raw: true,
    });

    return res.ok({
      totalOrganizations,
      totalCompanies,
      activeCompanies,
      inactiveCompanies,
      suspendedCompanies,
      newCompanies,
      activeSubs,
      expiredSubs,
      totalRevenue,
      totalUsers,
      recentCompanies,
      monthlyRevenue,
    });
  } catch (err) {
    return handleError(err, res, req);
  }
};

// -----------------------------------------------------------
// 2. COMPANY LIST (paginated, filterable)
// -----------------------------------------------------------
exports.getCompanies = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search = "",
      status,
    } = req.body;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const where = {};

    if (search) {
      where[Op.or] = [
        { company_name: { [Op.like]: `%${search}%` } },
        { email: { [Op.like]: `%${search}%` } },
        { mobile_no: { [Op.like]: `%${search}%` } },
      ];
    }

    if (status !== undefined && status !== null && status !== "") {
      where.status = parseInt(status);
    }

    const { count, rows } = await CompanyMaster.findAndCountAll({
      where,
      include: [
        { model: Organization, as: "organization", attributes: ["name", "code"] }
      ],
      attributes: [
        "id", "company_name", "email", "mobile_no",
        "status", "created_at", "organization_id", "company_id",
        "address", "city"
      ],
      order: [["created_at", "DESC"]],
      limit: parseInt(limit),
      offset,
    });

    const orgIds = rows.map(r => r.organization_id).filter(Boolean);
    const compIds = rows.map(r => r.id);

    const activeSubscriptions = await CompanySubscription.findAll({
      where: {
        status: 0,
        [Op.or]: [
          { organization_id: { [Op.in]: orgIds } },
          { company_id: { [Op.in]: compIds } }
        ]
      },
      include: [{ model: SubscriptionPlan, as: "subscriptionPlan", attributes: ["name", "subscription_type", "price"] }]
    });

    const companies = rows.map((c) => {
      const data = c.toJSON ? c.toJSON() : c;
      const sub = activeSubscriptions.find(s => 
        (data.organization_id && s.organization_id === data.organization_id) || 
        (s.company_id === data.id)
      ) || null;

      return {
        ...data,
        organization_name: data.organization?.name || "",
        subscription: sub,
      };
    });

    return res.ok({
      companies,
      total: count,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(count / parseInt(limit)),
    });
  } catch (err) {
    return handleError(err, res, req);
  }
};

// -----------------------------------------------------------
// 3. GET SINGLE COMPANY DETAIL
// -----------------------------------------------------------
exports.getCompanyDetail = async (req, res) => {
  try {
    const { id } = req.params;

    const company = await CompanyMaster.findOne({
      where: { id },
      include: [
        { model: Organization, as: "organization", attributes: ["name", "code"] }
      ],
    });

    if (!company) {
      return res.error("NOT_FOUND", "Company not found");
    }

    const companyData = company.get({ plain: true });

    // All subscriptions for this company / organization
    let subWhere = { company_id: id };
    if (company.organization_id) {
      subWhere = {
        [Op.or]: [
          { organization_id: company.organization_id },
          { company_id: id }
        ]
      };
    }
    const subscriptions = await CompanySubscription.findAll({
      where: subWhere,
      include: [{ model: SubscriptionPlan, as: "subscriptionPlan", attributes: ["name", "subscription_type", "price", "duration_days"] }],
      order: [["created_at", "DESC"]],
      raw: true,
      nest: true,
    });

    // User count
    const userCount = await User.count({ where: { company_id: id } });

    // Company Settings
    const { CompanySettings } = require("../../models");
    const settings = await CompanySettings.findAll({
      where: { company_id: id, status: 0 },
      attributes: ["settings_name", "settings_value"],
      raw: true,
    });

    return res.ok({ company: companyData, subscriptions, userCount, settings });
  } catch (err) {
    return handleError(err, res, req);
  }
};

// -----------------------------------------------------------
// 3.1 UPDATE COMPANY SETTINGS
// -----------------------------------------------------------
exports.updateCompanySettings = async (req, res) => {
  const { sequelize, CompanySettings } = require("../../models");
  const { reloadCompanySettingsCache } = require("../../helpers");
  const transaction = await sequelize.transaction();
  try {
    const { company_id, company_settings } = req.body;

    if (!company_id) {
      await transaction.rollback();
      return res.error("VALIDATION_ERROR", "company_id is required");
    }

    if (!company_settings || !Array.isArray(company_settings)) {
      await transaction.rollback();
      return res.error("VALIDATION_ERROR", "company_settings must be an array");
    }

    for (const setting of company_settings) {
      const [record, created] = await CompanySettings.findOrCreate({
        where: { company_id, settings_name: setting.settings_name },
        defaults: {
          company_id,
          settings_name: setting.settings_name,
          settings_value: setting.settings_value,
          status: 0,
        },
        transaction,
      });

      if (!created) {
        await record.update(
          { settings_value: setting.settings_value },
          { transaction }
        );
      }
    }

    await transaction.commit();
    try {
      await reloadCompanySettingsCache(company_id);
    } catch (cacheErr) {
      console.error("[Cache] Settings reload failed inside updateCompanySettings:", cacheErr);
    }

    return res.success("UPDATE_SUCCESS");
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// -----------------------------------------------------------
// 4. UPDATE COMPANY STATUS
// -----------------------------------------------------------
exports.updateCompanyStatus = async (req, res) => {
  try {
    const { company_id, status, reason } = req.body;

    if (status === undefined || status === null) {
      return res.error("VALIDATION_ERROR", "Status is required.");
    }

    const company = await CompanyMaster.findOne({ where: { id: company_id } });
    if (!company) {
      return res.error("NOT_FOUND", "Company not found.");
    }

    await CompanyMaster.update(
      { status: parseInt(status) },
      { where: { id: company_id } }
    );

    return res.success("UPDATE_SUCCESS", { company_id, status, reason });
  } catch (err) {
    return handleError(err, res, req);
  }
};

// -----------------------------------------------------------
// 5. ALL SUBSCRIPTIONS LIST
// -----------------------------------------------------------
exports.getAllSubscriptions = async (req, res) => {
  try {
    const { page = 1, limit = 20, search = "", status } = req.body;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const where = {};
    if (status !== undefined && status !== null && status !== "") {
      where.status = parseInt(status);
    }

    const { count, rows } = await CompanySubscription.findAndCountAll({
      where,
      include: [
        { model: SubscriptionPlan, as: "subscriptionPlan", attributes: ["name", "subscription_type", "price"] },
        {
          model: CompanyMaster,
          as: "company",
          attributes: ["company_name", "email"],
          ...(search ? { where: { company_name: { [Op.like]: `%${search}%` } } } : {}),
        },
        {
          model: Organization,
          as: "organization",
          attributes: ["name"],
        },
      ],
      order: [["created_at", "DESC"]],
      limit: parseInt(limit),
      offset,
      nest: true,
    });

    return res.ok({
      subscriptions: rows,
      total: count,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(count / parseInt(limit)),
    });
  } catch (err) {
    return handleError(err, res, req);
  }
};

// -----------------------------------------------------------
// 6. ALL SUBSCRIPTION PLANS
// -----------------------------------------------------------
exports.getPlans = async (req, res) => {
  try {
    const plans = await SubscriptionPlan.findAll({
      order: [["created_at", "DESC"]],
    });
    return res.ok(plans);
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.createPlan = async (req, res) => {
  try {
    const plan = await SubscriptionPlan.create(req.body);
    return res.success("PLAN_CREATED", plan);
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.updatePlan = async (req, res) => {
  try {
    const { id, ...rest } = req.body;
    await SubscriptionPlan.update(rest, { where: { id } });
    return res.success("PLAN_UPDATED");
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.deletePlan = async (req, res) => {
  try {
    const { id } = req.body;
    await SubscriptionPlan.update({ status: 2 }, { where: { id } });
    return res.success("PLAN_DELETED");
  } catch (err) {
    return handleError(err, res, req);
  }
};

// -----------------------------------------------------------
// 7. ACTIVATION REQUESTS (companies with activation_pending status)
// -----------------------------------------------------------
exports.getActivationRequests = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.body;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    // status = 3 means activation_pending
    const { count, rows } = await CompanyMaster.findAndCountAll({
      where: { status: 3 },
      order: [["created_at", "DESC"]],
      limit: parseInt(limit),
      offset,
      raw: true,
    });

    return res.ok({
      requests: rows,
      total: count,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(count / parseInt(limit)),
    });
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.processActivationRequest = async (req, res) => {
  try {
    const { company_id, action, reason } = req.body; // action: 'approve' | 'reject'

    const company = await CompanyMaster.findOne({ where: { id: company_id } });
    if (!company) {
      return res.error("NOT_FOUND", "Company not found.");
    }

    // 0 = active, 1 = inactive, 2 = suspended, 3 = pending
    const newStatus = action === "approve" ? 0 : 1;
    await CompanyMaster.update({ status: newStatus }, { where: { id: company_id } });

    return res.success("UPDATE_SUCCESS", { company_id, action, reason });
  } catch (err) {
    return handleError(err, res, req);
  }
};

// -----------------------------------------------------------
// 8. IMPERSONATION (AUTO LOGIN)
// -----------------------------------------------------------
exports.impersonateCompany = async (req, res) => {
  try {
    const { company_id } = req.body;

    if (!company_id) {
      return res.error("VALIDATION_ERROR", "company_id is required");
    }

    const { User, RolePermission } = require("../../models");
    const { generateToken } = require("../../helpers/tokenHelper");

    // Find the first active super admin / business admin / admin, or any active user
    const user = await User.findOne({
      where: { company_id, status: 0 },
      include: [{
        model: RolePermission,
        as: "RolePermission",
        attributes: ["role_key", "role_name"],
        required: false
      }],
      order: [
        ["is_super_admin", "DESC"],
        ["role_id", "ASC"]
      ]
    });

    if (!user) {
      return res.error("NOT_FOUND", "No active users found for this company to impersonate.");
    }

    const token = generateToken(user, company_id, "impersonation");

    return res.ok({ token });
  } catch (err) {
    return handleError(err, res, req);
  }
};

// -----------------------------------------------------------
// 9. ORGANIZATIONS LIST
// -----------------------------------------------------------
exports.getOrganizations = async (req, res) => {
  try {
    const { count, rows } = await Organization.findAndCountAll({
      where: { status: { [Op.ne]: 2 } },
      order: [["name", "ASC"]],
      raw: true,
    });

    const orgIds = rows.map(r => r.id);
    const activeSubscriptions = await CompanySubscription.findAll({
      where: {
        status: 0,
        organization_id: { [Op.in]: orgIds },
        subscription_type: 'plan'
      },
      include: [{ model: SubscriptionPlan, as: "subscriptionPlan", attributes: ["id", "name", "price"] }]
    });

    const organizations = rows.map(org => {
      const sub = activeSubscriptions.find(s => s.organization_id === org.id) || null;
      return {
        ...org,
        subscription: sub
      };
    });

    return res.ok({ organizations, total: count });
  } catch (err) {
    return handleError(err, res, req);
  }
};

// -----------------------------------------------------------
// 10. CREATE COMPANY (WITH NEW OR EXISTING ORGANIZATION)
// -----------------------------------------------------------
exports.createCompany = async (req, res) => {
  const rootSeq = getRootSequelize();
  const transaction = await rootSeq.transaction();
  try {
    const {
      create_new_org,
      organization_name,
      organization_id,
      company_name,
      legal_name,
      email,
      mobile_no,
      address,
      city,
      state_id,
      country_id,
      pincode,
      business_type_id,
      tax_no,
      pan_no,
      admin_user_name,
      admin_email,
      admin_password,
    } = req.body;

    const bcrypt = require("bcrypt");
    const { RolePermission, User } = require("../../models");
    const { initializeCompanySettings, initializeCompanyRoles, constants } = require("../../helpers");

    // 1. Resolve Organization
    let finalOrgId = organization_id;

    if (create_new_org === true || create_new_org === 'true') {
      if (!organization_name || organization_name.trim() === "") {
        await transaction.rollback();
        return res.error("VALIDATION_ERROR", { organization_name: "Organization Name is required when creating a new organization." });
      }

      // Check uniqueness of Organization Name
      const orgExists = await Organization.findOne({
        where: { name: organization_name, status: { [Op.ne]: 2 } },
        transaction,
      });
      if (orgExists) {
        await transaction.rollback();
        return res.error("VALIDATION_ERROR", { organization_name: "Organization Name already exists." });
      }

      // Generate Unique Organization Code
      const lastOrg = await Organization.findOne({
        order: [["code", "DESC"]],
        transaction,
      });

      let nextOrgNumber = 1;
      if (lastOrg?.code?.match(/\d+$/)) {
        nextOrgNumber = parseInt(lastOrg.code.match(/\d+$/)[0], 10) + 1;
      }
      const organization_code = `ORG-${String(nextOrgNumber).padStart(3, "0")}`;

      const newOrg = await Organization.create(
        {
          name: organization_name,
          code: organization_code,
        },
        { transaction }
      );
      finalOrgId = newOrg.id;
    } else {
      if (!finalOrgId) {
        await transaction.rollback();
        return res.error("VALIDATION_ERROR", { organization_id: "Organization is required." });
      }
      const org = await Organization.findByPk(finalOrgId, { transaction });
      if (!org) {
        await transaction.rollback();
        return res.error("NOT_FOUND", { organization_id: "Selected Organization not found." });
      }
    }

    // 2. Create Company
    if (!company_name || company_name.trim() === "") {
      await transaction.rollback();
      return res.error("VALIDATION_ERROR", { company_name: "Company Name is required." });
    }

    // Determine the next sequential company code
    const lastCompany = await CompanyMaster.findOne({
      order: [["company_code", "DESC"]],
      transaction,
    });

    let nextNumber = 1;
    if (lastCompany?.company_code?.match(/\d+$/)) {
      nextNumber = parseInt(lastCompany.company_code.match(/\d+$/)[0], 10) + 1;
    }
    const company_code = `CM${String(nextNumber).padStart(3, "0")}`;

    const newCompany = await CompanyMaster.create(
      {
        company_name,
        company_code,
        organization_id: finalOrgId,
        legal_name: legal_name || company_name,
        address: address || null,
        mobile_no: mobile_no || null,
        email: email || null,
        tax_no: tax_no || null,
        pan_no: pan_no || null,
        business_type_id: business_type_id || null,
        country_id: country_id ? parseInt(country_id) : null,
        state_id: state_id ? parseInt(state_id) : null,
        city: city || null,
        pincode: pincode || null,
        currency_id: 67, // Default India INR
        company_id: 0,
        status: 0,
        is_default: 2,
      },
      { transaction }
    );

    // 3. Initialize Roles
    await initializeCompanyRoles(newCompany.id, 0, 0, transaction);

    // Find the business admin role just created
    const adminRole = await RolePermission.findOne({
      where: {
        company_id: newCompany.id,
        role_key: constants.ROLE_KEYS.BUSINESS_ADMIN,
        status: 0,
      },
      transaction,
    });

    // 4. Create default super admin User
    if (!admin_email || admin_email.trim() === "") {
      await transaction.rollback();
      return res.error("VALIDATION_ERROR", { admin_email: "Admin Email is required." });
    }
    let finalPassword = admin_password;
    if (!finalPassword || finalPassword.trim() === "") {
      const crypto = require("crypto");
      finalPassword = crypto.randomBytes(16).toString("hex");
    }

    // Check uniqueness of Admin User email/username in DB
    const userExists = await User.findOne({
      where: {
        [Op.or]: [
          { email: admin_email },
          { user_name: admin_user_name || admin_email },
        ],
        status: { [Op.ne]: 2 },
      },
      transaction,
    });
    if (userExists) {
      await transaction.rollback();
      return res.error("VALIDATION_ERROR", { admin_email: "Admin Email or Username is already registered." });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(finalPassword, salt);

    const newUser = await User.create(
      {
        user_name: admin_user_name || admin_email.split("@")[0],
        email: admin_email,
        mobile_no: mobile_no || null,
        password: hashedPassword,
        address: address || null,
        city: city || null,
        state_id: state_id ? parseInt(state_id) : null,
        country_id: country_id ? parseInt(country_id) : null,
        pincode: pincode || null,
        role_id: adminRole ? adminRole.id : constants.BUSINESS_ADMIN_ROLE_ID,
        is_super_admin: true,
        permission: adminRole ? adminRole.permissions : null,
        company_id: newCompany.id,
        company_access: JSON.stringify([newCompany.id]),
        status: 0,
      },
      { transaction }
    );

    await initializeCompanySettings(newCompany.id, newUser.id, transaction);

    await transaction.commit();
    return res.success("COMPANY_CREATED", newCompany);
  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};

// -----------------------------------------------------------
// 11. SYSTEM LOGS
// -----------------------------------------------------------

exports.getDatabaseLogs = async (req, res) => {
  try {
    const { Logs, DeviceMaster } = require("../../models");
    const commonQuery = require("../../helpers/commonQuery");

    const fieldConfig = [
      ["entity_name", true, true],
      ["action_type", true, true],
      ["company_id", true, true],
      ["record_id", true, true],
      ["log_message", true, false],
      ["ip_address", true, true],
      ["access_type", true, true],
      ["status", true, true],
      ["created_at", true, true],
    ];

    const result = await commonQuery.fetchPaginatedData(
      Logs,
      req.body,
      fieldConfig,
      {
        attributes: ["id", "entity_name", "action_type", "record_id", "log_message", "old_data", "new_data", "stack_trace", "endpoint", "ip_address", "status", "access_type", "caller", "created_at", "company_id"],
        include: [
          { model: User, as: "user", attributes: ["id", "user_name", "email"] },
          { model: DeviceMaster, as: "device", attributes: ["id", "device_name"] },
          { model: CompanyMaster, as: "company", attributes: ["id", "company_name"] },
        ],
      },
      {} // Bypass company restrictions
    );

    return res.ok(result);
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.getApiLogs = async (req, res) => {
  try {
    const { ApiLog, DeviceMaster } = require("../../models");
    const commonQuery = require("../../helpers/commonQuery");

    const fieldConfig = [
      ["method", true, true],
      ["url", true, true],
      ["company_id", true, true],
      ["status_code", true, true],
      ["ip_address", true, true],
      ["access_type", true, true],
      ["caller", true, true],
      ["created_at", true, true],
    ];

    const result = await commonQuery.fetchPaginatedData(
      ApiLog,
      req.body,
      fieldConfig,
      {
        attributes: ["id", "method", "url", "status_code", "ip_address", "request_body", "response_body", "duration", "user_agent", "access_type", "caller", "created_at", "company_id"],
        include: [
          { model: User, as: "user", attributes: ["id", "user_name", "email"] },
          { model: DeviceMaster, as: "device", attributes: ["id", "device_name"] },
          { model: CompanyMaster, as: "company", attributes: ["id", "company_name"] },
        ],
      },
      {} // Bypass company restrictions
    );

    return res.ok(result);
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.getLogFiles = async (req, res) => {
  try {
    const fs = require("fs");
    const path = require("path");
    const logDir = path.join(process.cwd(), "uploads", "logs");

    if (!fs.existsSync(logDir)) {
      return res.ok({ files: [] });
    }

    const files = fs.readdirSync(logDir)
      .filter(file => file.endsWith(".log"))
      .map(file => {
        const filePath = path.join(logDir, file);
        const stats = fs.statSync(filePath);
        return {
          name: file,
          size: stats.size, // in bytes
          modifiedAt: stats.mtime
        };
      })
      .sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());

    return res.ok({ files });
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.getLogFileContent = async (req, res) => {
  try {
    const fs = require("fs");
    const path = require("path");
    const { filename, lines } = req.query;

    if (!filename || !/^[a-zA-Z0-9_\-\.]+\.log$/.test(filename)) {
      return res.status(400).json({ success: false, message: "Invalid filename" });
    }

    const logDir = path.join(process.cwd(), "uploads", "logs");
    const filePath = path.join(logDir, filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, message: "Log file not found" });
    }

    const maxLines = parseInt(lines, 10) || 500;
    const buffer = fs.readFileSync(filePath);
    
    let linesCount = 0;
    let index = buffer.length - 1;

    while (index >= 0 && linesCount < maxLines) {
      if (buffer[index] === 10) { // '\n'
        linesCount++;
      }
      index--;
    }

    const content = buffer.slice(index + 1).toString("utf8");
    return res.ok({ content });
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.clearCache = async (req, res) => {
  try {
    const cache = require("../../helpers/cache");
    const permissionCache = require("../../helpers/permissionCache");

    if (cache.clearAllCaches) {
      cache.clearAllCaches();
    }
    if (permissionCache.clearAllPermissionsCache) {
      permissionCache.clearAllPermissionsCache();
    }

    return res.success("CACHE_CLEARED", { message: "System-wide cache successfully flushed." });
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.assignCompanyPlan = subscriptionController.assignSubscription;

exports.updateCompanySubscription = async (req, res) => {
  try {
    const { id, ...updateData } = req.body;
    if (!id) {
      return res.error("BAD_REQUEST", "Subscription ID is required");
    }

    const sub = await CompanySubscription.findOne({ where: { id } });
    if (!sub) {
      return res.error("NOT_FOUND", "Company subscription record not found");
    }

    // Update the record with matching fields from body
    await sub.update(updateData);

    const { reloadCompanySubscriptionCache } = require("../../helpers");
    await reloadCompanySubscriptionCache(sub.organization_id || sub.company_id);

    return res.success("SUB_UPDATED", sub);
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.getModulesAndEntities = async (req, res) => {
  try {
    const { ModuleMaster, ModuleEntityMaster } = require("../../models");
    const data = await ModuleMaster.findAll({
      where: { status: 0 },
      attributes: ["id", "module_name", "cust_module_name"],
      include: [{
        model: ModuleEntityMaster,
        as: "entities",
        where: { status: 0 },
        attributes: ["id", "entity_name", "cust_entity_name"],
        required: false,
      }],
      order: [
        // ordering can be done by ID since priority might not always exist or we default to ASC
        ["id", "ASC"]
      ]
    });
    return res.ok(data);
  } catch (err) {
    return handleError(err, res, req);
  }
};


