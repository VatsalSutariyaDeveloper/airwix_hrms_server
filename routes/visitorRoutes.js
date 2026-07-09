const express = require("express");
const router = express.Router();
const visitorController = require("../controllers/visitorController");

const { bufferImage } = require("../helpers/fileUpload");

router.post("/create", bufferImage(), visitorController.createPass);
router.get("/list", visitorController.getPasses);
router.get("/search", visitorController.getPassByCodeOrPhone);
router.post("/punch-in/:id", bufferImage(), visitorController.punchIn);
router.post("/punch-out/:id", visitorController.punchOut);
router.put("/update/:id", bufferImage("visitor_photo"), visitorController.updatePass);
router.delete("/delete/:id", visitorController.deletePass);
router.post("/cancel/:id", visitorController.cancelPass);
router.post("/send-pass/:id", visitorController.sendPass);

module.exports = router;
