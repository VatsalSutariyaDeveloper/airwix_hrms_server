const { 
    EmployeeShift, 
    EmployeeWeeklyOff,
    Employee,
    ShiftTemplate,
    WeeklyOffTemplate,
    WeeklyOffTemplateDay,
    sequelize, 
    EmployeeAttendanceTemplate
} = require("../../models");
const { commonQuery, handleError } = require("../../helpers");
const attendanceHelper = require("../../helpers/attendanceHelper");
const EmployeeTemplateService = require("../../services/employeeTemplateService");
const LeaveBalanceService = require("../../services/leaveBalanceService");
const dayjs = require("dayjs");

/**
 * Rebuilds attendance for an employee for the last 30 days.
 * This ensures that changes to templates or settings are reflected in punch records.
 */
const rebuildRecentAttendance = async (employeeId, transaction) => {
    const today = dayjs();
    const startDate = today.subtract(30, 'day');
    
    for (let i = 0; i <= 30; i++) {
        const date = startDate.add(i, 'day').format('YYYY-MM-DD');
        await attendanceHelper.rebuildAttendanceDay(employeeId, date, {}, transaction);
    }
};

const employeeAttendanceController = {
    /**
     * Get employee-specific shift setting.
     */
    getShiftSetting: async (req, res) => {
        try {
            const { employeeId } = req.params;
            let settings = await commonQuery.findAllRecords(EmployeeShift, { 
                employee_id: employeeId,
                status: 0
            });

            // Fallback to Master Template if no individual setting exists
            if (settings.length === 0) {
                const employee = await commonQuery.findOneRecord(Employee, employeeId, { attributes: ['shift_template', 'weekly_off_template'] });
                if (employee && employee.shift_template) {
                    const masterShift = await commonQuery.findOneRecord(ShiftTemplate, employee.shift_template);
                    
                    if (masterShift) {
                        // Fetch weekly offs to skip them, matching the old sync behavior
                        let offDays = [];
                        let weeklyOffs = await commonQuery.findAllRecords(EmployeeWeeklyOff, { 
                            employee_id: employeeId,
                            week_no: 0,
                            is_off: true
                        });
                        
                        if (weeklyOffs.length === 0 && employee.weekly_off_template) {
                            weeklyOffs = await commonQuery.findAllRecords(WeeklyOffTemplateDay, {
                                template_id: employee.weekly_off_template, status: 0
                            });
                        }
                        
                        offDays = weeklyOffs.filter(wo => wo.is_off && wo.week_no === 0).map(wo => wo.day_of_week);

                        const shiftData = masterShift.toJSON();
                        
                        settings = [0, 1, 2, 3, 4, 5, 6]
                            .filter(day => !offDays.includes(day))
                            .map(day => ({
                                ...shiftData,
                                employee_id: employeeId,
                                day_of_week: day,
                                shift_id: masterShift.id,
                                is_template: true
                            }));
                    }
                }
            }

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
            await commonQuery.hardDeleteRecords(EmployeeShift, { 
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

                await commonQuery.bulkCreate(EmployeeShift, payloads, {}, transaction);
            }

            // Sync past attendance data for the current month
            await EmployeeTemplateService.syncAttendanceForPastDays([employeeId], transaction, {
                user_id: req.user.id,
                company_id: req.user.company_id,
                branch_id: req.user.branch_id
            });

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
            let weeklyOffs = await commonQuery.findAllRecords(EmployeeWeeklyOff, { 
                employee_id: employeeId,
                status: 0
            });

            // Fallback to Master Template
            if (weeklyOffs.length === 0) {
                const employee = await commonQuery.findOneRecord(Employee, employeeId, { attributes: ['weekly_off_template'] });
                if (employee && employee.weekly_off_template) {
                    weeklyOffs = await commonQuery.findAllRecords(WeeklyOffTemplateDay, {
                        template_id: employee.weekly_off_template,
                        status: 0
                    });
                    weeklyOffs = weeklyOffs.map(wo => ({ ...wo.toJSON(), is_template: true }));
                }
            }

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

            // Sync past attendance data for the current month
            await EmployeeTemplateService.syncAttendanceForPastDays([employeeId], transaction, {
                user_id: req.user.id,
                company_id: req.user.company_id,
                branch_id: req.user.branch_id
            });

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

            await LeaveBalanceService.bulkSyncEmployeeAttendancePolicy([employeeId], transaction);
            // Sync past attendance data for the current month
            // await EmployeeTemplateService.syncAttendanceForPastDays([employeeId], transaction, {
            //     user_id: req.user.id,
            //     company_id: req.user.company_id,
            //     branch_id: req.user.branch_id
            // });

            await transaction.commit();
            return res.success("Employee attendance template updated successfully");
        } catch (error) {
            await transaction.rollback();
            return handleError(error, res, req);
        }
    }
};

module.exports = employeeAttendanceController;
