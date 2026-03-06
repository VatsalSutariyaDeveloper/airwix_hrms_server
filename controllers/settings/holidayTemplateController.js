const { sequelize, handleError, validateRequest, commonQuery } = require("../../helpers");
const { constants } = require("../../helpers/constants");
const { HolidayTemplate, HolidayTransaction, Employee } = require("../../models");
const EmployeeTemplateService = require("../../services/employeeTemplateService");


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

    const template = await commonQuery.createRecord(HolidayTemplate, POST, transaction, { company_id: true });

    if (POST.holiday_transactions && Array.isArray(POST.holiday_transactions)) {
      for (const holidayTransaction of POST.holiday_transactions) {
        const transactionData = {
          ...holidayTransaction,
          template_id: template.id
        };
        await commonQuery.createRecord(HolidayTransaction, transactionData, transaction, { company_id: true });
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
    }, transaction, false, { company_id: true });

    if (!existingHolidayTemplate) {
      await transaction.rollback();
      return res.error(constants.HOLIDAY_TEMPLATE_NOT_FOUND);
    }

    await commonQuery.updateRecordById(HolidayTemplate, id, POST, transaction, false, { company_id: true });

    if (POST.holiday_transactions) {
      await syncHolidayTransactions(id, POST.holiday_transactions, existingHolidayTemplate.holidayTransactions || [], transaction);
    }

    // Trigger sync for all employees using this template
    const employeesToSync = await commonQuery.findAllRecords(Employee, { holiday_template: id, status: 0 }, { attributes: ['id'] }, transaction, { company_id: true } );
    if (employeesToSync.length > 0) {
        const employeeIds = employeesToSync.map(emp => emp.id);
        await EmployeeTemplateService.bulkSyncSpecificTemplate(employeeIds, 'holiday_template', id, transaction);
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
      { company_id: true }
    );

    if (data.items && data.items.length > 0) {
      data.items = await Promise.all(
        data.items.map(async (item) => {
          const holiday_count = await commonQuery.countRecords(HolidayTransaction, {
            template_id: item.id
          }, {}, { company_id: true });

          return {
            ...(item.toJSON ? item.toJSON() : item),
            holiday_count
          };
        })
      );
    }

    if (data.items && Array.isArray(data.items)) {
      for (const record of data.items) {
        const employeeCount = await commonQuery.countRecords(
          Employee,
          { holiday_template: record.id, status: 0 },
          {},
          { company_id: true }
        );
        record.employee_count = employeeCount;
      }
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
    }, null, false, { company_id: true });
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
    }, null, { company_id: true });
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

    const holidayTemplateCount = await commonQuery.softDeleteById(HolidayTemplate, ids, null, transaction, { company_id: true });
    if (holidayTemplateCount === 0) {
      await transaction.rollback();
      return res.error(constants.NO_RECORDS_FOUND);
    }

    await commonQuery.softDeleteById(HolidayTransaction, { template_id: ids }, null, transaction, { company_id: true });

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
      transaction,
      false,
      { company_id: true }
    );

    if (!updated) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }

    await commonQuery.updateRecordById(HolidayTransaction, { template_id: ids }, { status }, transaction, false, { company_id: true });

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
    await commonQuery.softDeleteById(HolidayTransaction, { id: transactionToDelete.id }, transaction, false, { company_id: true });
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
      await commonQuery.updateRecordById(HolidayTransaction, transactionData.id, dbPayload, transaction, false, { company_id: true });
    } else {
      // Create new transaction
      await commonQuery.createRecord(HolidayTransaction, dbPayload, transaction, { company_id: true });
    }
  }
}