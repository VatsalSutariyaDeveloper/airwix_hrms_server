const { BranchMaster, CountryMaster, StateMaster, ZoneMaster, sequelize } = require("../../models");
const { validateRequest, commonQuery, handleError } = require("../../helpers");
const { ENTITIES } = require("../../helpers/constants");

const ENTITY = ENTITIES.BRANCH_MASTER.NAME;

// Create
exports.create = async (req, res) => {
  try {
    const requiredFields = {
      branch_name: "Branch Name",
      country_id: "Country",
      state_id: "State",
      city: "City",
      pincode: "Pincode",
      user_id: "User",
      company_id: "Company"
    };

    const errors = await validateRequest(req.body, requiredFields, {
      uniqueCheck: {
        model: BranchMaster,
        fields: ["branch_name"]
      },
      skipDefaultRequired: ["branch_id"],
    });

    if (errors) {
      return res.error("VALIDATION_ERROR", { errors });
    }

    const result = await commonQuery.createRecord(BranchMaster, req.body);
    return res.success("CREATE", ENTITY, result);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Update
exports.update = async (req, res) => {
  try {
    const requiredFields = {
      branch_name: "Branch Name",
      country_id: "Country",
      state_id: "State",
      city: "City",
      pincode: "Pincode",
      user_id: "User",
      company_id: "Company"
    };

    const errors = await validateRequest(req.body, requiredFields, {
      uniqueCheck: {
        model: BranchMaster,
        fields: ["branch_name"],
        excludeId: req.params.id
      }, 
      skipDefaultRequired: ["branch_id"],
    });

    if (errors) {
      return res.error("VALIDATION_ERROR", { errors });
    }

    const updated = await commonQuery.updateRecordById(BranchMaster, req.params.id, req.body);
    if (!updated || updated.status === 2) return res.error("NOT_FOUND");
    return res.success("UPDATE", ENTITY, updated);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Read by ID (with related data)
exports.getById = async (req, res) => {
  try {
    const record = await commonQuery.findOneRecord(BranchMaster,
      req.params.id,
       {
        include: [
          { model: CountryMaster, as: "country", attributes: [] },
          { model: StateMaster, as: "state", attributes: [] },
          { model: ZoneMaster, as: "zone", attributes: [] },
        ],
        attributes: [
          "id", "branch_name", "city", "pincode", "status",
          "country_id", ["country.country_name", "country_name"],
          "state_id", ["state.state_name", "state_name"],
          "zone_id", ["zone.zone_name", "zone_name"]
        ]
      }
    );

    if (!record || record.status === 2) return res.error("NOT_FOUND");
    return res.success("FETCH", ENTITY, record);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Get all with Pagination and Search
exports.getAll = async (req, res) => {
  try {
     const fieldConfig = [
      ["branch_name", true, true],
      ["city", true, true],
      ["country_name", true, true],
      ["state_name", true, true],
      ["zone_name", true, true],
    ];
    const data = await commonQuery.fetchPaginatedData(
      BranchMaster,
      req.body,
      fieldConfig,
      {
        include: [
          { model: CountryMaster, as: "country", attributes: [], required:false },
          { model: StateMaster, as: "state", attributes: [], required:false },
          { model: ZoneMaster, as: "zone", attributes: [], required:false },
        ],
        attributes: [
          "id", "branch_name", "city", "pincode", "status",
          ["country.country_name", "country_name"],
          ["state.state_name", "state_name"],
          ["zone.zone_name", "zone_name"]
        ]
      }
    );

    return res.success("FETCH", ENTITY, data);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Get list of all active Data for dropdowns.
exports.dropdownList = async (req, res) => {
  try {
    const record = await commonQuery.findAllRecords(
      BranchMaster,
      {
        status: 0
      },
      {
        attributes: ["id", "branch_name"],
        order: [
          ["branch_name", "ASC"]
        ]
      },
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
      ids: "Select Data"
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
    
    const deleted = await commonQuery.softDeleteById(BranchMaster, ids, transaction);
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
      status: "Select Status"
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

    // Update only the status field by id
    const updated = await commonQuery.updateRecordById(
      BranchMaster,
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
