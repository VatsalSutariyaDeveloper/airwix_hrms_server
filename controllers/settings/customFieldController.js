const { CustomField, ModuleMaster, ModuleEntityMaster, User } = require("../../models");
const { validateRequest, commonQuery, handleError, constants, Op, sequelize, ENTITIES, uploadFile } = require("../../helpers");
const { MODULES } = require("../../helpers/moduleEntitiesConstants");

/**
 * Creates a new Custom Field.
 */
exports.create = async (req, res) => {
  const transaction = await sequelize.transaction();

  try {
    const POST = req.body;

    const entity_id = MODULES.EMPLOYEE.ID;

    // 1. Basic Validation (field_name removed)
    const requiredFields = {
      field_label: "Field Label",
      field_type: "Field Type"
    };

    const errors = await validateRequest(POST, requiredFields, {}, transaction);
    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, { errors });
    }

    // 2. Generate snake_case slug from label
    POST.field_name = generateSnakeCase(POST.field_label);

    // 3. Ensure Options are valid for Select/Radio types
    if (['select', 'radio'].includes(POST.field_type)) {
        if (!POST.options || !Array.isArray(POST.options) || POST.options.length === 0) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, { errors: "Options are required for Select/Radio types." });
        }
    }

    if (POST.field_type === 'image' && req.files) {
      let uploadedFile = null;

      if (Array.isArray(req.files)) {
        uploadedFile = req.files.find(f => f.fieldname === "default_value");
      } else if (req.files?.default_value) {
        uploadedFile = Array.isArray(req.files.default_value)
          ? req.files.default_value[0]
          : req.files.default_value;
      }

      if (uploadedFile) {
        // Fix upload request structure
        const imageReq = {
          ...req,
          files: {
            default_value: [uploadedFile]
          }
        };

        const uploadResult = await uploadFile(
          imageReq,
          res,
          constants.CUSTOM_FIELD_IMG_FOLDER,
          transaction
        );
        
        if (uploadResult && uploadResult.default_value) {
          POST.default_value = uploadResult.default_value;
        }
      }
    } 

    // 4. Create Record
    const customField = await commonQuery.createRecord(CustomField, {...POST, entity_id}, transaction);

    if (!customField) {
      await transaction.rollback();
      return res.error(constants.DATABASE_ERROR, { errors: constants.FAILED_TO_CREATE_RECORD });
    }

    await transaction.commit();
    return res.success(constants.RECORD_CREATED, customField);

  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};

/**
 * Retrieves a paginated list of Custom Fields.
 */
