const { PrintPermission } = require("../../../models");
const { validateRequest, commonQuery,handleError, sequelize } = require("../../../helpers");
const { constants } = require("../../../helpers/constants");

// Create Print Permission
exports.create = async (req, res) => {
  const transaction = await sequelize.transaction();
  const requiredFields = {
    print_permission: "Print Permission",
    user_id: "User",
    branch_id: "Branch",
    company_id: "Company"
  };

  const errors = await validateRequest(req.body, requiredFields, {}, transaction);
  if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }

  try {
    await commonQuery.createRecord(PrintPermission, req.body, transaction);
    await transaction.commit();
    return res.success(constants.PRINT_PERMISSION_CREATED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Get All Print Permissions
exports.getAll = async (req, res) => {
  try {
    const result = await commonQuery.findAllRecords(PrintPermission, { status: 0 });
    return res.ok(result);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Get Print Permission by ID
exports.getById = async (req, res) => {
  try {
    const record = await commonQuery.findOneRecord(PrintPermission, req.params.id);
    if (!record || record.status === 2) return res.error(constants.NOT_FOUND);
    return res.ok(record);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Update Print Permission
exports.update = async (req, res) => {
  const transaction = await sequelize.transaction();
  const requiredFields = {
    print_permission: "Print Permission",
    user_id: "User",
    branch_id: "Branch",
    company_id: "Company"
  };

  const errors = await validateRequest(req.body, requiredFields, {}, transaction);
  if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }

  try {
    const updated = await commonQuery.updateRecordById(PrintPermission, req.params.id, req.body, transaction);
    if (!updated || updated.status === 2) return res.error(constants.NOT_FOUND);
    await transaction.commit();
    return res.success(constants.PRINT_PERMISSION_UPDATED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Soft Delete Print Permission
exports.delete = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const deleted = await commonQuery.softDeleteById(PrintPermission, req.params.id, transaction);
    if (!deleted) return res.error(constants.ALREADY_DELETED);
    await transaction.commit();
    return res.success(constants.PRINT_PERMISSION_DELETED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};
