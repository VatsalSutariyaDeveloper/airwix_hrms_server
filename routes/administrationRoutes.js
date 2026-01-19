const express = require("express");
const router = express.Router();

// --- Import Controllers ---
// Permission & Modules
const moduleMasterController = require("../controllers/administration/permission/moduleMasterController");
const moduleEntityMasterController = require("../controllers/administration/permission/moduleEntityMasterController");
const modulePermissionTypeMasterController = require("../controllers/administration/permission/modulePermissionTypeMasterController");
const permissionController = require("../controllers/administration/permission/permissionController");

// Address / Location
const stateMasterController = require("../controllers/administration/address/stateMasterController");
const countryMasterController = require("../controllers/administration/address/countryMasterController");

// General Masters
const bankMasterController = require("../controllers/administration/bankMasterController");
const currencyMasterController = require("../controllers/administration/currencyMasterController");
const companySettingsMasterController = require("../controllers/administration/companySettingsMasterController");

// --- Helper to safely get handler ---
// const getHandler = (controller, method, name) => {
//     if (controller && typeof controller[method] === 'function') {
//         return controller[method];
//     }
//     // console.warn(`⚠️ Warning: Controller method '${name}.${method}' is missing. Route disabled.`);
//     return (req, res) => res.status(501).json({ message: `Endpoint ${name}.${method} not implemented` });
// };

// =================================================================
// 1. MODULE & PERMISSIONS
// =================================================================

// Module Master (Base: /module)
router.post("/module/", moduleMasterController.create);
router.post("/module/get-transactions", moduleMasterController.getAll);
router.post("/module/dropdown-list", moduleMasterController.dropdownList);
router.get("/module/:id", moduleMasterController.getById);
router.put("/module/:id", moduleMasterController.update);
router.delete("/module/", moduleMasterController.delete);
router.patch("/module/status", moduleMasterController.updateStatus);

// Module Entity Master (Base: /module-entity)
router.post("/module-entity/", moduleEntityMasterController.create);
router.post("/module-entity/get-transactions", moduleEntityMasterController.getAll);
router.get("/module-entity/:id", moduleEntityMasterController.getById);
router.put("/module-entity/:id", moduleEntityMasterController.update);
router.delete("/module-entity/", moduleEntityMasterController.delete);
router.patch("/module-entity/status", moduleEntityMasterController.updateStatus);

// Module Permission Type (Base: /module-permission-type)
router.post("/module-permission-type/", modulePermissionTypeMasterController.create);
router.post("/module-permission-type/get-transactions", modulePermissionTypeMasterController.getAll);
router.post("/module-permission-type/dropdown-list", modulePermissionTypeMasterController.dropdownList);
router.get("/module-permission-type/:id", modulePermissionTypeMasterController.getById);
router.put("/module-permission-type/:id", modulePermissionTypeMasterController.update);
router.delete("/module-permission-type/", modulePermissionTypeMasterController.delete);
router.patch("/module-permission-type/status", modulePermissionTypeMasterController.updateStatus);

// Permission Routes (Base: /permission)
// Static routes first
router.get("/permission/constants", permissionController.getPermissionConstants);
router.post("/permission/hierarchy", permissionController.getPermissionHierarchy);
// Management routes
router.post("/permission/add-permission", permissionController.createPermission);
router.get("/permission/get-permissions", permissionController.getAllPermissions);
// Route Protection
router.post("/permission/add-route-permission", permissionController.createRoutePermission);
router.post("/permission/get-route-permissions", permissionController.getAllRoutePermissions);
router.get("/permission/getById-route-permission/:id", permissionController.getByIdRoutePermission);
router.put("/permission/update-route-permission/:id", permissionController.updateRoutePermission);
router.delete("/permission/delete-route-permission/", permissionController.deleteRoutePermission);

// =================================================================
// 3. ADDRESS & LOCATION
// =================================================================

// State (Base: /state)
router.post("/state/", stateMasterController.create);
router.post("/state/get-transactions", stateMasterController.getAll);
router.post("/state/dropdown-list", stateMasterController.dropdownList);
router.get("/state/:id", stateMasterController.getById);
router.put("/state/:id", stateMasterController.update);
router.delete("/state/", stateMasterController.delete);
router.patch("/state/status", stateMasterController.updateStatus);

// Country (Base: /country)
router.post("/country/", countryMasterController.create);
router.post("/country/get-transactions", countryMasterController.getAll);
router.post("/country/dropdown-list", countryMasterController.dropdownList);
router.get("/country/:id", countryMasterController.getById);
router.put("/country/:id", countryMasterController.update);
router.delete("/country/", countryMasterController.delete);
router.patch("/country/status", countryMasterController.updateStatus);

// =================================================================
// 4. GENERAL MASTERS
// =================================================================

// Bank Master (Base: /bank) - Admin Side
router.post("/bank/", bankMasterController.create);
router.get("/bank/", bankMasterController.getAll);
router.get("/bank/:id", bankMasterController.getById);
router.put("/bank/:id", bankMasterController.update);
router.delete("/bank/:id", bankMasterController.delete);

// Currency Master (Base: /currency)
router.post("/currency/", currencyMasterController.create);
router.post("/currency/get-transactions", currencyMasterController.getAll);
router.post("/currency/dropdown-list", currencyMasterController.dropdownList);
router.get("/currency/:id/:default_currency", currencyMasterController.getById);
router.get("/currency/:id", currencyMasterController.getById);
router.put("/currency/:id", currencyMasterController.update);
router.delete("/currency/", currencyMasterController.delete);
router.patch("/currency/status", currencyMasterController.updateStatus);

// Company Settings (Base: /company-settings)
router.post("/company-settings/", companySettingsMasterController.create);
router.post("/company-settings/get-transactions", companySettingsMasterController.getAll);
router.get("/company-settings/:id", companySettingsMasterController.getById);
router.put("/company-settings/:id", companySettingsMasterController.update);
router.delete("/company-settings/", companySettingsMasterController.delete);

module.exports = router;