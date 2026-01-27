const { CountryMaster } = require("../../../models");
const { sequelize, validateRequest, commonQuery, handleError } = require("../../../helpers");
const { constants} = require("../../../helpers/constants");

// Create a new country
exports.create = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const requiredFields = {
            country_name: "Country Name",
            country_code: "Country Code",
            isd_code: "ISD Code",
        };
        const errors = await validateRequest(req.body, requiredFields, {
            uniqueCheck: { model: CountryMaster, fields: [["country_name","country_code"]] },
        }, transaction);

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        await commonQuery.createRecord(CountryMaster, req.body, transaction);
        await transaction.commit();
        return res.success(constants.COUNTRY_MASTER_CREATED);
    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Get all countries with pagination
exports.getAll = async (req, res) => {
    try {
        // key, isSearchable, isSortable
        const fieldConfig = [
            ["country_name", true, true],
            ["country_code", true, true],
            ["isd_code", true, true],
        ];

        const options = {
            attributes: ["id", "country_name", "country_code", "isd_code", "status"]
        };
        const data = await commonQuery.fetchPaginatedData(
            CountryMaster,
            req.body,
            fieldConfig,
            options,
            false
        );
        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// Get a list of countries for dropdowns with pagination and search
exports.dropdownList = async (req, res) => {
    try {

        // key, isSearchable, isSortable
        const fieldConfig = [
            ["country_name", true, true],
            ["country_code", true, true],
            ["isd_code", true, true],
        ];

        // 4. Set default sorting for dropdown: Alphabetical by country name
        if (!req.body.sortBy) {
            req.body.sortBy = "country_name";
            req.body.sortDirection = "ASC";
        }

        // 5. Call the reusable pagination function instead of findAllRecords
        const data = await commonQuery.fetchPaginatedData(
            CountryMaster,
            { ...req.body, status: 0 },
            fieldConfig,
            {attributes: ["id", "country_name", "isd_code", "country_code", "currency_id", "mask", "digit"]},
            false
        );
        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// Get a single country by ID
exports.getById = async (req, res) => {
    try {
        const record = await commonQuery.findOneRecord(CountryMaster, req.params.id);
        if (!record || record.status === 2) return res.error(constants.COUNTRY_MASTER_NOT_FOUND);
        return res.ok(record);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// Update a country by ID
exports.update = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.params;
        const requiredFields = {
            country_name: "Country Name",
            country_code: "Country Code",
            isd_code: "ISD Code",
        };
        const errors = await validateRequest(req.body, requiredFields, {
            uniqueCheck: { model: CountryMaster, fields: ["country_name","country_code"], excludeId: id },
        }, transaction);

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        const updated = await commonQuery.updateRecordById(CountryMaster, id, req.body, transaction);
        if (!updated) {
             await transaction.rollback();
             return res.error(constants.COUNTRY_MASTER_NOT_FOUND);
        }
        await transaction.commit();
        return res.success(constants.COUNTRY_MASTER_UPDATED);
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
      return res.error(constants.VALIDATION_ERROR, errors);
    }
    const { ids } = req.body; // Accept array of ids
    
    // Validate that ids is an array and not empty
    if (!Array.isArray(ids) || ids.length === 0) {
      await transaction.rollback();
      return res.error(constants.INVALID_IDS_ARRAY);
    }
    
    const deleted = await commonQuery.softDeleteById(CountryMaster, ids, transaction);
    if (!deleted) {
        await transaction.rollback();
        return res.error(constants.COUNTRY_MASTER_NOT_FOUND);
    }
    await transaction.commit();
    return res.success(constants.COUNTRY_MASTER_DELETED);
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

    const updated = await commonQuery.updateRecordById(
      CountryMaster,
      ids,
      { status },
      transaction
    );

    if (!updated) {
      await transaction.rollback();
      return res.error(constants.COUNTRY_MASTER_NOT_FOUND);
    }

    await transaction.commit();
    return res.success(constants.COUNTRY_MASTER_UPDATED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};
