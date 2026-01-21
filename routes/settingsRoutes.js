const express = require("express");
const router = express.Router();
const { uploadExcelToDisk, bufferFile, bufferImage } = require("../helpers/fileUpload");

// --- Import Controllers ---
const branchMasterController = require("../controllers/settings/branchMasterController");
const companyMasterController = require("../controllers/settings/company/companyMasterController");
const companyCofigrationController = require("../controllers/settings/company/companyConfigrationController");
const userController = require("../controllers/settings/user/userController");
const rolePermissionController = require("../controllers/settings/user/rolePermissionController");
const importController = require("../controllers/settings/import/importController");
const utilsController = require("../controllers/settings/utilsController");
const userAccessController = require("../controllers/settings/user/userAccessController");
const shiftController = require("../controllers/settings/shiftController.js");
const deviceMasterController = require("../controllers/settings/deviceMasterController");
const holidayTemplateController = require("../controllers/settings/holidayTemplateController");
const weeklyOffTemplateController = require("../controllers/settings/weeklyOffTemplateController");
const attendanceTemplateController = require("../controllers/settings/attendanceTemplateController");
const leaveTemplateController = require("../controllers/settings/leave/leaveTemplateController");
const leaveRequestController = require("../controllers/settings/leave/leaveRequestController");

//Session Data
router.get("/user-access/session-data", userAccessController.sessionData);



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
// 23. IMPORT ROUTES
// ==========================
router.get("/download-errors", importController.downloadErrorFile);
router.post("/import-data", uploadExcelToDisk("file"), importController.importData);

// ==========================
// 24. SHIFT ROUTES
// ==========================
router.post("/shift", shiftController.create);
router.post("/shift/get-transactions", shiftController.getAll);
router.get("/shift/:id", shiftController.getById);
router.put("/shift/:id", shiftController.update);
router.delete("/shift/", shiftController.delete);
router.patch("/shift/status", shiftController.updateStatus);
router.post("/shift/dropdown-list", shiftController.dropdownList);


// ==========================
// 25. DEVICE MASTER ROUTES
// ==========================
router.get("/device-master/:id", deviceMasterController.getById);
router.post("/device-master/get-transactions", deviceMasterController.getAll);
router.post("/device-master", deviceMasterController.create);
router.put("/device-master/:id", deviceMasterController.update);
router.delete("/device-master", deviceMasterController.delete);
router.patch("/device-master/status", deviceMasterController.updateStatus);
router.post("/device-master/dropdown-list", deviceMasterController.dropdownList);

// ==========================
// 26. HOLIDAY TEMPLATE ROUTES
// ==========================
router.post("/holiday-template/", holidayTemplateController.create);
router.put("/holiday-template/:id", holidayTemplateController.update);
router.post("/holiday-template/get-transactions", holidayTemplateController.getAll);
router.post("/holiday-template/dropdown-list", holidayTemplateController.dropdownList);
router.get("/holiday-template/:id", holidayTemplateController.getById);
router.delete("/holiday-template/", holidayTemplateController.delete);
router.patch("/holiday-template/status", holidayTemplateController.updateStatus);

// ==========================
// 27. WEEKLY OFF ROUTES
// ==========================
router.get("/weekly-off-template/:id", weeklyOffTemplateController.getById);
router.post("/weekly-off-template/get-transactions", weeklyOffTemplateController.getAll);
router.post("/weekly-off-template", weeklyOffTemplateController.create);
router.put("/weekly-off-template/:id", weeklyOffTemplateController.update);
router.delete("/weekly-off-template", weeklyOffTemplateController.delete);
router.patch("/weekly-off-template/status", weeklyOffTemplateController.updateStatus);
router.post("/weekly-off-template/dropdown-list", weeklyOffTemplateController.dropdownList);

// ===============================
// 28. ATTENDANCE TEMPLATE ROUTES
// ===============================
router.get("/attendance-template/:id", attendanceTemplateController.getById);
router.post("/attendance-template/get-transactions", attendanceTemplateController.getAll);
router.post("/attendance-template", attendanceTemplateController.create);
router.put("/attendance-template/:id", attendanceTemplateController.update);
router.delete("/attendance-template", attendanceTemplateController.delete);
router.patch("/attendance-template/status", attendanceTemplateController.updateStatus);
router.post("/attendance-template/dropdown-list", attendanceTemplateController.dropdownList);


// ==========================
// 27. LEAVE TEMPLATE ROUTES
// ==========================
router.post("/leave-template", leaveTemplateController.create);
router.post("/leave-template/get-transactions", leaveTemplateController.getAll);
router.get("/leave-template/:id", leaveTemplateController.getById);
router.put("/leave-template/:id", leaveTemplateController.update);
router.delete("/leave-template", leaveTemplateController.delete);
router.patch("/leave-template/status", leaveTemplateController.updateStatus);
router.get("/leave-template/assigned-leaves/:employeeId", leaveTemplateController.getAssignedLeavesByEmployee);

// ==========================
// 28. LEAVE REQUEST & BALANCE ROUTES
// ==========================
router.post("/leave-request", leaveRequestController.create);
router.post("/leave-request/get-transactions", leaveRequestController.getAll);
router.get("/leave-request/:id", leaveRequestController.getById);
router.put("/leave-request/status/:id", leaveRequestController.updateStatus);
router.get("/leave-balance/:employeeId", leaveRequestController.getEmployeeBalance);

module.exports = router;