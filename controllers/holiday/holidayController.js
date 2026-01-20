const { sequelize, handleError, validateRequest, commonQuery } = require("../../helpers");
const { constants } = require("../../helpers/constants");
const { Holiday } = require("../../models");



exports.create = async (req, res) => {
    const transaction = await sequelize.transaction();
    const POST = req.body;

    try {
        const requiredFields = {
            name: "Name",
        };

        const errors = await validateRequest(POST, requiredFields, {}, transaction);

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        await commonQuery.createRecord(Holiday, POST, transaction);
        await transaction.commit();
        return res.success(constants.HOLIDAY_CREATED);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

exports.update = async (req, res) => {
    const transaction = await sequelize.transaction();
    const POST = req.body;
    const { id } = req.params;

    try {
        const requiredFields = {
            name: "Name",
        };

        const errors = await validateRequest(POST, requiredFields, {}, transaction);

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        const existingHoliday = await commonQuery.findOneRecord(Holiday, { id });
        if (!existingHoliday) {
            await transaction.rollback();
            return res.error(constants.HOLIDAY_NOT_FOUND);
        }

        await commonQuery.updateRecordById(Holiday, id, POST, transaction);
        await transaction.commit();
        return res.success(constants.HOLIDAY_UPDATED);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};


exports.getAll = async (req, res) => {
    try {
        const fieldConfig = [
            ["name", true, true],
            ["date", true, true],
        ];

        const data = await commonQuery.fetchPaginatedData(
            Holiday,
            req.body,
            fieldConfig,
            {},
        );

        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getById = async (req, res) => {
    try {
        const record = await commonQuery.findOneRecord(Holiday, req.params.id);
        if (!record || record.status === 2) return res.error(constants.HOLIDAY_NOT_FOUND);

        return res.ok(record);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.dropdownList = async (req, res) => {
  try {
    const result = await commonQuery.findAllRecords(Holiday, { status: 0 });
    return res.ok(result);
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.delete = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const deleted = await commonQuery.softDeleteById(Holiday, req.params.id, transaction);
    if (!deleted) {
      await transaction.rollback();
      return res.error(constants.HOLIDAY_NOT_FOUND);
    }
    await transaction.commit();
    return res.success(constants.HOLIDAY_DELETED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

exports.updateStatus = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { status, ids } = req.body;

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

    // Validate that status is provided and valid (0,1,2 as per your definition)
    if (![0, 1, 2].includes(status)) {
      await transaction.rollback();
      return res.error(constants.INVALID_STATUS);
    }

    // Update only the status field by id
    const updated = await commonQuery.updateRecordById(
      Holiday,
      ids,
      { status },
      transaction
    );

    if (!updated || updated.status === 2) {
      if (!transaction.finished) await transaction.rollback();
      return res.error(constants.HOLIDAY_NOT_FOUND);
    }

    await transaction.commit();
    return res.success(constants.HOLIDAY_UPDATED);
  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};