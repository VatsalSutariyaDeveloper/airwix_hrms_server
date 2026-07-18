const jwt = require("jsonwebtoken");
const { requestContext } = require("../utils/requestContext.js");
const { User, CompanyMaster, BranchMaster, DeviceMaster } = require("../models");
const { constants, deviceHelper } = require("../helpers");

// In-memory token blacklist
const tokenBlacklist = new Set();

const SKIP_ROUTES = [
  "/api/administration/permission/constants",
  "/api/AWXTEC-PY",
  "/api/auth/AWXTEC-PY"
];

const addToBlacklist = (token) => {
  tokenBlacklist.add(token);
};

const isTokenBlacklisted = (token) => {
  return tokenBlacklist.has(token);
};

// Sequelize connection/pool errors mean the DB is already struggling - firing
// more queries (FCM cleanup, auto-unpair lookups) in response only deepens
// the outage instead of recovering from it, so we fail fast on these instead.
const DB_UNAVAILABLE_ERROR_NAMES = new Set([
  "SequelizeConnectionError",
  "SequelizeConnectionRefusedError",
  "SequelizeHostNotFoundError",
  "SequelizeHostNotReachableError",
  "SequelizeInvalidConnectionError",
  "SequelizeConnectionTimedOutError",
  "SequelizeConnectionAcquireTimeoutError"
]);
const isDbUnavailableError = (err) => !!err && DB_UNAVAILABLE_ERROR_NAMES.has(err.name);

// Clean up FCM token on unauthorized session
async function cleanupFcmToken(token, transaction = null) {
  if (!token) return;
  try {
    const decoded = jwt.decode(token);
    if (decoded && decoded.fcm_token && decoded.id) {
      const { UserDevice, User } = require("../models");
      const { commonQuery } = require("../helpers");
      await commonQuery.hardDeleteRecords(UserDevice, { fcm_token: decoded.fcm_token, user_id: decoded.id }, transaction, false);
      const userRecord = await User.findByPk(decoded.id, { transaction });
      if (userRecord && userRecord.fcm_token === decoded.fcm_token) {
        await User.update({ fcm_token: null }, { where: { id: decoded.id }, transaction });
      }
    }
  } catch (err) {
    console.error("Failed to cleanup FCM token in middleware:", err.message);
  }
}

