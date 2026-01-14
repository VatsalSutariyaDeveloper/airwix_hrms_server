const { AccountCategoryMaster } = require("../../models");
const { validateRequest, commonQuery, handleError, sequelize } = require("../../helpers");
const { ENTITIES } = require("../../helpers/constants");

const ENTITY = ENTITIES.ACCOUNT_CATEGORY_MASTER.NAME;

// Create a new account category record
exports.create = async (req, res) => {
  const transaction = await sequelize.transaction();
  const POST = req.body;
  try {
    const requiredFields = {
      name: "Category Name",
      type: "Category Type"
    };

    const errors = await validateRequest(POST, requiredFields, {
      uniqueCheck: {
        model: AccountCategoryMaster,
        fields: ["name"],
        condition: { type: POST.type }
      },
      transaction
    });

    if (errors) {
      await transaction.rollback();
      return res.error("VALIDATION_ERROR", { errors });
    }

    const data = await commonQuery.createRecord(AccountCategoryMaster, POST, transaction);
    await transaction.commit();
    return res.success("CREATE", ENTITY, data);
  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Get account category record by ID
exports.getById = async (req, res) => {
  try {
    const record = await commonQuery.findOneRecord(
      AccountCategoryMaster,
      req.params.id
    );

    if (!record || record.status === 2) return res.error("NOT_FOUND");
    return res.success("FETCH", ENTITY, record);
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.getAll = async (req, res) => {
  const fieldConfig = [
    ["name", true, true],
    ["type", true, true],
    ["description", true, false],
  ];

  req.body.filter = {
    ...(req.body.filter || {}),
    status: 0,
  };

  // Call reusable function
  const data = await commonQuery.fetchPaginatedData(
    AccountCategoryMaster,
    req.body,
    fieldConfig,
    { attributes: ["id", "name", "type", "description", "parent_id","status"] },
    true
  );
  return res.success("FETCH", ENTITY, data);
};

// Get list of all active categories for dropdowns
exports.dropdownList = async (req, res) => {
  try {
    const record = await commonQuery.findAllRecords(
      AccountCategoryMaster,
      {
        ...req.body,
        status: 0,
      },
      { attributes: ["id", "name", "type", "description", "parent_id"], order: ["name"] }
    );
    return res.success("FETCH", ENTITY, record);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Update account category record by ID
exports.update = async (req, res) => {
  const transaction = await sequelize.transaction();
  const POST = req.body;
  try {
    const requiredFields = {
      name: "Category Name",
      type: "Category Type"
    };

    const errors = await validateRequest(POST, requiredFields, {
      uniqueCheck: {
        model: AccountCategoryMaster,
        fields: ["name"],
        condition: { type: POST.type }
      },
      transaction
    });

    if (errors) {
      await transaction.rollback();
      return res.error("VALIDATION_ERROR", { errors });
    }

    const data = await commonQuery.updateRecordById(AccountCategoryMaster, req.params.id, POST, transaction);
    await transaction.commit();
    return res.success("UPDATE", ENTITY, data);
  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
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
      return res.error("VALIDATION_ERROR", { errors });
    }
    const { ids } = req.body; // Accept array of ids

    // Validate that ids is an array and not empty
    if (!Array.isArray(ids) || ids.length === 0) {
      await transaction.rollback();
      return res.error("INVALID_idS_ARRAY");
    }

    const deleted = await commonQuery.softDeleteById(AccountCategoryMaster, ids, transaction);
    if (!deleted) {
      await transaction.rollback();
      return res.error("NOT_FOUND");
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
    const { ids, status } = req.body; // expecting status in request body

    const requiredFields = {
      ids: "Select Any One Data",
      status: "Select Status",
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
    if (![0, 1, 2].includes(status)) {
      await transaction.rollback();
      return res.error("VALIDATION_ERROR", {
        errors: ["Invalid status value"],
      });
    }

    // Update only the status field by id
    const updated = await commonQuery.updateRecordById(
      AccountCategoryMaster,
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
