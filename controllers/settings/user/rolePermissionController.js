const { RolePermission, ModulePermissionTypeMaster, ModuleMaster, ModuleEntityMaster, User} = require("../../../models");
const { sequelize, validateRequest, handleError, commonQuery, constants } = require("../../../helpers");

// Create Role Access Permission
exports.create = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const requiredFields = {
      role_name: "Role Name",
      permissions: "Select Permissions",
    };

    const errors = await validateRequest(req.body, requiredFields,{
        uniqueCheck: {model: RolePermission, fields: ["role_name"]}
    }, transaction);

    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, { errors });
    }

    const result = await commonQuery.createRecord(
      RolePermission,
      req.body,
      transaction
    );

    await transaction.commit();
    return res.success(constants.ROLE_PERMISSION_CREATED, result);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Get All
exports.getAll = async (req, res) => {
  // key, isSearchable, isSortable
  const fieldConfig = [
    ["role_name", true, true],
  ];

  // Call reusable function
  const data = await commonQuery.fetchPaginatedData(
    RolePermission,
    req.body,
    fieldConfig,
    {
      include: [
        {
          model: User,
          as: "users",
          attributes: [],
          required: false,
        }
      ],
      attributes: [
        "id",
        "role_name",
        "permissions",
        sequelize.fn(
          "STRING_AGG",
          sequelize.col("users.user_name"),
          ", "
        ),
        "status",
        "created_at",
        "updated_at",
      ],
      group: ['rolePermission.id'],
    }
  );
  return res.ok(data);
};

/**
 * Get Users
 */
exports.dropdownList = async (req, res) => {
  try {
    const record = await commonQuery.findAllRecords(
      RolePermission,
      { 
        status: 0
      },
      { 
        attributes: ["id", "role_name"], 
        order: [["role_name", "ASC"]] 
      },
    );
    return res.ok(record);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Get by ID
exports.getById = async (req, res) => {
  try {
    const record = await commonQuery.findOneRecord(
      RolePermission,
      req.params.id
    );
    
    if (!record || record.status === 2) return res.error(constants.NOT_FOUND, { code: constants.ROLE_PERMISSION_NOT_FOUND });
    
    let permissionObj = record.permissions;
        
    // Ensure it is an object
    if (typeof permissionObj === 'string') {
        try { permissionObj = JSON.parse(permissionObj); } catch(e) {}
    }
    
    // Assign back to the record before sending
    record.setDataValue('permissions', permissionObj);

    return res.ok(record);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Update
exports.update = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const requiredFields = {
      role_name: "Role Name",
      permissions: "Select Permissions",
    };
    
    const errors = await validateRequest(req.body, requiredFields,{
      uniqueCheck: {
        model: RolePermission,
        fields: ["role_name"],
        excludeId: req.params.id,
      }}, transaction);

    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, { errors });
    }

    // Update Role Permission
    const { update_user_role, permissions } = req.body;

    const updated = await commonQuery.updateRecordById(
      RolePermission,
      req.params.id,
      req.body,
      transaction
    );

    if (!updated || updated.status === 2) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }

    if (update_user_role === "yes") {
      await commonQuery.updateRecordById(
        User,
        { role_id: req.params.id },
        { permission: permissions },
        transaction
      );
    }
    
    await transaction.commit();
    return res.success(constants.ROLE_PERMISSION_UPDATED, updated);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Soft delete by IDs
exports.delete = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const requiredFields = {
      ids: "Select Data"
    };

    const errors = await validateRequest(req.body, requiredFields, {}, transaction);

    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, { errors });
    }

    const { ids } = req.body; // Accept array of ids
    
    // Validate that ids is an array and not empty
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.error(constants.INVALID_INPUT);
    }
    
    const deleted = await commonQuery.softDeleteById(RolePermission, ids, transaction);
    if (!deleted) {
      await transaction.rollback();
      return res.error(constants.ALREADY_DELETED);
    }

    await transaction.commit();
    return res.success(constants.ROLE_PERMISSION_DELETED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Update Status 
exports.updateStatus = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {

    const { status, ids } = req.body; // expecting status in request body
    
    const requiredFields = {
      ids: "Select Any One Data",
      status: "Select Status"
    };

    const errors = await validateRequest(req.body, requiredFields, {}, transaction);

    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, { errors });
    }
    
    // Validate that ids is an array and not empty
    if (!Array.isArray(ids) || ids.length === 0) {
      await transaction.rollback();
      return res.error(constants.INVALID_INPUT);
    }

    // Validate that status is provided and valid (0,1,2 as per your definition)
    if (![0,1,2].includes(status)) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, { errors: constants.INVALID_STATUS });
    }

    // Update only the status field by id
    const updated = await commonQuery.updateRecordById(
      RolePermission,
      ids,
      { status },
      transaction
    );

    if (!updated || updated.status === 2) {
      if (!transaction.finished) await transaction.rollback();
      return res.error(constants.NOT_FOUND, { code: constants.ROLE_PERMISSION_NOT_FOUND });
    }

    await transaction.commit();
    return res.success(constants.ROLE_PERMISSION_UPDATED, updated);
  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Get Module Entity And Permissions
exports.getPermissions = async (req, res) => {
  try {
    let RolePermission = null;
    let moduleEntities = null;

    // 1. Get Module Permission Type Master
    const modulePermissionTypes = await commonQuery.findAllRecords(
      ModulePermissionTypeMaster,
      { 
        status: 0,
      },
      { attributes: ["id", "permission_type_name", "priority"] },
      null,
      false
    );

    // 2. Get Permission Role
    if (req.body.ROLE_PERMISSION_id) {
      RolePermission = await commonQuery.findOneRecord(RolePermission, req.body.ROLE_PERMISSION_id);
    }

    // 3. Get Module + Entities
    // if (req.body.module_id) {
      moduleEntities = await commonQuery.findAllRecords(
        ModuleMaster,
        { 
          status: 0,
        },
        {
          attributes: ["id", "module_name", "cust_module_name", "priority"],
          include: [
            {
              model: ModuleEntityMaster,
              as: "entities",
              where: { status: 0 },
              attributes: [
                "id",
                "entity_name",
                "cust_entity_name",
                "entity_permmision_type_ids",
                "priority",
              ],
            },
          ],
        },
        null,
        false
      );
    // }

    return res.ok({
      modulePermissionTypes,
      RolePermission,
      moduleEntities,
    });

  } catch (err) {
    return handleError(err, res, req);
  }
};
