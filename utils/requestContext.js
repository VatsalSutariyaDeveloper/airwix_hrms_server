const { AsyncLocalStorage } = require("async_hooks");

const requestContext = new AsyncLocalStorage();

function getContext() {
  const store = requestContext.getStore();
  
  // Return safe defaults if store is missing (e.g., background job, startup error)
  if (!store) {
    return {
      user_id: null,
      company_id: null,
      organization_id: null,
      branch_id: null,
      branch_access: [],
      role_id: null,
      is_super_admin: false,
      isMasterAdmin: false,
      is_attendance_supervisor: false,
      is_reporting_manager: false,
      is_admin: false,
      ip: "127.0.0.1",
      userAgent: "unknown",
      endpoint: "unknown",
      access: "system",
      batch_id: null
    };
  }
  
  return {
    user_id: store.userId,
    company_id: store.companyId,
    organization_id: store.organizationId,
    branch_id: store.branchId,
    branch_access: store.branchAccess,
    role_id: store.roleId,
    is_super_admin: store.is_super_admin || false,
    isMasterAdmin: store.isMasterAdmin || false,
    is_attendance_supervisor: store.is_attendance_supervisor || false,
    is_reporting_manager: store.is_reporting_manager || false,
    is_admin: store.is_admin || false,
    ip: store.ip,
    userAgent: store.userAgent || "unknown",
    endpoint: store.endpoint || "unknown",
    access: store.access,
    batch_id: store.batchId || null
  };
}

module.exports = {
  requestContext,
  getContext
};
