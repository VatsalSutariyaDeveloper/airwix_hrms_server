const { sequelize } = require("../models");
const Op = require("sequelize").Op;
const validateRequest = require("./validateRequest");
const commonQuery = require("./commonQuery");
const adminCommonQuery = require("./adminCommonQuery");
const { uploadFile, uploadBase64File, deleteFile, fileExists } = require("./fileUpload");
const { handleError } = require("./functions/errorFunctions");
const { getExpDateByItem, convertStock } = require("./functions/helperFunction");
const { updateItemCurrentStock } = require("./functions/inventoryFunctions");
const { fixDecimals, fixNum, fixQty, parseDate, formatDateTime, initializeCompanySettings, initializeCompanyRoles, applyRounding: applyRoundingHelper } = require("./functions/commonFunctions");
const { constants, ENTITIES } = require("./constants");
const { getCompanySetting, clearCompanyCache, clearAllCompaniesCache, getCompanySubscription, clearCompanySubscriptionCache, clearAllCompanySubscriptionCache, reloadCompanyCache, reloadRoutePermissions, getRoutePermissionId, updateSubscriptionCache, reloadCompanySubscriptionCache, reloadCompanySettingsCache } = require("./cache");
const { handleImport, handleExport, streamExport } = require("./functions/excelService");
const { logQuery, logError, writeLogToFile, archiveAndCleanupLogs, archiveAndDeleteOldRows } = require("./functions/logFunctions");
const otpService = require("./otpService");
const { Err, fail } = require("./Err");
const { getContext } = require("../utils/requestContext");
const whatsappService = require("./whatsappService");

module.exports = {
  sequelize,
  Op,
  validateRequest,
  commonQuery,
  adminCommonQuery,
  uploadFile,
  uploadBase64File,
  deleteFile,
  fileExists,
  handleError,
  getExpDateByItem,
  fixDecimals,
  fixNum,
  fixQty,
  getContext,
  constants,
  ENTITIES,
  parseDate,
  formatDateTime,
  convertStock,
  handleImport,
  handleExport,
  streamExport,

  logQuery,
  logError,
  writeLogToFile,
  archiveAndCleanupLogs,
  archiveAndDeleteOldRows,
  updateItemCurrentStock,
  initializeCompanySettings,
  initializeCompanyRoles,
  getCompanySetting,
  applyRounding: applyRoundingHelper,
  reloadCompanySettingsCache,
  clearCompanyCache,
  clearAllCompaniesCache,
  getCompanySubscription,
  reloadCompanySubscriptionCache,
  clearCompanySubscriptionCache,
  clearAllCompanySubscriptionCache,
  updateSubscriptionCache,
  reloadCompanyCache,
  reloadRoutePermissions,
  getRoutePermissionId,
  otpService,
  tokenHelper: require("./tokenHelper"),
  whatsappService,
  cryptoHelper: require("./cryptoHelper"),
  deviceHelper: require("./deviceHelper"),
  sessionHelper: require("./sessionHelper"),
  Err,
  fail
};
