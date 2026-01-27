const { CityMaster, StateMaster, CountryMaster } = require("../../../models"); // Added StateMaster and CountryMaster
const { validateRequest, commonQuery, handleError, sequelize } = require("../../../helpers");
const { constants } = require("../../../helpers/constants");

exports.create = async (req, res) => {
  const transaction = await sequelize.transaction();
  const requiredFields = {
    state_id: "State",
    city_name: "City Name",
  };

  const errors = await validateRequest(req.body, requiredFields, {
    skipDefaultRequired: ["company_id", "branch_id", "user_id"],
    uniqueCheck: {
      model: CityMaster,
      fields: ["city_name"]
    }
  }, transaction);

  if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors); 
    }

  try {
    await commonQuery.createRecord(CityMaster, req.body, transaction);
    await transaction.commit();
    return res.success(constants.CITY_MASTER_CREATED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

exports.getAll = async (req, res) => {
  try {
    const result = await commonQuery.findAllRecords(CityMaster, { status: 0 }, {
      include: [{
        model: StateMaster,
        as: 'state',
        attributes: ['id', 'state_name'],
        include: [{ 
          model: CountryMaster,
          as: 'country',
          attributes: ['id', 'country_name']
        }]
      }]
    }, null, false);
    return res.ok(result);
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.getById = async (req, res) => {
  try {
    const record = await commonQuery.findOneRecord(CityMaster, { id: req.params.id, status: 0 }, {
      include: [{
        model: StateMaster,
        as: 'state',
        attributes: ['id', 'state_name'],
        include: [{ 
          model: CountryMaster,
          as: 'country',
          attributes: ['id', 'country_name']
        }]
      }]
    }, null, false, false);
    if (!record) return res.error(constants.CITY_MASTER_NOT_FOUND);
    return res.ok(record);
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.update = async (req, res) => {
  const transaction = await sequelize.transaction();
  const requiredFields = {
    state_id: "State",
    city_name: "City Name",
  };

  const errors = await validateRequest(req.body, requiredFields, {
    skipDefaultRequired: ["company_id", "branch_id", "user_id"],
    uniqueCheck: {
      model: CityMaster,
      fields: ["city_name"],
      excludeId: req.params.id,
    }
  }, transaction);

  if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors); 
    }

  try {
    const updated = await commonQuery.updateRecordById(CityMaster, req.params.id, req.body, transaction);
    if (!updated) {
      await transaction.rollback();
      return res.error(constants.CITY_MASTER_NOT_FOUND);
    }
    await transaction.commit();
    return res.success(constants.CITY_MASTER_UPDATED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};  

exports.delete = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const deleted = await commonQuery.softDeleteById(CityMaster, req.params.id, transaction);
    if (!deleted) {
      await transaction.rollback();
      return res.error(constants.CITY_MASTER_NOT_FOUND);
    }
    await transaction.commit();
    return res.success(constants.CITY_MASTER_DELETED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};
