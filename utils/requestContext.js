const { AsyncLocalStorage } = require("async_hooks");

const requestContext = new AsyncLocalStorage();

function getContext() {
  const store = requestContext.getStore();
  console.log("Request Context Store:", store);
  if (!store) {
    throw new Error("Request context not available");
  }
  return {
    user_id: store.userId,
    company_id: store.companyId,
    branch_id: store.branchId,
    role_id: store.roleId,
    ip: store.ip
  };
}

module.exports = {
  requestContext,
  getContext
};
