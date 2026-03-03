const { AsyncLocalStorage } = require("async_hooks");

const requestContext = new AsyncLocalStorage();

function getContext() {
  const store = requestContext.getStore();
  if (!store) {
    throw new Error("Request context not available");
  }
  return {
    user_id: store.userId,
    company_id: store.companyId,
    organization_id: store.organizationId,
    branch_id: store.branchId,
    branch_access: store.branchAccess,
    role_id: store.roleId,
    is_super_admin: store.is_super_admin || false,
    ip: store.ip
  };
}

module.exports = {
  requestContext,
  getContext
};
