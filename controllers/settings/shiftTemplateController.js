const { ShiftTemplate, ShiftBreak, Employee } = require("../../models");
const { sequelize, validateRequest, commonQuery, handleError, constants } = require("../../helpers");
const EmployeeTemplateService = require("../../services/employeeTemplateService");

// Create a new bank master record
exports.create = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const requiredFields = {
            shift_name: "Shift Name",
            // shift_type: "Shift Type",
            // shift_code: "Shift Code",
            start_time: "Start Time",
            end_time: "End Time",
            punch_in: "Punch In",
            punch_out: "Punch Out",
        };

        if (Number(req.body.punch_in) === 1) {
            requiredFields.punch_in_time = "Punch In Time";
        }

        if (Number(req.body.punch_out) === 1) {
            requiredFields.punch_out_time = "Punch Out Time";
        }

        const errors = await validateRequest(req.body, requiredFields, {
            uniqueCheck: {
                model: ShiftTemplate,
                fields: ["shift_name"],
                excludeId: req.params.id,
            }
        }, transaction);

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        const shifts = await commonQuery.createRecord(ShiftTemplate, req.body, transaction);

        if (req.body.breaks && Array.isArray(req.body.breaks)) {
            const breaks = req.body.breaks.map(b => {
                const { id, ...breakData } = b; // Remove the id field
                return {
                    ...breakData,
                    start_buffer: breakData.start_buffer === "" ? null : breakData.start_buffer,
                    buffer_end: breakData.buffer_end === "" ? null : breakData.buffer_end,
                    start_time: breakData.start_time === "" ? null : breakData.start_time,
                    end_time: breakData.end_time === "" ? null : breakData.end_time,
                    shift_template_id: shifts.id,
                    user_id: req.user?.id || 0,
                    branch_id: req.body.branch_id || 0,
                    company_id: req.body.company_id || 0
                };
            });
            const commonBreaks = {
                user_id: req.user?.id || 0,
                branch_id: req.body.branch_id || 0,
                company_id: req.body.company_id || 0
            };
            await commonQuery.bulkCreate(ShiftBreak, breaks, commonBreaks, transaction);
        }

        await transaction.commit();
        return res.success(constants.CREATED, shifts);
    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Get all active shift records
