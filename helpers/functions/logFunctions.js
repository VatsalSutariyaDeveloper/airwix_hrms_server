const { ActivityLog, Logs, sequelize } = require("../../models"); 
const { generateLogMessage } = require("./logMessageGenerator"); // Assuming you have this
const fs = require('fs');
const path = require('path');
const { Op } = require("sequelize");

const IGNORED_FIELDS = ["createdAt", "updatedAt", "deletedAt", "password", "token", "otp"];
const TEXT_LIMIT = 1000000;
const JSON_LIMIT = 1000000;

// --- Helpers ---
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

// 1. Log User Activity (Simple Table)
exports.logActivity = async (logData, transaction = null) => {
  try {
    const message = logData.log_message || `${logData.action_type} on ${logData.entity_name}`;
    
    await ActivityLog.create({
      entity_name: logData.entity_name,
      action_type: logData.action_type,
      user_id: (logData.user_id && Number(logData.user_id) !== 0) ? logData.user_id : null,
      company_id: logData.company_id,
      branch_id: logData.branch_id,
      record_id: logData.record_id,
      log_message: truncateText(message, TEXT_LIMIT), 
      ip_address: logData.ip_address,
    }, { transaction });
  } catch (err) {
    console.error(`[CRITICAL] Failed to log activity: ${err.message}`);
    throw err;
  }
};

// 2. Log Data Changes (CRUD) -> Goes to 'Logs' Table
exports.logQuery = async (logData, mainTransaction = null) => {
  // ----------------------------------------------------------------
  // STEP 1: PREPARE & SANITIZE DATA
  // ----------------------------------------------------------------
  let message, finalOld, finalNew;
  
  try {
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
    const logPayload = {
        entity_name: logData.entity_name,
        action_type: logData.action_type,
        user_id: (logData.user_id && Number(logData.user_id) !== 0) ? logData.user_id : null,
        company_id: logData.company_id,
        branch_id: logData.branch_id,
        record_id: logData.record_id,
        log_message: truncateText(message, TEXT_LIMIT),
        old_data: safeJson(finalOld),
        new_data: safeJson(finalNew),
        sql_query: logData.sql_query, 
        stack_trace: null,
        ip_address: logData.ip_address,
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
  try {
    // Write to the centralized Logs table
    await Logs.create({
      entity_name: logData.entity_name,
      action_type: "ERROR",
      user_id: logData.user_id,
      company_id: logData.company_id,
      branch_id: logData.branch_id,
      record_id: null,
      log_message: truncateText(logData.error_message, TEXT_LIMIT),
      old_data: null,
      // Store the request body in 'new_data' column for consistency
      new_data: safeJson(logData.request_body), 
      // Store the technical stack
      stack_trace: safeJson(logData.stack_trace),
      ip_address: logData.ip_address,
      is_resolved: 0
    }, { transaction });

  } catch (err) {
    console.error(`[CRITICAL] Failed to log error: ${err.message}`);
    throw err;
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

// Archive Function (Updated for new table names)
exports.archiveAndCleanupLogs = async (daysToKeep = 90) => {
    const thresholdDate = new Date();
    thresholdDate.setDate(thresholdDate.getDate() - daysToKeep);
    
    // Archive Logs Table
    const oldLogs = await Logs.findAll({
        where: { createdAt: { [Op.lt]: thresholdDate } },
        raw: true
    });

    if (oldLogs.length > 0) {
        const fileName = `logs_archive_${new Date().toISOString().split('T')[0]}.json`;
        const filePath = path.join(__dirname, '../../uploads/archives', fileName);
        fs.writeFileSync(filePath, JSON.stringify(oldLogs));
        
        const idsToDelete = oldLogs.map(log => log.id);
        await Logs.destroy({ where: { id: idsToDelete } });
    }
};