const { AsyncLocalStorage } = require("async_hooks");
const requestContext = new AsyncLocalStorage();

function getContext() {
  const store = requestContext.getStore();
  if (!store) {
    throw new Error("Request context not available");
  }
  return store;
}

module.exports = {
  requestContext,
  getContext,
};
