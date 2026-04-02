const express = require("express");
const router = express.Router();
const resignationController = require("../controllers/employee/resignationController");

// Resignation Template Routes
router.post("/template", resignationController.create);
router.get("/template", resignationController.getAll);
router.post("/template/get-transactions", resignationController.getAll);
router.get("/template/dropdown-list", resignationController.dropdownList);
router.get("/template/:id", resignationController.getById);
router.put("/template/:id", resignationController.update);
router.delete("/template/:id", resignationController.delete);
 
// Resignation Reason Routes
const reasonController = require("../controllers/settings/resignationReasonController");
router.post("/reason", reasonController.create);
router.get("/reason", reasonController.getAll);
router.post("/reason/get-transactions", reasonController.getAll);
router.get("/reason/dropdown-list", reasonController.dropdownList);
router.get("/reason/:id", reasonController.getById);
router.put("/reason/:id", reasonController.update);
router.delete("/reason/:id", reasonController.delete);

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
