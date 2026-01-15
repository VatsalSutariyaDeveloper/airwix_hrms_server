const express = require("express");
const router = express.Router();
const employeeController = require("../controllers/employee/employeeController");

router.post("/", employeeController.create);
router.post("/get-transaction", employeeController.getAll);
router.get("/dropdown-list", employeeController.dropdownList);
router.get("/:id", employeeController.getById);
router.put("/update-status", employeeController.updateStatus);
router.put("/:id", employeeController.update);
router.delete("/:id", employeeController.delete);

module.exports = router;
