const express = require("express");
const router = express.Router();
const employeeController = require("../controllers/employee/employeeController");
const { bufferImage } = require("../helpers/fileUpload");

router.post("/", bufferImage(["profile_image", "bank_proof_doc", "pan_doc", "aadhaar_doc", "passport_doc", "permanent_address_proof_doc", "present_address_proof_doc"]), employeeController.create);

// router.post("/", bufferImage("profile_image"), employeeController.create); 
router.post("/get-transaction", employeeController.getAll);
router.post("/get-punch", employeeController.getPunch);
router.get("/dropdown-list", employeeController.dropdownList);
router.get("/:id", employeeController.getById);
router.put("/update-status", employeeController.updateStatus);
router.put("/:id", bufferImage(["profile_image", "bank_proof_doc", "pan_doc", "aadhaar_doc", "passport_doc", "permanent_address_proof_doc", "present_address_proof_doc"]), employeeController.update);
router.delete("/:id", employeeController.delete);

// ✅ NEW: Face Recognition Routes
// Uses 'bufferImage' to handle the file in memory first
router.post("/register-face", bufferImage("image"), employeeController.registerFace);
router.post("/face-punch", bufferImage("image"), employeeController.facePunch);

module.exports = router;