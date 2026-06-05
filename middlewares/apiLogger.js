const { ApiLog } = require("../models");
const { requestContext } = require("../utils/requestContext.js");

const syncedApiTenants = new Set();

const apiLogger = async (req, res, next) => {
  const startTime = Date.now();
  
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
      
      // Skip logging the logs retrieval themselves to avoid recursion/spam
      if (req.originalUrl.includes("/api/logs") || req.originalUrl.includes("/api/activity")) {
        return;
      }

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

      const logData = {
        company_id: store?.companyId || null,
        branch_id: store?.branchId || null,
        user_id: store?.userId || null,
        method: req.method,
        url: req.originalUrl,
        status_code: res.statusCode,
        ip_address: req.ip || req.headers["x-forwarded-for"] || req.connection.remoteAddress,
        request_body: req.method !== "GET" ? req.body : null,
        response_body: parsedResponse,
        duration: duration,
        user_agent: req.headers["user-agent"],
        status: res.statusCode >= 400 ? 1 : 0 // 0 = Success, 1 = Error
      };

      // Mask sensitive fields
      if (logData.request_body) {
        if (logData.request_body.password) logData.request_body.password = "********";
        if (logData.request_body.token) logData.request_body.token = "********";
      }

      const { storage } = require("./tenantMiddleware");
      let tenantPrefix = "DEFAULT";
      try {
        tenantPrefix = storage.getStore() || "DEFAULT";
      } catch (e) {}

      if (!syncedApiTenants.has(tenantPrefix)) {
        try {
          await ApiLog.sync();
          syncedApiTenants.add(tenantPrefix);
        } catch (syncErr) {
          console.error(`[APILOG] Failed to sync ApiLog table for tenant ${tenantPrefix}:`, syncErr.message);
        }
      }

      await ApiLog.create(logData);
    } catch (err) {
      console.error("Failed to save API log:", err.message);
    }
  });

  next();
};

module.exports = apiLogger;
