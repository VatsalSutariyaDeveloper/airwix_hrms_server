const { Op } = require("sequelize");
const {
    Employee,
    AttendancePunch,
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
    EmployeeShift,
    EmployeePrintTemplate,
    EmployeeSalaryTemplate,
    EmployeeSalaryTemplateTransaction,
    sequelize,
    ShiftBreak,
    LeaveRequest,
    LeaveTemplate
} = require("../models");
const { commonQuery, constants } = require("../helpers");
const LeaveBalanceService = require("./leaveBalanceService");
const { rebuildAttendanceDay, bulkSyncAttendanceDays } = require("../helpers/attendanceHelper");
const dayjs = require("dayjs");


const rejectPendingLeaveRequestsOnTemplateChange = async (employeeId, req, transaction, oldTemplateId = null) => {
    try {
        const pendingRequests = await commonQuery.findAllRecords(
            LeaveRequest,
            {
                employee_id: employeeId,
                approval_status: { [Op.in]: [constants.LEAVE_APPROVAL_STATUS.PENDING] },
                status: 0
            },
            {},
            transaction
        );

        if (pendingRequests.length === 0) {
            return; 
        }
        
        let employeeForBalance;
        if (oldTemplateId) {
            // Get employee with OLD template for balance restoration
            employeeForBalance = await commonQuery.findOneRecord(
                Employee,
                employeeId,
                {
                    include: [{ 
                        model: LeaveTemplate, 
                        as: "leaveTemplate",
                        where: { id: oldTemplateId }
                    }]
                },
                transaction
            );
        } else {
            // Fallback to current template
            employeeForBalance = await commonQuery.findOneRecord(
                Employee,
                employeeId,
                {
                    include: [{ model: LeaveTemplate, as: "leaveTemplate" }]
                },
                transaction
            );
        }

        if (!employeeForBalance || !employeeForBalance.leaveTemplate) {
            // Still reject pending requests but skip balance restoration
            for (const request of pendingRequests) {                
                // Update leave request status to rejected
                const history = request.approval_history || [];
                history.push({
                    level: request.current_level,
                    action: "REJECTED",
                    by: req.user?.id || null,
                    at: new Date(),
                    note: "Auto-rejected due to leave template change (balance restoration skipped - no template)"
                });

                await commonQuery.updateRecordById(LeaveRequest, request.id, {
                    approval_status: constants.LEAVE_APPROVAL_STATUS.REJECTED,
                    approval_history: history
                }, transaction);

            }
            return;
        }

        const template = employeeForBalance.leaveTemplate;
        for (const request of pendingRequests) {
            const cycleDates = LeaveBalanceService.getCycleDates(
                employeeForBalance.joining_date,
                template.leave_policy_cycle,
                dayjs(request.start_date)
            );

            const balance = await commonQuery.findOneRecord(
                EmployeeLeaveBalance,
                {
                    employee_id: request.employee_id,
                    leave_category_id: request.leave_category_id,
                    year: cycleDates.end.year(),
                    month: template.leave_policy_cycle === 'MONTHLY' ? cycleDates.end.month() + 1 : null,
                    status: 0
                },
                {},
                transaction
            );

            if (balance) {
                const balanceUpdate = {
                    used_leaves: parseFloat(balance.used_leaves) - parseFloat(request.total_days)
                };
                if (balance.is_paid) {
                    balanceUpdate.pending_leaves = parseFloat(balance.pending_leaves) + parseFloat(request.total_days);
                }
                await commonQuery.updateRecordById(EmployeeLeaveBalance, balance.id, balanceUpdate, transaction);
            }

            // Update leave request status to rejected
            const history = request.approval_history || [];
            history.push({
                level: request.current_level,
                action: "REJECTED",
                by: req.user?.id || null,
                at: new Date(),
                note: "Auto-rejected due to leave template change"
            });

            await commonQuery.updateRecordById(LeaveRequest, request.id, {
                approval_status: constants.LEAVE_APPROVAL_STATUS.REJECTED,
                approval_history: history
            }, transaction);
        }
    } catch (error) {
        console.error('Error rejecting pending leave requests:', error);
        throw error;
    }
};

