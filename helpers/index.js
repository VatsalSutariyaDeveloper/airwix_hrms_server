const { sequelize } = require("../models");
const Op = require("sequelize").Op;
const validateRequest = require("./validateRequest");
const commonQuery = require("./commonQuery");
const { uploadFile, uploadBase64File, deleteFile, fileExists } = require("./fileUpload");
const { handleError } = require("./functions/errorFunctions");
const { getExpDateByItem, convertStock } = require("./functions/helperFunction");
const { updateItemCurrentStock } = require("./functions/inventoryFunctions");
const { fixDecimals, fixNum, fixQty, parseDate, formatDateTime, initializeCompanySettings, initializeCompanyRoles } = require("./functions/commonFunctions");
const { constants, ENTITIES } = require("./constants");
const { getCompanySetting,clearCompanyCache, getCompanySubscription, clearCompanySubscriptionCache, clearAllCompanySubscriptionCache, reloadCompanyCache, reloadRoutePermissions, getRoutePermissionId, updateSubscriptionCache, reloadCompanySubscriptionCache, reloadCompanySettingsCache } = require("./cache");
const { handleImport, handleExport, streamExport } = require("./functions/excelService");
const { logActivity, logQuery, logError, writeLogToFile, archiveAndCleanupLogs } = require("./functions/logFunctions");
const  otpService = require("./otpService");
const { Err, fail } = require("./Err");
const { getContext } = require("../utils/requestContext");

  module.exports = {
    sequelize,
    Op,
    validateRequest,
    commonQuery,
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
    logActivity,
    logQuery,
    logError,
    writeLogToFile,
    archiveAndCleanupLogs,
    updateItemCurrentStock,
    initializeCompanySettings,
    initializeCompanyRoles,
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
    otpService,
    tokenHelper: require("./tokenHelper"),
    whatsappService: require("./whatsappService"),
    Err,
    fail
};
