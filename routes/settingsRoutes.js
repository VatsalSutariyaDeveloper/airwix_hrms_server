const express = require("express");
const router = express.Router();
const { uploadExcelToDisk, bufferFile, bufferImage } = require("../helpers/fileUpload");

// --- Import Controllers ---
const branchMasterController = require("../controllers/settings/branchMasterController");
const companyMasterController = require("../controllers/settings/company/companyMasterController");
const companyCofigrationController = require("../controllers/settings/company/companyConfigrationController");
const templatesMessageController = require("../controllers/settings/templatesMessageController");
const userController = require("../controllers/settings/user/userController");
const rolePermissionController = require("../controllers/settings/user/rolePermissionController");
const notificationController = require("../controllers/settings/notificationController");
const utilsController = require("../controllers/settings/utilsController");
const importController = require("../controllers/settings/import/importController");
const taxTypeController = require("../controllers/settings/tax/taxTypeController");
const taxesController = require("../controllers/settings/tax/taxesController");
const taxGroupController = require("../controllers/settings/tax/taxGroupController");
const controller = require("../controllers/settings/user/userAccessController");

router.get("/user-access/session-data", controller.sessionData);



// ==========================
// 2. BRANCH MASTER
// ==========================
// Base Path: /branch
router.post("/branch/", branchMasterController.create);
router.post("/branch/get-transactions", branchMasterController.getAll);
router.post("/branch/dropdown-list", branchMasterController.dropdownList);
router.get("/branch/:id", branchMasterController.getById);
router.put("/branch/:id", branchMasterController.update);
router.delete("/branch/", branchMasterController.delete);
router.patch("/branch/status", branchMasterController.updateStatus);


// ==========================
// 3. COMPANY MASTER
// ==========================
// Base Path: /company
router.post("/company/", bufferImage(["logo_image", "admin_signature_img"]), companyMasterController.create);
router.post("/company/get-transactions", companyMasterController.getCompanies);
router.put("/company/:id", bufferImage(["logo_image", "admin_signature_img"]), companyMasterController.update);
router.get("/company/", companyMasterController.getAll);
router.get("/company/:id", companyMasterController.getById);
router.delete("/company/:id", companyMasterController.delete);




// ==========================
// 5. COMPANY CONFIGURATION
// ==========================
// Base Path: /company-configration
router.get("/company-configration/", companyCofigrationController.getAll);
router.get("/company-configration/:id", companyCofigrationController.getById);
router.get("/company-configration/:id/:group", companyCofigrationController.getByGroup);
router.put("/company-configration/:id", companyCofigrationController.update);


















// ==========================
// 14. TEMPLATE MESSAGES
// ==========================
// Base Path: /templates-message
router.post("/templates-message/", templatesMessageController.create);
router.post("/templates-message/get-transactions", templatesMessageController.getAll);
router.post("/templates-message/dropdown-list", templatesMessageController.dropdownList);
router.get("/templates-message/:id", templatesMessageController.getById);
router.put("/templates-message/:id", templatesMessageController.update);
router.delete("/templates-message/", templatesMessageController.delete);
router.patch("/templates-message/status", templatesMessageController.updateStatus);


// ==========================
// 15. NOTIFICATIONS
// ==========================
// Base Path: /notification
router.post("/notification/dropdown-list", notificationController.getAll);
router.put("/notification/read", notificationController.updateReadStatus);


// ==========================
// 16. UTILS
// ==========================
// Base Path: /utils
router.post("/utils/send-email", bufferFile(["attachments"]), utilsController.sendEmail);
router.post("/utils/fetch-gst-details", utilsController.fetchGSTDetails);
router.post("/utils/fetch-ifsc-details", utilsController.fetchIFSCDetails);




// ==========================
// 18. USER ROUTES
// ==========================
// Base Path: /user
router.post("/user/get-transactions", userController.getAll);
router.post("/user/dropdown-list", userController.dropdownList);
router.post("/user/", bufferFile(["profile_image","authorized_signature"]), userController.create);
router.put("/user/:id", bufferFile(["profile_image","authorized_signature"]), userController.update);
router.get("/user/:id", userController.getById);
router.delete("/user/", userController.delete);
router.patch("/user/status", userController.updateStatus);
// Password management
router.post("/user/setup-password", userController.setPassword);
router.post("/user/forgot-password", userController.forgotPassword);
router.get("/user/verify-token/:token", userController.verifySetupToken);


// ==========================
// 19. ROLE PERMISSION ROUTES
// ==========================
// Base Path: /role-permission
router.post("/role-permission/get-permissions", rolePermissionController.getPermissions);
router.post("/role-permission/dropdown-list", rolePermissionController.dropdownList);
router.post("/role-permission/get-transactions", rolePermissionController.getAll);
router.post("/role-permission/", rolePermissionController.create);
router.get("/role-permission/:id", rolePermissionController.getById);
router.put("/role-permission/:id", rolePermissionController.update);
router.delete("/role-permission/", rolePermissionController.delete);
router.patch("/role-permission/status", rolePermissionController.updateStatus);






// ==========================
// 22. CHARGES & TAXES
// ==========================


// Tax Type (Base Path: /tax-type)
router.post("/tax-type/", taxTypeController.create);
router.post("/tax-type/get-transactions", taxTypeController.getAll);
router.post("/tax-type/dropdown-list", taxTypeController.dropdownList);
router.get("/tax-type/:id", taxTypeController.getById);
router.put("/tax-type/:id", taxTypeController.update);
router.delete("/tax-type/", taxTypeController.delete);
router.patch("/tax-type/status", taxTypeController.updateStatus);

// Taxes (Base Path: /taxes)
router.post("/taxes/", taxesController.create);
router.post("/taxes/dropdown-list", taxesController.dropdownList);
router.post("/taxes/get-transactions", taxesController.getAll);
router.get("/taxes/:id", taxesController.getById);
router.put("/taxes/:id", taxesController.update);
router.delete("/taxes/", taxesController.delete);
router.patch("/taxes/status", taxesController.updateStatus);

// Tax Group (Base Path: /tax-group)
router.post("/tax-group/", taxGroupController.create);
router.post("/tax-group/dropdown-list", taxGroupController.dropdownList);
router.post("/tax-group/get-transactions", taxGroupController.getAll);
router.get("/tax-group/:id", taxGroupController.getById);
router.put("/tax-group/:id", taxGroupController.update);
router.delete("/tax-group/", taxGroupController.delete);
router.patch("/tax-group/status", taxGroupController.updateStatus);
router.post("/tax-group/rates/dropdown-list", taxGroupController.getGroupRates);


// ==========================
// 23. IMPORT ROUTES
// ==========================
router.get("/download-errors", importController.downloadErrorFile);
router.post("/import-data", uploadExcelToDisk("file"), importController.importData);

module.exports = router;