const { ModuleMaster, ModuleEntityMaster } = require("../../../models");
const { sequelize, validateRequest, commonQuery,handleError, getCompanySetting, constants } = require("../../../helpers");
const { Op } = require("sequelize");

exports.dropdownList = async (req, res) => {
  try {
    const record = await commonQuery.findAllRecords(
      ModuleMaster,
      { status: 0 },
      { attributes: ["id", "module_name"], order: ["module_name"] },
      null,
      false
    );
    return res.ok(record);
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.create = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const requiredFields = {
      module_name: "Module Name",
      cust_module_name: "Module Name For Parties",
      priority: "Module Order",
    };

    const errors = await validateRequest(req.body, requiredFields,
      {
        fieldTypes: { priority: "number" },
        uniqueCheck: { model: ModuleMaster, fields: ["module_name"] },
      },
      transaction
    );
    
    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors );
    }
    await commonQuery.createRecord(
      ModuleMaster,
      req.body,
      transaction
    );
    await transaction.commit();
    return res.success(constants.MODULE_CREATED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Get All Module Masters
exports.getAll = async (req, res) => {

  // key, isSearchable, isSortable
  const fieldConfig = [
    ["module_name", true, true],
    ["cust_module_name", true, true],
    ["module_icon_name", false, false],
  ];

  const data = await commonQuery.fetchPaginatedData(
    ModuleMaster,
    req.body,
    fieldConfig,
    {},
    false
  );
  return res.ok(data);
};

// Get Module Master by ID
exports.getById = async (req, res) => {
  try {
    const record = await commonQuery.findOneRecord(ModuleMaster, req.params.id, {}, null, false, false);
    if (!record || record.status == 2) return res.error(constants.NOT_FOUND);
    return res.ok(record);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Update Module Master
exports.update = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const requiredFields = {
      module_name: "Module Name",
      cust_module_name: "Module Name For Parties",
      priority: "Module Order",
    };

    const errors = await validateRequest(req.body, requiredFields,
      {
        fieldTypes: { priority: "number" },
        uniqueCheck: { model: ModuleMaster, fields: ["module_name"], excludeId: req.params.id },
      },
      transaction
    );
    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors );
    }
    const updated = await commonQuery.updateRecordById(ModuleMaster, req.params.id, req.body, transaction, false, false);
    if (!updated || updated.status === 2) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }
    await transaction.commit();
    return res.success(constants.MODULE_UPDATED, updated);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Soft Delete Module Master
// Soft Delete Module Master
exports.delete = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const requiredFields = {
      ids: "Select Data"
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

    // 1. Delete the Module(s)
    const deleted = await commonQuery.softDeleteById(ModuleMaster, ids, transaction, false);
    
    if (!deleted) {
      await transaction.rollback();
      return res.error(constants.ALREADY_DELETED);
    }

    // ------------------------------------------------------------------
    // 2. CASCADE DELETE: Delete associated Entities
    // ------------------------------------------------------------------
    // This looks for ModuleEntityMaster records where module_id is in the `ids` array
    // and sets their status to 2.
    await commonQuery.softDeleteById(
      ModuleEntityMaster, 
      { module_id: { [Op.in]: ids } }, 
      transaction,
      false
    );

    await transaction.commit();
    return res.success(constants.MODULE_DELETED);
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
      status: "Select Status"
    };

    const errors = await validateRequest(req.body, requiredFields, {}, transaction);
    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors );
    }
    
    // Validate that ids is an array and not empty
    if (!Array.isArray(ids) || ids.length === 0) {
      await transaction.rollback();
      return res.error(constants.INVALID_ID);
    }

    // Validate that status is provided and valid (0,1,2 as per your definition)
    if (![0,1,2].includes(status)) {
      await transaction.rollback();
      return res.error(constants.INVALID_STATUS);
    }

    // Update only the status field by id
    const updated = await commonQuery.updateRecordById(
      ModuleMaster,
      ids,
      { status },
      transaction
    );

    if (!updated || updated.status === 2) {
      if (!transaction.finished) await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }

    await transaction.commit();
    return res.success(constants.MODULE_UPDATED);
  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};




