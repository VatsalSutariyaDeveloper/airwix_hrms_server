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

const PUBLIC_ROUTE_KEYWORDS = [
  "/auth",
  "/subscription",
  "/public",
  "/webhook",
  "/settings/user-access",
  "/dashboard",
  "/dropdown-list",
  "/administration",
];

module.exports = async function checkPermission(req, res, next) {
  try {
    // -----------------------------------------------------------
    // ✅ 1. CHECK PUBLIC ROUTES FIRST (Before getting Context)
    // -----------------------------------------------------------
    
    if (process.env.BYPASS_PERMISSION === "true") return next();
    if (req.method === "OPTIONS") return next();

    // Fix: Check if URL contains "/auth" or matches other public keywords
    // 'req.originalUrl' is safer to use than 'req.path' in middlewares
    const currentUrl = req.originalUrl.toLowerCase();
    
    const isPublic = PUBLIC_ROUTE_KEYWORDS.some(keyword => currentUrl.includes(keyword));
    
    if (isPublic) {
      // If it's a login/public route, we STOP here. 
      // We do NOT try to get context, because it doesn't exist yet.
      return next();
    }

    // -----------------------------------------------------------
    // ✅ 2. GET CONTEXT (Only for Protected Routes)
    // -----------------------------------------------------------
    const ctx = getContext(); 
    // This will now only run if the user IS logged in (has a token).
    
    const currentPath = normalizePath(req.originalUrl);
    const currentMethod = req.method.toUpperCase();

    const routeRule = await getRoutePermissionId(currentMethod, currentPath);

    if (!routeRule) {
      console.warn(`[PERMISSION] Missing rule: ${currentMethod} ${currentPath}`);
      return next();
    }

    const userId = ctx.user_id;
    const companyId = ctx.company_id;
    const branchId = ctx.branch_id;

    if (!userId || !companyId) {
      return res.error(constants.UNAUTHORIZED, ["Authentication required"]);
    }

    const companySubscription = await getCompanySubscription(companyId);
    const allowedModules = (companySubscription.allowed_module_ids || "").split(",").map(Number);

    if (!allowedModules.includes(routeRule)) {
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