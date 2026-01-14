const { PrintTypeMaster } = require("../../../models");
const { validateRequest, commonQuery,handleError, sequelize } = require("../../../helpers");
const { ENTITIES, constants } = require("../../../helpers/constants");

const ENTITY = ENTITIES.PRINT_TYPE.NAME;
// Create Print Type
exports.create = async (req, res) => {
  const transaction = await sequelize.transaction();
  const requiredFields = {
    print_type_name: "Print Type Name",
    user_id: "User",
    branch_id: "Branch",
    company_id: "Company"
  };

  const errors = await validateRequest(req.body, requiredFields, {
    uniqueCheck: {
      model: PrintTypeMaster,
      fields: ["print_type_name"]
    }
  }, transaction);

  if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors); 
    }

  try {
    await commonQuery.createRecord(PrintTypeMaster, req.body, transaction);
    await transaction.commit();
    return res.success(constants.PRINT_TYPE_MASTER_CREATED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Get All
exports.getAll = async (req, res) => {
  try {
    const result = await commonQuery.findAllRecords(PrintTypeMaster, { status: 0 });
    return res.ok(result);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Get by ID
exports.getById = async (req, res) => {
  try {
    const record = await commonQuery.findOneRecord(PrintTypeMaster, req.params.id);
    if (!record || record.status === 2) return res.error(constants.NOT_FOUND);
    return res.ok(record);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Update
exports.update = async (req, res) => {
  const transaction = await sequelize.transaction();
  const requiredFields = {
    print_type_name: "Print Type Name",
    user_id: "User",
    branch_id: "Branch",
    company_id: "Company"
  };

  const errors = await validateRequest(req.body, requiredFields, {
    uniqueCheck: {
      model: PrintTypeMaster,
      fields: ["print_type_name"],
      excludeId: req.params.id
    }
  }, transaction);

  if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors); 
    }

  try {
    const updated = await commonQuery.updateRecordById(PrintTypeMaster, req.params.id, req.body, transaction);
    if (!updated || updated.status === 2) return res.error(constants.NOT_FOUND);
    await transaction.commit();
    return res.success(constants.PRINT_TYPE_MASTER_UPDATED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Delete
exports.delete = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const deleted = await commonQuery.softDeleteById(PrintTypeMaster, req.params.id, transaction);
    if (!deleted) return res.error(constants.ALREADY_DELETED);
    await transaction.commit();
    return res.success(constants.PRINT_TYPE_MASTER_DELETED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};
