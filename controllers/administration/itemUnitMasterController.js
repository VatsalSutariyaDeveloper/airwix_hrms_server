const { ItemUnitMaster } = require("../../models");
const { sequelize, validateRequest, commonQuery,handleError } = require("../../helpers");
const { ENTITIES, constants } = require("../../helpers/constants");

const ENTITY = ENTITIES.ITEM_UNIT_MASTER.NAME;


exports.create = async (req, res) => {
  const transaction = await sequelize.transaction();  
  try {
    const errors = await validateRequest(req.body, {
      unit_name: "Unit Name",
      user_id: "User",
      branch_id: "Branch",
      company_id: "Company"
    }, {
      uniqueCheck: {
        model: ItemUnitMaster,
        fields: ["unit_name"]
      }
    }, transaction);

    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    await commonQuery.createRecord(ItemUnitMaster, req.body, transaction);
    await transaction.commit();
    return res.success(constants.ITEM_UNIT_MASTER_CREATED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

exports.getAll = async (req, res) => {
  try {
    const result = await commonQuery.findAllRecords(ItemUnitMaster, { status: 0 }, {}, null, false);
    return res.ok(result);
  } catch (err) {
    return handleError(err, res, req);
  }
};


exports.dropdownList = async (req, res) => {
  try {
    const record = await commonQuery.findAllRecords(
      ItemUnitMaster,
      { 
        user_id: req.body.user_id,       
        branch_id: req.body.branch_id,
        company_id: req.body.company_id,
        status: 0
      },
      // { attributes: ["id", [sequelize.literal("CONCAT(unit_name, ' - ', unit_full_name)"), "unit_name"]] },
      { attributes: ["id", "unit_name", "unit_full_name"] },
      null,
      false
    );
    return res.ok(record);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Read All (status: 0 only)
exports.getAll = async (req, res) => {
  try {
    // key, isSearchable, isSortable
    const fieldConfig = [
      ["unit_name", true, true],
      ["unit_full_name", true, true],
    ];

    const data = await commonQuery.fetchPaginatedData(
      ItemUnitMaster,
      req.body,
      fieldConfig,
      {},
      false
    );
    return res.ok(data);
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.getById = async (req, res) => {
  try {
    const record = await commonQuery.findOneRecord(ItemUnitMaster, req.params.id);
    if (!record || record.status === 2) return res.error(constants.ITEM_UNIT_MASTER_NOT_FOUND);
    return res.ok(record);
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.update = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const errors = await validateRequest(req.body, {
      unit_name: "Unit Name",
      user_id: "User",
      branch_id: "Branch",
      company_id: "Company"
    }, {
      uniqueCheck: {
        model: ItemUnitMaster,
        fields: ["unit_name"],
        excludeId: req.params.id
      }
    });

    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    const updated = await commonQuery.updateRecordById(ItemUnitMaster, req.params.id, req.body);
    if (!updated || updated.status === 2){
      await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }

    await transaction.commit();
    return res.success(constants.ITEM_UNIT_MASTER_UPDATED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Soft delete Item Type Master by ID
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
    
    const deleted = await commonQuery.softDeleteById(ItemUnitMaster, ids, transaction);
    if (!deleted) {
      await transaction.rollback();
      return res.error(constants.ALREADY_DELETED);
    }

    await transaction.commit();
    return res.success(constants.ITEM_UNIT_MASTER_DELETED);
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
      return res.error(constants.VALIDATION_ERROR, errors);
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
      ItemUnitMaster,
      ids,
      { status },
      transaction
    );

    if (!updated || updated.status === 2) {
      if (!transaction.finished) await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }

    await transaction.commit();
    return res.success(constants.ITEM_UNIT_MASTER_UPDATED);
  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};