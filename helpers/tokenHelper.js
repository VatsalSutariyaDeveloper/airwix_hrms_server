const jwt = require("jsonwebtoken");
const { constants } = require("./constants");

/**
 * Common token generator for User sessions
 */
const generateToken = (user, companyId, access_by = "web login") => {
  // console.trace("generateToken called from:")
  const roleKey = user.role_key || user.RolePermission?.role_key || null;
  const expiresIn = access_by === "application" ? "36500d" : "30d";

  return jwt.sign(
    {
      id: user.id || user.user_id,
      employee_id: user.employee_id,
      role_id: user.role_id,
      role_key: roleKey,
      is_employee: roleKey === constants.ROLE_KEYS.EMPLOYEE,
      company_id: companyId,
      organization_id: user.organization_id || null,
      access_by: access_by,
      is_attendance_supervisor: user.is_attendance_supervisor || roleKey === constants.ROLE_KEYS.ATTENDANCE_SUPERVISOR,
      is_reporting_manager: user.is_reporting_manager || roleKey === constants.ROLE_KEYS.REPORTING_MANAGER,
      is_super_admin: user.is_super_admin || roleKey === constants.ROLE_KEYS.BUSINESS_ADMIN,
      is_admin: roleKey === constants.ROLE_KEYS.ADMIN,
      access: user.access,
      device_id: user.device_id || null,
      fcm_token: user.fcm_token || null
    },
    process.env.JWT_SECRET || "your_jwt_secret",
    { expiresIn }
  );
};

module.exports = {
  generateToken
};