exports.getAll = async (req, res) => {
  try {
    const fieldConfig = [
      ["field_label", true, true],
      ["field_name", true, true],
      // ["field_type", true, true],
      // ["module_name", true, false], 
      ["entity_name", true, false]  
    ];

    const data = await commonQuery.fetchPaginatedData(
      CustomField,
      req.body,
      fieldConfig,
      {
        include: [
          // { model: ModuleMaster, as: "module", attributes: [] },
          { model: ModuleEntityMaster, as: "entity", attributes: [] },
          { model: User, as: "user", attributes: [] }
        ],
        attributes: [
            "id",
            "field_label",
            "field_name",
            "field_type",
            "is_mandatory",
            "is_readonly",
            "priority",
            "status",
            "created_at",
            // "module_id", 
            "entity_id",
            // "module.module_name",
            "entity.entity_name",
            "user.user_name"
        ],
        order: [["priority", "ASC"]]
      },
    );

    return res.ok(data);
  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * Retrieves a simplified list of Custom Fields for dropdowns.
 */
exports.dropdownList = async (req, res) => {
  try {
    const fieldConfig = [
      ["field_label", true, true],
    ];

    const data = await commonQuery.fetchPaginatedData(
      CustomField,
      { ...req.body, status: 0, limit: 100, entity_id: req.body.entity_id }, // Force Active status
      fieldConfig,
      { 
        include: [
            // { model: ModuleMaster, as: "module", attributes: [] },
            { model: ModuleEntityMaster, as: "entity", attributes: [] }
        ],
        attributes: ["id", "field_label", "field_name", "field_type", "is_mandatory", "is_readonly", "default_value", "placeholder", "options", "validation_regex", "priority", "description", "status", "entity_id", "entity.entity_name"] 
      },
    );

    if (data && data.items) { 
      data.items = data.items.map(record => { 
        const item = record.toJSON ? record.toJSON() : record;

        if (item.field_type === 'image' && item.default_value) {
          item.image_url = `${process.env.FILE_SERVER_URL}${constants.CUSTOM_FIELD_IMG_FOLDER}${item.default_value}`;
        } else {
          item.image_url = null;
        }
        
        return item;
      });
    }

    return res.ok(data);
  } catch (err) {
    return handleError(err, res, req);
  }
};


/**
 * Retrieves a single Custom Field by ID.
 */
exports.getById = async (req, res) => {
    try {
        const { id } = req.params;

        const record = await commonQuery.findOneRecord(
            CustomField, 
            id, 
            {
                include: [
                    // { model: ModuleMaster, as: "module", attributes: [] },
                    { model: ModuleEntityMaster, as: "entity", attributes: [] }
                ],
                attributes: ["id", "field_label", "field_name", "field_type", "is_mandatory", "is_readonly", "default_value", "placeholder", "options", "validation_regex", "priority", "description", "status", "entity_id", "entity.entity_name"]
            },
        );
        
        if (!record || record.status === 2) return res.error(constants.NOT_FOUND);

        const response = { ...record.toJSON() };
        
        if (response.field_type === 'image' && response.default_value) {
            response.image_url = `${process.env.FILE_SERVER_URL || ''}${constants.CUSTOM_FIELD_IMG_FOLDER}${response.default_value}`;
        } else {
            response.image_url = null;
        }

        return res.ok(response);
    } catch (err) {
        return handleError(err, res, req);
    }
};

/**
 * Updates an existing Custom Field.
 */
exports.update = async (req, res) => {
  const transaction = await sequelize.transaction();

  try {
    const { id } = req.params;
    const POST = req.body;

    const requiredFields = {
      field_label: "Field Label",
      field_type: "Field Type"
    };

    const errors = await validateRequest(POST, requiredFields);
    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, { errors });
    }

    const existingField = await commonQuery.findOneRecord(CustomField, id, {}, transaction);

    if (!existingField) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }

    // If label changed, update slug automatically
    if(POST.field_label && POST.field_label !== existingField.field_label) {
        POST.field_name = generateSnakeCase(POST.field_label);
    }

    // Handle image upload/update
    if (POST.field_type === 'image' && req.files) {
      let uploadedFile = null;

      if (Array.isArray(req.files)) {
        uploadedFile = req.files.find(f => f.fieldname === "default_value");
      } else if (req.files?.default_value) {
        uploadedFile = Array.isArray(req.files.default_value)
          ? req.files.default_value[0]
          : req.files.default_value;
      }

      if (uploadedFile) {
        // Fix upload request structure
        const imageReq = {
          ...req,
          files: {
            default_value: [uploadedFile]
          }
        };

        const uploadResult = await uploadFile(
          imageReq,
          res,
          constants.CUSTOM_FIELD_IMG_FOLDER,
          transaction,
          existingField.default_value
        );
        
        if (uploadResult && uploadResult.default_value) {
          POST.default_value = uploadResult.default_value;
        }
      }
    }

    const updatedField = await commonQuery.updateRecordById(CustomField, id, POST, transaction);

    await transaction.commit();
    return res.success(constants.RECORD_UPDATED, updatedField);
  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};

/**
 * Soft deletes Custom Fields.
 */
exports.delete = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
      const { ids } = req.body;

      if (!Array.isArray(ids) || ids.length === 0) {
        await transaction.rollback();
        return res.error(constants.VALIDATION_ERROR, { errors: [constants.REQUIRED] });
      }
      
      const count = await commonQuery.softDeleteById(CustomField, ids, transaction);
      
      if (count === 0) {
          await transaction.rollback();
          return res.error(constants.NO_RECORDS_FOUND);
      }
  
      await transaction.commit();
      return res.success(constants.RECORD_DELETED);
    } catch (err) {
      if (!transaction.finished) await transaction.rollback();
      return handleError(err, res, req);
    }
};

/**
 * Updates the priorities of multiple Custom Fields in batch.
 */
exports.updatePriorities = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { priorities } = req.body;

    if (!Array.isArray(priorities) || priorities.length === 0) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, { errors: "Priorities list is required." });
    }

    for (const item of priorities) {
      const { id, priority } = item;
      if (id === undefined || priority === undefined) continue;

      await commonQuery.updateRecordById(
        CustomField, 
        id, 
        { priority }, 
        transaction,
        false, // No need to reload
        true   // Apply tenant fields (company_id etc)
      );
    }

    await transaction.commit();
    return res.success(constants.RECORD_UPDATED);
  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};


/**
 * Updates the status of Custom Fields.
 */
exports.updateStatus = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { status, ids } = req.body;
    
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
      return res.error(constants.VALIDATION_ERROR, { errors: [constants.REQUIRED] });
    }

    // Validate that status is provided and valid (0,1,2 as per your definition)
    if (![0,1,2].includes(status)) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, { errors: ["Invalid status value"] });
    }

    // Update only the status field by id
    const updated = await commonQuery.updateRecordById(
      CustomField,
      ids,
      { status },
      transaction
    );

    if (!updated) {
      if (!transaction.finished) await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }

    await transaction.commit();
    return res.success(constants.RECORD_UPDATED, updated);
  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};

/**
 * Helper function to generate snake_case slug
 */
function generateSnakeCase(str) {
    if (!str) return '';
    return str
        .toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, '')    // Remove special characters
        .replace(/[\s_-]+/g, '_')    // Replace spaces/hyphens with underscore
        .replace(/^-+|-+$/g, '');    // Trim hyphens
}