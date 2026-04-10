const express = require("express");
const router = express.Router();
const announcementController = require("../controllers/announcementController");

router.post("/", announcementController.create);
router.post("/get-transactions", announcementController.getAll);
router.get("/active", announcementController.getActiveAnnouncements);
router.get("/:id", announcementController.getById);
router.patch("/status", announcementController.updateStatus);
router.put("/:id", announcementController.update);
router.delete("/", announcementController.delete);

module.exports = router;