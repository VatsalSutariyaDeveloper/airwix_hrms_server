
const { 
    EmployeeShiftSetting, 
    EmployeeWeeklyOff,
    Employee,
    ShiftTemplate,
    WeeklyOffTemplate,
    WeeklyOffTemplateDay,
    sequelize 
} = require("../../models");
const { commonQuery, handleError } = require("../../helpers");

const employeeAttendanceController = {
    /**
     * Get employee-specific shift setting.
     */
    getShiftSetting: async (req, res) => {
        try {
            const { employeeId } = req.params;
            const settings = await commonQuery.findAllRecords(EmployeeShiftSetting, { 
                employee_id: employeeId 
            });

            return res.success("Employee shift settings fetched successfully", settings);
        } catch (error) {
            return handleError(error, res, req);
        }
    },

    /**
     * Update employee-specific shift setting.
     */
    updateShiftSetting: async (req, res) => {
        const transaction = await sequelize.transaction();
        try {
            const { employeeId } = req.params;
            const { shifts } = req.body;

            if (!Array.isArray(shifts)) {
                return res.error("Invalid shifts data", 400);
            }

            // Remove existing day-wise shift settings
            await commonQuery.hardDeleteRecords(EmployeeShiftSetting, { 
                employee_id: employeeId 
            }, transaction);

            if (shifts.length > 0) {
                const payloads = shifts.map(shift => {
                   const { id, createdAt, updatedAt, ...cleanShift } = shift;
                   return {
                       ...cleanShift,
                       employee_id: employeeId,
                       company_id: req.user?.company_id || 0,
                   };
                });

                await commonQuery.bulkCreate(EmployeeShiftSetting, payloads, {}, transaction);
            }

            await transaction.commit();
            return res.success("Employee shift settings updated successfully");
        } catch (error) {
            await transaction.rollback();
            return handleError(error, res, req);
        }
    },

    /**
     * Get employee-specific weekly offs.
     */
    getWeeklyOffs: async (req, res) => {
        try {
            const { employeeId } = req.params;
            const weeklyOffs = await commonQuery.findAllRecords(EmployeeWeeklyOff, { 
                employee_id: employeeId 
            });

            return res.success("Employee weekly offs fetched successfully", weeklyOffs);
        } catch (error) {
            return handleError(error, res, req);
        }
    },

    /**
     * Update employee-specific weekly offs.
     */
    updateWeeklyOffs: async (req, res) => {
        const transaction = await sequelize.transaction();
        try {
            const { employeeId } = req.params;
            const { weeklyOffs } = req.body;

            if (!Array.isArray(weeklyOffs)) {
                return res.error("Invalid weekly offs data", 400);
            }

            await commonQuery.hardDeleteRecords(EmployeeWeeklyOff, { 
                employee_id: employeeId 
            }, transaction);

            if (weeklyOffs.length > 0) {
                const payloads = weeklyOffs.map(off => ({
                    employee_id: employeeId,
                    template_id: off.template_id || null,
                    day_of_week: off.day_of_week,
                    week_no: off.week_no || 0,
                    is_off: off.is_off !== undefined ? off.is_off : true,
                    status: off.status || 0,
                    company_id: req.user?.company_id || 0,
                }));

                await commonQuery.bulkCreate(EmployeeWeeklyOff, payloads, {}, transaction);
            }

            await transaction.commit();
            return res.success("Employee weekly offs updated successfully");
        } catch (error) {
            await transaction.rollback();
            return handleError(error, res, req);
        }
    },

    /**
     * Get employee-specific attendance template.
     */
    getAttendanceTemplate: async (req, res) => {
        try {
            const { employeeId } = req.params;
            const { EmployeeAttendanceTemplate } = require("../../models");
            const setting = await commonQuery.findOneRecord(EmployeeAttendanceTemplate, { 
                employee_id: employeeId 
            });

            return res.success("Employee attendance template fetched successfully", setting);
        } catch (error) {
            return handleError(error, res, req);
        }
    },

    /**
     * Update employee-specific attendance template.
     */
    updateAttendanceTemplate: async (req, res) => {
        const transaction = await sequelize.transaction();
        try {
            const { employeeId } = req.params;
            const data = req.body;
            const { EmployeeAttendanceTemplate } = require("../../models");

            let existing = await commonQuery.findOneRecord(EmployeeAttendanceTemplate, { 
                employee_id: employeeId 
            }, {}, transaction);

            const payload = {
                ...data,
                employee_id: employeeId,
                company_id: req.user?.company_id || 0,
            };

            if (existing) {
                await commonQuery.updateRecordById(EmployeeAttendanceTemplate, existing.id, payload, transaction);
            } else {
                await commonQuery.createRecord(EmployeeAttendanceTemplate, payload, transaction);
            }

            await transaction.commit();
            return res.success("Employee attendance template updated successfully");
        } catch (error) {
            await transaction.rollback();
            return handleError(error, res, req);
        }
    }
};

module.exports = employeeAttendanceController;
