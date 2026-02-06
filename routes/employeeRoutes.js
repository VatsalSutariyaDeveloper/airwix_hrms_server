const express = require("express");
const router = express.Router();
const employeeController = require("../controllers/employee/employeeController");
const employeeSalaryTemplateController = require("../controllers/employee/employeeSalaryTemplateController");
const employeeLeaveBalanceController = require("../controllers/employee/employeeLeaveBalanceController");
const employeeAttendanceController = require("../controllers/employee/employeeAttendanceController");
const { bufferImage, bufferFile } = require("../helpers/fileUpload");
const { uploadExcelToDisk } = require("../helpers/fileUpload");
const importEmployeeController = require("../controllers/settings/import/importEmployeeController");

// const { bufferImage } = require("../helpers/fileUpload");

router.post("/", bufferFile(["profile_image", "bank_proof_doc", "pan_doc", "aadhaar_doc", "passport_doc", "permanent_address_proof_doc", "present_address_proof_doc", "driving_license_doc", "voter_id_doc", "uan_doc"]), employeeController.create);
router.post("/get-transactions", employeeController.getAll);
router.post("/check-employee-code", employeeController.checkEmployeeCode);
router.post("/get-punch", employeeController.getPunch);
router.post("/dropdown-list", employeeController.dropdownList);
router.post("/get-wages", employeeController.getWages);
router.post("/assign-template", employeeController.assignTemplate);
router.post("/get-employees-by-template", employeeController.getEmployeesByTemplate);
router.post("/assign-role", employeeController.assignRole);
router.patch("/status", employeeController.updateStatus);
router.get("/:id", employeeController.getById);
router.put("/:id", bufferFile(["profile_image", "bank_proof_doc", "pan_doc", "aadhaar_doc", "passport_doc", "permanent_address_proof_doc", "present_address_proof_doc", "driving_license_doc", "voter_id_doc", "uan_doc"]), employeeController.update);
router.delete("/", employeeController.delete);
router.post("/invite-user", employeeController.inviteUser);
router.post("/import-data", uploadExcelToDisk("file"), importEmployeeController.importData);

router.post("/register-face", bufferImage("image"), employeeController.registerFace);
router.post("/face-punch", bufferImage("image"), employeeController.facePunch);

// Employee Salary Template Routes
router.get("/salary-template/:employeeId", employeeSalaryTemplateController.getTemplate);
router.put("/salary-template/:employeeId", employeeSalaryTemplateController.updateTemplate);

// Employee Leave Balance Routes
router.post("/leave-balance", employeeLeaveBalanceController.getByEmployeeId);
router.put("/leave-balance/:id", employeeLeaveBalanceController.updateByEmployeeId);

// Employee Attendance Routes (Shift & Weekly Off)
router.get("/shift-setting/:employeeId", employeeAttendanceController.getShiftSetting);
router.put("/shift-setting/:employeeId", employeeAttendanceController.updateShiftSetting);
router.get("/weekly-off/:employeeId", employeeAttendanceController.getWeeklyOffs);
router.put("/weekly-off/:employeeId", employeeAttendanceController.updateWeeklyOffs);
router.get("/attendance-setting/:employeeId", employeeAttendanceController.getAttendanceTemplate);
router.put("/attendance-setting/:employeeId", employeeAttendanceController.updateAttendanceTemplate);

module.exports = router;
