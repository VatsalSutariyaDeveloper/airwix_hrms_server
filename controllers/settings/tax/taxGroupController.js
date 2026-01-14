const { TaxGroup, TaxGroupTransaction, sequelize, Taxes, TaxTypeMaster } = require("../../../models");
const { validateRequest, handleError, commonQuery, constants, Op, fixNum } = require("../../../helpers");
const { fixDecimals } = require("../../../helpers/functions/commonFunctions");

// Create TaxGroup
exports.create = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const requiredFields = {
      tax_group_name: "Group Name",
    };
    
    const errors = await validateRequest(req.body, requiredFields, {
      uniqueCheck: {
        model: TaxGroup,
        fields: ["tax_group_name"],
      },
    }, transaction);

    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    if (!Array.isArray(req.body.transactions) || req.body.transactions.length === 0) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, constants.AT_LEAST_ONE_TAX);
    }
    
    const result = await commonQuery.createRecord(TaxGroup, req.body, transaction);

    // child transactions
    if (req.body.transactions && Array.isArray(req.body.transactions)) {
      await commonQuery.bulkCreate(
        TaxGroupTransaction,
        req.body.transactions,
        {
          tax_group_id: result.id,
          user_id: req.body.user_id,
          branch_id: req.body.branch_id,
          company_id: req.body.company_id,
        },
        transaction
      );
    }

    await transaction.commit();
    return res.success(constants.TAX_GROUP_CREATED, result);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

