const {
    Employee,
    AttendanceTemplate,
    HolidayTransaction,
    WeeklyOffTemplateDay,
    LeaveTemplateCategory,
    SalaryTemplateTransaction,
    SalaryTemplate,
    ShiftTemplate,
    PrintTemplate,
    EmployeeAttendanceTemplate,
    EmployeeHoliday,
    EmployeeWeeklyOff,
    EmployeeLeaveBalance,
    EmployeeShiftSetting,
    EmployeePrintTemplate,
    EmployeeSalaryTemplate,
    EmployeeSalaryTemplateTransaction,
    sequelize,
    Op
} = require("../models");
const { commonQuery } = require("../helpers");
const LeaveBalanceService = require("./leaveBalanceService");

class EmployeeTemplateService {
    /**
     * Syncs all templates based on the current employee record.
     * Useful for initial creation.
     */
    static async syncAllTemplates(employeeId, transaction = null) {
        const t = transaction || (await sequelize.transaction());
        try {
            const employee = await commonQuery.findOneRecord(Employee, employeeId, {}, t);
            if (!employee) throw new Error("Employee not found");

            await this.syncAttendanceTemplate(employee.id, employee.attendance_setting_template, null, t);
            await this.syncHolidayTemplate(employee.id, employee.holiday_template, null, t);
            await this.syncWeeklyOffTemplate(employee.id, employee.weekly_off_template, null, t);
            await this.syncLeaveTemplate(employee.id, employee.leave_template, null, t);
            await this.syncSalaryTemplate(employee.id, employee.salary_template_id, null, t);
            await this.syncShiftTemplate(employee.id, employee.shift_template, null, t);

            if (!transaction) await t.commit();
        } catch (error) {
            if (!transaction && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * Main handler for selective template synchronization.
     * @param {number} employeeId 
     * @param {string} fieldName - The field name from the Employee model (e.g., 'leave_template')
     * @param {number|null} templateId - Optional new master template ID
     * @param {Object|Array|null} manualData - Optional custom data to save directly
     * @param {Object} transaction 
     */
    static async syncSpecificTemplate(employeeId, fieldName, templateId = null, manualData = null, transaction = null) {
        switch (fieldName) {
            case 'attendance_setting_template':
                return this.syncAttendanceTemplate(employeeId, templateId, manualData, transaction);
            case 'holiday_template':
                return this.syncHolidayTemplate(employeeId, templateId, manualData, transaction);
            case 'weekly_off_template':
                return this.syncWeeklyOffTemplate(employeeId, templateId, manualData, transaction);
            case 'leave_template':
                return this.syncLeaveTemplate(employeeId, templateId, manualData, transaction);
            case 'salary_template_id':
                return this.syncSalaryTemplate(employeeId, templateId, manualData, transaction);
            case 'shift_template':
                return this.syncShiftTemplate(employeeId, templateId, manualData, transaction);
            default:
                return null;
        }
    }

    // --- INTERNAL SYNC HELPERS ---

    static async syncAttendanceTemplate(employeeId, templateId, manualData, transaction) {
        if (!templateId && !manualData) {
            await commonQuery.softDeleteById(EmployeeAttendanceTemplate, { employee_id: employeeId }, transaction);
            return;
        }

        let data = manualData;
        if (!data && templateId) {
            const master = await commonQuery.findOneRecord(AttendanceTemplate, templateId, {}, transaction);
            if (master) {
                data = master.toJSON();
                delete data.id; delete data.created_at; delete data.updated_at;
            }
        }

        if (!data) return;

        const existing = await commonQuery.findOneRecord(EmployeeAttendanceTemplate, { employee_id: employeeId }, {}, transaction);
        const payload = { ...data, employee_id: employeeId, template_id: templateId || (existing ? existing.template_id : null) };

        if (existing) {
            await commonQuery.updateRecordById(EmployeeAttendanceTemplate, existing.id, payload, transaction);
        } else {
            await commonQuery.createRecord(EmployeeAttendanceTemplate, payload, transaction);
        }
    }

    static async syncHolidayTemplate(employeeId, templateId, manualData, transaction) {
        if (!templateId && !manualData) {
            await commonQuery.hardDeleteRecords(EmployeeHoliday, { employee_id: employeeId }, transaction);
            return;
        }

        let items = manualData;
        if (!items && templateId) {
            items = await commonQuery.findAllRecords(HolidayTransaction, { template_id: templateId, status: 0 }, {}, transaction);
            items = items.map(i => {
                const d = i.toJSON();
                delete d.id; delete d.created_at; delete d.updated_at;
                return { ...d, employee_id: employeeId, template_id: templateId };
            });
        }

        if (!items || !Array.isArray(items)) return;

        await commonQuery.hardDeleteRecords(EmployeeHoliday, { employee_id: employeeId }, transaction);
        if (items.length > 0) {
            await commonQuery.bulkCreate(EmployeeHoliday, items, {}, transaction);
        }
    }

    static async syncWeeklyOffTemplate(employeeId, templateId, manualData, transaction) {
        if (!templateId && !manualData) {
            await commonQuery.hardDeleteRecords(EmployeeWeeklyOff, { employee_id: employeeId }, transaction);
            return;
        }

        let items = manualData;
        if (!items && templateId) {
            items = await commonQuery.findAllRecords(WeeklyOffTemplateDay, { template_id: templateId, status: 0 }, {}, transaction);
            items = items.map(i => {
                const d = i.toJSON();
                delete d.id; delete d.created_at; delete d.updated_at;
                return { ...d, employee_id: employeeId, template_id: templateId };
            });
        }

        if (!items || !Array.isArray(items)) return;

        await commonQuery.hardDeleteRecords(EmployeeWeeklyOff, { employee_id: employeeId }, transaction);
        if (items.length > 0) {
            await commonQuery.bulkCreate(EmployeeWeeklyOff, items, {}, transaction);
        }
    }

    static async syncLeaveTemplate(employeeId, templateId, manualData, transaction) {
        // We now use LeaveBalanceService to handle this as it manages EmployeeLeaveBalance records
        await LeaveBalanceService.syncEmployeeBalances(employeeId, templateId, transaction);
        
        // If there's manual data, we could potentially iterate and update specific balances here
        // but for now, standard sync is preferred to maintain policy integrity.
    }

    static async syncSalaryTemplate(employeeId, templateId, manualData, transaction) {
        if (!templateId && !manualData) {
            await commonQuery.softDeleteById(EmployeeSalaryTemplateTransaction, { employee_id: employeeId }, transaction);
            await commonQuery.softDeleteById(EmployeeSalaryTemplate, { employee_id: employeeId }, transaction);
            return;
        }

        // First sync the main salary template data
        let templateData = manualData;
        let masterComponents = null;

        if (!templateData && templateId) {
            const masterTemplate = await commonQuery.findOneRecord(SalaryTemplate, templateId, {
                include: [{ model: SalaryTemplateTransaction }]
            }, transaction);
            
            if (masterTemplate) {
                templateData = masterTemplate.toJSON();
                masterComponents = templateData.SalaryTemplateTransactions; // Capture related components
                delete templateData.id; delete templateData.created_at; delete templateData.updated_at;
                delete templateData.SalaryTemplateTransactions;
            }
        }

        let employeeSalaryTemplateId = null;

        if (templateData) {
            const existingTemplate = await commonQuery.findOneRecord(EmployeeSalaryTemplate, { employee_id: employeeId }, {}, transaction);
            const templatePayload = { 
                ...templateData, 
                employee_id: employeeId, 
                template_id: templateId || (existingTemplate ? existingTemplate.template_id : null) 
            };

            if (existingTemplate) {
                await commonQuery.updateRecordById(EmployeeSalaryTemplate, existingTemplate.id, templatePayload, transaction);
                employeeSalaryTemplateId = existingTemplate.id;
            } else {
                const newRecord = await commonQuery.createRecord(EmployeeSalaryTemplate, templatePayload, transaction);
                employeeSalaryTemplateId = newRecord.id;
            }
        }

        // Then sync the salary template transactions (Components)
        let items = masterComponents;
        if (!items && manualData && manualData.components) {
            items = manualData.components;
        }

        if (items && Array.isArray(items)) {
            const mappedItems = items.map(i => {
                const d = i.toJSON ? i.toJSON() : i;
                delete d.id; delete d.created_at; delete d.updated_at;
                return { 
                    ...d, 
                    employee_id: employeeId, 
                    employee_salary_template_id: employeeSalaryTemplateId 
                };
            });

            await commonQuery.hardDeleteRecords(EmployeeSalaryTemplateTransaction, { employee_id: employeeId }, transaction);
            if (mappedItems.length > 0) {
                await commonQuery.bulkCreate(EmployeeSalaryTemplateTransaction, mappedItems, {}, transaction);
            }
        }
    }

    static async syncShiftTemplate(employeeId, templateId, manualData, transaction) {
        if (!templateId && !manualData) {
            await commonQuery.hardDeleteRecords(EmployeeShiftSetting, { employee_id: employeeId }, transaction);
            return;
        }

        let data = manualData;
        if (!data && templateId) {
            const master = await commonQuery.findOneRecord(ShiftTemplate, templateId, {}, transaction);
            if (master) {
                data = master.toJSON();
                // Store master template ID as shift_id in the employee setting
                data.shift_id = master.id;
                delete data.id; delete data.created_at; delete data.updated_at;
            }
        }

        if (!data) return;

        // 1. Clear existing day-wise settings for this employee
        await commonQuery.hardDeleteRecords(EmployeeShiftSetting, { employee_id: employeeId }, transaction);

        // 2. Fetch Weekly Offs for this employee to identify "All Week" offs
        const weeklyOffs = await commonQuery.findAllRecords(EmployeeWeeklyOff, { 
            employee_id: employeeId,
            week_no: 0,
            is_off: true
        }, {}, transaction);
        const offDays = weeklyOffs.map(wo => wo.day_of_week);

        // 3. Create shift settings for all 7 days (0-6), skipping permanent week-offs
        const payloads = [0, 1, 2, 3, 4, 5, 6]
            .filter(day => !offDays.includes(day))
            .map(day => ({
                ...data,
                employee_id: employeeId,
                day_of_week: day,
                shift_id: templateId || data.shift_id,
                company_id: data.company_id || 0,
            }));

        if (payloads.length > 0) {
            await commonQuery.bulkCreate(EmployeeShiftSetting, payloads, {}, transaction);
        }
    }

    // static async syncPrintTemplates(employeeId, manualData, transaction) {
    //     let items = manualData;
    //     if (!items) {
    //         const employee = await commonQuery.findOneRecord(Employee, employeeId, { attributes: ['company_id'] }, transaction);
    //         if (!employee) return;
    //         items = await commonQuery.findAllRecords(PrintTemplate, { company_id: employee.company_id, status: 0 }, {}, transaction);
    //         items = items.map(i => {
    //             const d = i.toJSON();
    //             delete d.id; delete d.created_at; delete d.updated_at;
    //             return { ...d, employee_id: employeeId, template_id: i.id };
    //         });
    //     }

    //     if (!items || !Array.isArray(items)) return;

    //     await commonQuery.softDeleteById(EmployeePrintTemplate, { employee_id: employeeId }, transaction, true);
    //     if (items.length > 0) {
    //         await commonQuery.bulkCreate(EmployeePrintTemplate, items, {}, transaction);
    //     }
    // }
}

module.exports = EmployeeTemplateService;
