const { HSNMaster } = require("../../models");
const { sequelize, validateRequest, commonQuery,handleError } = require("../../helpers");
const { constants } = require("../../helpers/constants");

// Create
exports.create = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const requiredFields = {
      hsn_code: "HSN Code",
      user_id: "User",
      company_id: "Company"
    };

    const errors = await validateRequest(req.body, requiredFields, {
      uniqueCheck: {
        model: HSNMaster,
        fields: ["hsn_code"]
      }
    }, transaction);

    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }
    
    await commonQuery.createRecord(HSNMaster, req.body, transaction);
    await transaction.commit();
    return res.success(constants.HSN_MASTER_CREATED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Update
exports.update = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const requiredFields = {
      hsn_code: "HSN Code",
      user_id: "User",
      company_id: "Company"
    };

    const errors = await validateRequest(req.body, requiredFields, {
      uniqueCheck: {
        model: HSNMaster,
        fields: ["hsn_code"],
        excludeId: req.params.id
      }
    }, transaction);

    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }
    const updated = await commonQuery.updateRecordById(HSNMaster, req.params.id, req.body);
    if (!updated || updated.status === 2) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }
    await transaction.commit();
    return res.success(constants.HSN_MASTER_UPDATED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Read by ID
exports.getById = async (req, res) => {
  try {
    const record = await commonQuery.findOneRecord(HSNMaster, req.params.id);

    if (!record || record.status === 2) {
      return res.error(constants.HSN_MASTER_NOT_FOUND);
    }

    return res.ok(record);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Get all active Data For listing with pagination and search
exports.getAll = async (req, res) => {
  try {

      const fieldConfig = [
        ["hsn_code", true, true],
        ["description", true, false],
        ["group_value", true, true], 
      ];

    const data = await commonQuery.fetchPaginatedData(
      HSNMaster,
      req.body,
      fieldConfig,
      null,
      false 
    );

    return res.ok(data);
  } catch (err) {
    return handleError(err, res, req);
  }
};


// Get list of all Data for dropdowns.
exports.dropdownList = async (req, res) => {

  try {
       const fieldConfig = [
        ["hsn_code", true, false], 
        ["description", true, false], 
      ];

      const data = await commonQuery.fetchPaginatedData(
        HSNMaster,
        req.body,
        fieldConfig,
        {
          attributes: ["id", "hsn_code","description"],
          order: [["hsn_code"]],
        },
        false
      );
      
      return res.ok(data);
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
      return res.error(constants.VALIDATION_ERROR, errors);
    }
    const { ids } = req.body; // Accept array of ids
    
    // Validate that ids is an array and not empty
    if (!Array.isArray(ids) || ids.length === 0) {
      await transaction.rollback();
      return res.error(constants.INVALID_ID);
    }
    
    const deleted = await commonQuery.softDeleteById(HSNMaster, ids, transaction);
    if (!deleted) {
      await transaction.rollback();
      return res.error(constants.ALREADY_DELETED);
    }
    await transaction.commit();
    return res.success(constants.HSN_MASTER_DELETED);
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
      HSNMaster,
      ids,
      { status },
      transaction
    );

    if (!updated || updated.status === 2) {
      if (!transaction.finished) await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }

    await transaction.commit();
    return res.success(constants.HSN_MASTER_UPDATED);
  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};
