const { sequelize, handleError, validateRequest, commonQuery } = require("../../helpers");
const { constants } = require("../../helpers/constants");
const { Op } = require("sequelize");
const { HolidayTemplate, HolidayTransaction, Employee, AttendanceDay, EmployeeWeeklyOff } = require("../../models");
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

    // Skip holiday transactions sync and employee sync if only_template is true
    if (!POST.only_template) {
      if (POST.holiday_transactions) {
        await syncHolidayTransactions(id, POST.holiday_transactions, existingHolidayTemplate.holidayTransactions || [], transaction);
      }

      // Trigger sync for all employees using this template
      const employeesToSync = await commonQuery.findAllRecords(Employee, { holiday_template: id, status: 0 }, { attributes: ['id'] }, transaction);
      if (employeesToSync.length > 0) {
          const employeeIds = employeesToSync.map(emp => emp.id);
          await EmployeeTemplateService.bulkSyncSpecificTemplate(employeeIds, 'holiday_template', id, transaction);
      }
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
      fieldConfig
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

    if (data.items && Array.isArray(data.items)) {
      for (const record of data.items) {
        const employeeCount = await commonQuery.countRecords(
          Employee,
          { holiday_template: record.id, status: 0 },
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

    const holidayTemplateCount = await commonQuery.softDeleteById(HolidayTemplate, ids, transaction);
    if (holidayTemplateCount === 0) {
      await transaction.rollback();
      return res.error(constants.NO_RECORDS_FOUND);
    }

    await commonQuery.softDeleteById(HolidayTransaction, { template_id: ids }, transaction);

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
  
  // Clean up AttendanceDay records for removed holidays
  if (transactionsToDelete.length > 0) {
    const removedHolidayDates = transactionsToDelete.map(t => t.date);
    
    // Find all employees using this holiday template
    const employeesUsingTemplate = await commonQuery.findAllRecords(Employee, { 
      holiday_template: templateId, 
      status: 0 
    }, { attributes: ['id', 'company_id'] }, transaction);
    
    if (employeesUsingTemplate.length > 0) {
      const today = new Date().toISOString().split('T')[0];
      
      for (const employee of employeesUsingTemplate) {
        for (const holidayDate of removedHolidayDates) {
          // Only process for today or future dates
          if (holidayDate < today) continue;
          const dayOfWeek = new Date(holidayDate).getDay();
          const dayOfMonth = new Date(holidayDate).getDate();
          const weekNo = Math.ceil(dayOfMonth / 7);
          
          // Check if this date is also a weekly off
          let isWeeklyOff = false;
          const weeklyOff = await commonQuery.findOneRecord(EmployeeWeeklyOff, {
            employee_id: employee.id,
            day_of_week: dayOfWeek,
            [Op.or]: [{ week_no: 0 }, { week_no: weekNo }],
            is_off: true,
            status: 0,
          }, {}, transaction);
          if (weeklyOff) isWeeklyOff = true;
          
          if (isWeeklyOff) {
            // Update to WEEKLY_OFF status instead of deleting
            const existingAttendanceDay = await commonQuery.findOneRecord(AttendanceDay, {
              employee_id: employee.id,
              attendance_date: holidayDate,
              status: 4 // Only update HOLIDAY records
            }, {}, transaction);
            
            if (existingAttendanceDay) {
              await commonQuery.updateRecordById(AttendanceDay, existingAttendanceDay.id, {
                status: 3, // WEEKLY_OFF
                shift_id: null,
                note: ``
                // note: `System: Changed from Holiday to Weekly Off (${new Date(holidayDate).toLocaleDateString('en-US', { weekday: 'long' })})`
              }, transaction);
            }
          } else {
            // Delete the AttendanceDay record if it's not a weekly off
            await commonQuery.hardDeleteRecords(AttendanceDay, {
              employee_id: employee.id,
              attendance_date: holidayDate,
              status: 4 // Only delete HOLIDAY records
            }, transaction);
          }
        }
      }
    }
  }
  
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
      
      // Handle AttendanceDay updates for new holidays
      const today = new Date().toISOString().split('T')[0];
      
      // Only process for today or future dates
      if (transactionData.date >= today) {
        const dayOfWeek = new Date(transactionData.date).getDay();
        const dayOfMonth = new Date(transactionData.date).getDate();
        const weekNo = Math.ceil(dayOfMonth / 7);
        
        // Find all employees using this holiday template
        const employeesUsingTemplate = await commonQuery.findAllRecords(Employee, { 
          holiday_template: templateId, 
          status: 0 
        }, { attributes: ['id', 'company_id'] }, transaction);
        
        if (employeesUsingTemplate.length > 0) {
        for (const employee of employeesUsingTemplate) {
          // Check if this date is also a weekly off
          let isWeeklyOff = false;
          const weeklyOff = await commonQuery.findOneRecord(EmployeeWeeklyOff, {
            employee_id: employee.id,
            day_of_week: dayOfWeek,
            [Op.or]: [{ week_no: 0 }, { week_no: weekNo }],
            is_off: true,
            status: 0,
          }, {}, transaction);
          if (weeklyOff) isWeeklyOff = true;
          
          if (isWeeklyOff) {
            // Update existing WEEKLY_OFF to HOLIDAY status
            const existingAttendanceDay = await commonQuery.findOneRecord(AttendanceDay, {
              employee_id: employee.id,
              attendance_date: transactionData.date,
              status: 3 // Only update WEEKLY_OFF records
            }, {}, transaction);
            
            if (existingAttendanceDay) {
              await commonQuery.updateRecordById(AttendanceDay, existingAttendanceDay.id, {
                status: 4, // HOLIDAY
                note: ``
                // note: `System: Changed from Weekly Off to Holiday (${transactionData.name || 'Holiday'})`
              }, transaction);
            } else {
              // Create new HOLIDAY record
              await commonQuery.createRecord(AttendanceDay, {
                employee_id: employee.id,
                attendance_date: transactionData.date,
                status: 4, // HOLIDAY
                note: ``,
                // note: `System: Holiday auto-detected (${transactionData.name || 'Holiday'})`,
                created_at: new Date(),
                updated_at: new Date()
              }, transaction);
            }
          } else {
            // Not a weekly off, create new HOLIDAY record
            await commonQuery.createRecord(AttendanceDay, {
              employee_id: employee.id,
              attendance_date: transactionData.date,
              status: 4, // HOLIDAY
              note: ``,
              // note: `System: Holiday auto-detected (${transactionData.name || 'Holiday'})`,
              created_at: new Date(),
              updated_at: new Date()
            }, transaction);
          }
        }
      }
      }
    }
  }
}