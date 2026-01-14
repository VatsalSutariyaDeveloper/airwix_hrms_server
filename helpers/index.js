const sequelize = require("../config/database");
const Op = require("sequelize").Op;
const validateRequest = require("./validateRequest");
const commonQuery = require("./commonQuery");
const { uploadFile, deleteFile, fileExists } = require("./fileUpload");
const { handleError } = require("./functions/errorFunctions");
const { getExpDateByItem, convertStock } = require("./functions/helperFunction");
const { updateItemCurrentStock } = require("./functions/inventoryFunctions");
const { fixDecimals, fixNum, fixQty, parseDate, initializeCompanySettings } = require("./functions/commonFunctions");
const { constants, ENTITIES } = require("./constants");
const { getCompanySetting,clearCompanyCache, getCompanySubscription, clearCompanySubscriptionCache, clearAllCompanySubscriptionCache, reloadCompanyCache, reloadRoutePermissions, getRoutePermissionId, updateSubscriptionCache, reloadCompanySubscriptionCache, reloadCompanySettingsCache } = require("./cache");
const { handleImport, handleExport, streamExport } = require("./functions/excelService");
const { logActivity, logQuery, archiveAndCleanupLogs } = require("./functions/logFunctions");
const  otpService = require("./otpService");

  module.exports = {
    sequelize,
    Op,
    validateRequest,
    commonQuery,
    uploadFile,
    deleteFile,
    fileExists,
    handleError,
    getExpDateByItem,
    fixDecimals,
    fixNum,
    fixQty,
    constants,
    ENTITIES,
    parseDate,
    convertStock,
    handleImport,
    handleExport,
    streamExport,
    logActivity,
    logQuery, 
    archiveAndCleanupLogs,
    updateItemCurrentStock,
    initializeCompanySettings,
    getCompanySetting,
    reloadCompanySettingsCache,
    clearCompanyCache,
    getCompanySubscription,
    reloadCompanySubscriptionCache,
    clearCompanySubscriptionCache,
    clearAllCompanySubscriptionCache,
    updateSubscriptionCache,
    reloadCompanyCache,
    reloadRoutePermissions,
    getRoutePermissionId,
    otpService
};
