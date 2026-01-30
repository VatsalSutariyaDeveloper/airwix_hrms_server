const express = require("express");
const router = express.Router();
const employeeController = require("../controllers/employee/employeeController");
const employeeSalaryTemplateController = require("../controllers/employee/employeeSalaryTemplateController");
const employeeLeaveCategoryController = require("../controllers/employee/employeeLeaveCategoryController");
const { bufferImage, bufferFile } = require("../helpers/fileUpload");

const importController = require("../controllers/settings/import/importController");
// const { bufferImage } = require("../helpers/fileUpload");

router.post("/", bufferFile(["profile_image", "bank_proof_doc", "pan_doc", "aadhaar_doc", "passport_doc", "permanent_address_proof_doc", "present_address_proof_doc", "driving_license_doc", "voter_id_doc", "uan_doc"]), employeeController.create);
router.post("/get-transactions", employeeController.getAll);
router.post("/get-punch", employeeController.getPunch);
router.post("/dropdown-list", employeeController.dropdownList);
router.get("/get-employeecode", employeeController.getEmployeeCode);
router.post("/get-wages", employeeController.getWages);
router.post("/assign-template", employeeController.assignTemplate);
router.post("/get-employees-by-template", employeeController.getEmployeesByTemplate);
router.post("/assign-role", employeeController.assignRole);
router.patch("/status", employeeController.updateStatus);
router.get("/:id", employeeController.getById);
router.put("/:id", bufferFile(["profile_image", "bank_proof_doc", "pan_doc", "aadhaar_doc", "passport_doc", "permanent_address_proof_doc", "present_address_proof_doc", "driving_license_doc", "voter_id_doc", "uan_doc"]), employeeController.update);
router.delete("/", employeeController.delete);

router.post("/register-face", bufferImage("image"), employeeController.registerFace);
router.post("/face-punch", bufferImage("image"), employeeController.facePunch);

// Employee Salary Template Routes
router.get("/salary-template/:employeeId", employeeSalaryTemplateController.getTemplate);
router.put("/salary-template/:employeeId", employeeSalaryTemplateController.updateTemplate);

// Employee Leave Category Routes
router.get("/leave-category/:employeeId", employeeLeaveCategoryController.getByEmployeeId);
router.put("/leave-category/:employeeId", employeeLeaveCategoryController.updateByEmployeeId);

module.exports = router;
