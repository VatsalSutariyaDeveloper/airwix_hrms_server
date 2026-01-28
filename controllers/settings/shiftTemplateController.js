const { ShiftTemplate, Employee } = require("../../models");
const { sequelize, validateRequest, commonQuery, handleError, constants } = require("../../helpers");

// Create a new bank master record
exports.create = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const requiredFields = {
            shift_name: "Shift Name",
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
        await transaction.commit();
        return res.success(constants.SHIFT_CREATED, shifts);
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
      req.body,
      fieldConfig,
    );

    if (records.items && Array.isArray(records.items)) {
            records.items = await Promise.all(
                records.items.map(async (record) => {
                    const employeeCount = await commonQuery.countRecords(
                        Employee,
                        { shift_template: record.id, status: 0 },
                        {},
                        false
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
        const record = await commonQuery.findOneRecord(ShiftTemplate, req.params.id);
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