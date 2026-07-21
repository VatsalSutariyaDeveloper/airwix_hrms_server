const { Logs, ApiLog, sequelize, Employee } = require("../../models"); 
const { generateLogMessage } = require("./logMessageGenerator"); // Assuming you have this
const fs = require('fs');
const path = require('path');
const { Op } = require("sequelize");
const { getContext } = require("../../utils/requestContext");

const IGNORED_FIELDS = ["createdAt", "updatedAt", "deletedAt", "password", "token", "otp"];
const TEXT_LIMIT = 1000000;
const JSON_LIMIT = 1000000;

// --- Helpers ---
const sanitizeUserId = (id) => {
  const num = Number(id);
  return (id && !isNaN(num) && num > 0) ? num : null;
};

const cleanObject = (obj) => {
  if (!obj || typeof obj !== "object") return obj;
  const cleaned = { ...obj };
  IGNORED_FIELDS.forEach((field) => delete cleaned[field]);
  return cleaned;
};

const toPlain = (data) => {
  if (!data) return data;
  if (typeof data.toJSON === "function") return data.toJSON();
  if (Array.isArray(data)) return data.map((item) => (typeof item?.toJSON === "function" ? item.toJSON() : item));
  return data;
};

const safeJson = (data) => {
  if (!data) return null;
  try {
    const stringified = JSON.stringify(data);
    if (stringified.length <= JSON_LIMIT) return data;
    return {
      _warning: "Data_Too_Large_For_DB",
      _original_size: stringified.length,
      _preview: stringified.substring(0, 5000) + " ... [TRUNCATED]"
    };
  } catch (err) {
    return { _error: "Circular_Structure_or_Parse_Error" };
  }
};

const getDiff = (oldData, newData) => {
  if (!oldData || !newData) return { old: cleanObject(oldData), new: cleanObject(newData) };
  const diffOld = {};
  const diffNew = {};
  let hasChanges = false;
  const allKeys = new Set([...Object.keys(oldData), ...Object.keys(newData)]);

  allKeys.forEach((key) => {
    if (IGNORED_FIELDS.includes(key)) return;
    const oldVal = oldData[key];
    const newVal = newData[key];
    let areEqual = oldVal == newVal;
    if (typeof oldVal === 'object' && oldVal !== null && typeof newVal === 'object' && newVal !== null) {
         areEqual = JSON.stringify(oldVal) === JSON.stringify(newVal);
    }
    if (!areEqual) {
      diffOld[key] = oldVal;
      diffNew[key] = newVal;
      hasChanges = true;
    }
  });
  if (!hasChanges) return null; 
  return { old: diffOld, new: diffNew };
};

const processLogData = (actionType, oldData, newData) => {
  let finalOld = null;
  let finalNew = null;
  
  if (actionType === "UPDATE" || actionType === "STATUS_CHANGE") {
      const diff = getDiff(oldData, newData);
      if (diff) { finalOld = diff.old; finalNew = diff.new; }
  } else if (actionType === "CREATE" || actionType === "BULK_CREATE") {
      finalNew = cleanObject(newData);
  } else if (actionType === "DELETE") {
      finalOld = cleanObject(oldData);
  } else {
      finalOld = cleanObject(oldData);
      finalNew = cleanObject(newData);
  }
  return { finalOld, finalNew };
};

const truncateText = (text, limit) => {
    if (!text) return text;
    const str = String(text);
    return str.length <= limit ? str : str.substring(0, limit) + "...";
};

// --- EXPORTS ---


const syncedTenants = new Set();

const ensureLogsTableSynced = async () => {
  let tenantPrefix = "DEFAULT";
  try {
    const { storage } = require("../../middlewares/tenantMiddleware");
    tenantPrefix = storage.getStore() || "DEFAULT";
  } catch (e) {}

  if (!syncedTenants.has(tenantPrefix)) {
    try {
      await Logs.sync();
      syncedTenants.add(tenantPrefix);
    } catch (syncErr) {
      console.error(`[LOGS] Failed to sync Logs table for tenant ${tenantPrefix}:`, syncErr.message);
    }
  }
};

