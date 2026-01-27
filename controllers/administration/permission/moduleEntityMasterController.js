const {
  ModuleEntityMaster,
  ModulePermissionTypeMaster,
  ModuleMaster,
  Permission,
} = require("../../../models");
const {
  sequelize,
  validateRequest,
  commonQuery,
  handleError,
  getCompanySetting,
  constants,
} = require("../../../helpers");
const { Op } = require("sequelize");
const { clearEntityCache } = require("../../../helpers/permissionCache");

// Create Module Entity Master Access
exports.create = async (req, res) => {
  const POST = req.body;
  const transaction = await sequelize.transaction();
  try {
    const requiredFields = {
      module_id: "Master Module",
      entity_name: "Entity Name",
      cust_entity_name: "Entity Name For Parties",
      entity_url: "Entity URL",
      entity_description: "Entity Description",
      entity_icon_name: "Entity Icon Name",
      priority: "Entity Order",
      actions: "Actions",
    };

    const errors = await validateRequest(POST, requiredFields,
      {
        uniqueCheck: { model: ModuleEntityMaster, fields: [["module_id", "entity_name"]] },
      },
      transaction
    );

    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors );
    }
    const result = await commonQuery.createRecord(
      ModuleEntityMaster,
      POST,
      transaction
    );

    const actionList = Array.isArray(POST.actions) ? POST.actions : [POST.actions];
    const createdPermissions = [];
    const skippedActions = [];

    for (const action of actionList) {
      const existingPermission = await commonQuery.findOneRecord(
        Permission, 
        { module_id: POST.module_id, entity_id: result.id, action: action.action }, 
        {},
        transaction,
        false,
        false
      );

      if (existingPermission) {
        skippedActions.push(action);
        continue;
      }

      const newPerm = await commonQuery.createRecord(Permission, {
        module_id: POST.module_id,
        entity_id: result.id,
        action: action.action,
      }, transaction, false);

      createdPermissions.push(newPerm);
    }

    await transaction.commit();
    return res.success(constants.ENTITY_CREATED, result);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Get All Module Entity Master
