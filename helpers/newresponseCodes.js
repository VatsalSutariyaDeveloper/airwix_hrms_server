/**
 * =====================================================
 * RESPONSE CODES
 * -----------------------------------------------------
 * Rules:
 * - NO human readable messages
 * - NO HTTP status codes
 * - ONLY stable machine-readable codes
 * - Used by backend, translated by frontend
 * =====================================================
 */

module.exports = {

  /* =======================
   * COMMON / GENERIC
   * ======================= */
  SUCCESS: "SUCCESS",
  CREATED: "CREATED",
  UPDATED: "UPDATED",
  DELETED: "DELETED",
  FETCHED: "FETCHED",

  /* =======================
   * VALIDATION & INPUT
   * ======================= */
  VALIDATION_ERROR: "VALIDATION_ERROR",
  REQUIRED_FIELD_MISSING: "REQUIRED_FIELD_MISSING",
  INVALID_INPUT: "INVALID_INPUT",
  INVALID_ID: "INVALID_ID",
  INVALID_STATUS: "INVALID_STATUS",

  /* =======================
   * AUTH & PERMISSION
   * ======================= */
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  SESSION_EXPIRED: "SESSION_EXPIRED",
  PERMISSION_DENIED: "PERMISSION_DENIED",

  /* =======================
   * RESOURCE / DATA
   * ======================= */
  NOT_FOUND: "NOT_FOUND",
  ALREADY_EXISTS: "ALREADY_EXISTS",
  ALREADY_DELETED: "ALREADY_DELETED",
  DUPLICATE_ENTRY: "DUPLICATE_ENTRY",
  FOREIGN_KEY_CONSTRAINT: "FOREIGN_KEY_CONSTRAINT",

  /* =======================
   * DATABASE / SERVER
   * ======================= */
  DATABASE_ERROR: "DATABASE_ERROR",
  TRANSACTION_FAILED: "TRANSACTION_FAILED",
  SERVER_ERROR: "SERVER_ERROR",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",

  /* =======================
   * FILE / UPLOAD
   * ======================= */
  FILE_REQUIRED: "FILE_REQUIRED",
  FILE_TYPE_NOT_ALLOWED: "FILE_TYPE_NOT_ALLOWED",
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  FILE_UPLOAD_FAILED: "FILE_UPLOAD_FAILED",

  /* =======================
   * EMAIL
   * ======================= */
  EMAIL_SEND_FAILED: "EMAIL_SEND_FAILED",
  EMAIL_AUTH_FAILED: "EMAIL_AUTH_FAILED",
  EMAIL_CONNECTION_FAILED: "EMAIL_CONNECTION_FAILED",
  EMAIL_TIMEOUT: "EMAIL_TIMEOUT",

  /* =======================
   * BUSINESS RULES
   * ======================= */
  INSUFFICIENT_STOCK: "INSUFFICIENT_STOCK",
  NEGATIVE_STOCK_NOT_ALLOWED: "NEGATIVE_STOCK_NOT_ALLOWED",
  STOCK_NOT_AVAILABLE: "STOCK_NOT_AVAILABLE",
  SERIES_NOT_FOUND: "SERIES_NOT_FOUND",
  SERIES_EXHAUSTED: "SERIES_EXHAUSTED",

  /* =======================
   * STOCK ENTITY
   * ======================= */
  STOCK_ADJUSTMENT_CREATED: "STOCK_ADJUSTMENT_CREATED",
  STOCK_ADJUSTMENT_UPDATED: "STOCK_ADJUSTMENT_UPDATED",
  STOCK_ADJUSTMENT_DELETED: "STOCK_ADJUSTMENT_DELETED",
  STOCK_FETCHED: "STOCK_FETCHED",
  STOCK_APPROVAL_UPDATED: "STOCK_APPROVAL_UPDATED",

  /* =======================
   * SALES
   * ======================= */
  INVOICE_CREATED: "INVOICE_CREATED",
  INVOICE_UPDATED: "INVOICE_UPDATED",
  INVOICE_DELETED: "INVOICE_DELETED",
  INVOICE_ALREADY_EXISTS: "INVOICE_ALREADY_EXISTS",

  /* =======================
   * PURCHASE
   * ======================= */
  PURCHASE_ORDER_CREATED: "PURCHASE_ORDER_CREATED",
  PURCHASE_ORDER_UPDATED: "PURCHASE_ORDER_UPDATED",
  PURCHASE_ORDER_DELETED: "PURCHASE_ORDER_DELETED",

  /* =======================
   * USER / COMPANY LIMITS
   * ======================= */
  USER_LIMIT_REACHED: "USER_LIMIT_REACHED",
  COMPANY_LIMIT_REACHED: "COMPANY_LIMIT_REACHED",

};
