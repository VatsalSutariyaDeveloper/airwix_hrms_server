const { StateMaster, CountryMaster } = require("../../../models");
const { sequelize, validateRequest, commonQuery, handleError } = require("../../../helpers");
const { constants } = require("../../../helpers/constants");

// Create a new state
exports.create = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const requiredFields = {
            country_id: "Country",
            state_name: "State Name",
        };
        const errors = await validateRequest(req.body, requiredFields, {
            uniqueCheck: { model: StateMaster, fields: [["state_name", "country_id"]] },
        }, transaction);

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors );
        }

        await commonQuery.createRecord(StateMaster, req.body, transaction);
        await transaction.commit();
        return res.success(constants.STATE_MASTER_CREATED);
    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Get all states with pagination and country name
exports.getAll = async (req, res) => {
    try {
        const fieldConfig = [
            ["state_name", true, true],
            ["country_name", true, true],
        ];
        const options = {
            include: [{
                model: CountryMaster,
                as: 'country',
                attributes: []
            }],
            attributes: [
                "id",
                "state_name",
                "status",
                "country.country_name",
            ]
        };
        const data = await commonQuery.fetchPaginatedData(
            StateMaster,
            req.body,
            fieldConfig,
            options,
            null,
            false
        );
        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// Get a list of states for dropdowns with pagination and search
exports.dropdownList = async (req, res) => {
    try {
        // key, isSearchable, isSortable
        const fieldConfig = [
            ["state_name", true, true],
        ];
        
        if (req.body.country_id) {
            // Ensure req.body.filter exists before assigning to it
            if (!req.body.filter) {
                req.body.filter = {};
            }
            req.body.filter.country_id = req.body.country_id;
        }

        // 4. Set default sorting for dropdown: Alphabetical by state name.
        if (!req.body.sortBy) {
            req.body.sortBy = "state_name";
            req.body.sortDirection = "ASC";
        }

        // 5. Call the reusable pagination function.
        const data = await commonQuery.fetchPaginatedData(
            StateMaster,
            { ...req.body, status: 0 },
            fieldConfig,
            {attributes: ["id", "state_name"]},
            false
        );
        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// Get a single state by ID
exports.getById = async (req, res) => {
    try {
        const record = await commonQuery.findOneRecord(StateMaster, req.params.id);
        if (!record || record.status === 2) return res.error(constants.STATE_MASTER_NOT_FOUND);
        return res.ok(record);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// Update a state by ID
exports.update = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.params;
        const requiredFields = {
            country_id: "Country",
            state_name: "State Name",
        };
        const errors = await validateRequest(req.body, requiredFields, {
            uniqueCheck: { model: StateMaster, fields: [["state_name", "country_id"]], excludeId: id },
        }, transaction);

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors );
        }

        const updated = await commonQuery.updateRecordById(StateMaster, id, req.body, transaction);
        if (!updated) {
             await transaction.rollback();
             return res.error(constants.STATE_MASTER_NOT_FOUND);
        }
        await transaction.commit();
        return res.success(constants.STATE_MASTER_UPDATED);
    } catch (err) {
        await transaction.rollback();
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
      return res.error(constants.VALIDATION_ERROR, errors );
    }
    const { ids } = req.body; // Accept array of ids
    
    // Validate that ids is an array and not empty
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.error(constants.INVALID_IDS_ARRAY);
    }
    
    const deleted = await commonQuery.softDeleteById(StateMaster, ids, transaction);
    if (!deleted) {
        await transaction.rollback();
        return res.error(constants.STATE_MASTER_ALREADY_DELETED);
    }
    await transaction.commit();
    return res.success(constants.STATE_MASTER_DELETED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Update Status
exports.updateStatus = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { status, ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
        await transaction.rollback();
      return res.error(constants.SELECT_AT_LEAST_ONE_RECORD);
    }
    if (![0, 1].includes(status)) {
        await transaction.rollback();
        return res.error(constants.INVALID_STATUS);
    }

    const updated = await commonQuery.updateRecordById(
      StateMaster,
      ids,
      { status },
      transaction
    );

    if (!updated) {
      await transaction.rollback();
      return res.error(constants.STATE_MASTER_NOT_FOUND);
    }

    await transaction.commit();
    return res.success(constants.STATE_MASTER_UPDATED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};
