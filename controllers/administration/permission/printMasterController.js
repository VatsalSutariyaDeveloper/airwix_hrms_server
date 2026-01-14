const { PrintMaster } = require("../../../models");
const { validateRequest, commonQuery,handleError, sequelize } = require("../../../helpers");
const { constants } = require("../../../helpers/constants");

// Create Print Master
exports.create = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const requiredFields = {
      print_type_id: "Print Type",
      print_name: "Print Name",
      icon_name: "Icon Name",
      page_path: "Page Path",
      color_code: "Color Code",
      priority: "Priority",
      approve_status: "Approve Status",
      without_logo: "Without Logo",
      user_id: "User",
      branch_id: "Branch",
      company_id: "Company"
    };

    const errors = await validateRequest(req.body, requiredFields, {}, transaction);
    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }
    await commonQuery.createRecord(PrintMaster, req.body);
    await transaction.commit();
    return res.success(constants.PRINT_MASTER_CREATED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Get All
exports.getAll = async (req, res) => {
  try {
    const result = await commonQuery.findAllRecords(PrintMaster, { status: 0 });
    return res.ok(result);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Get by ID
exports.getById = async (req, res) => {
  try {
    const record = await commonQuery.findOneRecord(PrintMaster, req.params.id);
    if (!record || record.status === 2) return res.error(constants.NOT_FOUND);
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
      print_type_id: "Print Type",
      print_name: "Print Name",
      icon_name: "Icon Name",
      page_path: "Page Path",
      color_code: "Color Code",
      priority: "Priority",
      approve_status: "Approve Status",
      without_logo: "Without Logo",
      user_id: "User",
      branch_id: "Branch",
      company_id: "Company"
    };

    const errors = await validateRequest(req.body, requiredFields, {}, transaction);
    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }
    const updated = await commonQuery.updateRecordById(PrintMaster, req.params.id, req.body);
    if (!updated || updated.status === 2) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }
    await transaction.commit();
    return res.success(constants.PRINT_MASTER_UPDATED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Delete
exports.delete = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const deleted = await commonQuery.softDeleteById(PrintMaster, req.params.id);
    if (!deleted) return res.error(constants.ALREADY_DELETED);
    await transaction.commit();
    return res.success(constants.PRINT_MASTER_DELETED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};
