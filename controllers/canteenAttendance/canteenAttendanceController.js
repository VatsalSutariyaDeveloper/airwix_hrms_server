const { CanteenAttendance, Employee, Sequelize, sequelize } = require("../../models");
const { validateRequest, commonQuery, handleError } = require("../../helpers");
const { constants } = require("../../helpers/constants");
const { Op } = Sequelize;

// Create
exports.create = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const POST = req.body;
        const requiredFields = {
            employee_id: "Employee ID",
            date: "Date",
        };

        const errors = await validateRequest(POST, requiredFields, {}, transaction);

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        const employee = await commonQuery.findOneRecord(Employee, 
        { id: POST.employee_id }, 
        transaction);
        
        if (!employee) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        await commonQuery.createRecord(CanteenAttendance, POST, transaction);

        await transaction.commit();
        return res.success(constants.CREATED);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Update
exports.update = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.params;
        const POST = req.body;
        const requiredFields = {
            employee_id: "Employee ID",
            date: "Date",
        };

        const errors = await validateRequest(POST, requiredFields, {}, transaction);

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        const employee = await commonQuery.findOneRecord(Employee, 
        { id: POST.employee_id }, 
        transaction);
        
        if (!employee) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        const updatedAttendance = await commonQuery.updateRecordById(CanteenAttendance, id, POST, transaction);
        if (!updatedAttendance) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        await transaction.commit();
        return res.success(constants.UPDATED);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

exports.delete = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {

    const { ids , date } = req.body;

    const errors = await validateRequest(req.body, { ids: "Select Data", date: "Date" }, {}, transaction);
    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }
    if (!Array.isArray(ids) || ids.length === 0) {
      await transaction.rollback();
      return res.error(constants.INVALID_INPUT);
    }

    const deleted = await commonQuery.hardDeleteRecords(CanteenAttendance, { employee_id: ids, date: date }, transaction);
    if (!deleted) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }
    
    await transaction.commit();
    return res.success(constants.DELETED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

exports.getSummary = async (req, res) => {
    try {
    const { date } = req.body;

     const fieldConfig = [
        ["first_name", true, false]
    ]

    const allEmployees = await commonQuery.fetchPaginatedData(
            Employee,
            { status: 0, ...req.body, limit:"All" },
            fieldConfig,
            {
                include:[
                    {
                        model: CanteenAttendance,
                        as: "canteenAttendances",
                        where: { date: date },
                        attributes: ["id", "employee_id", "date", "status", "created_at"],
                        required: false
                    }
                ],
                attributes: ["id", "first_name", "employee_code", "employee_type", "worker_type"],
            }
      );

    const presentEmployees = [];
    const absentEmployees = [];

    allEmployees.items.forEach(employee => {
        if (employee.canteenAttendances && employee.canteenAttendances.length > 0) {
            const hasPresentStatus = employee.canteenAttendances.some(att => att.status === 0);
            if (hasPresentStatus) {
                presentEmployees.push(employee);
            } else {
                absentEmployees.push(employee);
            }
        } else {
            absentEmployees.push(employee);
        }
    });

    const result = {
        presentCount: presentEmployees.length,
        absentCount: absentEmployees.length,
        totalStaffCount: allEmployees.items.length,
        presentEmployeeData: presentEmployees,
        absentEmployeeData: absentEmployees
    };
        
      res.ok(result);
      
    } catch (err) {
        return handleError(err, res, req);
    }
};