class EmployeeTemplateService {
    static rejectPendingLeaveRequestsOnTemplateChange = rejectPendingLeaveRequestsOnTemplateChange;
    /**
     * Syncs all templates based on the current employee record.
     * Useful for initial creation.
     */
    static async syncAllTemplates(employeeId, transaction = null) {
        const t = transaction || (await sequelize.transaction());
        try {
            const employee = await commonQuery.findOneRecord(Employee, employeeId, {}, t, true);
            if (!employee) throw new Error("Employee not found");

            await this.syncAttendanceTemplate(employee.id, employee.attendance_setting_template, null, t);
            await this.syncHolidayTemplate(employee.id, employee.holiday_template, null, t);
            await this.syncWeeklyOffTemplate(employee.id, employee.weekly_off_template, null, t);

            // Auto-sync past data for the current month based on new templates
            await this.syncAttendanceForPastDays([employee.id], t, {
                company_id: employee.company_id,
                branch_id: employee.branch_id
            });

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
    static async syncSpecificTemplate(employeeId, fieldName, templateId = null, manualData = null, transaction = null, skipRebuild = false, meta = {}) {
        let result = null;
        switch (fieldName) {
            case 'attendance_setting_template':
                result = await this.syncAttendanceTemplate(employeeId, templateId, manualData, transaction, meta);
                break;
            case 'holiday_template':
                result = await this.syncHolidayTemplate(employeeId, templateId, manualData, transaction, skipRebuild, meta);
                break;
            case 'weekly_off_template':
                result = await this.syncWeeklyOffTemplate(employeeId, templateId, manualData, transaction, skipRebuild, meta);
                break;
            case 'leave_template':
                result = await this.syncLeaveTemplate(employeeId, templateId, manualData, transaction, meta);
                break;
            case 'salary_template_id':
                result = await this.syncSalaryTemplate(employeeId, templateId, manualData, transaction, meta);
                break;
            case 'shift_template':
                result = await this.syncShiftTemplate(employeeId, templateId, manualData, transaction, skipRebuild, meta);
                break;
        }

        // Trigger past data sync for attendance related templates
        if (!skipRebuild && ['attendance_setting_template', 'holiday_template', 'weekly_off_template'].includes(fieldName)) {
            const employee = meta.employee || await commonQuery.findOneRecord(Employee, employeeId, { attributes: ['id', 'company_id', 'branch_id'] }, transaction);
            if (employee) {
                await this.syncAttendanceForPastDays([employeeId], transaction, {
                    user_id: meta.user_id || meta.req?.user?.id || 0,
                    company_id: meta.company_id || employee.company_id,
                    branch_id: meta.branch_id || employee.branch_id
                });
            }
        }
        return result;
    }

    /**
     * Optimized bulk handler for template synchronization.
     * @param {Array<number>} employeeIds 
     * @param {string} fieldName 
     * @param {number|null} templateId 
     * @param {Object} transaction 
     */
    static async bulkSyncSpecificTemplate(employeeIds, fieldName, templateId = null, transaction = null, meta = {}) {
        if (!Array.isArray(employeeIds) || employeeIds.length === 0) return;

        let result = null;
        switch (fieldName) {
            case 'attendance_setting_template':
                result = await this.bulkSyncAttendanceTemplate(employeeIds, templateId, transaction, meta, meta.skipRebuild);
                break;
            case 'holiday_template':
                result = await this.bulkSyncHolidayTemplate(employeeIds, templateId, transaction, meta, meta.skipRebuild);
                break;
            case 'weekly_off_template':
                result = await this.bulkSyncWeeklyOffTemplate(employeeIds, templateId, transaction, meta, meta.skipRebuild);
                break;
            case 'leave_template':
                result = await LeaveBalanceService.bulkSyncEmployeeBalances(employeeIds, templateId, transaction, meta);
                break;
            case 'salary_template_id':
                result = await this.bulkSyncSalaryTemplate(employeeIds, templateId, transaction, meta);
                break;
            case 'shift_template':
                result = await this.bulkSyncShiftTemplate(employeeIds, templateId, transaction, meta, meta.skipRebuild);
                break;
        }

        // Trigger past data sync for attendance related templates
        // if (!meta.skipRebuild && ['holiday_template', 'weekly_off_template'].includes(fieldName)) {
        //     await this.syncAttendanceForPastDays(employeeIds, transaction, {
        //         user_id: meta.user_id || meta.req?.user?.id || 0,
        //         company_id: meta.company_id,
        //         branch_id: meta.branch_id
        //     });
        // }
        return result;
    }

    // --- ATTENDANCE SYNC HELPERS ---

    static async syncAttendanceForPastDays(employeeIds, transaction = null, meta = {}) {
        if (!Array.isArray(employeeIds) || employeeIds.length === 0) return;
        try {
            // Rebuild current month to fill in holidays, weekly offs, and auto-absent
            const startOfMonth = dayjs().startOf('month');
            const today = dayjs();
            let cur = startOfMonth;

            while (cur.isBefore(today) || cur.isSame(today, 'day')) {
                await bulkSyncAttendanceDays(employeeIds, cur.format("YYYY-MM-DD"), meta, transaction);
                cur = cur.add(1, 'day');
            }
        } catch (error) {
            console.error("Error in syncAttendanceForPastDays:", error);
            // Don't throw to avoid blocking the main transaction if auto-sync fails
        }
    }

    // --- INTERNAL SYNC HELPERS ---

    static async syncAttendanceTemplate(employeeId, templateId, manualData, transaction, meta = {}) {
        if (!templateId && !manualData) {
            await commonQuery.softDeleteById(EmployeeAttendanceTemplate, { employee_id: employeeId }, transaction);
            return;
        }

        let data = manualData;
        if (!data && templateId) {
            const master = meta.preFetchedMaster || await commonQuery.findOneRecord(AttendanceTemplate, templateId, {}, transaction);
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

    static async bulkSyncAttendanceTemplate(employeeIds, templateId, transaction, meta = {}) {
        if (!templateId) {
            await commonQuery.softDeleteById(EmployeeAttendanceTemplate, { employee_id: { [Op.in]: employeeIds } }, transaction);
            return;
        }

        const master = meta.preFetchedMaster || await commonQuery.findOneRecord(AttendanceTemplate, templateId, {}, transaction);
        if (!master) return;

        const data = master.toJSON();
        delete data.id; delete data.created_at; delete data.updated_at;

        // 1. Fetch existing mappings for these employees
        const existing = await commonQuery.findAllRecords(EmployeeAttendanceTemplate, { employee_id: { [Op.in]: employeeIds } }, {}, transaction);
        const existingMap = new Map(existing.map(e => [e.employee_id, e]));

        const toCreate = [];
        const toUpdate = [];

        for (const empId of employeeIds) {
            const payload = { ...data, employee_id: empId, template_id: templateId };
            const ext = existingMap.get(empId);
            if (ext) {
                toUpdate.push({ id: ext.id, payload });
            } else {
                toCreate.push(payload);
            }
        }

        // 2. Perform bulk updates/creates
        if (toCreate.length > 0) {
            await commonQuery.bulkCreate(EmployeeAttendanceTemplate, toCreate, {}, transaction);
        }
        for (const item of toUpdate) {
            await commonQuery.updateRecordById(EmployeeAttendanceTemplate, item.id, item.payload, transaction);
        }
    }

    static async syncHolidayTemplate(employeeId, templateId, manualData, transaction, skipRebuild = false, meta = {}) {
        if (!templateId && !manualData) {
            await commonQuery.hardDeleteRecords(EmployeeHoliday, { employee_id: employeeId }, transaction);
            return;
        }

        let items = manualData;
        if (!items && templateId) {
            items = meta.preFetchedMaster || await commonQuery.findAllRecords(HolidayTransaction, { template_id: templateId, status: 0 }, {}, transaction);
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

        // Trigger attendance rebuild for current month to reflect new holidays
        if (!skipRebuild) {
            await this.rebuildCurrentMonthAttendance(employeeId, transaction);
        }
    }

    static async bulkSyncHolidayTemplate(employeeIds, templateId, transaction, meta = {}, skipRebuild = false) {
        if (!templateId) {
            await commonQuery.hardDeleteRecords(EmployeeHoliday, { employee_id: { [Op.in]: employeeIds } }, transaction);
            return;
        }

        let items = meta.preFetchedMaster || await commonQuery.findAllRecords(HolidayTransaction, { template_id: templateId, status: 0 }, {}, transaction);
        
        if (items && items.length > 0) {
            const employeeHolidayItems = [];
            for (const empId of employeeIds) {
                for (const holiday of items) {
                    const d = holiday.toJSON();
                    delete d.id; delete d.created_at; delete d.updated_at;
                    employeeHolidayItems.push({ ...d, employee_id: empId, template_id: templateId });
                }
            }

            await commonQuery.hardDeleteRecords(EmployeeHoliday, { employee_id: { [Op.in]: employeeIds } }, transaction);
            if (employeeHolidayItems.length > 0) {
                await commonQuery.bulkCreate(EmployeeHoliday, employeeHolidayItems, {}, transaction);
            }
        } else {
            await commonQuery.hardDeleteRecords(EmployeeHoliday, { employee_id: { [Op.in]: employeeIds } }, transaction);
        }

        if (!skipRebuild) {
            await this.rebuildCurrentMonthAttendance(employeeIds, transaction);
        }
    }

    static async syncWeeklyOffTemplate(employeeId, templateId, manualData, transaction, skipRebuild = false, meta = {}) {
        if (!templateId && !manualData) {
            await commonQuery.hardDeleteRecords(EmployeeWeeklyOff, { employee_id: employeeId }, transaction);
            return;
        }

        let items = manualData;
        if (!items && templateId) {
            items = meta.preFetchedMaster || await commonQuery.findAllRecords(WeeklyOffTemplateDay, { template_id: templateId, status: 0 }, {}, transaction);
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

        // Trigger attendance rebuild for current month to reflect new off days
        if (!skipRebuild) {
            await this.rebuildCurrentMonthAttendance(employeeId, transaction);
        }
    }

    static async bulkSyncWeeklyOffTemplate(employeeIds, templateId, transaction, meta = {}, skipRebuild = false) {
        if (!templateId) {
            await commonQuery.hardDeleteRecords(EmployeeWeeklyOff, { employee_id: { [Op.in]: employeeIds } }, transaction);
            return;
        }

        let items = meta.preFetchedMaster || await commonQuery.findAllRecords(WeeklyOffTemplateDay, { template_id: templateId, status: 0 }, {}, transaction);
        
        if (items && items.length > 0) {
            const employeeWeeklyOffItems = [];
            for (const empId of employeeIds) {
                for (const item of items) {
                    const d = item.toJSON ? item.toJSON() : item;
                    delete d.id; delete d.created_at; delete d.updated_at;
                    employeeWeeklyOffItems.push({ ...d, employee_id: empId, template_id: templateId });
                }
            }

            await commonQuery.hardDeleteRecords(EmployeeWeeklyOff, { employee_id: { [Op.in]: employeeIds } }, transaction);
            if (employeeWeeklyOffItems.length > 0) {
                await commonQuery.bulkCreate(EmployeeWeeklyOff, employeeWeeklyOffItems, {}, transaction);
            }
        } else {
            await commonQuery.hardDeleteRecords(EmployeeWeeklyOff, { employee_id: { [Op.in]: employeeIds } }, transaction);
        }

        if (!skipRebuild) {
            await this.rebuildCurrentMonthAttendance(employeeIds, transaction);
        }
    }

    static async syncLeaveTemplate(employeeId, templateId, manualData, transaction, meta = {}) {
        // We now use LeaveBalanceService to handle this as it manages EmployeeLeaveBalance records
        await LeaveBalanceService.syncEmployeeBalances(employeeId, templateId, transaction, meta.employee, meta.preFetchedMaster);
        
        // If there's manual data, we could potentially iterate and update specific balances here
        // but for now, standard sync is preferred to maintain policy integrity.
    }

    static async syncSalaryTemplate(employeeId, templateId, manualData, transaction, meta = {}) {
        if (!templateId && !manualData) {
            await commonQuery.softDeleteById(EmployeeSalaryTemplateTransaction, { employee_id: employeeId }, transaction);
            await commonQuery.softDeleteById(EmployeeSalaryTemplate, { employee_id: employeeId }, transaction);
            return;
        }

        // First sync the main salary template data
        let templateData = manualData;
        let masterComponents = null;

        if (!templateData && templateId) {
            const masterTemplate = meta.preFetchedMaster || await commonQuery.findOneRecord(SalaryTemplate, templateId, {
                include: [{ model: SalaryTemplateTransaction, as: "salaryTemplateTransactions" }]
            }, transaction);
            
            if (masterTemplate) {
                templateData = masterTemplate.toJSON();
                masterComponents = templateData.salaryTemplateTransactions; // Capture related components
                delete templateData.id; delete templateData.created_at; delete templateData.updated_at;
                delete templateData.salaryTemplateTransactions;
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

            // Sync Employee table fields
            const sc = templateData.statutory_config;
            if (sc) {
                await commonQuery.updateRecordById(Employee, employeeId, {
                    salary_template_id: templateId || 0,
                    pf_eligible: sc?.employee_pf?.enabled || false,
                    esi_eligible: sc?.employee_esi?.enabled || false,
                    pt_eligible: sc?.pt?.enabled || false,
                    lwf_eligible: sc?.employee_lwf?.enabled || false,
                }, transaction);
            } else {
                 await commonQuery.updateRecordById(Employee, employeeId, {
                    salary_template_id: templateId || 0
                }, transaction);
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

    static async bulkSyncSalaryTemplate(employeeIds, templateId, transaction, meta = {}) {
        if (!templateId) {
            await commonQuery.softDeleteById(EmployeeSalaryTemplateTransaction, { employee_id: { [Op.in]: employeeIds } }, transaction);
            await commonQuery.softDeleteById(EmployeeSalaryTemplate, { employee_id: { [Op.in]: employeeIds } }, transaction);
            return;
        }

        const masterTemplate = meta.preFetchedMaster || await commonQuery.findOneRecord(SalaryTemplate, templateId, {
            include: [{ model: SalaryTemplateTransaction, as: "salaryTemplateTransactions" }]
        }, transaction);

        if (!masterTemplate) return;

        const templateData = masterTemplate.toJSON();
        const masterComponents = templateData.salaryTemplateTransactions || [];
        delete templateData.id; delete templateData.created_at; delete templateData.updated_at;
        delete templateData.salaryTemplateTransactions;

        // 1. Sync Main Template Records in Bulk
        const existing = await commonQuery.findAllRecords(EmployeeSalaryTemplate, { employee_id: { [Op.in]: employeeIds } }, {}, transaction);
        const existingMap = new Map(existing.map(e => [e.employee_id, e]));

        const toCreateTemplates = [];
        const toUpdateTemplates = [];

        for (const empId of employeeIds) {
            const payload = { ...templateData, employee_id: empId, template_id: templateId };
            const ext = existingMap.get(empId);
            if (ext) toUpdateTemplates.push({ id: ext.id, payload });
            else toCreateTemplates.push(payload);
        }

        if (toCreateTemplates.length > 0) {
            await commonQuery.bulkCreate(EmployeeSalaryTemplate, toCreateTemplates, {}, transaction);
        }
        for (const item of toUpdateTemplates) {
            await commonQuery.updateRecordById(EmployeeSalaryTemplate, item.id, item.payload, transaction);
        }

        // Refresh mapping to get IDs of newly created records for transactions
        const allEmpTemplates = await commonQuery.findAllRecords(EmployeeSalaryTemplate, { employee_id: { [Op.in]: employeeIds } }, { attributes: ['id', 'employee_id'] }, transaction);
        const empTemplateIdMap = new Map(allEmpTemplates.map(et => [et.employee_id, et.id]));

        // 2. Sync Components in Bulk
        const componentPayloads = [];
        for (const empId of employeeIds) {
            const empTemplateId = empTemplateIdMap.get(empId);
            for (const comp of masterComponents) {
                const d = comp.toJSON ? comp.toJSON() : comp;
                const payload = { 
                    ...d, 
                    employee_id: empId, 
                    employee_salary_template_id: empTemplateId 
                };
                delete payload.id; delete payload.created_at; delete payload.updated_at;
                componentPayloads.push(payload);
            }
        }

        await commonQuery.hardDeleteRecords(EmployeeSalaryTemplateTransaction, { employee_id: { [Op.in]: employeeIds } }, transaction);
        if (componentPayloads.length > 0) {
            await commonQuery.bulkCreate(EmployeeSalaryTemplateTransaction, componentPayloads, {}, transaction);
        }

        // 3. Sync Employee Table Fields
        const sc = templateData.statutory_config;
        const empUpdatePayload = { salary_template_id: templateId };
        if (sc) {
            empUpdatePayload.pf_eligible = sc?.employee_pf?.enabled || false;
            empUpdatePayload.esi_eligible = sc?.employee_esi?.enabled || false;
            empUpdatePayload.pt_eligible = sc?.pt?.enabled || false;
            empUpdatePayload.lwf_eligible = sc?.employee_lwf?.enabled || false;
        }

        await commonQuery.updateRecordById(Employee, { id: { [Op.in]: employeeIds } }, empUpdatePayload, transaction);
    }

    static async syncShiftTemplate(employeeId, templateId, manualData, transaction, skipRebuild = false, meta = {}) {
        if (!templateId && !manualData) {
            await commonQuery.hardDeleteRecords(EmployeeShift, { employee_id: employeeId }, transaction);
            return;
        }

        let data = manualData;
        if (!data && templateId) {
            const master = meta.preFetchedMaster || await commonQuery.findOneRecord(ShiftTemplate, templateId, {}, transaction);
            if (master) {
                data = master.toJSON();
                // Store master template ID as shift_id in the employee setting
                data.shift_id = master.id;
                delete data.id; delete data.created_at; delete data.updated_at;
            }
        }

        if (!data) return;

        // 1. Clear existing day-wise settings for this employee
        await commonQuery.hardDeleteRecords(EmployeeShift, { employee_id: employeeId }, transaction);

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
            await commonQuery.bulkCreate(EmployeeShift, payloads, {}, transaction);
        }

        // Trigger attendance rebuild for current month to reflect new shift timings
        if (!skipRebuild) {
            await this.rebuildCurrentMonthAttendance(employeeId, transaction);
        }
    }

    static async bulkSyncShiftTemplate(employeeIds, templateId, transaction, meta = {}, skipRebuild = false) {
        if (!templateId) {
            await commonQuery.hardDeleteRecords(EmployeeShift, { employee_id: { [Op.in]: employeeIds } }, transaction);
            return;
        }

        const master = meta.preFetchedMaster || await commonQuery.findOneRecord(ShiftTemplate, templateId, {}, transaction);
        if (!master) return;

        let data = master.toJSON ? master.toJSON() : master;
        data.shift_id = master.id;
        delete data.id; delete data.created_at; delete data.updated_at;

        // 1. Clear existing day-wise settings for these employees
        await commonQuery.hardDeleteRecords(EmployeeShift, { employee_id: { [Op.in]: employeeIds } }, transaction);

        // 2. Fetch Weekly Offs for these employees to identify "All Week" offs
        const weeklyOffs = await commonQuery.findAllRecords(EmployeeWeeklyOff, {
            employee_id: { [Op.in]: employeeIds },
            week_no: 0,
            is_off: true
        }, {}, transaction);

        const offDaysMap = {};
        for (const empId of employeeIds) offDaysMap[empId] = [];
        weeklyOffs.forEach(wo => {
            if (!offDaysMap[wo.employee_id]) offDaysMap[wo.employee_id] = [];
            offDaysMap[wo.employee_id].push(wo.day_of_week);
        });

        // 3. Create shift settings for all 7 days (0-6), skipping permanent week-offs
        const payloads = [];
        for (const empId of employeeIds) {
            const offDays = offDaysMap[empId] || [];
            const daysToCreate = [0, 1, 2, 3, 4, 5, 6].filter(day => !offDays.includes(day));
            
            for (const day of daysToCreate) {
                payloads.push({
                    ...data,
                    employee_id: empId,
                    day_of_week: day,
                    shift_id: templateId || data.shift_id,
                    company_id: data.company_id || 0,
                });
            }
        }

        if (payloads.length > 0) {
            await commonQuery.bulkCreate(EmployeeShift, payloads, {}, transaction);
        }

        // 4. Batch rebuild
        if (!skipRebuild) {
            await this.rebuildCurrentMonthAttendance(employeeIds, transaction);
        }
    }

    /**
     * Rebuilds attendance for the current month for one or more employees.
     * Optimized for bulk by fetching monthly data in chunks.
     */
    static async rebuildCurrentMonthAttendance(employeeIds, transaction = null) {
        if (!Array.isArray(employeeIds)) employeeIds = [employeeIds];
        if (employeeIds.length === 0) return;

        const today = dayjs();
        const startOfMonth = today.startOf('month').format('YYYY-MM-DD');
        const endOfMonth = today.endOf('month').format('YYYY-MM-DD');
        
        // 1. Pre-fetch all employees to avoid redundant calls in the deeper helpers
        const employees = await commonQuery.findAllRecords(Employee, { id: { [Op.in]: employeeIds } }, {
            include: [
                { model: EmployeeAttendanceTemplate, as: "employeeAttendanceTemplate", where: { status: 0 }, required: false },
                { model: AttendanceTemplate, as: "attendanceTemplate", required: false }
            ]
        }, transaction);
        if (!employees.length) return;

        const empMap = new Map(employees.map(e => [e.id, e]));

        // 2. Fetch ALL relevant data for these employees for the entire month to process in memory
        // This is much faster than querying day-by-day in the loop.
        
        // --- Punches ---
        const allMonthPunches = await commonQuery.findAllRecords(AttendancePunch, {
            employee_id: { [Op.in]: employeeIds },
            punch_time: { [Op.between]: [`${startOfMonth} 00:00:00`, `${endOfMonth} 23:59:59`] },
            status: 0
        }, { order: [['punch_time', 'ASC']] }, transaction, { company_id: true });

        const punchMap = new Map(); // Key: empId_YYYY-MM-DD
        allMonthPunches.forEach(p => {
            const dateStr = dayjs(p.punch_time).format('YYYY-MM-DD');
            const key = `${p.employee_id}_${dateStr}`;
            if (!punchMap.has(key)) punchMap.set(key, []);
            punchMap.get(key).push(p);
        });

        // --- Holidays ---
        const holidayTemplateIds = [...new Set(employees.map(e => e.holiday_template).filter(Boolean))];
        const allHolidays = holidayTemplateIds.length > 0 ? await commonQuery.findAllRecords(HolidayTransaction, {
            template_id: { [Op.in]: holidayTemplateIds },
            date: { [Op.between]: [startOfMonth, endOfMonth] },
            status: 0
        }, {}, transaction) : [];
        const holidayMap = new Map(); // Key: templateId_YYYY-MM-DD
        allHolidays.forEach(h => holidayMap.set(`${h.template_id}_${h.date}`, h));

        // --- Weekly Offs ---
        const weeklyOffTemplateIds = [...new Set(employees.map(e => e.weekly_off_template).filter(Boolean))];
        const allWeeklyOffs = weeklyOffTemplateIds.length > 0 ? await commonQuery.findAllRecords(WeeklyOffTemplateDay, {
            template_id: { [Op.in]: weeklyOffTemplateIds },
            status: 0
        }, {}, transaction) : [];
        const weeklyOffMap = new Map(); // Key: templateId
        allWeeklyOffs.forEach(wo => {
            if (!weeklyOffMap.has(wo.template_id)) weeklyOffMap.set(wo.template_id, []);
            weeklyOffMap.get(wo.template_id).push(wo);
        });

        // --- Shifts ---
        const allEmpShifts = await commonQuery.findAllRecords(EmployeeShift, {
            employee_id: { [Op.in]: employeeIds },
            status: 0
        }, {}, transaction);
        const empShiftMap = new Map(); // Key: empId
        allEmpShifts.forEach(s => {
            if (!empShiftMap.has(s.employee_id)) empShiftMap.set(s.employee_id, []);
            empShiftMap.get(s.employee_id).push(s);
        });

        const shiftTemplateIds = [...new Set([
            ...employees.map(e => e.shift_template).filter(Boolean),
            ...allEmpShifts.map(s => s.shift_id).filter(Boolean)
        ])];
        const allShiftTemplates = shiftTemplateIds.length > 0 ? await commonQuery.findAllRecords(ShiftTemplate, {
            id: { [Op.in]: shiftTemplateIds }
        }, { include: [{ model: ShiftBreak, as: "ShiftBreaks" }] }, transaction) : [];
        const shiftTemplateMap = new Map(allShiftTemplates.map(s => [s.id, s]));

        // --- Leaves ---
        const allApprovedLeaves = await commonQuery.findAllRecords(LeaveRequest, {
            employee_id: { [Op.in]: employeeIds },
            approval_status: constants.LEAVE_APPROVAL_STATUS.APPROVED,
            [Op.or]: [
                { start_date: { [Op.between]: [startOfMonth, endOfMonth] } },
                { end_date: { [Op.between]: [startOfMonth, endOfMonth] } },
                { [Op.and]: [{ start_date: { [Op.lte]: startOfMonth } }, { end_date: { [Op.gte]: endOfMonth } }] }
            ],
            status: 0
        }, {}, transaction);
        
        const leaveMap = new Map(); // Key: empId_YYYY-MM-DD
        allApprovedLeaves.forEach(l => {
            let cur = dayjs(l.start_date);
            const lEnd = dayjs(l.end_date);
            while (cur.isBefore(lEnd) || cur.isSame(lEnd, 'day')) {
                const ds = cur.format('YYYY-MM-DD');
                if (ds >= startOfMonth && ds <= endOfMonth) {
                    leaveMap.set(`${l.employee_id}_${ds}`, l);
                }
                cur = cur.add(1, 'day');
            }
        });

        // 3. Loop through days and employees
        let currentDate = dayjs(startOfMonth);
        const lastDate = dayjs(endOfMonth);

        while (currentDate.isBefore(lastDate) || currentDate.isSame(lastDate, 'day')) {
            const dateStr = currentDate.format('YYYY-MM-DD');
            const dayOfWeek = currentDate.day();
            const dayOfMonth = currentDate.date();
            const weekNo = Math.ceil(dayOfMonth / 7);
            
            for (const empId of employeeIds) {
                const emp = empMap.get(empId);
                if (!emp) continue;

                // Prepare context for rebuildAttendanceDay to avoid internal queries
                const context = {
                    employee: emp,
                    preFetchedPunches: punchMap.get(`${empId}_${dateStr}`) || [],
                    preFetchedHoliday: holidayMap.get(`${emp.holiday_template}_${dateStr}`) || null,
                    preFetchedWeeklyOffs: weeklyOffMap.get(emp.weekly_off_template) || [],
                    preFetchedEmpShifts: empShiftMap.get(empId) || [],
                    preFetchedShiftTemplates: shiftTemplateMap,
                    preFetchedLeave: leaveMap.get(`${empId}_${dateStr}`) || null,
                    dayOfWeek,
                    weekNo
                };

                try {
                    await rebuildAttendanceDay(empId, dateStr, context, transaction);
                } catch (err) {
                    console.error(`[Rebuild] Failed for emp ${empId} on ${dateStr}:`, err.message);
                }
            }
            currentDate = currentDate.add(1, 'day');
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