exports.getAll = async (req, res) => {
  try {
    const fieldConfig = [
      ["shift_name", true, true],
    ];

    const records = await commonQuery.fetchPaginatedData(
      ShiftTemplate,
      { ...req.body, status: 0 },
      fieldConfig,
      {
        include: [{ model: ShiftBreak, as: 'ShiftBreaks' }]
      }
    );

    if (records.items && Array.isArray(records.items)) {
            records.items = await Promise.all(
                records.items.map(async (record) => {
                    const employeeCount = await commonQuery.countRecords(
                        Employee,
                        { shift_template: record.id, status: 0 }
                    );
                    
                    return {
                        ...(record.toJSON ? record.toJSON() : record),
                        employee_count: employeeCount
                    };
                })
            );
        }

    return res.ok(records);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Get By Id
exports.getById = async (req, res) => {
    try {
        const record = await commonQuery.findOneRecord(ShiftTemplate, req.params.id, {
            include: [{ model: ShiftBreak, as: 'ShiftBreaks', where: { status: 0 } }]
        });
        if (!record || record.status === 2) return res.error(constants.NOT_FOUND);
        return res.ok(record);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// Update shift record by ID
exports.update = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const requiredFields = {
            shift_name: "Shift Name",
            // shift_type: "Shift Type",
            // shift_code: "Shift Code",
            start_time: "Start Time",
            end_time: "End Time",
            punch_in: "Punch In",
            punch_out: "Punch Out",
        };

        if (Number(req.body.punch_in) === 1) {
            requiredFields.punch_in_time = "Punch In Time";
        }

        if (Number(req.body.punch_out) === 1) {
            requiredFields.punch_out_time = "Punch Out Time";
        }

        const errors = await validateRequest(
            req.body,
            requiredFields,
            {
                uniqueCheck: {
                    model: ShiftTemplate,
                    fields: ["shift_name"],
                    excludeId: req.params.id,
                }
            },
            transaction
        );

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }
        const updated = await commonQuery.updateRecordById(ShiftTemplate,req.params.id, req.body, transaction);
        if (!updated || updated.status === 2) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        if (req.body.breaks && Array.isArray(req.body.breaks)) {
            const commonFields = {
                shift_template_id: req.params.id,
                user_id: req.user?.id || 0,
                branch_id: req.user.branch_id || 0,
                company_id: req.user.company_id || 0,
            };

            const incomingIds = req.body.breaks
                .map(b => b.id)
                .filter(id => id !== undefined && id !== null && id !== "");

            // Soft-delete breaks that exist in DB but are not present in the request
            const existingBreaks = await commonQuery.findAllRecords(
                ShiftBreak,
                { shift_template_id: req.params.id },
                { attributes: ['id'] },
                transaction,
                {}   // skip tenant filter — filter by shift_template_id is enough
            );
            const idsToDelete = existingBreaks
                .map(b => b.id)
                .filter(id => !incomingIds.includes(id));
            
            if (idsToDelete.length > 0) {
                await commonQuery.softDeleteById(ShiftBreak, idsToDelete, transaction, {});
            }

            const toCreate = [];
            for (const b of req.body.breaks) {
                const { id, ...breakWithoutId } = b; // Remove the id field
                const breakData = {
                    ...breakWithoutId,
                    ...commonFields,
                    start_buffer: breakWithoutId.start_buffer === "" ? null : breakWithoutId.start_buffer,
                    buffer_end: breakWithoutId.buffer_end === "" ? null : breakWithoutId.buffer_end,
                    start_time: breakWithoutId.start_time === "" ? null : breakWithoutId.start_time,
                    end_time: breakWithoutId.end_time === "" ? null : breakWithoutId.end_time,
                };

                if (b.id) {
                    // Update existing break - only if it's a valid database ID (not a large timestamp)
                    if (typeof b.id === 'number' && b.id < 2147483647) {
                        await commonQuery.updateRecordById(ShiftBreak, b.id, breakData, transaction);
                    } else {
                        // Treat large timestamp IDs as new breaks
                        toCreate.push(breakData);
                    }
                } else {
                    // Collect new breaks to bulk-create
                    toCreate.push(breakData);
                }
            }

            if (toCreate.length > 0) {
                await commonQuery.bulkCreate(ShiftBreak, toCreate, {}, transaction);
            }
        }

        // Trigger sync for all employees using this template
        const employeesToSync = await commonQuery.findAllRecords(Employee, { shift_template: req.params.id, status: 0 }, { attributes: ['id'] }, transaction);
        if (employeesToSync.length > 0) {
            const employeeIds = employeesToSync.map(emp => emp.id);
            await EmployeeTemplateService.bulkSyncSpecificTemplate(employeeIds, 'shift_template', req.params.id, transaction);
        }

        await transaction.commit();
        return res.success(constants.SHIFT_UPDATED, updated);
    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Soft delete a shift record by ID
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
        let { ids } = req.body; 

        // Validate that ids is an array and not empty
        if (!Array.isArray(ids) || ids.length === 0) {
            await transaction.rollback();
            return res.error(constants.INVALID_ID);
        }

        const deleted = await commonQuery.softDeleteById(ShiftTemplate, ids, transaction);

        if (!deleted) {
            await transaction.rollback();
            return res.error(constants.ALREADY_DELETED);
        }

        await transaction.commit();
        return res.success(constants.SHIFT_DELETED);
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

    // Update only the status field by id
    const updated = await commonQuery.updateRecordById(
      ShiftTemplate,
      ids,
      { status: status },
      transaction
    );

    if (!updated || updated.status === 2) {
      if (!transaction.finished) await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }

    await transaction.commit();
    return res.success(constants.SHIFT_UPDATED);
  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};

// exports.assignShift = async (req, res) => {
//     const { employee_id, shift_id, effective_from } = req.body;

//     await shiftService.assignShiftToEmployee(
//         employee_id,
//         shift_id,
//         effective_from
//     );

//     res.json({ message: "Shift assigned successfully" });
// };

exports.dropdownList = async (req, res) => {
  try {
    const result = await commonQuery.findAllRecords(ShiftTemplate, { status: 0 });
    return res.ok(result);
  } catch (err) {
    return handleError(err, res, req);
  }
}