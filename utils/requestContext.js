import { AsyncLocalStorage } from "async_hooks";

export const requestContext = new AsyncLocalStorage();

export function getContext() {
  const store = requestContext.getStore();
  if (!store) {
    throw new Error("Request context not available");
  }
  return store;
}
