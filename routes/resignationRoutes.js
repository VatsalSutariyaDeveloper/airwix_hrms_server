const express = require("express");
const router = express.Router();
const resignationController = require("../controllers/employee/resignationController");

// Resignation Template Routes
router.post("/template", resignationController.createTemplate);
router.get("/template", resignationController.getAllTemplates);
router.get("/template/:id", resignationController.getTemplateById);
router.put("/template/:id", resignationController.updateTemplate);
router.delete("/template/:id", resignationController.deleteTemplate);

// Employee Resignation Routes
router.post("/submit", resignationController.submitResignation);
router.get("/my-request", resignationController.getMyResignation);
router.post("/get-transactions", resignationController.getAllResignations);
router.get("/:id", resignationController.getResignationById);
router.post("/action/:id", resignationController.handleAction); // approval/rejection
router.put("/checklist/:id", resignationController.updateChecklist);
router.post("/calculate-ff/:id", resignationController.calculateFF); // Final Settlement calculation preview

module.exports = router;
