const { CurrencyMaster } = require("../../models");
const { validateRequest, commonQuery, handleError, sequelize, getCompanySetting } = require("../../helpers");
const { default: axios } = require("axios");
const { constants } = require("../../helpers/constants");


// Create a new Currency 
exports.create = async (req, res) => {
  try {
    const transaction = await sequelize.transaction();
    const requiredFields = {
      currency_name: "Currency Name",
      currency_code: "Currency Code",
      currency_rate: "Currency Rate",
    };

    const errors = await validateRequest(req.body, requiredFields, {
      uniqueCheck: {
        model: CurrencyMaster,
        fields: ["currency_name"]
      }
    });

    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }
    await commonQuery.createRecord(CurrencyMaster, req.body, transaction);
    await transaction.commit();
    return res.success(constants.CURRENCY_MASTER_CREATED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Get all active Data For listing with pagination and search
exports.getAll = async (req, res) => {

  // key, isSearchable, isSortable
  const fieldConfig = [
    ["currency_name", true, true],
    ["currency_code", true, true],
    ["currency_rate", false, true],
  ];

  // Call reusable function
  const data = await commonQuery.fetchPaginatedData(
    CurrencyMaster,
    req.body,
    fieldConfig,
    null,
    false
  );
  return res.ok(data);
};

// Get a list of states for dropdowns with pagination and search
exports.dropdownList = async (req, res) => {
  try {
    // 1. Define fields searchable in the dropdown component (e.g., state name)
      const fieldConfig = [
          ["currency_name", true, true],
          ["currency_code", true, false],
        ];

    // 2. Define specific attributes to return for dropdown options
    const options = {
      attributes: ["id", "currency_name", "currency_code","currency_symbol"],
    };
    if (req.body.country_id) {
      if (!req.body.filter) {
        req.body.filter = {};
      }
      req.body.filter.country_id = req.body.country_id;
    }

    // 4. Set default sorting for dropdown: Alphabetical by state name.
    if (!req.body.sortBy) {
      req.body.sortBy = "currency_name";
      req.body.sortDirection = "ASC";
    }

    // 5. Call the reusable pagination function.
    const data = await commonQuery.fetchPaginatedData(
      CurrencyMaster,
      { ...req.body, status: 0 },
      fieldConfig,
      options,
      false,
    );
    return res.ok(data);
  } catch (err) {
    return handleError(err, res, req);
  }
};


// Get Data by ID (with optional Live Exchange Rate)
exports.getById = async (req, res) => {
  try {
    const { id, default_currency } = req.params;

    // 1. Fetch the target currency. This is needed in both cases.
    const record = await commonQuery.findOneRecord(CurrencyMaster, id, {}, null, false, false);

    if (!record || record.status === 2) {
      return res.error(constants.CURRENCY_MASTER_NOT_FOUND, { message: "Target currency not found." });
    }

    const responseData = record.get({ plain: true });
    if(responseData.currency_rate == 0){
      responseData.currency_rate = 1.00;    }

    // 2. Check if a default_currency was provided to compare against
    if (default_currency) {

      const baseCurrency = await commonQuery.findOneRecord(CurrencyMaster, default_currency, {}, null, false, false);

      if (!baseCurrency) {
        return res.error(constants.CURRENCY_MASTER_NOT_FOUND, { message: "Base currency for rate check not found." });
      }

      const targetCode = record.currency_code;
      const baseCode = baseCurrency.currency_code;

      // If the currencies are the same, the rate is 1
      if (targetCode === baseCode) {
        responseData.currency_rate = 1.00;
        return res.ok(responseData);
      }

      // Call the external API for the live rate
      try {
        const apiUrl = `https://api.frankfurter.app/latest?from=${targetCode}&to=${baseCode}`;
        const apiResponse = await axios.get(apiUrl);
        const liveRate = apiResponse.data.rates[baseCode];

        responseData.currency_rate = liveRate || 1.00; // Add the live rate

      } catch (apiError) {
        responseData.currency_rate = '1.00';
        responseData.rate_warning = "Could not fetch live currency rate. Defaulting to 1.";
      }
    }

    return res.ok(responseData);

  } catch (err) {
    return handleError(err, res, req);
  }
};

// Update Data by ID
exports.update = async (req, res) => {
  try {
    const requiredFields = {
      currency_name: "Currency Name",
      currency_code: "Currency Code",
      currency_rate: "Currency Rate",
    };

    const errors = await validateRequest(req.body, requiredFields, {
      uniqueCheck: {
        model: CurrencyMaster,
        fields: ["currency_name"],
        excludeId: req.params.id
      }
    });

    if (errors) {
      return res.error(constants.VALIDATION_ERROR, errors);
    }
    const updated = await commonQuery.updateRecordById(CurrencyMaster, req.params.id, req.body);
    if (!updated || updated.status === 2) return res.error(constants.NOT_FOUND);
    return res.success(constants.CURRENCY_MASTER_UPDATED);
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

    const deleted = await commonQuery.softDeleteById(CurrencyMaster, ids, transaction);
    if (!deleted) {
      await transaction.rollback();
      return res.error(constants.ALREADY_DELETED);
    }
    await transaction.commit();
    return res.success(constants.CURRENCY_MASTER_DELETED);
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
    if (![0, 1, 2].includes(status)) {
      await transaction.rollback();
      return res.error(constants.INVALID_STATUS);
    }

    // Update only the status field by id
    const updated = await commonQuery.updateRecordById(
      CurrencyMaster,
      ids,
      { status },
      transaction
    );

    if (!updated || updated.status === 2) {
      if (!transaction.finished) await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }

    await transaction.commit();
    return res.success(constants.CURRENCY_MASTER_UPDATED);
  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};
