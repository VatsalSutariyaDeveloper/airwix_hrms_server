const jwt = require("jsonwebtoken");
const { requestContext } = require("../utils/requestContext.js");
const { User, CompanyMaster, BranchMaster } = require("../models");
const { constants } = require("../helpers");

// In-memory token blacklist
const tokenBlacklist = new Set();

const SKIP_ROUTES = [
  "/api/administration/permission/constants"
];

const addToBlacklist = (token) => {
  tokenBlacklist.add(token);
};

const isTokenBlacklisted = (token) => {
  return tokenBlacklist.has(token);
};

async function authMiddleware(req, res, next) {
  // ✅ Skip auth for specific routes
  if (SKIP_ROUTES.includes(req.path) || req.path.startsWith("/api/onboarding/public/")) {
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

    // Verify User, Company, and Branch status
    const userRole = decoded.role_id;
    if (userRole) {
      const user = await User.findOne({ where: { id: decoded.id, status: 0 } });
      if (!user) return res.status(401).json({ success: false, message: "Unauthorized - User is inactive or not exist" });
    }

    if (decoded.company_id) {
      const company = await CompanyMaster.findOne({ where: { id: decoded.company_id, status: 0 } });
      if (!company) return res.status(401).json({ success: false, message: "Unauthorized - Company is inactive or not exist" });
    }

    if (decoded.branch_id) {
      const branch = await BranchMaster.findOne({ where: { id: decoded.branch_id, status: 0 } });
      if (!branch) return res.status(401).json({ success: false, message: "Unauthorized - Branch is inactive or not exist" });
    }

    req.user = {
      id: decoded.id,
      employee_id: decoded.employee_id,
      company_id: decoded.company_id,
      organization_id: decoded.organization_id || null, // Decrypt organization_id
      branch_id: decoded.branch_id,
      role_id: decoded.role_id,
      branch_access: decoded.branch_access || "",
      permissions: decoded.permissions || [],
      access_by: decoded.access_by || "web login",
      is_attendance_supervisor: decoded.is_attendance_supervisor,
      is_reporting_manager: decoded.is_reporting_manager,
      is_super_admin: decoded.is_super_admin || decoded.role_key === constants.ROLE_KEYS.BUSINESS_ADMIN,
      is_admin: decoded.is_admin || decoded.role_key === constants.ROLE_KEYS.ADMIN,
      access: decoded.access || (decoded.role_key ? "employee" : "attendance device")
    };
// console.log("req.user",req.user)
    requestContext.run(
      {
        userId: decoded.id,
        employeeId: decoded.employee_id,
        companyId: decoded.company_id,
        organizationId: decoded.organization_id || null, // Link organizationId to context
        branchId: decoded.branch_id,
        branchAccess: decoded.branch_access || "",
        roleId: decoded.role_id,
        is_attendance_supervisor: decoded.is_attendance_supervisor,
        is_reporting_manager: decoded.is_reporting_manager,
        is_super_admin: decoded.is_super_admin || decoded.role_key === constants.ROLE_KEYS.BUSINESS_ADMIN,
        is_admin: decoded.is_admin || decoded.role_key === constants.ROLE_KEYS.ADMIN,
        access: decoded.access || (decoded.role_key ? "employee" : "attendance device"),
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
