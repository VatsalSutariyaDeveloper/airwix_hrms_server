const { BusinessTypeMaster } = require("../../models");
const { validateRequest, commonQuery,handleError, sequelize } = require("../../helpers");
const { ENTITIES } = require("../../helpers/constants");

const ENTITY = ENTITIES.BUSINESS_TYPE.NAME;

/**
 * Create business type
 */
exports.create = async (req, res) => {
  try {
    const requiredFields = {
      business_type_name: "Business Type Name",
    };

    const errors = await validateRequest(req.body, requiredFields, {
      uniqueCheck: {
        model: BusinessTypeMaster,
        fields: ["business_type_name"]
      }
    }, transaction);
    if (errors) {
      await transaction.rollback();
      return res.error("VALIDATION_ERROR", { errors });
    }
    const result = await commonQuery.createRecord(BusinessTypeMaster, req.body);
    return res.success("CREATE", ENTITY, result);
  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * Get business type by ID
 */
exports.getById = async (req, res) => {
  try {
    const record = await commonQuery.findOneRecord(BusinessTypeMaster, req.params.id);
    if (!record || record.status === 2) return res.error("NOT_FOUND");
    return res.success("FETCH", ENTITY, record);
  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * Update business type
 */
exports.update = async (req, res) => {
  try {
     const requiredFields = {
      business_type_name: "Business Type Name",
    };

    const errors = await validateRequest(req.body, requiredFields, {
        uniqueCheck: {
          model: BusinessTypeMaster,
          fields: ["business_type_name"],
          excludeId: req.params.id
        }
    });
    if (errors) {
      return res.error("VALIDATION_ERROR", { errors });
    }

    const updated = await commonQuery.updateRecordById(BusinessTypeMaster, req.params.id, req.body);
    if (!updated || updated.status === 2) return res.error("NOT_FOUND");
    return res.success("UPDATE", ENTITY, updated);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Get all active Data For listing with pagination and search
exports.getAll = async (req, res) => {

  const fieldConfig = [
    ["business_type_name", true, true],
  ];

  // Call reusable function
  const data = await commonQuery.fetchPaginatedData(
    BusinessTypeMaster,
    req.body,
    fieldConfig,
  );
  return res.success("FETCH", ENTITY, data);
};

// Get list of all Data for dropdowns.
exports.dropdownList = async (req, res) => {
  try {
    const record = await commonQuery.findAllRecords(
      BusinessTypeMaster,
      { 
        user_id: req.body.user_id,       
        branch_id: req.body.branch_id,
        company_id: req.body.company_id,
        status: 0
      },
      { attributes: ["id", "business_type_name"], order: ["business_type_name"] }
    );
    return res.success("FETCH", ENTITY, record);
  } catch (err) {
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
      return res.error("VALIDATION_ERROR", { errors });
    }
    const { ids } = req.body; // Accept array of ids
    
    // Validate that ids is an array and not empty
    if (!Array.isArray(ids) || ids.length === 0) {
      await transaction.rollback();
      return res.error("INVALID_idS_ARRAY");
    }
    
    const deleted = await commonQuery.softDeleteById(BusinessTypeMaster, ids, transaction);
    if (!deleted) {
      await transaction.rollback();
      return res.error("ALREADY_DELETED");
    }
    await transaction.commit();
    return res.success("DELETE", ENTITY);
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
      return res.error("VALIDATION_ERROR", { errors });
    }
    
    // Validate that ids is an array and not empty
    if (!Array.isArray(ids) || ids.length === 0) {
      await transaction.rollback();
      return res.error("INVALID_idS_ARRAY");
    }

    // Validate that status is provided and valid (0,1,2 as per your definition)
    if (![0,1,2].includes(status)) {
      await transaction.rollback();
      return res.error("VALIDATION_ERROR", { errors: ["Invalid status value"] });
    }

    // Update only the status field by id
    const updated = await commonQuery.updateRecordById(
      BusinessTypeMaster,
      ids,
      { status },
      transaction
    );

    if (!updated || updated.status === 2) {
      if (!transaction.finished) await transaction.rollback();
      return res.error("NOT_FOUND");
    }

    await transaction.commit();
    return res.success("UPDATE", ENTITY + " Status", updated);
  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};

