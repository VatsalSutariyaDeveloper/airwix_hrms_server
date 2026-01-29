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
    EmployeeLeaveCategory,
    EmployeeShiftSetting,
    EmployeePrintTemplate,
    EmployeeSalaryTemplate,
    EmployeeSalaryTemplateTransaction,
    sequelize,
    Op
} = require("../models");
const { commonQuery } = require("../helpers");

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

            const jobs = [
                this.syncAttendanceTemplate(employee.id, employee.attendance_setting_template, null, t),
                this.syncHolidayTemplate(employee.id, employee.holiday_template, null, t),
                this.syncWeeklyOffTemplate(employee.id, employee.weekly_off_template, null, t),
                this.syncLeaveTemplate(employee.id, employee.leave_template, null, t),
                this.syncSalaryTemplate(employee.id, employee.salary_template_id, null, t),
                this.syncShiftTemplate(employee.id, employee.shift_template, null, t),
                // this.syncPrintTemplates(employee.id, null, t)
            ];

            await Promise.all(jobs);

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

        await commonQuery.softDeleteById(EmployeeHoliday, { employee_id: employeeId }, transaction, true);
        if (items.length > 0) {
            await commonQuery.bulkCreate(EmployeeHoliday, items, {}, transaction);
        }
    }

    static async syncWeeklyOffTemplate(employeeId, templateId, manualData, transaction) {
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

        await commonQuery.softDeleteById(EmployeeWeeklyOff, { employee_id: employeeId }, transaction, true);
        if (items.length > 0) {
            await commonQuery.bulkCreate(EmployeeWeeklyOff, items, {}, transaction);
        }
    }

    static async syncLeaveTemplate(employeeId, templateId, manualData, transaction) {
        let items = manualData;
        if (!items && templateId) {
            items = await commonQuery.findAllRecords(LeaveTemplateCategory, { leave_template_id: templateId, status: 0 }, {}, transaction);
            items = items.map(i => {
                const d = i.toJSON();
                delete d.id; delete d.created_at; delete d.updated_at;
                return { ...d, employee_id: employeeId, leave_template_id: templateId };
            });
        }

        if (!items || !Array.isArray(items)) return;

        await commonQuery.softDeleteById(EmployeeLeaveCategory, { employee_id: employeeId }, transaction, true);
        if (items.length > 0) {
            await commonQuery.bulkCreate(EmployeeLeaveCategory, items, {}, transaction);
        }
    }

    static async syncSalaryTemplate(employeeId, templateId, manualData, transaction) {
        // First sync the main salary template data
        let templateData = manualData;
        if (!templateData && templateId) {
            const masterTemplate = await commonQuery.findOneRecord(SalaryTemplate, templateId, {}, transaction);
            if (masterTemplate) {
                templateData = masterTemplate.toJSON();
                delete templateData.id; delete templateData.created_at; delete templateData.updated_at;
            }
        }

        if (templateData) {
            const existingTemplate = await commonQuery.findOneRecord(EmployeeSalaryTemplate, { employee_id: employeeId }, {}, transaction);
            const templatePayload = { ...templateData, employee_id: employeeId, template_id: templateId || (existingTemplate ? existingTemplate.template_id : null) };

            if (existingTemplate) {
                await commonQuery.updateRecordById(EmployeeSalaryTemplate, existingTemplate.id, templatePayload, transaction);
            } else {
                await commonQuery.createRecord(EmployeeSalaryTemplate, templatePayload, transaction);
            }
        }

        // Then sync the salary template transactions
        let items = manualData;
        if (!items && templateId) {
            items = await commonQuery.findAllRecords(SalaryTemplateTransaction, { salary_template_id: templateId, status: 0 }, {}, transaction);
            items = items.map(i => {
                const d = i.toJSON();
                delete d.id; delete d.created_at; delete d.updated_at;
                return { ...d, employee_id: employeeId, template_id: templateId };
            });
        }

        if (!items || !Array.isArray(items)) return;

        await commonQuery.softDeleteById(EmployeeSalaryTemplateTransaction, { employee_id: employeeId }, transaction, true);
        if (items.length > 0) {
            await commonQuery.bulkCreate(EmployeeSalaryTemplateTransaction, items, {}, transaction);
        }
    }

    static async syncShiftTemplate(employeeId, templateId, manualData, transaction) {
        let data = manualData;
        if (!data && templateId) {
            const master = await commonQuery.findOneRecord(ShiftTemplate, templateId, {}, transaction);
            if (master) {
                data = master.toJSON();
                delete data.id; delete data.created_at; delete data.updated_at;
            }
        }

        if (!data) return;

        const existing = await commonQuery.findOneRecord(EmployeeShiftSetting, { employee_id: employeeId }, {}, transaction);
        const payload = { ...data, employee_id: employeeId, shift_id: templateId || (existing ? existing.shift_id : null) };

        if (existing) {
            await commonQuery.updateRecordById(EmployeeShiftSetting, existing.id, payload, transaction);
        } else {
            await commonQuery.createRecord(EmployeeShiftSetting, payload, transaction);
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
