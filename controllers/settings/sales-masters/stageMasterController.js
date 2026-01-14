const { StageMaster } = require("../../../models");
const {
  sequelize,
  validateRequest,
  commonQuery,
  handleError,
} = require("../../../helpers");

const { ENTITIES } = require("../../../helpers/constants");

const ENTITY = ENTITIES.STAGE.NAME;


// Create Stage Master
exports.create = async (req, res) => {
  const transaction = await sequelize.transaction();
  const POST = req.body;
  const requiredFields = {
    name: "Stage Name",
    user_id: "User",
    branch_id: "Branch",
    company_id: "Company",
  };

  const errors = await validateRequest(POST, requiredFields, {
    uniqueCheck: {
      model: StageMaster,
      fields: ["name"],
    },
  }, transaction);

  if (errors) {
      await transaction.rollback();
      return res.error("VALIDATION_ERROR", { errors });
    }

  try {
    await commonQuery.createRecord(StageMaster, POST);
    await transaction.commit();
    return res.success("CREATE", ENTITY);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Get Stage Master by ID
exports.getById = async (req, res) => {
  try {
    const record = await commonQuery.findOneRecord(StageMaster, req.params.id);
    if (!record || record.status === 2) return res.error("NOT_FOUND");
    return res.success("FETCH", ENTITY, record);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Update Stage Master
exports.update = async (req, res) => {
  const transaction = await sequelize.transaction();
  const POST = req.body;
  try {
    const requiredFields = {
      name: "Stage Name",
      user_id: "User",
      branch_id: "Branch",
      company_id: "Company",
    };

    const errors = await validateRequest(POST, requiredFields, {
      uniqueCheck: {
        model: StageMaster,
        fields: ["name"],
        excludeId: req.params.id,
      },
    });

    if (errors) {
      return res.error("VALIDATION_ERROR", { errors });
    }

    const updated = await commonQuery.updateRecordById(
      StageMaster,
      req.params.id,
      POST,
      transaction
    );
    if (!updated || updated.status === 2) return res.error("NOT_FOUND");
    await transaction.commit();
    return res.success("UPDATE", ENTITY, updated);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Get all active Data For listing with pagination and search
exports.getAll = async (req, res) => {
  const fieldConfig = [
    ["name", true, true],
    // ["address", true, false],
  ];

  // Call reusable function
  const data = await commonQuery.fetchPaginatedData(
    StageMaster,
    req.body,
    fieldConfig,
  );
  return res.success("FETCH", ENTITY, data);
};

// Get list of all Data for dropdowns.
exports.dropdownList = async (req, res) => {
  try {
    const record = await commonQuery.findAllRecords(
      StageMaster,
      {
        user_id: req.body.user_id,
        branch_id: req.body.branch_id,
        company_id: req.body.company_id,
        ...(req.body.type ? { type: req.body.type } : {}),
        status: 0,
      },
      { attributes: ["id", "name"], order: ["id"] }
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
      return res.error("INVALID_idS_ARRAY");
    }

    const deleted = await commonQuery.softDeleteById(
      StageMaster,
      ids,
      transaction
    );
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
      StageMaster,
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