// 2. Log Data Changes (CRUD) -> Goes to 'Logs' Table
exports.logQuery = async (logData, mainTransaction = null) => {
  await ensureLogsTableSynced();
  // ----------------------------------------------------------------
  // STEP 1: PREPARE & SANITIZE DATA
  // ----------------------------------------------------------------
  let message, finalOld, finalNew;
  
  try {
    const targetData = logData.new_data || logData.old_data;
    if (targetData && targetData.employee_id && logData.entity_name !== 'Employee' && (!targetData.employee_name && !targetData.first_name)) {
        try {
            const emp = await Employee.findOne({ 
                where: { id: targetData.employee_id }, 
                attributes: ['first_name', 'employee_code'], 
                raw: true 
            });
            if (emp) {
                if (logData.new_data) {
                    logData.new_data.employee_name = emp.first_name;
                    logData.new_data.employee_code = emp.employee_code;
                }
                if (logData.old_data) {
                    logData.old_data.employee_name = emp.first_name;
                    logData.old_data.employee_code = emp.employee_code;
                }
            }
        } catch (e) {
            console.warn(`[LOG_QUERY] Failed to fetch employee info for log suffix: ${e.message}`);
        }
    }

     message = logData.log_message || generateLogMessage(
        logData.entity_name, 
        logData.action_type, 
        logData.new_data || logData.old_data
    );

    const oldData = toPlain(logData.old_data);
    const newData = toPlain(logData.new_data);

    // [CRITICAL] SANITIZE HEAVY FIELDS
    // Removing these prevents "Data too long" errors that crash the DB transaction
    if (oldData) {
        if (oldData.face_descriptor) oldData.face_descriptor = "[VECTOR_DATA_REMOVED]";
        if (oldData.profile_image) oldData.profile_image = "[IMAGE_FILENAME]";
        if (oldData.education_details) oldData.education_details = "[JSON_DATA_TRUNCATED]"; 
    }
    
    if (newData) {
        if (newData.face_descriptor) newData.face_descriptor = "[VECTOR_DATA_REMOVED]";
        if (newData.profile_image) newData.profile_image = "[IMAGE_FILENAME]";
        if (newData.education_details) newData.education_details = "[JSON_DATA_TRUNCATED]";
    }
    
    const processed = processLogData(logData.action_type, oldData, newData);
    finalOld = processed.finalOld;
    finalNew = processed.finalNew;

  } catch (prepError) {
      console.error("[LOG_PREP_ERROR] Failed to prepare log data:", prepError.message);
      return; // Stop here. Failing to prep log shouldn't crash app.
  }

  // ----------------------------------------------------------------
  // STEP 2: PERFORM INSERT WITH SAFEGUARD (SAVEPOINT)
  // ----------------------------------------------------------------
  try {
    let ctx = null;
    try { ctx = getContext(); } catch (e) {}

    const logPayload = {
        entity_name: logData.entity_name,
        action_type: logData.action_type,
        user_id: (logData.access_type === 'attendance' || logData.access_type === 'canteen' || ctx?.access === 'attendance' || ctx?.access === 'canteen') ? null : sanitizeUserId(logData.user_id || ctx?.user_id),
        company_id: logData.company_id || ctx?.company_id,
        branch_id: logData.branch_id || ctx?.branch_id,
        record_id: logData.record_id,
        log_message: truncateText(message, TEXT_LIMIT),
        old_data: safeJson(finalOld),
        new_data: safeJson(finalNew),
        endpoint: logData.endpoint || (ctx ? ctx.endpoint : 'unknown'),
        ip_address: logData.ip_address || (ctx ? ctx.ip : null),
        user_agent: logData.user_agent || (ctx ? ctx.userAgent : 'unknown'),
        caller: logData.caller,
        batch_id: logData.batch_id || ctx?.batch_id
    };
    if (mainTransaction) {
        // [MAGIC FIX] Create a Nested Transaction (Savepoint)
        // If this block fails, Sequelize rolls back ONLY this nested part.
        // The 'mainTransaction' remains active and valid.
        await sequelize.transaction({ transaction: mainTransaction }, async (nestedT) => {
            await Logs.create(logPayload, { transaction: nestedT });
        });
    } else {
        // No main transaction, just insert normally
        await Logs.create(logPayload);
    }

  } catch (err) {
    // ----------------------------------------------------------------
    // STEP 3: SILENT FAILURE
    // ----------------------------------------------------------------
    // We catch the error so it doesn't bubble up to commonQuery.
    // Because we used a Savepoint above, the main transaction is still safe.
    console.error(`[WARNING] Audit Log Failed (Swallowed safely): ${err.message}`);
    // DO NOT throw err;
  }
};

// 3. Log Errors -> Goes to 'Logs' Table (Unified)
exports.logError = async (logData, transaction = null) => {
  await ensureLogsTableSynced();
  const timestamp = new Date().toLocaleString();
  const errorMsg = logData.error_message || "Unknown error";
  
  try {
    let ctx = null;
    try { ctx = getContext(); } catch (e) {}

    // 1. ALWAYS write to physical file as backup (safety first)
    const fileLogMessage = `🚨 ERROR: ${errorMsg}\n   Entity: ${logData.entity_name}\n   Body: ${JSON.stringify(logData.request_body || {})}\n   Stack: ${JSON.stringify(logData.stack_trace || {})}`;
    exports.writeLogToFile("error.log", fileLogMessage);

    // 2. Write to the database
    await Logs.create({
      entity_name: logData.entity_name || "SERVER_ERROR",
      action_type: "ERROR",
      user_id: (logData.access_type === 'attendance' || logData.access_type === 'canteen' || ctx?.access === 'attendance' || ctx?.access === 'canteen') ? null : sanitizeUserId(logData.user_id || ctx?.user_id),
      company_id: logData.company_id || ctx?.company_id,
      branch_id: logData.branch_id || ctx?.branch_id,
      record_id: null,
      log_message: truncateText(errorMsg, TEXT_LIMIT),
      old_data: null,
      // Store the request body in 'new_data' column for consistency
      new_data: safeJson(logData.request_body), 
      // Store the technical stack
      stack_trace: safeJson(logData.stack_trace),
      ip_address: logData.ip_address || ctx?.ip || "127.0.0.1",
      status: 0,
      access_type: logData.access_type || (ctx ? ctx.access : 'system'),
      endpoint: logData.endpoint || (ctx ? ctx.endpoint : 'unknown'),
      user_agent: logData.user_agent || (ctx ? ctx.userAgent : 'unknown'),
      caller: logData.caller || ctx?.caller || "unknown"
    }, { transaction });

  } catch (err) {
    // If DB log fails, we at least have it in the physical file
    console.error(`[CRITICAL - ${timestamp}] Database error logging failed, but file log preserved: ${err.message}`);
  }
};

