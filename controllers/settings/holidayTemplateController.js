const { sequelize, handleError, validateRequest, commonQuery } = require("../../helpers");
const { constants } = require("../../helpers/constants");
const { HolidayTemplate, HolidayTransaction } = require("../../models");


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

    const template = await commonQuery.createRecord(HolidayTemplate, POST, transaction);

    if (POST.holiday_transactions && Array.isArray(POST.holiday_transactions)) {
      for (const holidayTransaction of POST.holiday_transactions) {
        const transactionData = {
          ...holidayTransaction,
          template_id: template.id
        };
        await commonQuery.createRecord(HolidayTransaction, transactionData, transaction);
      }
    }

    await transaction.commit();
    return res.success(constants.HOLIDAY_TEMPLATE_CREATED);
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

    const existingHolidayTemplate = await commonQuery.findOneRecord(HolidayTemplate, id, {
      include: [{ model: HolidayTransaction, as: "holidayTransactions" }],
    }, transaction);

    if (!existingHolidayTemplate) {
      await transaction.rollback();
      return res.error(constants.HOLIDAY_TEMPLATE_NOT_FOUND);
    }

    await commonQuery.updateRecordById(HolidayTemplate, id, POST, transaction);

    if (POST.holiday_transactions) {
      await syncHolidayTransactions(id, POST.holiday_transactions, existingHolidayTemplate.holidayTransactions || [], transaction);
    }

    await transaction.commit();
    return res.success(constants.HOLIDAY_TEMPLATE_UPDATED);
  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};

exports.getAll = async (req, res) => {
  try {
    const fieldConfig = [
      ["name", true, true],
      ["start_period", true, true],
      ["end_period", true, true],
    ];

    const data = await commonQuery.fetchPaginatedData(
      HolidayTemplate,
      req.body,
      fieldConfig,
      {},
    );

    if (data.items && data.items.length > 0) {
      data.items = await Promise.all(
        data.items.map(async (item) => {
          const holiday_count = await commonQuery.countRecords(HolidayTransaction, {
            template_id: item.id
          });

          return {
            ...(item.toJSON ? item.toJSON() : item),
            holiday_count
          };
        })
      );
    }

    return res.ok(data);
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.getById = async (req, res) => {
  try {
    const record = await commonQuery.findOneRecord(HolidayTemplate, req.params.id, {
      include: [
        {
          model: HolidayTransaction,
          as: 'holidayTransactions',
          required: false,
          attributes: ['id', 'template_id', 'name', 'date', 'holiday_type', 'color', 'status'],

        }
      ]
    });
    if (!record || record.status === 2) return res.error(constants.HOLIDAY_TEMPLATE_NOT_FOUND);

    return res.ok(record);
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.dropdownList = async (req, res) => {
  try {
    const result = await commonQuery.findAllRecords(HolidayTemplate, { status: 0 }, {
      include: [
        {
          model: HolidayTransaction,
          as: 'holidayTransactions',
          required: false,
          attributes: ['id', 'template_id', 'name', 'date', 'status'],
        },
      ]
    });
    return res.ok(result);
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.delete = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
      const { ids } = req.body;

      if (!Array.isArray(ids) || ids.length === 0) {
        await transaction.rollback();
        return res.error(constants.SELECT_AT_LEAST_ONE_RECORD);
      }
      
      const holidayTemplateCount = await commonQuery.softDeleteById(HolidayTemplate, ids, null, transaction);
      if (holidayTemplateCount === 0) {
          await transaction.rollback();
          return res.error(constants.NO_RECORDS_FOUND);
      }
      
      await commonQuery.softDeleteById(HolidayTransaction, { template_id: ids }, null, transaction);
     
      await transaction.commit();
      return res.success(constants.HOLIDAY_TEMPLATE_DELETED);
    } catch (err) {
      if (!transaction.finished) await transaction.rollback();
      return handleError(err, res, req);
    }
};

exports.updateStatus = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { status, ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      await transaction.rollback();
      return res.error(constants.SELECT_AT_LEAST_ONE_RECORD);
    }

    const updated = await commonQuery.updateRecordById(
      HolidayTemplate,
      ids,
      { status },
      transaction
    );

    if (!updated) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }

    await commonQuery.updateRecordById(HolidayTransaction, { template_id: ids }, { status }, transaction);

    await transaction.commit();
    return res.success(constants.HOLIDAY_TEMPLATE_UPDATED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Helper function to sync holiday transactions
async function syncHolidayTransactions(templateId, incomingTransactions, existingTransactions, transaction) {
  const incomingData = incomingTransactions || [];
  const incomingIds = incomingData.map(d => d.id).filter(Boolean);
  
  // Use existing transactions passed from controller instead of fetching again
  const transactionsToDelete = existingTransactions.filter(att => !incomingIds.includes(att.id));
  for (const transactionToDelete of transactionsToDelete) {
    await commonQuery.softDeleteById(HolidayTransaction, { id: transactionToDelete.id }, transaction);
  }
  
  // Process each transaction from request
  for (const transactionData of incomingData) {
    const dbPayload = {
      name: transactionData.name,
      date: transactionData.date,
      holiday_type: transactionData.holiday_type || 1,
      color: transactionData.color || "#E11D48",
      template_id: templateId
    };
    
    if (transactionData.id) {
      // Update existing transaction
      await commonQuery.updateRecordById(HolidayTransaction, transactionData.id, dbPayload, transaction);
    } else {
      // Create new transaction
      await commonQuery.createRecord(HolidayTransaction, dbPayload, transaction);
    }
  }
}