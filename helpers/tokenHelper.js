const jwt = require("jsonwebtoken");
const { constants } = require("./constants");

/**
 * Common token generator for User sessions
 */
const generateToken = (user, companyId, access_by = "web login") => {
  // Logic to determine branch_id: use user.branch_id, or first branch from branch_access, or 0
  const branchId = user.branch_id || (user.branch_access && user.branch_access.split(',')[0] ? parseInt(user.branch_access.split(',')[0]) : 0);
  const roleKey = user.role_key || user.RolePermission?.role_key || null;

  return jwt.sign(
    {
      id: user.id || user.user_id,
      employee_id: user.employee_id,
      role_id: user.role_id,
      role_key: roleKey,
      is_employee: roleKey === constants.ROLE_KEYS.EMPLOYEE,
      branch_id: branchId,
      company_id: companyId,
      organization_id: user.organization_id || null,
      access_by: access_by,
      branch_access: user.branch_access || "",
      is_attendance_supervisor: user.is_attendance_supervisor || roleKey === constants.ROLE_KEYS.ATTENDANCE_SUPERVISOR,
      is_reporting_manager: user.is_reporting_manager || roleKey === constants.ROLE_KEYS.REPORTING_MANAGER,
      is_super_admin: user.is_super_admin || roleKey === constants.ROLE_KEYS.BUSINESS_ADMIN,
      is_admin: roleKey === constants.ROLE_KEYS.ADMIN,
      access: user.access
    },
    process.env.JWT_SECRET || "your_jwt_secret",
    { expiresIn: "30d" }
  );
};

module.exports = {
  generateToken
};
