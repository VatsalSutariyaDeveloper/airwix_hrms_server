const express = require("express");
const router = express.Router();
const resignationController = require("../controllers/employee/resignationController");
const reasonController = require("../controllers/settings/resignationReasonController");
const resignationTemplateController = require("../controllers/settings/resignationTemplateController");

// Resignation Template Routes
router.post("/template", resignationTemplateController.create);
router.get("/template", resignationTemplateController.getAll);
router.post("/template/get-transactions", resignationTemplateController.getAll);
router.get("/template/dropdown-list", resignationTemplateController.dropdownList);
router.get("/template/:id", resignationTemplateController.getById);
router.put("/template/:id", resignationTemplateController.update);
router.delete("/template/delete", resignationTemplateController.delete);

// Resignation Reason Routes
router.post("/reason", reasonController.create);
router.get("/reason", reasonController.getAll);
router.post("/reason/get-transactions", reasonController.getAll);
router.get("/reason/dropdown-list", reasonController.dropdownList);
router.get("/reason/:id", reasonController.getById);
router.put("/reason/:id", reasonController.update);
router.delete("/reason", reasonController.delete);

// Employee Resignation Routes
router.post("/submit", resignationController.submitResignation);
router.get("/my-request", resignationController.getMyResignation);
router.post("/get-transactions", resignationController.getAllResignations);
router.post("/get-history", resignationController.getResignationHistory);
router.post("/pending-approvals", resignationController.getPendingApprovals);
router.get("/:id", resignationController.getResignationById);
router.post("/action/:id", resignationController.handleAction); // approval/rejection
router.post("/calculate-ff/:id", resignationController.calculateFF); // Final Settlement calculation preview
router.delete("/", resignationController.delete);

module.exports = router;
