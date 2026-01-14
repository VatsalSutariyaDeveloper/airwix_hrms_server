const { CommonCategoryMaster } = require("../../models");
const { validateRequest, commonQuery,handleError } = require("../../helpers");
const { ENTITIES } = require("../../helpers/constants");

const ENTITY = ENTITIES.COMMON_CATEGORY.NAME;

// Create a new Common Category
exports.create = async (req, res) => {
  try {
    const requiredFields = {
      category_name: "Category Name",
      user_id: "User",
      branch_id: "Branch",
      company_id: "Company"
    };

    const errors = await validateRequest(req.body, requiredFields, {
      uniqueCheck: {
        model: CommonCategoryMaster,
        fields: ["category_name"],
      },
    });

    if (errors) {
      return res.error("VALIDATION_ERROR", { errors });
    }
    const result = await commonQuery.createRecord(CommonCategoryMaster, req.body);
    return res.success("CREATE", ENTITY, result);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Get all active Common Categories
exports.getAll = async (req, res) => {
  try {
    const result = await commonQuery.findAllRecords(CommonCategoryMaster, { status: 0 });
    return res.success("FETCH", ENTITY, result);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Get Common Category by ID
exports.getById = async (req, res) => {
  try {
    const record = await commonQuery.findOneRecord(CommonCategoryMaster, req.params.id);
    if (!record || record.status === 2) return res.error("NOT_FOUND");
    return res.success("FETCH", ENTITY, record);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Update Common Category by ID
exports.update = async (req, res) => {
  const requiredFields = {
    category_name: "Category Name",
    user_id: "User",
    branch_id: "Branch",
    company_id: "Company"
  };

  const errors = await validateRequest(req.body, requiredFields, {
    uniqueCheck: {
      model: CommonCategoryMaster,
      fields: ["category_name"],
      excludeId: req.params.id,
    },
  }, transaction);

  if (errors) {
      await transaction.rollback();
      return res.error("VALIDATION_ERROR", { errors });
    }

  try {
    const updated = await commonQuery.updateRecordById(CommonCategoryMaster, req.params.id, req.body);
    if (!updated || updated.status === 2) return res.error("NOT_FOUND");
    return res.success("UPDATE", ENTITY, updated);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Soft delete Common Category by ID
exports.delete = async (req, res) => {
  try {
    const deleted = await commonQuery.softDeleteById(CommonCategoryMaster, req.params.id);
    if (!deleted) return res.error("ALREADY_DELETED");
    return res.success("DELETE", ENTITY);
  } catch (err) {
    return handleError(err, res, req);
  }
};
