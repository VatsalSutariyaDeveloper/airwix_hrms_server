const { Permission, ModuleMaster, ModuleEntityMaster, RoutePermission } = require("../../../models");
const { sequelize, commonQuery, validateRequest, constants, handleError } = require("../../../helpers");
const { reloadRoutePermissions } = require("../../../helpers/cache");

// --- 1. Manage Permissions (Granular Actions) ---

exports.createPermission = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { module_id, entity_id, actions, description } = req.body;

        if (!module_id || !entity_id || !actions) {
            await transaction.rollback();
            return res.error("Module ID, entity ID, and Actions are required.");
        }

        const actionList = Array.isArray(actions) ? actions : [actions];
        const createdPermissions = [];
        const skippedActions = [];

        for (const action of actionList) {
            const existingPermission = await commonQuery.findOneRecord(
                Permission,
                { module_id, entity_id, action },
                transaction
            );

            if (existingPermission) {
                skippedActions.push(action);
                continue;
            }

            const newPerm = await commonQuery.createRecord(Permission, {
                module_id,
                entity_id,
                action,
                description
            }, transaction);

            createdPermissions.push(newPerm);
        }

        await transaction.commit();

        return res.success({
            created_count: createdPermissions.length,
            created_permissions: createdPermissions,
            skipped_actions: skippedActions
        }, "Permissions processed successfully");

    } catch (error) {
        await transaction.rollback();
        console.error("Create Permission Error:", error);
        return res.error(error.message || "Failed to create permissions");
    }
};

exports.getAllPermissions = async (req, res) => {
    try {
        const permissions = await commonQuery.findAllRecords(
            Permission, 
            {}, 
            {
            include: [
                { model: ModuleMaster, as: 'module', attributes: ['module_name'] },
                { model: ModuleEntityMaster, as: 'entity', attributes: ['entity_name'] }
            ],
            order: [['id', 'DESC']]
        }, null, false);
        return res.ok(permissions);
    } catch (error) {
        return handleError(error, res);
    }
};

// ✅ ADDED: This function is required for your 'npm run gen:perms' script
exports.getPermissionConstants = async (req, res) => {
    try {
        const permissions = await commonQuery.findAllRecords(
            Permission,
            {},
            {
                attributes: ['id', 'action', 'slug'],
                include: [
                    // 1. Fetch 'id' from ModuleMaster
                    {
                        model: ModuleMaster,
                        as: 'module',
                        attributes: ['id', 'module_name']
                    },
                    // 2. Fetch 'id' from ModuleEntityMaster
                    {
                        model: ModuleEntityMaster,
                        as: 'entity',
                        attributes: ['id', 'entity_name', 'cust_entity_name']
                    }
                ],
                raw: true,
                nest: true
            }, null, false);

        const constantTree = {};
        const formatKey = (str) => str ? str.toUpperCase().replace(/[^A-Z0-9]/g, '_') : 'UNKNOWN';

        permissions.forEach((p) => {
            const modKey = formatKey(p.module.module_name);
            const entKey = formatKey(p.entity.cust_entity_name || p.entity.entity_name);
            const actKey = formatKey(p.action);

            // --- LEVEL 1: MODULE ---
            if (!constantTree[modKey]) {
                constantTree[modKey] = {
                    ID: p.module.id, // <--- Add Module ID here
                };
            }

            // --- LEVEL 2: ENTITY ---
            if (!constantTree[modKey][entKey]) {
                constantTree[modKey][entKey] = {
                    ID: p.entity.id, // <--- Add Entity ID here
                };
            }

            // --- LEVEL 3: ACTION ---
            // Map the CONSTANT to the Permission ID
            constantTree[modKey][entKey][actKey] = p.id;
        });

        return res.success(constants.FETCHED, constantTree);
    } catch (error) {
        return handleError(error, res, req);
    }
};

exports.getPermissionHierarchy = async (req, res) => {
    try {
        const [modules, permissions] = await Promise.all([
            commonQuery.findAllRecords(ModuleMaster, { status: 0 }, {
                attributes: ['id', 'module_name', 'module_icon_name', 'priority', 'cust_module_name'],
                include: [{
                    model: ModuleEntityMaster,
                    as: 'entities',
                    where: { status: 0 },
                    attributes: ['id', 'entity_name', 'priority', 'cust_entity_name'],
                    required: false
                }],
                order: [
                    ['priority', 'ASC'],
                    [{ model: ModuleEntityMaster, as: 'entities' }, 'priority', 'ASC']
                ]
            }, null, false),
            commonQuery.findAllRecords(Permission, {}, {
                attributes: ['id', 'module_id', 'entity_id', 'action', 'slug', 'description']
            }, null, false)
        ]);

        const hierarchy = modules.map(module => {
            const moduleJson = module.toJSON();

            if (moduleJson.entities) {
                moduleJson.entities = moduleJson.entities.map(entityItem => {
                    const entityPermissions = permissions.filter(p =>
                        p.module_id === moduleJson.id &&
                        p.entity_id === entityItem.id
                    );

                    return {
                        ...entityItem,
                        label: entityItem.cust_entity_name || entityItem.entity_name,
                        permissions: entityPermissions
                    };
                });
            }

            return {
                id: moduleJson.id,
                name: (moduleJson.cust_module_name || moduleJson.module_name).toLowerCase().replace(/\s/g, '_'),
                label: moduleJson.cust_module_name || moduleJson.module_name,
                icon: moduleJson.module_icon_name,
                entities: moduleJson.entities || []
            };
        });

        return res.ok(hierarchy);
    } catch (error) {
        console.error("Hierarchy Error:", error);
        return handleError(error, res, req);
    }
};

