const express = require("express");
const router = express.Router();
const resignationController = require("../controllers/employee/resignationController");

// Resignation Template Routes
router.post("/template", resignationController.createTemplate);
router.get("/template", resignationController.getAllTemplates);
router.get("/template/:id", resignationController.getTemplateById);
router.put("/template/:id", resignationController.updateTemplate);
router.delete("/template/:id", resignationController.deleteTemplate);
 
// Resignation Reason Routes
const reasonController = require("../controllers/settings/resignationReasonController");
router.post("/reason", reasonController.createReason);
router.get("/reason", reasonController.getAllReasons);
router.get("/reason/:id", reasonController.getReasonById);
router.put("/reason/:id", reasonController.updateReason);
router.delete("/reason/:id", reasonController.deleteReason);

// Dropdown Routes
router.get("/template/dropdown", resignationController.getTemplateDropdown);
router.get("/reason/dropdown", resignationController.getReasonDropdown);

// Employee Resignation Routes
router.post("/submit", resignationController.submitResignation);
router.get("/my-request", resignationController.getMyResignation);
router.post("/get-transactions", resignationController.getAllResignations);
router.get("/pending-approvals", resignationController.getPendingApprovals);
router.get("/:id", resignationController.getResignationById);
router.post("/action/:id", resignationController.handleAction); // approval/rejection
router.post("/calculate-ff/:id", resignationController.calculateFF); // Final Settlement calculation preview

module.exports = router;
