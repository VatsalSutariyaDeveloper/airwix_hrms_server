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

// Get All Module Entity Name
exports.moduleList = async (req, res) => {
  try {
    const { enable_multi_branch, enable_multi_godown } = await getCompanySetting(req.body.company_id);

    const removalEntity = [];
    if (!enable_multi_branch) removalEntity.push(constants.BRANCH_ENTITY_ID);
    if (!enable_multi_godown) removalEntity.push(constants.GODOWN_ENTITY_ID, constants.ADMINISATOR_GODOWN_ENTITY_ID);

    const record = await commonQuery.findAllRecords(
      ModuleEntityMaster,
      { 
        id: { [Op.notIn]: removalEntity },
        user_id: req.body.user_id,       
        branch_id: req.body.branch_id,
        company_id: req.body.company_id,
        status: 0
      },
      { attributes: ["id", "entity_name"] },
      null,
      false
    );
    return res.ok(record);
  } catch (err) {
    console.log(err);
    return handleError(err, res, req);
  }
};
exports.getByModuleId = async (req, res) => {
  try {
    // Sanitize the URL by removing the leading slash if it exists
    let urlToFind = req.body.url;
    // Remove leading slash if it exists
    if (urlToFind.startsWith("/")) {
      urlToFind = urlToFind.substring(1);
    }
    
    // Remove trailing slash if it exists
    if (urlToFind.endsWith("/")) {
      urlToFind = urlToFind.slice(0, -1);
    }

    
    const { enable_multi_branch, enable_multi_godown } = await getCompanySetting(req.body.company_id);

    const removalEntity = [];
    if (!enable_multi_branch) removalEntity.push(constants.BRANCH_ENTITY_ID);
    if (!enable_multi_godown) removalEntity.push(constants.GODOWN_ENTITY_ID, constants.ADMINISATOR_GODOWN_ENTITY_ID);

    const record = await commonQuery.findAllRecords(
      ModuleMaster,
      { 
        module_url: urlToFind,
        status: 0,
        user_id: req.body.user_id,
        branch_id: req.body.branch_id,
        company_id: req.body.company_id 
      },
      {
        attributes: [
          "id",
          "module_name",
          "cust_module_name",
          "module_icon_name",
          "module_url",
          "priority",
        ],
        include: [
          {
            model: ModuleEntityMaster,
            as: "entities",
            where: { 
              id: { [Op.notIn]: removalEntity },
              status: 0,
              entity_visiblity: 1,
            },
            attributes: [
              "id",
              "entity_name",
              "cust_entity_name",
              "entity_icon_name",
              "entity_url",
              "priority",
            ],
          },
        ],
      },
      null,
      false
    );

    return res.ok(record);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Create Module Entity Master Access
exports.create = async (req, res) => {
  const POST = req.body;
  const transaction = await sequelize.transaction();
  try {
    const requiredFields = {
      module_id: "Master Module",
      entity_name: "Entity Name",
      cust_entity_name: "Entity Name For Parties",
      // entity_permmision_type_ids: "Permission Type IDs",
      entity_url: "Entity URL",
      entity_description: "Entity Description",
      entity_icon_name: "Entity Icon Name",
      priority: "Entity Order",
      user_id: "User",
      branch_id: "Branch",
      company_id: "Company",
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
        transaction
      );

      if (existingPermission) {
        skippedActions.push(action);
        continue;
      }

      const newPerm = await commonQuery.createRecord(Permission, {
        module_id: POST.module_id,
        entity_id: result.id,
        action: action.action,
      }, transaction);

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
  // key, isSearchable, isSortable
    const fieldConfig = [
      ["moduleMaster.module_name", true, true],
      ["entity_name", true, true],
      ["cust_entity_name", true, true],
    ];
    const { enable_multi_branch, enable_multi_godown } = await getCompanySetting(req.body.company_id);

    const removalEntity = [];
    if (!enable_multi_branch) removalEntity.push(constants.BRANCH_ENTITY_ID);
    if (!enable_multi_godown) removalEntity.push(constants.GODOWN_ENTITY_ID, constants.ADMINISATOR_GODOWN_ENTITY_ID);
    if (!req.body.filter) {
      req.body.filter = {};
    }
    req.body.filter.id = { [Op.notIn]: removalEntity };

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
            model: ModulePermissionTypeMaster,
            as: "permissionType",
            required: false,
            on: sequelize.literal(
              `FIND_IN_SET(permissionType.id, entity_permmision_type_ids)`
            ),
            attributes: [],
          },
        ],
        attributes: [
          "id",
          "moduleMaster.module_name",
          "entity_name",
          "cust_entity_name",
          "entity_icon_name",
          "priority",
          "status",
          "company_id",
          "branch_id",
          "user_id",
          [
            sequelize.fn(
              "GROUP_CONCAT",
              sequelize.col("permissionType.permission_type_name")
            ),
            "entity_permission_names",
          ],
        ],
        group: ["id"],
      },
      null,
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
          model: ModulePermissionTypeMaster,
          as: "permissionType",
          required: false,
          // Using sequelize.literal for FIND_IN_SET
          on: sequelize.literal(
            `FIND_IN_SET(permissionType.id, ModuleEntityMaster.entity_permmision_type_ids)`
          ),
          attributes: [],
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
      // entity_permmision_type_ids: "Permission Type IDs",
      priority: "Entity Order",
      user_id: "User",
      branch_id: "Branch",
      company_id: "Company",
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
    const updated = await commonQuery.updateRecordById(
      ModuleEntityMaster,
      req.params.id,
      POST,
      transaction
    );
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
            transaction
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
          await commonQuery.hardDeleteById(
            Permission,
            id,
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
      transaction
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

    // Validate that status is provided and valid (0,1,2 as per your definition)
    if (![0, 1, 2].includes(status)) {
      await transaction.rollback();
      return res.error(constants.INVALID_STATUS);
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

// Get Module ID and Entity ID by URL
exports.getModuleAndEntityIdsByUrl = async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.error( constants.REQUIRED_FIELD_MISSING, "URL");
    }

    let normalizedUrl = url.trim();

    // Step 1: Remove leading slash (if it exists)
    if (normalizedUrl.startsWith('/')) {
      normalizedUrl = normalizedUrl.slice(1); // Remove leading slash
    }

    // Remove trailing slash if present (but not the root "/")
    if (normalizedUrl.length > 1 && normalizedUrl.endsWith('/')) {
      normalizedUrl = normalizedUrl.slice(0, -1);
    }

    let previousUrl;
    do {
      previousUrl = normalizedUrl;
      normalizedUrl = normalizedUrl.replace(/\/(add|edit|view|\d+|[0-9a-fA-F-]{36})$/, "");
    } while (previousUrl !== normalizedUrl);

    const { enable_multi_branch, enable_multi_godown } = await getCompanySetting(req.body.company_id);

    const removalEntity = [];
    if (!enable_multi_branch) removalEntity.push(constants.BRANCH_ENTITY_ID);
    if (!enable_multi_godown) removalEntity.push(constants.GODOWN_ENTITY_ID, constants.ADMINISATOR_GODOWN_ENTITY_ID);
    // Step 2: Try Entity
    const entityRecord = await commonQuery.findOneRecord(
      ModuleEntityMaster,
      { 
        id: { [Op.notIn]: removalEntity },
        entity_url: normalizedUrl,
        user_id: req.body.user_id,
        branch_id: req.body.branch_id,
        company_id: req.body.company_id 
      }
    );

    if (entityRecord) {
      return res.ok({
        module_id: entityRecord.module_id,
        entity_id: entityRecord.id,
      });
    }

    // Step 3: Try Module
    const moduleRecord = await commonQuery.findOneRecord(
      ModuleMaster,
      { 
        module_url: normalizedUrl,
        user_id: req.body.user_id,
        branch_id: req.body.branch_id,
        company_id: req.body.company_id 
      }
    );

    if (moduleRecord) {
      return res.ok({
        module_id: moduleRecord.id,
        entity_id: null,
      });
    }

    // Step 4: Not found
    return res.error(constants.NOT_FOUND);

  } catch (err) {
    return handleError(err, res, req);
  }
};
