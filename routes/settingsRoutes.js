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
const importEmployeeController = require('../controllers/settings/import/importEmployeeController.js');
const utilsController = require("../controllers/settings/utilsController");
const userAccessController = require("../controllers/settings/user/userAccessController");
const shiftTemplateController = require("../controllers/settings/shiftTemplateController");
const deviceMasterController = require("../controllers/settings/deviceMasterController");
const holidayTemplateController = require("../controllers/settings/holidayTemplateController");
const weeklyOffTemplateController = require("../controllers/settings/weeklyOffTemplateController");
const attendanceTemplateController = require("../controllers/settings/attendanceTemplateController");
const leaveTemplateController = require("../controllers/settings/leave/leaveTemplateController");
const leaveRequestController = require("../controllers/settings/leave/leaveRequestController");
const salaryTemplateController = require("../controllers/settings/salary/salaryTemplateController");
const salaryComponentController = require("../controllers/settings/salary/salaryComponentController");
const departmentController = require("../controllers/settings/departmentController");
const employeeLeaveBalanceController = require("../controllers/employee/employeeLeaveBalanceController");
const designationMasterController = require("../controllers/settings/designationMasterController");
const incentiveTypeController = require("../controllers/settings/incentiveTypeController.js");
const employeeSettingsController = require("../controllers/settings/employeeSettingsController");

//Session Data
router.get("/user-access/session-data", userAccessController.sessionData);
router.get("/switch-company", userAccessController.switchCompany);
router.get("/switch-branch", userAccessController.switchBranch);


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
router.post("/utils/fetch-pincode-details", utilsController.fetchPincodeDetails);



// ==========================
// 18. USER ROUTES
// ==========================
// Base Path: /user
router.post("/user/get-transactions", userController.getAll);
router.post("/user/dropdown-list", userController.dropdownList);
router.post("/user/", bufferFile(["profile_image", "authorized_signature"]), userController.create);
router.put("/user/:id", bufferFile(["profile_image", "authorized_signature"]), userController.update);
router.get("/user/:id", userController.getById);
router.delete("/user/", userController.delete);
router.patch("/user/status", userController.updateStatus);
// Password management (Moved to public auth routes)


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
router.post("/shift", shiftTemplateController.create);
router.post("/shift/get-transactions", shiftTemplateController.getAll);
router.get("/shift/:id", shiftTemplateController.getById);
router.put("/shift/:id", shiftTemplateController.update);
router.delete("/shift/", shiftTemplateController.delete);
router.patch("/shift/status", shiftTemplateController.updateStatus);
router.post("/shift/dropdown-list", shiftTemplateController.dropdownList);


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
// 29. LEAVE TEMPLATE ROUTES
// ==========================
router.post("/leave-template", leaveTemplateController.create);
router.post("/leave-template/get-transactions", leaveTemplateController.getAll);
router.get("/leave-template/:id", leaveTemplateController.getById);
router.put("/leave-template/:id", leaveTemplateController.update);
router.delete("/leave-template", leaveTemplateController.delete);
router.patch("/leave-template/status", leaveTemplateController.updateStatus);
router.post("/leave-template/dropdown-list", leaveTemplateController.dropdownList);
router.get("/leave-template/assigned-leaves/:employeeId", leaveTemplateController.getAssignedLeavesByEmployee);

// ==========================
// 30. LEAVE REQUEST & BALANCE ROUTES
// ==========================
router.post("/leave-request", leaveRequestController.create);
router.post("/leave-request/get-transactions", leaveRequestController.getAll);
router.post("/leave-request/pending-approvals", leaveRequestController.getPendingApprovals);
router.get("/leave-request/:id", leaveRequestController.getById);
router.put("/leave-request/status/:id", leaveRequestController.updateStatus);
router.get("/leave-balance/:employeeId", employeeLeaveBalanceController.getByEmployeeId);

// ==========================
// 31. Salary Template ROUTES
// ==========================
router.post("/salary-template/", salaryTemplateController.create);
router.post("/salary-template/get-transactions", salaryTemplateController.getAll);
router.post("/salary-template/dropdown-list", salaryTemplateController.dropdownList);
router.get("/salary-template/:id", salaryTemplateController.getById);
router.put("/salary-template/:id", salaryTemplateController.update);
router.delete("/salary-template/", salaryTemplateController.delete);
router.patch("/salary-template/status", salaryTemplateController.updateStatus);

// ==========================
// 32. Salary Component ROUTES
// ==========================
router.post("/salary-component/", salaryComponentController.create);
router.post("/salary-component/get-transactions", salaryComponentController.getAll);
router.post("/salary-component/dropdown-list", salaryComponentController.dropdownList);
router.get("/salary-component/:id", salaryComponentController.getById);
router.put("/salary-component/:id", salaryComponentController.update);
router.delete("/salary-component/", salaryComponentController.delete);
router.patch("/salary-component/status", salaryComponentController.updateStatus);

// ==========================
// 33. DEPARTMENT ROUTES
// ==========================
router.post("/department/", departmentController.create);
router.post("/department/get-transactions", departmentController.getAll);
router.post("/department/dropdown-list", departmentController.dropdownList);
router.get("/department/:id", departmentController.getById);
router.put("/department/:id", departmentController.update);
router.delete("/department/", departmentController.delete);
router.patch("/department/status", departmentController.updateStatus);

// ==========================
// 34. DESIGNATION MASTER
// ==========================
// Base Path: /designation
router.post("/designation/", designationMasterController.create);
router.post("/designation/get-transactions", designationMasterController.getAll);
router.post("/designation/dropdown-list", designationMasterController.dropdownList);
router.get("/designation/:id", designationMasterController.getById);
router.put("/designation/:id", designationMasterController.update);
router.delete("/designation/", designationMasterController.delete);
router.patch("/designation/status", designationMasterController.updateStatus);

// ==========================
// 35. IMPORT EMPLOYEE ROUTES
// ==========================
// Base Path: /employee
router.get("/employee/download-errors", importEmployeeController.downloadErrorFile);
router.post("/employee/import-data", uploadExcelToDisk("file"), importEmployeeController.importData);
// router.get("/download-errors", importEmployeeController.downloadErrorFile);
// router.post("/import-data", uploadExcelToDisk("file"), importEmployeeController.importData);

// ==========================
// INCENTIVE_TYPE
// ==========================
// Base Path: /incentive-type
router.post("/incentive-type", incentiveTypeController.create);
router.post("/incentive-type/get-transactions", incentiveTypeController.getAll);
router.post("/incentive-type/dropdown-list", incentiveTypeController.dropdownList);
router.get("/incentive-type/:id", incentiveTypeController.getById);
router.put("/incentive-type/:id", incentiveTypeController.update);
router.delete("/incentive-type", incentiveTypeController.delete);
router.patch("/incentive-type/status", incentiveTypeController.updateStatus);


router.post("/employee-settings/", employeeSettingsController.create);
router.post("/employee-settings/get-transactions", employeeSettingsController.getAll);
router.put("/employee-settings/", employeeSettingsController.update);


module.exports = router;