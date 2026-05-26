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
const incentiveTypeController = require("../controllers/settings/incentiveTypeController");
const employeeSettingsController = require("../controllers/settings/employeeSettingsController");
const companySettingsController = require("../controllers/settings/companySettingsController");
const customFieldController = require("../controllers/settings/customFieldController");
const outDutyRequestController = require("../controllers/settings/outDutyRequestController");
const attendanceRegularizationController = require("../controllers/attendance/attendanceRegularizationController");
const systemLogController = require("../controllers/systemLogController");
const expenseTypeController = require("../controllers/settings/expenseTypeController");
const employeeAttendanceController = require("../controllers/employee/employeeAttendanceController");
const employeeSalaryTemplateController = require("../controllers/employee/employeeSalaryTemplateController");
const employeeController = require("../controllers/employee/employeeController");

//Session Data
router.get("/user-access/session-data", userAccessController.sessionData);
router.get("/switch-company", userAccessController.switchCompany);
router.get("/switch-branch", userAccessController.switchBranch);
router.get("/device-data", userAccessController.getCompanySettingsData);


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

// --- UNIVERSAL ERROR LOGGING TEST ROUTES ---
// 1. Test Handled Express Error
router.get("/test/error-express", (req, res, next) => {
    next(new Error("🧪 TEST ERROR: This is a handled Express error."));
});

// 2. Test Unhandled Promise Rejection
router.get("/test/error-rejection", (req, res) => {
    Promise.reject(new Error("🧪 TEST REJECTION: This is an unhandled promise rejection."));
    res.json({ success: true, message: "Unhandled rejection triggered. Check logs." });
});

// 3. Test Uncaught Exception (WARNING: Restarts server)
router.get("/test/error-exception", (req, res) => {
    res.json({ success: true, message: "Uncaught exception triggered. Server will restart. Check logs." });
    setImmediate(() => {
        throw new Error("🧪 TEST EXCEPTION: This is an uncaught exception.");
    });
});
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
router.post("/user/role-assign", userController.assignRole);
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
router.get("/import-logs", importEmployeeController.getImportLogs);
router.delete("/import-logs/:id", importEmployeeController.deleteImportLog);

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
router.put("/device-master/unpair/:id", deviceMasterController.unpairDevice);
router.put("/device-master/pair/:id", deviceMasterController.pairDevice);
router.get("/device-master/get/my", deviceMasterController.getMyDevices);

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
// 30. EMPLOYEE ATTENDANCE TEMPLATE ROUTES
// ==========================
router.get("/employee-attendance-template/:employeeId", employeeAttendanceController.getAttendanceTemplate);
router.get("/employee-shift-template/:employeeId", employeeAttendanceController.getShiftSetting);
router.get("/employee-salary-template/:employeeId", employeeSalaryTemplateController.getTemplate);
router.get("/employee-holidays/:employeeId", employeeController.getEmployeeHolidays);
router.get("/employee-leave-template/:employeeId", leaveTemplateController.getEmployeeLeaveTemplate);
router.get("/leave/download-sample", importEmployeeController.downloadLeaveSample);
router.post("/leave/import-data", uploadExcelToDisk("file"), importEmployeeController.importData);
router.post("/attendance/import-data", uploadExcelToDisk("file"), importEmployeeController.importData);
router.post("/payroll/import-data", uploadExcelToDisk("file"), importEmployeeController.importData);

// ==========================
// 30. LEAVE REQUEST & BALANCE ROUTES
// ==========================
router.post("/leave-request", bufferFile(["document"]), leaveRequestController.create);
router.put("/leave-request/:id", bufferFile(["document"]), leaveRequestController.update);
router.post("/leave-request/get-transactions", leaveRequestController.getAll);
router.post("/leave-request/pending-approvals", leaveRequestController.getPendingApprovals);
router.get("/leave-request/:id", leaveRequestController.getById);
router.put("/leave-request/status/:id", leaveRequestController.updateStatus);
router.put("/leave-request/cancel/:id", leaveRequestController.cancelLeave);
router.post("/leave-request/calculate-days", leaveRequestController.calculateLeaveDays);
router.post("/leave-balance", employeeLeaveBalanceController.getByEmployeeId);
router.delete("/leave-request", leaveRequestController.delete);

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
// router.get("/download-errors", importEmployeeController.downloadErrorFile);
router.post("/employee/import-data", uploadExcelToDisk("file"), importEmployeeController.importData);

