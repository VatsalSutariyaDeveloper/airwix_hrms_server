const { ModulePermissionTypeMaster, ModuleEntityMaster } = require("../../../models");
const { sequelize, validateRequest, commonQuery, handleError, constants } = require("../../../helpers");
const { clearPermissionTypeCache } = require("../../../helpers/permissionCache");

// Get All Module Permission Types
exports.dropdownList = async (req, res) => {
  try {
    const record = await commonQuery.findAllRecords(
      ModulePermissionTypeMaster,
      { 
        status: 0
      },
      { attributes: ["id", "permission_type_name"] },
      null,
      false
    );
    return res.ok(record);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Create Module Master Access Route
exports.create = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const requiredFields = {
      permission_type_name: "Permission Type Name",
      user_id: "User",
      branch_id: "Branch",
      company_id: "Company"
    };

    const errors = await validateRequest(req.body, requiredFields,
      {
        uniqueCheck: { model: ModulePermissionTypeMaster, fields: ["permission_type_name"] },
      },
      transaction
    );
    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }
    await commonQuery.createRecord(ModulePermissionTypeMaster, req.body, transaction);
    await transaction.commit();
    return res.success(constants.MODULE_PERMISSION_TYPE_CREATED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};


exports.getAll = async (req, res) => {
  // Define allowed fields for ModuleMaster
  const fieldConfig = [
    ["permission_type_name", true, true],
  ];

  const data = await commonQuery.fetchPaginatedData(
    ModulePermissionTypeMaster,
    req.body,
    fieldConfig,
    {},
    false
  );

  return res.ok(data);
};

// Get by ID
exports.getById = async (req, res) => {
  try {
    const record = await commonQuery.findOneRecord(ModulePermissionTypeMaster, req.params.id);
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
      permission_type_name: "Permission Type Name",
      user_id: "User",
      branch_id: "Branch",
      company_id: "Company"
    };

    const errors = await validateRequest(req.body, requiredFields,
      {
        uniqueCheck: { model: ModulePermissionTypeMaster, fields: ["permission_type_name"], excludeId: req.params.id },
      },
      transaction
    );

    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }
    
    const updated = await commonQuery.updateRecordById(ModulePermissionTypeMaster, req.params.id, req.body, transaction);
    if (!updated || updated.status === 2) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }
    
    clearPermissionTypeCache(updated.permission_type_name);
    await transaction.commit();
    return res.success(constants.MODULE_PERMISSION_TYPE_UPDATED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Delete

// Soft Delete Module Master
exports.delete = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const requiredFields = {
      ids: "Select Data",
    };

    const errors = await validateRequest(req.body, requiredFields, {}, transaction);
    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }
    const { ids } = req.body; // Accept array of ids

    // Validate that ids is an array and not empty
    if (!Array.isArray(ids) || ids.length === 0) {
      await transaction.rollback();
      return res.error(constants.INVALID_ID);
    }

    const deleted = await commonQuery.softDeleteById(
      ModulePermissionTypeMaster,
      ids,
      transaction
    );
    if (!deleted) {
      await transaction.rollback();
      return res.error(constants.ALREADY_DELETED);
    }
    await transaction.commit();
    return res.success(constants.MODULE_PERMISSION_TYPE_DELETED);
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
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    // Validate that ids is an array and not empty
    if (!Array.isArray(ids) || ids.length === 0) {
      await transaction.rollback();
      return res.error(constants.INVALID_ID);
    }

    // Update only the status field by id
    const updated = await commonQuery.updateRecordById(
      ModulePermissionTypeMaster,
      ids,
      { status },
      transaction
    );

    if (!updated || updated.status === 2) {
      if (!transaction.finished) await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }

    await transaction.commit();
    return res.success(constants.MODULE_PERMISSION_TYPE_UPDATED);
  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};