exports.getAll = async (req, res) => {
  try {
    const fieldConfig = [
      ["moduleMaster.module_name", true, true],
      ["entity_name", true, true],
      ["cust_entity_name", true, true],
    ];
    const { enable_multi_branch, enable_multi_godown } = await getCompanySetting(req.user.company_id);

    // const removalEntity = [];
    // if (!enable_multi_branch) removalEntity.push(constants.BRANCH_ENTITY_ID);
    // if (!enable_multi_godown) removalEntity.push(constants.GODOWN_ENTITY_ID, constants.ADMINISATOR_GODOWN_ENTITY_ID);
    // if (!req.body.filter) {
    //   req.body.filter = {};
    // }
    // req.body.filter.id = { [Op.notIn]: removalEntity };

    const data = await commonQuery.fetchPaginatedData(
      ModuleEntityMaster,
      req.body,
      fieldConfig,
      {
        include: [
          {
            model: ModuleMaster,
            as: "moduleMaster",
            attributes: [],
          },
          {
            model: Permission,
            required: false,
            as: "permissions",
            attributes: []
          },
        ],
        attributes: [
          "id",
          [sequelize.col("moduleMaster.module_name"), "module_name"],
          "entity_name",
          "cust_entity_name",
          "entity_icon_name",
          "priority",
          "status",
          [
            sequelize.fn(
              "STRING_AGG",
              sequelize.col("permissions.action"),
              ", "
            ),
            "entity_permission_names",
          ],
        ],
        group: [
          "ModuleEntityMaster.id",
          "moduleMaster.module_name",
          "ModuleEntityMaster.entity_name",
          "ModuleEntityMaster.cust_entity_name",
          "ModuleEntityMaster.entity_icon_name",
          "ModuleEntityMaster.priority",
          "ModuleEntityMaster.status",
        ],
      },
      false
    );

    return res.ok(data);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Get Module Entity Master Access by ID
exports.getById = async (req, res) => {
  try {
    const record = await commonQuery.findOneRecord(ModuleEntityMaster, 
      req.params.id,
      {
        include: [
        {
          model: ModuleMaster,
          as: "moduleMaster",
          attributes: ["module_name"],
        },
        {
          model: Permission,
          required: false,
          as: "permissions",
          attributes: ["id", "action"]
        },
      ],
    }, null, false, false);



    if (!record || record.status === 2) {
      return res.error(constants.NOT_FOUND);
    }

     // Convert Sequelize instance → plain object
    const plainRecord = record.get ? record.get({ plain: true }) : record;

    // Add alias field
    plainRecord.entity_module_id = plainRecord.module_id;

    // Rename permissions to actions
    if (plainRecord.permissions) {
      plainRecord.actions = plainRecord.permissions;
      delete plainRecord.permissions;
    }

    return res.ok(plainRecord);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Update Module Entity Master Access
exports.update = async (req, res) => {
  const POST = req.body;
  const transaction = await sequelize.transaction();
  try {
    const requiredFields = {
      module_id: "Master Module",
      entity_name: "Entity Name",
      cust_entity_name: "Entity Name For Parties",
      priority: "Entity Order",
    };

    const errors = await validateRequest(req.body, requiredFields,
      {
        uniqueCheck: { model: ModuleEntityMaster, fields: [["module_id", "entity_name"]], excludeId: req.params.id },
      },
      transaction
    );

    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors );
    }

    const updated = await commonQuery.updateRecordById(ModuleEntityMaster, req.params.id, POST, transaction, false, false);

    if (!updated || updated.status === 2) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }

    // Handle permissions if actions are provided
    if (POST.actions) {
      const actionList = Array.isArray(POST.actions) ? POST.actions : [POST.actions];
      const createdPermissions = [];
      const updatedPermissions = [];
      const skippedActions = [];
      const sentActionIds = [];

      // First, process all actions in the payload
      for (const action of actionList) {
        if (action.id) {
          sentActionIds.push(action.id);
          const updatedPermission = await commonQuery.updateRecordById(
            Permission,
            action.id,
            { 
              action: action.action
            },
            transaction
          );
          
          if (updatedPermission) {
            updatedPermissions.push(updatedPermission);
          } else {
            skippedActions.push(action);
          }
        } else {
          const existingPermission = await commonQuery.findOneRecord(
            Permission, 
            { 
              module_id: POST.module_id, 
              entity_id: req.params.id, 
              action: action.action
            }, 
            transaction, false, false
          );

          if (existingPermission) {
            skippedActions.push(action);
            continue;
          }

          const newPerm = await commonQuery.createRecord(Permission, {
            module_id: POST.module_id,
            entity_id: req.params.id,
            action: action.action,
          }, transaction);

          createdPermissions.push(newPerm);
          sentActionIds.push(newPerm.id);
        }
      }

      const existingPermissions = await commonQuery.findAllRecords(
        Permission,
        { 
          module_id: POST.module_id, 
          entity_id: req.params.id 
        },
        { attributes: ["id"] },
        transaction,
        false
      );

      const existingPermissionIds = existingPermissions.map(p => p.id);
      const idsToDelete = existingPermissionIds.filter(id => !sentActionIds.includes(id));

      if (idsToDelete.length > 0) {
        for (const id of idsToDelete) {
          await commonQuery.hardDeleteRecords(
            Permission,
            { id },
            transaction
          );
        }
      }
    }

    clearEntityCache(updated.module_id, updated.id);
    await transaction.commit();
    return res.success(constants.ENTITY_UPDATED, updated);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

exports.delete = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const requiredFields = {
      ids: "Select Data",
    };

    const errors = await validateRequest(req.body, requiredFields, {}, transaction);
    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors );
    }
    const { ids } = req.body; // Accept array of ids

    // Validate that ids is an array and not empty
    if (!Array.isArray(ids) || ids.length === 0) {
      await transaction.rollback();
      return res.error(constants.INVALID_ID);
    }

    const deleted = await commonQuery.softDeleteById(
      ModuleEntityMaster,
      ids,
      transaction,
      false
    );
    if (!deleted) {
      await transaction.rollback();
      return res.error(constants.ALREADY_DELETED);
    }
    await transaction.commit();
    return res.success(constants.ENTITY_DELETED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Update Status of Module Master
exports.updateStatus = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { status, ids } = req.body; // expecting status in request body

    const requiredFields = {
      ids: "Select Any One Data",
      status: "Select Status",
    };

    const errors = await validateRequest(req.body, requiredFields, {}, transaction);
    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors );
    }

    // Validate that ids is an array and not empty
    if (!Array.isArray(ids) || ids.length === 0) {
      await transaction.rollback();
      return res.error(constants.INVALID_ID);
    }

    // Update only the status field by id
    const updated = await commonQuery.updateRecordById(
      ModuleEntityMaster,
      ids,
      { status },
      transaction
    );

    if (!updated || updated.status === 2) {
      if (!transaction.finished) await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }

    await transaction.commit();
    return res.success(constants.ENTITY_UPDATED);
  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};