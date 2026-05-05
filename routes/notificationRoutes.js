const express = require("express");
const router = express.Router();
const notificationController = require("../controllers/notificationController");

router.post("/list", notificationController.getNotifications);
router.post("/mark-read", notificationController.markAsRead);
router.post("/mark-all-read", notificationController.markAllAsRead);
router.post("/clear-all", notificationController.clearAll);
router.post("/unread-count", notificationController.getUnreadCount);

module.exports = router;
