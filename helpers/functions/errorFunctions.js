const constants = require("../constants");
const { logError } = require("./logFunctions");
const { Err } = require("../Err");

exports.handleError = async (err, res = null, req = null, isHighRisk = false) => {
  // If explicitly handled with our Err class, return immediately for Express
  if (res && (err instanceof Err || err.handled)) {
    if (err.data) {
      return res.dataError(err.message, err.data);
    }
    return res.error(constants.VALIDATION_ERROR, err.message);
  }

  // Extract caller from stack trace
  let caller = "unknown";
  if (err?.stack) {
    const lines = err.stack.split("\n");
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (
        !line.includes("node_modules") && 
        !line.includes("node:") && 
        !line.includes("errorFunctions.js") &&
        line.startsWith("at")
      ) {
        caller = line.replace(/^at /, "");
        break;
      }
    }
  }

  // Extract metadata if available
  const body = req?.body || {};
  const { user_id = null, company_id = null, branch_id = null } = body;
  const method = req?.method || "N/A";
  const url = req?.originalUrl || req?.url || "Internal/Process";
  const ip = req?.ip || "127.0.0.1";

  /* =========================================================
     1. DETAILED DEVELOPER CONSOLE LOG
     ========================================================= */
  const isProcessError = !res;
  const header = isHighRisk ? '🚨 HIGH RISK SYSTEM CRASH ' : (isProcessError ? '🚨 CRITICAL SYSTEM CRASH ' : '🚨 CONTROLLER ERROR ');
  
  console.error('\n\x1b[31m%s\x1b[0m', `______________________ ${header} ______________________`);
  console.error(`🕒 [Time]       : ${new Date().toLocaleString()}`);
  console.error(`🛣️  [Source]     : ${method} ${url}`);
  console.error(`📍 [Caller]     : ${caller}`);
  if (!isProcessError) {
    console.error(`👤 [Context]    : User: ${user_id || 'N/A'} | Co: ${company_id || 'N/A'} | Br: ${branch_id || 'N/A'}`);
  }
  console.error(`⚠️  [Type]       : ${err?.name || 'Unknown Error'}`);
  console.error(`💬 [Message]    : ${isHighRisk ? '[HIGH RISK] ' : ''}${err?.message || 'No message'}`);

  if (err?.sql) {
    console.error(`📜 [Failed SQL] : ${err.sql}`);
  }

  if (err?.errors && Array.isArray(err.errors)) {
    const valErrors = err.errors.map(e => `${e.path}: ${e.message}`).join(' | ');
    console.error(`📋 [Validations] : ${valErrors}`);
  }

  console.error(`💥 [Stack Trace] :`);
  console.error(err?.stack || "No stack trace available");
  console.error('\x1b[31m%s\x1b[0m', '_________________________________________________________________\n');


  /* ===============================
     2. UNIVERSAL LOGGING (DB + FILE)
     =============================== */
  const isSequelizeError = err?.name && err.name.toLowerCase().includes("sequelize");
  const entityName = isHighRisk ? "HIGH_RISK_CRASH" : (isProcessError 
    ? (isSequelizeError ? `DB_SYSTEM_ERROR: ${err.name}` : `GLOBAL_PROCESS_ERROR: ${err.name || 'CRASH'}`)
    : (isSequelizeError ? err.name : `CONTROLLER_ERROR: ${method} ${url.split('?')[0]}`));

  try {
    await logError({
      entity_name: entityName,
      user_id,
      company_id,
      branch_id,
      error_message: `${isHighRisk ? '[HIGH RISK] ' : ''}${err?.name || 'Error'}: ${err?.message || 'Unknown'}`,
      request_body: {
        method,
        url,
        body: body,
        query: req?.query || {},
        failed_sql: err?.sql || null,
        is_global_crash: isProcessError || isHighRisk
      },
      stack_trace: {
        name: err?.name,
        message: err?.message,
        stack: (err?.stack || "No stack").substring(0, 5000)
      },
      ip_address: ip,
      caller: caller
    });
  } catch (logErr) {
    console.error("[CRITICAL] Secondary error during logging attempt:", logErr.message);
  }

  /* ===============================
     3. EXPRESS RESPONSE HANDLING
     =============================== */
  // If this is a global process error (no 'res'), we just return
  if (!res) return;

  if (typeof res.error !== 'function') {
    console.error("[CRITICAL] Response object is unusable for res.error()");
    return res.status?.(500).json({ success: false, code: constants.SERVER_ERROR });
  }

  try {
    /* ---------- Sequelize validation / unique ---------- */
    if (
      err.name === "SequelizeValidationError" ||
      err.name === "SequelizeUniqueConstraintError"
    ) {
      const errors = {};
      err.errors?.forEach((e) => {
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
    console.error("[CRITICAL] Fatal logic error in error handler UI path:", fatalError);
    return res.status(500).json({ success: false, code: constants.SERVER_ERROR });
  }
};