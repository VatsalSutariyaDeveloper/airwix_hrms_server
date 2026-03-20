const jwt = require("jsonwebtoken");

/**
 * Common token generator for User sessions
 */
const generateToken = (user, companyId, access_by = "web login") => {
  // Logic to determine branch_id: use user.branch_id, or first branch from branch_access, or 0
  const branchId = user.branch_id || (user.branch_access && user.branch_access.split(',')[0] ? parseInt(user.branch_access.split(',')[0]) : 0);

  return jwt.sign(
    {
      id: user.id || user.user_id,
      employee_id: user.employee_id,
      role_id: user.role_id,
      is_employee: user.role_id === 5,
      branch_id: branchId,
      company_id: companyId,
      organization_id: user.organization_id || null,
      access_by: access_by,
      branch_access: user.branch_access || "",
      is_attendance_supervisor: user.is_attendance_supervisor,
      is_reporting_manager: user.is_reporting_manager,
      is_super_admin: user.is_super_admin || user.role_id == 1,
      is_admin: user.role_id == 2,
      access: user.access || (user.role_id ? "employee" : "attendance device")
    },
    process.env.JWT_SECRET || "your_jwt_secret",
    { expiresIn: "30d" }
  );
};

module.exports = {
  generateToken
};
