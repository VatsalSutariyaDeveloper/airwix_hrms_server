const express = require("express");
const router = express.Router();
const announcementController = require("../controllers/announcementController");

router.post("/", announcementController.createAnnouncement);
router.get("/", announcementController.getAnnouncements);
router.put("/:id", announcementController.updateAnnouncement);
router.delete("/:id", announcementController.deleteAnnouncement);
router.get("/active", announcementController.getActiveAnnouncements);

module.exports = router;