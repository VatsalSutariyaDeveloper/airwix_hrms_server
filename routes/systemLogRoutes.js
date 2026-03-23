const express = require("express");
const router = express.Router();
const systemLogController = require("../controllers/systemLogController");

router.post("/audit", systemLogController.getAuditLogs);
router.post("/activity", systemLogController.getActivityLogs);
router.post("/api", systemLogController.getApiLogs);

module.exports = router;