// --- 2. Manage Route Permissions (Binding Routes to IDs) ---

exports.createRoutePermission = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const requiredFields = {
            method: "Method",
            path_pattern: "Path",
            permission_id: "Permission",
        };

        const errors = await validateRequest(req.body, requiredFields, {
            uniqueCheck: {
                model: RoutePermission,
                fields: [["method", "path_pattern"]],
                excludeCompany: true,
                excludeStatus: true
            }
        }, transaction);

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        const { method, path_pattern, permission_id } = req.body;

        const newRouteRule = await commonQuery.createRecord(RoutePermission, {
            method: method.toUpperCase(),
            path_pattern,
            permission_id
        }, transaction);

        await reloadRoutePermissions(); // Refresh Cache
        await transaction.commit();
        return res.success(constants.SUCCESS, newRouteRule);

    } catch (error) {
        await transaction.rollback();
        console.error("Route Permission Error:", error);
        if (error.name === 'SequelizeUniqueConstraintError') {
            return res.error(constants.VALIDATION_ERROR, "This route path is already defined.");
        }
        return handleError(error, res, req);
    }
};

exports.getAllRoutePermissions = async (req, res) => {
    try {
        const fieldConfig = [
            ["method", true, true],
            ["path_pattern", true, true],
        ];

        // Remove tenant-specific fields from request body if they exist
        const { user_id, company_id, branch_id, ...cleanedBody } = req.body;

        const routes = await commonQuery.fetchPaginatedData(
            RoutePermission,
            cleanedBody,
            fieldConfig,
            {
                include: [{
                    model: Permission,
                    as: 'permission',
                    attributes: [],
                    include: [
                        { model: ModuleMaster, as: 'module', attributes: ['module_name'] },
                        { model: ModuleEntityMaster, as: 'entity', attributes: ['entity_name'] }
                    ]
                }],
                attributes: [
                    'id',
                    'method',
                    'path_pattern',
                    'permission_id',
                    'permission.slug',
                    'permission.module_id',
                    'permission.entity_id',
                    'permission.action',
                    'permission.module.module_name',
                    'permission.entity.entity_name'
                ],
                order: [['path_pattern', 'ASC']]
            },
            false
        );
        return res.ok(routes);
    } catch (error) {
        return handleError(error, res, req);
    }
};

// ✅ ADDED: Get Route Permission by ID
exports.getByIdRoutePermission = async (req, res) => {
    try {
        const { id } = req.params;

        if (!id) {
            return res.error(constants.VALIDATION_ERROR, "ID is required.");
        }

        const route = await commonQuery.findOneRecord(RoutePermission, id, {
            include: [{
                model: Permission,
                as: 'permission',
                attributes: [],
                include: [
                    { model: ModuleMaster, as: 'module', attributes: ['module_name'] },
                    { model: ModuleEntityMaster, as: 'entity', attributes: ['entity_name'] }
                ]
            }],
            attributes: [
                'id',
                'method',
                'path_pattern',
                'permission_id',
                'permission.slug',
                'permission.module_id',
                'permission.entity_id',
                'permission.action',
                'permission.module.module_name',
                'permission.entity.entity_name'
            ]
        });

        if (!route) {
            return res.error(constants.NOT_FOUND, "Route permission not found.");
        }

        return res.ok(route);
    } catch (error) {
        return handleError(error, res, req);
    }
};

// ✅ ADDED: Update Route Permission
exports.updateRoutePermission = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.params;
        const { method, path_pattern, permission_id } = req.body;

        const updated = await commonQuery.updateRecordById(RoutePermission, id, {
            method: method ? method.toUpperCase() : undefined,
            path_pattern,
            permission_id
        }, transaction);

        if (!updated) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND, "Route permission not found.");
        }

        await reloadRoutePermissions(); // Refresh Cache
        await transaction.commit();
        return res.success(constants.SUCCESS, updated);

    } catch (error) {
        await transaction.rollback();
        return handleError(error, res, req);
    }
};

// ✅ ADDED: Delete Route Permission
exports.deleteRoutePermission = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { ids } = req.body;

        if (!ids || (!Array.isArray(ids) && typeof ids !== 'number')) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, "Valid ID(s) are required.");
        }

        const idArray = Array.isArray(ids) ? ids : [ids];
        let deletedCount = 0;

        // Hard delete each record individually
        for (const id of idArray) {
            const deleted = await commonQuery.hardDeleteById(RoutePermission, id, transaction);
            if (deleted) {
                deletedCount++;
            }
        }

        if (deletedCount === 0) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND, "Route permission(s) not found.");
        }

        await reloadRoutePermissions(); // Refresh Cache
        await transaction.commit();
        return res.success(constants.SUCCESS, { deletedCount });

    } catch (error) {
        await transaction.rollback();
        return handleError(error, res, req);
    }
};