const { Shift } = require("../../models");
const { sequelize, validateRequest, commonQuery, handleError } = require("../../helpers");
const shiftService = require("../../helpers/shiftHelper");
const { constants } = require("../../helpers/constants");

// exports.createShift = async (req, res) => {
//     const shift = await shiftService.createShift(req.body, req.user.companyId);
//     res.json({ message: "Shift created", data: shift });
// };
// Create a new bank master record
exports.create = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const requiredFields = {
            shift_name: "Shift Name",
            start_time: "Start Time",
            end_time: "End Time",
        };

        const errors = await validateRequest(req.body, requiredFields, {
            uniqueCheck: {
                model: Shift,
                fields: ["shift_name"],
                excludeId: req.params.id,
            }
        }, transaction);

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        const shifts = await commonQuery.createRecord(Shift, req.body, transaction);
        await transaction.commit();
        return res.success(constants.SHIFT_CREATED, shifts);
    } catch (err) {
        await transaction.rollback();
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

// Get all active shift records
exports.getAll = async (req, res) => {
    try {
        const result = await commonQuery.findAllRecords(Shift, { status: 0 });
        return res.ok(result);
    } catch (err) {
        return handleError(err, res, req);
    }
};
// Get By Id
exports.getById = async (req, res) => {
    try {
        const record = await commonQuery.findOneRecord(Shift, req.params.id);
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
        // Only validate fields sent in request
        const fieldLabels = {
            shift_name: "Shift Name",
            start_time: "Start Time",
            end_time: "End Time",
        };

        const requiredFields = {};

        Object.keys(fieldLabels).forEach(key => {
            if (req.body[key] !== undefined) {
                requiredFields[key] = fieldLabels[key];
            }
        });

        const errors = await validateRequest(
            req.body,
            requiredFields,
            {
                uniqueCheck: {
                    model: Shift,
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
        const updated = await commonQuery.updateRecordById(Shift, { id: req.params.id }, req.body, transaction);
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
    // try {
    //     const deleted = await commonQuery.softDeleteById(Shift, req.params.id, transaction);
    //     if (!deleted) {
    //         await transaction.rollback();
    //         return res.error(constants.NOT_FOUND);
    //     }
    //     await transaction.commit();
    //     return res.success(constants.SHIFT_DELETED);
    // } catch (err) {
    //     await transaction.rollback();
    //     return handleError(err, res, req);
    // }
    //  const transaction = await sequelize.transaction();
    try {
        const requiredFields = {
            ids: "Select Data"
        };

        const errors = await validateRequest(req.body, requiredFields, {}, transaction);
        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }
        let { ids } = req.body; // Accept array of ids

        //normalize ids
        if (Array.isArray(ids) && typeof ids[0] === "string") {
            ids = ids[0]
                .split(",")
                .map(id => parseInt(id.trim()))
                .filter(Boolean);
        }

        // Validate that ids is an array and not empty
        if (!Array.isArray(ids) || ids.length === 0) {
            await transaction.rollback();
            return res.error(constants.INVALID_ID);
        }

        const deleted = await commonQuery.softDeleteById(Shift, ids, transaction);
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
      Shift,
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
