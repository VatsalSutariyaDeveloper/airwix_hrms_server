const { ApiLog } = require("../models");
const { requestContext } = require("../utils/requestContext.js");

const syncedApiTenants = new Set();

const apiLogger = async (req, res, next) => {
  const startTime = Date.now();

  // Skip logging the logs retrieval themselves to avoid recursion/spam
  if (req.originalUrl.includes("/api/logs") || req.originalUrl.includes("/api/activity")) {
    return next();
  }

  // Capture + mask the request body up front, on a copy - request handlers
  // further down the chain may mutate req.body before the response finishes.
  let requestBody = null;
  if (req.method !== "GET" && req.body) {
    requestBody = { ...req.body };
    if (requestBody.password) requestBody.password = "********";
    if (requestBody.token) requestBody.token = "********";
  }

  const { storage } = require("./tenantMiddleware");
  let tenantPrefix = "DEFAULT";
  try {
    tenantPrefix = storage.getStore() || "DEFAULT";
  } catch (e) {}

  // Create the log row immediately - before the request is processed - so a
  // request that hangs, crashes, or never sends a response still leaves a
  // record. The row is filled in with the outcome once the response finishes.
  const logEntryPromise = (async () => {
    try {
      if (!syncedApiTenants.has(tenantPrefix)) {
        await ApiLog.sync();
        syncedApiTenants.add(tenantPrefix);
      }
      return await ApiLog.create({
        method: req.method,
        url: req.originalUrl,
        ip_address: req.ip || req.headers["x-forwarded-for"] || req.connection.remoteAddress,
        request_body: requestBody,
        user_agent: req.headers["user-agent"],
        status: null,
        status_code: null
      });
    } catch (err) {
      console.error(`[APILOG] Failed to create API log entry for tenant ${tenantPrefix}:`, err.message);
      return null;
    }
  })();

  // To capture the response body, we need to override res.send
  const originalSend = res.send;
  let responseBody;

  res.send = function (body) {
    responseBody = body;
    return originalSend.apply(res, arguments);
  };

  res.on("finish", async () => {
    try {
      const duration = Date.now() - startTime;
      const store = requestContext.getStore();

      // Safely parse the response body
      let parsedResponse = null;
      if (responseBody) {
        if (typeof responseBody === "string") {
          try {
            parsedResponse = JSON.parse(responseBody);
          } catch (jsonErr) {
            parsedResponse = { raw_response: responseBody };
          }
        } else {
          parsedResponse = responseBody;
        }
      }

      // Inject the detailed authentication error reason if it exists
      if (req.auth_error_detail) {
        if (!parsedResponse || typeof parsedResponse !== "object") {
          parsedResponse = { response_data: parsedResponse };
        }
        parsedResponse.auth_error_detail = req.auth_error_detail;
      }

      const logEntry = await logEntryPromise;
      if (!logEntry) return;

      await logEntry.update({
        company_id: store?.companyId || null,
        branch_id: store?.branchId || null,
        user_id: (store?.access === 'attendance' || store?.access === 'canteen') ? null : (store?.userId || null),
        status_code: res.statusCode,
        response_body: parsedResponse,
        duration: duration,
        status: res.statusCode >= 400 ? 1 : 0 // 0 = Success, 1 = Error
      });
    } catch (err) {
      console.error("Failed to update API log:", err.message);
    }
  });

  next();
};

module.exports = apiLogger;
