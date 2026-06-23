const express = require("express");
const router = express.Router();
const visitorController = require("../controllers/visitorController");

const { bufferImage } = require("../helpers/fileUpload");

router.post("/create", bufferImage("visitor_photo"), visitorController.createPass);
router.get("/list", visitorController.getPasses);
router.get("/search", visitorController.getPassByCodeOrPhone);
router.post("/punch-in/:id", bufferImage("visitor_photo"), visitorController.punchIn);
router.post("/punch-out/:id", visitorController.punchOut);
router.put("/update/:id", bufferImage("visitor_photo"), visitorController.updatePass);
router.delete("/delete/:id", visitorController.deletePass);
router.post("/cancel/:id", visitorController.cancelPass);

module.exports = router;
