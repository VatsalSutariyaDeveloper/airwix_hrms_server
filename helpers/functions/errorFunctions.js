const constants = require("../constants");
const { logError } = require("./logFunctions");
const { Err } = require("../Err");

exports.handleError = async (err, res, req = {}) => {
  // If explicitly handled, returned immediately without logging to DB or Console
  if (err instanceof Err || err.handled) {
    if (err.data) {
      return res.dataError(err.message, err.data);
    }
    return res.error(constants.VALIDATION_ERROR, err.message);
  }

  const { user_id = null, company_id = null, branch_id = null } = req.body || {};

  /* =========================================================
     1. DETAILED DEVELOPER CONSOLE LOG (Added per request)
     ========================================================= */
  console.error('\n\x1b[31m%s\x1b[0m', '______________________ 🚨 CONTROLLER ERROR ______________________'); // Red Header
  console.error(`🕒 [Time]       : ${new Date().toLocaleString()}`);
  console.error(`🛣️  [Route]      : ${req.method || 'N/A'} ${req.originalUrl || req.url || 'Unknown'}`);
  console.error(`👤 [Context]    : User: ${user_id || 'N/A'} | Co: ${company_id || 'N/A'} | Br: ${branch_id || 'N/A'}`);
  console.error(`⚠️  [Type]       : ${err.name || 'Unknown Error'}`);
  console.error(`💬 [Message]    : ${err.message}`);

  // If it's a Sequelize error, log the failed SQL query
  if (err.sql) {
    console.error(`📜 [Failed SQL] : ${err.sql}`);
  }

  // If there are validation errors (Sequelize), log them clearly
  if (err.errors && Array.isArray(err.errors)) {
    const valErrors = err.errors.map(e => `${e.path}: ${e.message}`).join(' | ');
    console.error(`📋 [Validations] : ${valErrors}`);
  }

  console.error(`💥 [Stack Trace] :`);
  console.error(err.stack || "No stack trace available");
  console.error('\x1b[31m%s\x1b[0m', '_________________________________________________________________\n'); // Red Footer


  /* ===============================
     2. DATABASE LOGGING
     =============================== */
  const isSequelizeError = err?.name && err.name.toLowerCase().includes("sequelize");
  const entityName = isSequelizeError
    ? err.name
    : `CONTROLLER ERROR: ${req.method || "N/A"} ${req.baseUrl || ""}${req.path || "Unknown Path"}`;

  try {
    await logError({
      entity_name: entityName,
      user_id,
      company_id,
      branch_id,
      error_message: `${err.name}: ${err.message}`,
      request_body: {
        body: req.body || {},
        query: req.query || {},
        failed_sql: err.sql || null
      },
      stack_trace: {
        name: err.name,
        message: err.message,
        stack: (err.stack || "No stack").substring(0, 5000)
      },
      ip_address: req.ip || "N/A"
    });
  } catch (logErr) {
    console.error("[CRITICAL] Error logging failed:", logErr.message);
  }

  /* ===============================
     3. RESPONSE HANDLING
     =============================== */
  if (!res || typeof res.error !== 'function') {
    console.error("[CRITICAL] Response object is invalid or missing extended methods (res.error)");
    return res?.status?.(500).json({ success: false, code: constants.SERVER_ERROR }) || console.error("Response object is completely unusable.");
  }

  try {

    if (err instanceof Err || err.handled) {
      // LOGIC: If we have specific data context (like { qty: 100 }), use dataError
      if (err.data) {
        return res.dataError(err.message, err.data);
      }
      return res.error(err.message);
    }

    /* ---------- Sequelize validation / unique ---------- */
    if (
      err.name === "SequelizeValidationError" ||
      err.name === "SequelizeUniqueConstraintError"
    ) {
      const errors = {};
      err.errors.forEach((e) => {
        errors[e.path] = e.type || "INVALID";
      });
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    /* ---------- Foreign key constraint (MySQL) ---------- */
    if (
      err.original?.code === "ER_NO_REFERENCED_ROW_2" ||
      err.message?.toLowerCase().includes("foreign key constraint fails")
    ) {
      return res.error(constants.FOREIGN_KEY_CONSTRAINT);
    }

    /* ---------- Business rule / required checks ---------- */
    if (
      err.message?.toLowerCase().includes("user is required") ||
      err.message?.toLowerCase().includes("branch is required") ||
      err.message?.toLowerCase().includes("company is required")
    ) {
      return res.error(constants.REQUIRED_FIELDS_MISSING);
    }

    /* ---------- Permission / auth ---------- */
    if (err.code === "FORBIDDEN") {
      return res.error(constants.FORBIDDEN);
    }

    if (err.code === "UNAUTHORIZED") {
      return res.error(constants.UNAUTHORIZED);
    }

    /* ---------- Default fallback ---------- */
    return res.error(constants.SERVER_ERROR);

  } catch (fatalError) {
    console.error("[CRITICAL] Error in error handler:", fatalError);
    if (res && typeof res.error === 'function') {
      return res.error(constants.SERVER_ERROR);
    }
    // Fallback if res.error is missing
    return res.status(500).json({ success: false, code: constants.SERVER_ERROR });
  }
};