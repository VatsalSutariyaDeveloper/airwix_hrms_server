const jwt = require("jsonwebtoken");
const { requestContext } = require("../utils/requestContext.js");

// In-memory token blacklist
const tokenBlacklist = new Set();

const SKIP_ROUTES = [
  "/administration/permission/constants"
];

const addToBlacklist = (token) => {
  tokenBlacklist.add(token);
};

const isTokenBlacklisted = (token) => {
  return tokenBlacklist.has(token);
};

function authMiddleware(req, res, next) {
  // ✅ Skip auth for specific routes
  if (SKIP_ROUTES.includes(req.path)) {
    return next();
  }

  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ message: "Authorization header missing" });
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
      return res.status(401).json({ message: "Token missing" });
    }

    // Check if token is blacklisted
    if (isTokenBlacklisted(token)) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    req.user = {
      id: decoded.id,
      employee_id: decoded.employee_id,
      company_id: decoded.company_id,
      branch_id: decoded.branch_id,
      role_id: decoded.role_id,
      permissions: decoded.permissions || [],
      access_by: decoded.access_by || "web login",
      is_attendance_supervisor: decoded.is_attendance_supervisor,
      is_reporting_manager: decoded.is_reporting_manager,
      is_super_admin: decoded.role_id == 1,
      is_admin: decoded.role_id == 2
    };

    requestContext.run(
      {
        userId: decoded.id,
        employeeId: decoded.employee_id,
        companyId: decoded.company_id,
        branchId: decoded.branch_id,
        roleId: decoded.role_id,
        is_attendance_supervisor: decoded.is_attendance_supervisor,
        is_reporting_manager: decoded.is_reporting_manager,
        is_super_admin: decoded.role_id == 1,
        is_admin: decoded.role_id == 2,
        ip: req.ip
      },
      () => next()
    );

  } catch (err) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

module.exports = { 
  authMiddleware,
  addToBlacklist,
  isTokenBlacklisted
};
