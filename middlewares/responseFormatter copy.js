const responseCodes = require("../helpers/responseCodes");
const { logActivity } = require("../helpers"); // <-- Import logActivity helper

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

  /**
   * OK RESPONSE (FETCH / READ)
   * Usage: res.ok(data)
  */
  res.ok = (data) => {
    return res.json({
      success: true,
      data
    });
  };

  /**
   * SUCCESS RESPONSE (CREATE / UPDATE / DELETE)
   * Usage:
   *  res.success(code)
   *  res.success(code, data)
  */
  res.success = (code, data) => {
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
   *  res.error(code)
   *  res.error(code, errors)
  */
  res.error = (code, errors = null) => {
    const status = ERROR_HTTP_MAP[code] || 500;
    return res.status(status).json({ success:false, code, errors });
  };

  next();
};