async function authMiddleware(req, res, next) {
  // ✅ Bypass auth if request has valid x-master-admin-key header
  const providedMasterKey = req.headers["x-master-admin-key"];
  const expectedMasterKey = process.env.MASTER_ADMIN_SECRET_KEY || 'MASTER_ADMIN_SECRET_KEY';
  if (providedMasterKey && expectedMasterKey && providedMasterKey === expectedMasterKey) {
    const store = requestContext.getStore() || {};
    requestContext.run({
      ...store,
      isMasterAdmin: true,
      access: "master-admin"
    }, () => {
      next();
    });
    return;
  }

  // ✅ Skip auth for specific routes
  if (SKIP_ROUTES.includes(req.path) || req.path.startsWith("/api/onboarding/public/")) {
    return next();
  }

  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      req.auth_error_detail = "Authorization header is missing in request headers.";
      return res.status(401).json({ message: "Authorization header missing" });
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
      req.auth_error_detail = "Bearer token is missing in Authorization header.";
      return res.status(401).json({ message: "Token missing" });
    }

    // Check if token is blacklisted
    if (isTokenBlacklisted(token)) {
      req.auth_error_detail = "The token is blacklisted (the user has logged out).";
      await cleanupFcmToken(token);
      return res.status(401).json({ message: "Unauthorized" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Verify User, Company, and Branch status
    if (decoded.id && !decoded.device_id) {
      const user = await User.findOne({ where: { id: decoded.id, status: 0 } });
      if (!user) {
        req.auth_error_detail = `User with ID ${decoded.id} is inactive or does not exist.`;
        await cleanupFcmToken(token);
        return res.status(401).json({ success: false, message: "Unauthorized - User is inactive or not exist" });
      }
    }

    if (decoded.company_id) {
      const company = await CompanyMaster.findOne({ where: { id: decoded.company_id, status: 0 } });
      if (!company) {
        req.auth_error_detail = `Company with ID ${decoded.company_id} is inactive or suspended.`;
        await cleanupFcmToken(token);
        return res.status(401).json({ success: false, message: "Unauthorized - Company is inactive or not exist" });
      }
    }

    if (decoded.branch_id) {
      const branch = await BranchMaster.findOne({ where: { id: decoded.branch_id, status: 0 } });
      if (!branch) {
        req.auth_error_detail = `Branch with ID ${decoded.branch_id} is inactive or deleted.`;
        await cleanupFcmToken(token);
        return res.status(401).json({ success: false, message: "Unauthorized - Branch is inactive or not exist" });
      }
    }

    // 🚀 NEW: Verify Device ID if present (Multi-device security)
    if (decoded.device_id) {
      const device = await DeviceMaster.findOne({ 
        where: { 
          id: decoded.id,
          device_id: decoded.device_id, 
          status: 0 
        } 
      });
      if (!device) {
        const existingDevice = await DeviceMaster.findOne({ where: { id: decoded.id } });
        if (!existingDevice) {
          req.auth_error_detail = `Device with ID ${decoded.id} does not exist in DeviceMaster.`;
        } else if (existingDevice.device_id !== decoded.device_id) {
          req.auth_error_detail = `Device ID mismatch: DB has '${existingDevice.device_id}', client sent '${decoded.device_id}'.`;
        } else {
          req.auth_error_detail = `Device ID '${decoded.id}' exists but status is '${existingDevice.status}' (expected 0/active).`;
        }

        try {
          if (existingDevice && existingDevice.status !== 0 && existingDevice.status !== 3) {
            const newDeviceId = await deviceHelper.generateUniqueDeviceId(existingDevice.company_id, existingDevice.branch_id);
            await DeviceMaster.update({
              device_id: newDeviceId,
              ip_address: null,
              last_login_at: null,
              os_version: null,
              brand_name: null,
              device_model: null,
              status: constants.DEVICE_STATUS.PAIRING
            }, {
              where: { id: existingDevice.id }
            });
            console.log(`🔌 [AUTO-UNPAIR] Device ID ${existingDevice.id} auto-switched to PAIRING mode.`);
          }
        } catch (unpairErr) {
          console.error("Auto-unpair on status mismatch failed:", unpairErr.message);
        }
        await cleanupFcmToken(token);
        return res.status(401).json({ success: false, message: "Unauthorized - Device session is invalid or revoked" });
      }


      // 💓 Heartbeat: Update last activity for online status tracking
      DeviceMaster.update(
        { last_login_at: new Date() },
        { where: { id: device.id } }
      ).catch(err => console.error("Device heartbeat update failed:", err));
    }

    req.user = {
      id: decoded.id,
      employee_id: decoded.employee_id,
      company_id: decoded.company_id,
      organization_id: decoded.organization_id || null, // Decrypt organization_id
      branch_id: decoded.branch_id,
      role_id: decoded.role_id,
      role_key: decoded.role_key,
      branch_access: decoded.branch_access || "",
      permissions: decoded.permissions || [],
      access_by: decoded.access_by || "web login",
      is_attendance_supervisor: decoded.is_attendance_supervisor,
      is_reporting_manager: decoded.is_reporting_manager,
      is_super_admin: decoded.is_super_admin || decoded.role_key === constants.ROLE_KEYS.BUSINESS_ADMIN,
      is_admin: decoded.is_admin || decoded.role_key === constants.ROLE_KEYS.ADMIN,
      access: decoded.access || (decoded.role_key ? "employee" : "attendance"),
      device_id: decoded.device_id || null,
      fcm_token: decoded.fcm_token || null,
      selectedCompanyIds: decoded.selectedCompanyIds || null
    };
console.log("req.user",req.user)
    requestContext.run(
      {
        userId: decoded.id,
        employeeId: decoded.employee_id,
        companyId: decoded.company_id,
        selectedCompanyIds: decoded.selectedCompanyIds || [],
        organizationId: decoded.organization_id || null, // Link organizationId to context
        branchId: decoded.branch_id,
        branchAccess: decoded.branch_access || "",
        roleId: decoded.role_id,
        roleKey: decoded.role_key,
        is_attendance_supervisor: decoded.is_attendance_supervisor,
        is_reporting_manager: decoded.is_reporting_manager,
        is_super_admin: decoded.is_super_admin || decoded.role_key === constants.ROLE_KEYS.BUSINESS_ADMIN,
        is_admin: decoded.is_admin || decoded.role_key === constants.ROLE_KEYS.ADMIN,
        access: decoded.access || (decoded.role_key ? "employee" : "attendance"),
        ip: req.headers["x-forwarded-for"] || req.connection.remoteAddress || req.ip,
        userAgent: req.headers["user-agent"] || "unknown",
        endpoint: `${req.method} ${req.originalUrl}`
      },
      () => next()
    );

  } catch (err) {
    req.auth_error_detail = `JWT validation failed: ${err.message} (${err.name}).`;

    // If the DB itself is unavailable/pool-exhausted, don't fire off more
    // queries trying to clean up - that's what was turning brief DB slowness
    // into a multi-minute outage (each failed request queued 2-3 more
    // 60s-long connection acquisitions instead of failing fast).
    if (!isDbUnavailableError(err)) {
      try {
        const authHeader = req.headers.authorization;
        if (authHeader) {
          const token = authHeader.split(" ")[1];
          if (token) {
            await cleanupFcmToken(token);
          }
        }
      } catch (fcmCleanupErr) {
        console.error("FCM cleanup in verification catch failed:", fcmCleanupErr.message);
      }
      // 🔍 Log the detailed error to easily diagnose signature mismatches, expired tokens, or environment mismatches
      //
      // ⚠️ Deliberately NO auto-unpair here anymore. This block used to rotate
      // the device_id of an ACTIVE device whenever ANY invalid/expired token
      // carrying that device_id arrived. One stray request from a stale token
      // (background sync isolate, old session still in flight after re-login,
      // token signed with a different JWT_SECRET) would then permanently kill
      // the device's CURRENT valid session too → every request 401 → the app
      // auto-logged-out and forced a re-pairing for no real reason.
      // An invalid token must only be rejected, never mutate device state.
      try {
        const authHeader = req.headers.authorization;
        if (authHeader) {
          const token = authHeader.split(" ")[1];
          if (token) {
            const decoded = jwt.decode(token);
            if (decoded && decoded.device_id) {
              console.warn(
                `🔐 [AUTH FAILED] Invalid token carried device_id '${decoded.device_id}' (entity id ${decoded.id}). ` +
                `Rejected with 401 only — device row left untouched.`
              );
            }
          }
        }
      } catch (decodeErr) {
        console.error("Decode-for-logging in verification catch failed:", decodeErr.message);
      }
    }

    console.error("🔐 [AUTH FAILED] JWT Verification Error:", {
      message: err.message,
      name: err.name,
      expiredAt: err.expiredAt || null,
      path: req.path,
      ip: req.headers["x-forwarded-for"] || req.connection.remoteAddress || req.ip
    });

    if (isDbUnavailableError(err)) {
      return res.status(503).json({ message: "Service temporarily unavailable, please retry." });
    }
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

module.exports = { 
  authMiddleware,
  addToBlacklist,
  isTokenBlacklisted
};
