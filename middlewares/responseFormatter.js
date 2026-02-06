const responseCodes = require("../helpers/responseCodes");
const { logActivity } = require("../helpers"); 

// Mapping common success actions to the logActivity ENUM format
const logActionTypeMap = {
    "CREATE": "CREATE",
    "UPDATE": "UPDATE",
    "DELETE": "DELETE",
    "SOFT_DELETE": "DELETE", 
    "UPDATED": "UPDATE",
    "UPSERT": "UPDATE",
    "APPROVED": "STATUS_CHANGE",
    "APPROVAL_LOGGED": "STATUS_CHANGE",
    "STOCK_GENERAL_CREATED": "CREATE",
    "STOCK_GENERAL_UPDATED": "UPDATE",
    "STOCK_GENERAL_DELETED": "DELETE",
    "STOCK_APPROVAL_UPDATED": "STATUS_CHANGE",
    "LOGIN_SUCCESS": "CREATE",
    "LOGOUT_SUCCESS": "UPDATE",
    "PASSWORD_SET_SUCCESS": "UPDATE",
    "ADDON_PURCHASED": "CREATE",
    "PLAN_CREATED": "CREATE",
    "PLAN_UPDATED": "UPDATE",
    "SUB_ASSIGNED": "CREATE",
    "RENEWED": "UPDATE",
    "PLAN_DELETED": "DELETE",
    "CANCELLED": "STATUS_CHANGE",
    
    // 'FETCH' is intentionally omitted here to prevent log creation
};

// Helper to reliably find the primary ID (id) from the response data object
function getRecordId(data) {
    if (data && typeof data === 'object') {
        if (data.id) {
            return data.id;
        }
        // For scenarios where the data is an array but we log the operation
        if (Array.isArray(data) && data.length > 0 && data[0].id) {
            return data[0].id;
        }
    }
    return null;
}

/**
 * =====================================================
 * RESPONSE FORMATTER (SIMPLE & EXPLICIT)
 * =====================================================
*/

const ERROR_HTTP_MAP = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  SERVER_ERROR: 500
};

module.exports = (req, res, next) => {

  const isApp = () => {
    const accessBy = req.user?.access_by || req.body?.access_by || req.query?.access_by;
    return accessBy === "application";
  };

  /**
   * Helper to format response codes into human-readable messages
   * E.g. "USER_CREATED" -> "User Created"
   */
  const formatMessage = (code, defaultMsg = "Action successful") => {
    if (!code) return defaultMsg;
    
    // 1. If code is a key in responseCodes, use its message
    if (responseCodes[code] && typeof responseCodes[code] !== 'function' && responseCodes[code].message) {
      return responseCodes[code].message;
    }

    // 2. If it's a string, format it (Replace _ with Space and Title Case)
    if (typeof code === 'string') {
      // Check if it's actually a message (contains spaces or lowercase letters)
      if (code.includes(' ') || (/[a-z]/.test(code) && code.includes('_') === false)) {
        return code;
      }
      
      return code
        .split('_')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
    }

    return defaultMsg;
  };

  /**
   * OK RESPONSE (FETCH / READ)
   * Usage: res.ok(data) OR res.ok(data, "users")
   */
  res.ok = (data, rootKey = null) => {
    if (isApp()) {
      let finalData = data;
      if (rootKey && data) {
        finalData = { [rootKey]: data };
      }

      return res.json({
        success: true,
        message: formatMessage(null, "Data fetched successfully"),
        data: finalData
      });
    }
    return res.json({
      success: true,
      data
    });
  };

  /**
   * SUCCESS RESPONSE (CREATE / UPDATE / DELETE)
   * Usage:
   * res.success(code)
   * res.success(code, data)
   * res.success(code, data, "user")
   */
  res.success = (code, data, rootKey = null) => {
    if (isApp()) {
      let finalData = data || null;
      if (rootKey && data) {
        finalData = { [rootKey]: data };
      }

      return res.json({
        success: true,
        message: formatMessage(code),
        data: finalData
      });
    }

    const response = {
      success: true,
      code
    };

    if (data !== undefined) {
      response.data = data;
    }

    return res.json(response);
  };

  /**
   * ERROR
   * Usage:
   * res.error(code)
   * res.error(code, errors)
   */
  res.error = (code, errors = null) => {
    const status = ERROR_HTTP_MAP[code] || 500;
    if (isApp()) {
      // If errors is a string, it's the message. Otherwise try to format the code.
      let message = typeof errors === 'string' ? errors : (errors?.message || formatMessage(code, "An error occurred"));
      
      return res.status(status).json({
        success: false,
        message: message,
        data: errors
      });
    }
    return res.status(status).json({ success: false, code, errors });
  };

  res.dataError = (code, data = null) => {
    const status = ERROR_HTTP_MAP[code] || 400;
    if (isApp()) {
      return res.status(status).json({
        success: false,
        message: formatMessage(code, "Validation failed"),
        data: data
      });
    }
    return res.status(status).json({
      success: false,
      code,
      errors: null,
      data
    });
  };

  next();
};