exports.dropdownList = async (req, res) => {
  try {
    const { user_id, branch_id, company_id } = req.body;

    const records = await commonQuery.findAllRecords(
      TaxGroup,
      {
        user_id,
        branch_id,
        company_id,
        status: 0,
      },
      {
        include: [
          {
            model: TaxGroupTransaction,
            as: "transactions",
            where: {status: 0},
            attributes: [],
            required: false,
            include: [
              {
                model: Taxes,
                as: "taxes",
                where: {status: 0},
                attributes: [],
                required: false,
                include: [
                  {
                    model: TaxTypeMaster,
                    as: "taxType",
                    attributes: [], // hide taxType fields
                    required: false,
                  },
                ],
              },
            ],
          },
        ],
        attributes: [
          "id",
          "tax_group_name",
          [sequelize.col("transactions.taxes.taxType.tax_type"), "tax_type"],
        ],
        group: ["TaxGroup.id", "transactions.taxes.taxType.tax_type"],
      },
      null,
      false
    );

    return res.ok(records);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Get All (with pagination + filters)
exports.getAll = async (req, res) => {
  try {
    const fieldConfig = [
      ["tax_group_name", true, true],
    ];

    const data = await commonQuery.fetchPaginatedData(
      TaxGroup,
      req.body,
      fieldConfig,
      {
        attributes: [
          "id",
          "tax_group_name",
          "group_value",
          "status",
        ],
        raw: true,
        distinct: true,
      },
      false
    );

    return res.ok(data);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Get By ID (with child transactions)
exports.getById = async (req, res) => {
  try {
    const record = await commonQuery.findOneRecord(TaxGroup, req.params.id, {
        include: [{
        model: TaxGroupTransaction,
        as: "transactions",
        attributes: ['tax_group_id', 'tax_id'],
        include: [{
          model: Taxes,
          as: 'taxes',
          attributes: ['tax_name','tax_value']
        }]
      }],
     });
    if (!record || record.status === 2) return res.error(constants.NOT_FOUND);

    const formattedRecord = record.get({ plain: true });
      console.log(formattedRecord);
    formattedRecord.transactions = formattedRecord.transactions.map(trx => {
      return {
        ...trx,
        tax_id: trx.tax_id,
        tax_value: fixNum(trx.taxes ? trx.taxes.tax_value : 0),
        tax_name: trx.taxes ? trx.taxes.tax_name : null,
        taxes: undefined 
      };
    });
console.log("after",formattedRecord);
    return res.ok(formattedRecord);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// 🔹 Update
exports.update = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const requiredFields = {
      tax_group_name: "Group Name",
    };

    const errors = await validateRequest(req.body, requiredFields, {
      uniqueCheck: {
        model: TaxGroup,
        fields: ["tax_group_name"],
        excludeId: req.params.id,
      },
    }, transaction);
    
    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    // Added validation for transactions
    if (!Array.isArray(req.body.transactions) || req.body.transactions.length === 0) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, constants.AT_LEAST_ONE_TAX);
    }

    const updated = await commonQuery.updateRecordById(
      TaxGroup,
      req.params.id,
      req.body,
      transaction
    );

    if (!updated) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }

    // replace child transactions
    const newData = req.body.transactions || [];
    const incomingIds = newData.map((d) => d.id).filter(Boolean);
  
    await commonQuery.softDeleteById(
      TaxGroupTransaction,
      { tax_group_id: req.params.id, id: { [Op.notIn]: incomingIds } },
      null,
      transaction
    ); 

    const extraFields = {
      user_id: req.body.user_id,
      branch_id: req.body.branch_id,
      company_id: req.body.company_id,
    };
  
    for (const record of newData) {
      if (record.id) {
        await commonQuery.updateRecordById(
          TaxGroupTransaction,
          record.id,
          { ...record, ...extraFields },
          transaction
        );
      } else {
        await commonQuery.createRecord(
          TaxGroupTransaction,
          { ...record, ...extraFields, tax_group_id: req.params.id },
          transaction
        );
      }
    }

    await transaction.commit();
    return res.success(constants.TAX_GROUP_UPDATED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// 🔹 Soft Delete
exports.delete = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const errors = await validateRequest(req.body, { ids: "Select Data" }, {}, transaction);
    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      await transaction.rollback();
      return res.error(constants.INVALID_INPUT);
    }

    const deleted = await commonQuery.softDeleteById(TaxGroup, ids, transaction);
    await commonQuery.softDeleteById(TaxGroupTransaction, { tax_group_id : { [Op.in] : ids } }, transaction);
    
    if (!deleted) {
      await transaction.rollback();
      return res.error(constants.ALREADY_DELETED);
    }

    await transaction.commit();
    return res.success(constants.TAX_GROUP_DELETED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// 🔹 Update Status
exports.updateStatus = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { status, ids } = req.body;

    const errors = await validateRequest(req.body, {
      ids: "Select Any One Data",
      status: "Select Status",
    }, {}, transaction);

    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    if (![0, 1].includes(status)) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, ["Invalid status value"]);
    }

    const updated = await commonQuery.updateRecordById(
      TaxGroup,
      ids,
      { status },
      transaction
    );

    await commonQuery.updateRecordById(
      TaxGroupTransaction,
      { tax_group_id : { [Op.in] : ids } },
      { status },
      transaction
    );

    if (!updated) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }

    await transaction.commit();
    return res.success(constants.TAX_GROUP_UPDATED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

exports.getGroupRates = async (req, res) => {
  try {
    const records = await commonQuery.findAllRecords(
      TaxGroup,
      {
        status: 0,
        group_value: { [Op.ne]: null, [Op.gte]: 0 },
        company_id: req.body.company_id,
        branch_id: req.body.branch_id,
        user_id: req.body.user_id,
      },
      {
        include: [
          {
            model: TaxGroupTransaction,
            as: "transactions",
            attributes: [],
            required: false,
            include: [
              {
                model: Taxes,
                as: "taxes",
                attributes: [],
                required: false,
                include: [
                  {
                    model: TaxTypeMaster,
                    as: "taxType",
                    attributes: [],
                    required: false,
                  },
                ],
              },
            ],
          },
        ],
        attributes: [
          "id",
          "tax_group_name",
          [sequelize.col("group_value"), "rate"],
          [sequelize.col("transactions.taxes.taxType.tax_type"), "tax_type"],
        ],
        group: ["group_value", "tax_group_name", "transactions.taxes.taxType.tax_type", "TaxGroup.id"],
        order: [
           [sequelize.literal("CASE WHEN tax_group_name LIKE '%Nil%' OR tax_group_name LIKE '%Exempt%' THEN 1 ELSE 0 END"), 'ASC'],
           ["group_value", "ASC"]
        ],
      },
      null,
      false
    );

    const plainRecords = records.map((r) => r.get({ plain: true }));

    // Step 1: Map and fix decimals
    const formatted = await Promise.all(
      plainRecords.map(async (record) => {
        const fixedRate = fixNum(record.rate);
        const name = record.tax_group_name;

        const isSpecial = ["Nil Rated", "Exempted", "Nil", "Exempt"].some(val => name.includes(val));

        return {
          rate: record.rate,
          label: isSpecial ? name : `${fixedRate} %`, 
          groupKey: isSpecial ? name : record.rate, 
          value: record.rate,
          tax_type: record.tax_type?.toLowerCase() || null,
          id: record.id,
        };
      })
    );

    // Step 2: Group by unique key and merge intra/inter IDs
    const merged = Object.values(
      formatted.reduce((acc, item) => {
        const key = item.groupKey; 

        if (!acc[key]) {
          acc[key] = {
            label: item.label,
            value: item.value,
            intra_tax_group_id: null,
            inter_tax_group_id: null,
          };
        }

        if (item.tax_type === "intra") {
          acc[key].intra_tax_group_id = item.id;
        } else if (item.tax_type === "inter") {
          acc[key].inter_tax_group_id = item.id;
        } else {
          if(!acc[key].intra_tax_group_id) acc[key].intra_tax_group_id = item.id;
        }

        return acc;
      }, {})
    );

    return res.ok(merged);
  } catch (err) {
    return handleError(err, res, req);
  }
};