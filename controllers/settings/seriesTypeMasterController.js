const { SeriesTypeMaster, ModuleEntityMaster, Quotation, DrawingMaster } = require("../../models");
const { sequelize, validateRequest, commonQuery, handleError, constants } = require("../../helpers");
const { generateSeriesNumber, generateRevisionSeries } = require("../../helpers/functions/commonFunctions");

const ensureSingleDefault = async (POST, transaction) => {
  if (POST.is_default === 1) {

    await commonQuery.updateRecordById(
      SeriesTypeMaster,
      { series_entity_id: POST.series_entity_id },
      { is_default: 2 },
      transaction
    );
  }
};

exports.create = async (req, res) => {
  const POST = req.body;
  const transaction = await sequelize.transaction();

  try {
    const requiredFields = {
      series_entity_id: "Entity Name",
      series_type_name: "Series Type Name",
    };

    const errors = await validateRequest(POST, requiredFields, {
      uniqueCheck: {
        model: SeriesTypeMaster,
        fields: ["series_type_name"],
        where: { series_entity_id: POST.series_entity_id }
      },
    }, transaction);


    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, { errors });
    }

    const existingDefault = await commonQuery.findOneRecord(
      SeriesTypeMaster,
      { series_entity_id: POST.series_entity_id, is_default: 1 },
      {},
      transaction
    )

    if (!existingDefault) {
      POST.is_default = 1;
    }

    // if (POST.series_entity_id) {
    //   req.body.entity_id = req.body.series_entity_id;
    // }

    await ensureSingleDefault(POST, transaction);
    const result = await commonQuery.createRecord(SeriesTypeMaster, POST, transaction);
    await transaction.commit();

    return res.success(constants.CREATED, result);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

