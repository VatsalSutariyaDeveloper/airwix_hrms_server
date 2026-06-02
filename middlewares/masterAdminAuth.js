/**
 * Master Admin Authentication Middleware
 * Validates the X-Master-Admin-Key header against the env secret.
 * This is separate from the tenant-level authMiddleware.
 */
const { requestContext } = require("../utils/requestContext.js");

const masterAdminAuth = (req, res, next) => {
  const providedKey = req.headers["x-master-admin-key"];
  const expectedKey = process.env.MASTER_ADMIN_SECRET_KEY;

  if (!expectedKey) {
    console.error("[MasterAdmin] MASTER_ADMIN_SECRET_KEY is not set in .env");
    return res.status(500).json({
      success: false,
      code: "SERVER_ERROR",
      message: "Master admin secret key is not configured.",
    });
  }

  if (!providedKey || providedKey !== expectedKey) {
    return res.status(403).json({
      success: false,
      code: "FORBIDDEN",
      message: "Invalid or missing Master Admin key.",
    });
  }

  const store = requestContext.getStore() || {};
  requestContext.run({
    ...store,
    isMasterAdmin: true,
    access: "master-admin"
  }, () => {
    next();
  });
};

module.exports = masterAdminAuth;