// ==========================
// 36. INCENTIVE_TYPE
// ==========================
// Base Path: /incentive-type
router.post("/incentive-type", incentiveTypeController.create);
router.post("/incentive-type/get-transactions", incentiveTypeController.getAll);
router.post("/incentive-type/dropdown-list", incentiveTypeController.dropdownList);
router.get("/incentive-type/:id", incentiveTypeController.getById);
router.put("/incentive-type/:id", incentiveTypeController.update);
router.delete("/incentive-type", incentiveTypeController.delete);
router.patch("/incentive-type/status", incentiveTypeController.updateStatus);

// ==========================
// 36.1. EXPENSE TYPE MASTER
// ==========================
// Base Path: /expense-type
router.post("/expense-type", expenseTypeController.create);
router.post("/expense-type/get-transactions", expenseTypeController.getAll);
router.post("/expense-type/dropdown-list", expenseTypeController.dropdownList);
router.get("/expense-type/:id", expenseTypeController.getById);
router.put("/expense-type/:id", expenseTypeController.update);
router.delete("/expense-type", expenseTypeController.delete);
router.patch("/expense-type/status", expenseTypeController.updateStatus);


// ==========================
// 37. CUSTOM FIELD ROUTES
// ==========================
// Base Path: /custom-field
router.post("/custom-fields/", bufferImage(), customFieldController.create);
router.post("/custom-fields/get-transactions", customFieldController.getAll);
router.post("/custom-fields/dropdown-list", customFieldController.dropdownList);
router.get("/custom-fields/:id", customFieldController.getById);
router.put("/custom-fields/:id", bufferImage(), customFieldController.update);
router.patch("/custom-fields/update-priorities", customFieldController.updatePriorities);
router.delete("/custom-fields/", customFieldController.delete);
router.patch("/custom-fields/status", customFieldController.updateStatus);


// ==========================
// 38. EMPLOYEE SETTINGS ROUTES
// ==========================
// Base Path: /employee-settings
router.post("/employee-settings/", employeeSettingsController.create);
router.post("/employee-settings/get-transactions", employeeSettingsController.getAll);
router.put("/employee-settings/update", employeeSettingsController.update);

// ==========================
// 38.1. COMPANY SETTINGS ROUTES
// ==========================
// Base Path: /company-settings
router.post("/company-settings/", companySettingsController.create);
router.post("/company-settings/get-transactions", companySettingsController.getAll);
router.post("/company-settings/get-data", companySettingsController.getById);
router.put("/company-settings/update", companySettingsController.update);

// ==========================
// 39. OUT DUTY REQUEST ROUTES
// ==========================
router.post("/outduty-request/", outDutyRequestController.create);
router.post("/outduty-request/get-transactions", outDutyRequestController.getAll);
router.post("/outduty-request/pending-approvals", outDutyRequestController.getPendingApprovals);
router.get("/outduty-request/:id", outDutyRequestController.getById);
router.put("/outduty-request/:id", outDutyRequestController.update);
router.put("/outduty-request/status/:id", outDutyRequestController.updateStatus);
router.put("/outduty-request/cancel/:id", outDutyRequestController.cancelLeave);
router.post("/outduty-request/summary", outDutyRequestController.getOutDutySummary);
router.delete("/outduty-request", outDutyRequestController.delete);

// ===============================
// 40. ATTENDANCE REGULARIZATION  ROUTES
// ===============================
router.post("/attendance-regularization/", attendanceRegularizationController.create);
router.post("/attendance-regularization/get-transactions", attendanceRegularizationController.getAll);
router.post("/attendance-regularization/pending-approvals", attendanceRegularizationController.getPendingApprovals);
router.post("/attendance-regularization/summary", attendanceRegularizationController.getAttendanceRegularizationSummary);
router.get("/attendance-regularization/:id", attendanceRegularizationController.getById);
router.put("/attendance-regularization/:id", attendanceRegularizationController.update);
router.put("/attendance-regularization/status/:id", attendanceRegularizationController.updateStatus);
router.put("/attendance-regularization/cancel/:id", attendanceRegularizationController.cancel);
router.delete("/attendance-regularization", attendanceRegularizationController.delete);

// ==========================
// 41. SYSTEM LOG ROUTES
// ==========================
router.post("/system-logs/audit", systemLogController.getAuditLogs);
router.post("/system-logs/api", systemLogController.getApiLogs);
router.post("/system-logs/resolve", systemLogController.resolveSystemLog);

module.exports = router;