exports.dropdownList = async (req, res) => {
  try {
    const record = await commonQuery.findAllRecords(
      SeriesTypeMaster,
      {
        series_entity_id: req.body.series_entity_id,
        company_id: req.body.company_id,
        branch_id: req.body.branch_id,
        user_id: req.body.user_id,
        status: 0
      },
      { 
        attributes: ["id", "series_type_name"],
        order: [["is_default", "ASC"]] 
      }
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
      ["series_type_name", true, true],
      ["series_format", true, true],
      ["format_value", true, true],
      ["entity_name", true, true],
      ["cust_entity_name", true, true],
    ];

    const data = await commonQuery.fetchPaginatedData(
      SeriesTypeMaster,
      req.body,
      fieldConfig,
      {
        include: [
          {
            model: ModuleEntityMaster,
            as: "entity",
            attributes: [],
          },
        ],
        attributes: [
          "id",
          "series_type_name",
          "series_format",
          "format_value",
          "end_format_value",
          "status",
          "entity.entity_name",
          "entity.cust_entity_name",
          "is_default"
        ],
        distinct: true,
      }
    );
    return res.ok(data);
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.getById = async (req, res) => {
  try {
    const record = await commonQuery.findOneRecord(SeriesTypeMaster, req.params.id);
    if (!record || record.status === 2) return res.error(constants.NOT_FOUND);
    return res.ok(record);
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.update = async (req, res) => {
  const POST = req.body;
  const transaction = await sequelize.transaction();
  try {
    const requiredFields = {
      series_entity_id: "Entity Name",
      series_type_name: "Series Type Name",
    };

    // Step 2: Validate the request
    const errors = await validateRequest(
      POST,
      requiredFields,
      {
        uniqueCheck: {
          model: SeriesTypeMaster,
          fields: ["series_type_name"],
          where: { series_entity_id: POST.series_entity_id },
          excludeId: req.params.id,
        },
      },
      transaction
    );

    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, { errors });
    }

    // // Step 3: Assign correct entity_id (if applicable)
    // if (req.body.series_entity_id) {
    //   req.body.entity_id = req.body.series_entity_id;
    // }

    // Step 4: Update the record
    await ensureSingleDefault(POST, transaction);
    const updated = await commonQuery.updateRecordById(
      SeriesTypeMaster,
      { id: req.params.id },
      POST,
      transaction
    );

    if (!updated || updated.status === 2) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }

    // Step 5: Commit changes
    await transaction.commit();
    return res.success(constants.UPDATED, updated);

  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Soft Delete
exports.delete = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const requiredFields = {
      ids: "Select Data",
    };

    const errors = await validateRequest(req.body, requiredFields, {}, transaction);
    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, { errors });
    }
    const { ids } = req.body; 

    if (!Array.isArray(ids) || ids.length === 0) {
      await transaction.rollback();
      return res.error(constants.INVALID_idS_ARRAY);
    }

    const deleted = await commonQuery.softDeleteById(
      SeriesTypeMaster,
      ids,
      transaction
    );

    if (!deleted) {
      await transaction.rollback();
      return res.error(constants.ALREADY_DELETED);
    }

    await transaction.commit();
    return res.success(constants.DELETED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Update Status of Module Master
exports.updateStatus = async (req, res) => {
  // const transaction = await sequelize.transaction();
  // try {
  //   const { status, ids } = req.body; // expecting status in request body

  //   const requiredFields = {
  //     ids: "Select Any One Data",
  //     status: "Select Status",
  //   };

  //   const errors = await validateRequest(req.body, requiredFields, {}, transaction);
  //   if (errors) {
  //     await transaction.rollback();
  //     return res.error(constants.VALIDATION_ERROR, { errors });
  //   }

  //   // Validate that ids is an array and not empty
  //   if (!Array.isArray(ids) || ids.length === 0) {
  //     await transaction.rollback();
  //     return res.error(constants.INVALID_idS_ARRAY);
  //   }

  //   // Update only the status field by id
  //   const updated = await commonQuery.updateRecordById(
  //     SeriesTypeMaster,
  //     ids,
  //     { status },
  //     transaction
  //   );

  //   if (!updated || updated.status === 2) {
  //     if (!transaction.finished) await transaction.rollback();
  //     return res.error(constants.NOT_FOUND);
  //   }

  //   await transaction.commit();
  //   return res.success(constants.SERIES_UPDATED, updated);
  // } catch (err) {
  //   if (!transaction.finished) await transaction.rollback();
  //   return handleError(err, res, req);
  // }
};

exports.updateDefault = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, { errors: constants.SELECT_AT_LEAST_ONE_RECORD });
    }

    const firstRecord = await commonQuery.findOneRecord(SeriesTypeMaster, ids[0]);
    if (!firstRecord) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }

    await ensureSingleDefault({ series_entity_id: firstRecord.series_entity_id, is_default: 1 }, transaction);

    const updated = await commonQuery.updateRecordById(
      SeriesTypeMaster,
      ids,
      { is_default: 1 },
      transaction
    );

    if (!updated) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }

    await transaction.commit();
    return res.success(constants.UPDATED, updated);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};


exports.generateSerires = async (req, res) => {
  const POST = req.body;
  const transaction = await sequelize.transaction();
  try {
    const requiredFields = {
      series_type_id: "Series Type",
      company_id: "Company"
    };

    const errors = await validateRequest(POST, requiredFields, {}, transaction);

    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    let response;
    if(POST.revise_type == 1 && POST.prev_id ) {
      let Model;
      if(POST.model_name === 'Quotation') {
          Model = Quotation;
        }
        else {
          Model = DrawingMaster;
        }
      if (!Model) {
        await transaction.rollback();
        return res.error(constants.VALIDATION_ERROR, `Invalid model name: ${POST.model_name}`);
      }
      response = await generateRevisionSeries(Model, POST.prev_id, transaction);
    } else {
      response = await generateSeriesNumber(POST.series_type_id, POST.company_id, transaction);
    }
    
    await transaction.commit();

    return res.ok(response);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};