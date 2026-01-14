const { CustomField, ModuleMaster, ModuleEntityMaster, User } = require("../../models");
const { validateRequest, commonQuery, handleError, constants, Op, sequelize } = require("../../helpers");

/**
 * Creates a new Custom Field.
 */
exports.create = async (req, res) => {
  const transaction = await sequelize.transaction();

  try {
    const POST = req.body;

    // 1. Basic Validation (field_name removed)
    const requiredFields = {
      module_id: "Module",
      entity_id: "Entity",
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

    // 4. Create Record
    const customField = await commonQuery.createRecord(CustomField, POST, transaction);

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
      ["field_type", true, true],
      ["module_name", true, false], 
      ["entity_name", true, false]  
    ];

    const data = await commonQuery.fetchPaginatedData(
      CustomField,
      req.body,
      fieldConfig,
      {
        include: [
          { model: ModuleMaster, as: "module", attributes: [] },
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
            "module_id", 
            "entity_id",
            "module.module_name",
            "entity.entity_name",
            "user.user_name"
        ]
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
      { ...req.body, status: 0, entity_id: req.body.entity_id }, // Force Active status
      fieldConfig,
      { 
        include: [
            { model: ModuleMaster, as: "module", attributes: [] },
            { model: ModuleEntityMaster, as: "entity", attributes: [] }
        ],
        attributes: ["id", "field_label", "field_name", "field_type", "is_mandatory", "is_readonly", "default_value", "placeholder", "options", "validation_regex", "priority", "description", "status", "module_id", "entity_id", "module.module_name", "entity.entity_name"] 
      },
    );

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
                    { model: ModuleMaster, as: "module", attributes: [] },
                    { model: ModuleEntityMaster, as: "entity", attributes: [] }
                ],
                attributes: ["id", "field_label", "field_name", "field_type", "is_mandatory", "is_readonly", "default_value", "placeholder", "options", "validation_regex", "priority", "description", "status", "module_id", "entity_id", "module.module_name", "entity.entity_name"]
            },
        );
        
        if (!record || record.status === 2) return res.error(constants.NOT_FOUND);

        return res.ok(record);
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

    delete POST.module_id;
    delete POST.entity_id;

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
      
      const count = await commonQuery.softDeleteById(CustomField, ids, req.body, transaction);
      
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