// 4. Log to Physical File (Improved with better error handling)
exports.writeLogToFile = (filename, message) => {
    // Fire-and-forget approach with background error handling
    setImmediate(async () => {
        try {
            const logDir = path.join(process.cwd(), 'uploads', 'logs');
            
            // Ensure logs directory exists with proper error handling
            if (!fs.existsSync(logDir)) {
                try {
                    fs.mkdirSync(logDir, { recursive: true, mode: 0o755 });
                } catch (mkErr) {
                    console.error(`[LOGS] Failed to create logs directory: ${logDir}`, mkErr.message);
                    return;
                }
            }
            
            const filePath = path.join(logDir, filename);
            const timestamp = new Date().toLocaleString();
            const logMessage = `[${timestamp}] ${message}\n`;
            
            // Use async file write to avoid blocking
            await fs.promises.appendFile(filePath, logMessage, { encoding: 'utf8' });
            
        } catch (err) {
            console.error(`[LOGS] Error writing to ${filename}:`, {
                message: err.message,
                code: err.code,
                path: err.path
            });
        }
    });
};

// Retention window for every log table - anything older gets archived to a
// file on disk, then deleted from the DB, in small batches instead of one
// giant DELETE. A single DELETE across millions of TOASTed JSONB rows holds
// its lock/WAL footprint for the whole statement and is exactly the kind of
// "heavy process" that stalls the DB on an already-bloated table; batching
// keeps each transaction short and gives autovacuum room to keep up between
// batches.
const LOG_RETENTION_DAYS = 7;
const BATCH_DELETE_SIZE = 2000;

// Archives rows older than the retention window to a JSON file (streamed, so
// we never hold more than one batch in memory), then deletes them from `model`
// in the same batches. `dateColumn` is the actual DB column name to filter on.
// `options.onBatch(rows)` runs after archiving but before deleting each batch -
// used by callers that need a side effect per row (e.g. removing a file that
// a row references) before the DB record disappears.
const archiveAndDeleteOldRows = async (model, dateColumn, tableLabel, options = {}) => {
    const { onBatch, retentionDays = LOG_RETENTION_DAYS } = options;
    const thresholdDate = new Date();
    thresholdDate.setDate(thresholdDate.getDate() - retentionDays);

    let totalArchived = 0;
    let archiveStream = null;
    let archiveFilePath = null;
    for (;;) {
        const rows = await model.findAll({
            where: { [dateColumn]: { [Op.lt]: thresholdDate } },
            limit: BATCH_DELETE_SIZE,
            raw: true
        });
        if (rows.length === 0) break;

        if (!archiveStream) {
            const fileName = `${tableLabel}_archive_${new Date().toISOString().split('T')[0]}.json`;
            archiveFilePath = path.join(__dirname, '../../uploads/archives', fileName);
            if (!fs.existsSync(path.dirname(archiveFilePath))) {
                fs.mkdirSync(path.dirname(archiveFilePath), { recursive: true });
            }
            archiveStream = fs.createWriteStream(archiveFilePath);
            archiveStream.write("[\n");
        } else {
            archiveStream.write(",\n");
        }
        archiveStream.write(rows.map((r) => JSON.stringify(r)).join(",\n"));

        if (onBatch) {
            try {
                await onBatch(rows);
            } catch (err) {
                console.error(`[LOG_CLEANUP] onBatch hook failed for ${tableLabel}:`, err.message);
            }
        }

        await model.destroy({ where: { id: rows.map((r) => r.id) } });
        totalArchived += rows.length;

        // Yield between batches so this cleanup doesn't hog the connection pool/DB.
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (archiveStream) {
        archiveStream.write("\n]");
        archiveStream.end();
        console.log(`[LOG_CLEANUP] Archived ${totalArchived} old rows from ${tableLabel} to ${archiveFilePath}.`);
    }
    return totalArchived;
};
exports.archiveAndDeleteOldRows = archiveAndDeleteOldRows;

// Archive Function (Updated for new table names)
exports.archiveAndCleanupLogs = async () => {
    await archiveAndDeleteOldRows(Logs, "createdAt", "logs");
    await archiveAndDeleteOldRows(ApiLog, "created_at", "api_logs");
};