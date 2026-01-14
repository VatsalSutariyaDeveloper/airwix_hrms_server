const { RoutePermission } = require("../models");
const { constants } = require("../helpers/constants");
const { handleError } = require("../helpers/functions/errorFunctions");
const { getuser } = require("../helpers/permissionCache");
const { getCompanySubscription, getRoutePermissionId } = require("../helpers/cache");
const { getContext } = require("../utils/requestContext.js");

// Helper: Normalize URL (remove query params and trailing slashes)
const normalizePath = (path) => {
    return path.split('?')[0].replace(/\/+$/, "");
};

const PUBLIC_ROUTE_SUFFIXES = [
  "/auth",
  "/subscription",
  "/public",
  "/webhook",
];

module.exports = async function checkPermission(req, res, next) {
  try {
    const ctx = getContext();
    console.log("ctx",ctx)
    if (process.env.BYPASS_PERMISSION === "true") return next();
    if (req.method === "OPTIONS") return next();
    if (PUBLIC_ROUTE_SUFFIXES.some(s => req.path.endsWith(s))) return next();

    const currentPath = normalizePath(req.originalUrl);
    const currentMethod = req.method.toUpperCase();

    const routeRule = getRoutePermissionId(currentPath, currentMethod);
    if (!routeRule) {
      console.warn(`[PERMISSION] Missing rule: ${currentMethod} ${currentPath}`);
      return next();
    }

    const userId = ctx.userId;
    const companyId = ctx.companyId;
    const branchId = ctx.branchId;

    if (!userId || !companyId) {
      return res.error(constants.UNAUTHORIZED, ["Authentication required"]);
    }

    const companySubscription = await getCompanySubscription(companyId);
    const allowedModules = (companySubscription.allowed_module_ids || "")
      .split(",")
      .map(Number);

    if (!allowedModules.includes(routeRule.permission_id)) {
      return res.error(constants.FORBIDDEN, ["Module not enabled"]);
    }

    const user = await getuser(userId, branchId, companyId);
    if (!user || user.status === 2) {
      return res.error(constants.FORBIDDEN, [constants.USER_INACTIVE]);
    }

    if (Number(user.role_id) === 1) return next();

    const userPermissions = String(user.permission || "")
      .split(",")
      .map(p => p.trim());

    if (!userPermissions.includes(String(routeRule.permission_id))) {
      return res.error(constants.PERMISSION_DENIED, {
        required_permission_id: routeRule.permission_id
      });
    }

    next();
  } catch (err) {
    return handleError(err, res, req);
  }
};