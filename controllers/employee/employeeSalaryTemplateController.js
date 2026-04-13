const {
    Employee,
    EmployeeSalaryTemplate,
    EmployeeSalaryTemplateTransaction,
    SalaryComponent,
    sequelize,
    SalaryRevisionHistory,
    WeeklyOffTemplate,
    WeeklyOffTemplateDay,
    ShiftTemplate,
    EmployeeShift,
    EmployeeWeeklyOff
} = require("../../models");
const { commonQuery, handleError } = require("../../helpers");
const { calculateWorkingAndOffDays } = require("../../helpers/functions/commonFunctions");
const dayjs = require("dayjs");
const { constants } = require("../../helpers/constants");
const EmployeeTemplateService = require("../../services/employeeTemplateService");

const employeeSalaryTemplateController = {
    /**
     * Get employee-specific salary template and components.
     */
    getTemplate: async (req, res) => {
        try {
            const { employeeId } = req.params;

            const template = await commonQuery.findOneRecord(EmployeeSalaryTemplate,
                { employee_id: employeeId },
                {
                    include: [{
                        model: EmployeeSalaryTemplateTransaction,
                        as: "employeeSalaryTemplateTransactions",
                        include: [{
                            model: SalaryComponent,
                            as: "component",
                            attributes: ["id", "component_name", "component_type", "component_category", "calculation_type", "is_taxable", "is_statutory", "is_lwp_impacted", "is_part_of_ctc", "is_part_of_gross", "is_part_of_take_home", "is_system_component", "formula"]
                        }]
                    }]
                }
            );

            if (!template) {
                return res.error("VALIDATION_ERROR", "No salary template assigned to this employee");
            }

            // Fetch dynamic working days and hours
            const employee = await commonQuery.findOneRecord(Employee, employeeId, {
                attributes: ['id', 'weekly_off_template', 'shift_template']
            });

            let workingDays = 26;
            let monthDays = 30;
            let unitWorkingHours = 8;

            if (employee) {
                // 1. Working Days - Check Employee-specific weekly offs first
                let weeklyOffDays = await commonQuery.findAllRecords(EmployeeWeeklyOff, {
                    employee_id: employeeId,
                    status: 0
                });

                // If no specific employee weekly offs, fallback to template
                if ((!weeklyOffDays || weeklyOffDays.length === 0) && employee.weekly_off_template) {
                    const weeklyOffTemplate = await commonQuery.findOneRecord(
                        WeeklyOffTemplate,
                        employee.weekly_off_template,
                        {
                            include: [{ model: WeeklyOffTemplateDay, as: "days" }]
                        }
                    );

                    if (weeklyOffTemplate) {
                        weeklyOffDays = weeklyOffTemplate.days;
                    }
                }

                if (weeklyOffDays && weeklyOffDays.length > 0) {
                    const result = calculateWorkingAndOffDays(weeklyOffDays, new Date());
                    workingDays = result.working_days;
                    monthDays = result.total_days_in_month;
                }

                // 2. Working Hours from Shift
                const dateObj = dayjs();
                const dayOfWeek = dateObj.day();

                const empShift = await commonQuery.findOneRecord(EmployeeShift, {
                    employee_id: employeeId,
                    day_of_week: dayOfWeek,
                    status: 0,
                });

                let shift = null;
                if (empShift && empShift.shift_id) {
                    shift = await commonQuery.findOneRecord(ShiftTemplate, empShift.shift_id);
                } else if (!empShift && employee.shift_template) {
                    shift = await commonQuery.findOneRecord(ShiftTemplate, employee.shift_template);
                } else if (empShift && !empShift.shift_id) {
                    shift = empShift; // Manual shift configuration
                }

                if (shift) {
                    if (parseFloat(shift.total_payable_hours) > 0) {
                        unitWorkingHours = parseFloat(shift.total_payable_hours) / 60;
                    } else if (shift.min_full_day_minutes > 0) {
                        unitWorkingHours = shift.min_full_day_minutes / 60;
                    }
                }
            }

            const responseData = {
                ...template.toJSON(),
                working_days: workingDays,
                month_days: monthDays,
                unit_working_hours: unitWorkingHours
            };

            return res.success("Employee salary template fetched successfully", responseData);
        } catch (error) {
            return handleError(error, res, req);
        }
    },

    /**
     * Update employee-specific salary template data.
     */
    updateTemplate: async (req, res) => {
        const transaction = await sequelize.transaction();
        try {
            const { employeeId } = req.params;
            const {
                salary_template_id,
                template_name,
                staff_type,
                salary_type,
                ctc_monthly,
                ctc_yearly,
                lwp_calculation_basis,
                statutory_config,
                components,
                effective_date,
                revision_remarks,
                daily_rate,
                hourly_rate
            } = req.body;

            // 1. Get current template for history comparison
            let employeeTemplate = await commonQuery.findOneRecord(EmployeeSalaryTemplate, {
                employee_id: employeeId
            }, {}, transaction);

            const oldCTC = employeeTemplate ? parseFloat(employeeTemplate.ctc_monthly) || 0 : 0;
            const newCTC = parseFloat(ctc_monthly) || 0;

            const templatePayload = {
                employee_id: employeeId,
                template_id: salary_template_id || null,
                template_name,
                staff_type,
                salary_type,
                ctc_monthly: newCTC,
                ctc_yearly: parseFloat(ctc_yearly) || (newCTC * 12),
                lwp_calculation_basis,
                statutory_config,
                daily_rate: parseFloat(daily_rate) || 0,
                hourly_rate: parseFloat(hourly_rate) || 0,
                company_id: req.user?.company_id || 0,
                branch_id: req.user?.branch_id || 0,
                user_id: req.user?.id || 0
            };

            if (employeeTemplate) {
                await commonQuery.updateRecordById(EmployeeSalaryTemplate, employeeTemplate.id, templatePayload, transaction);
            } else {
                employeeTemplate = await commonQuery.createRecord(EmployeeSalaryTemplate, templatePayload, transaction);
            }

            // 2. History Recording
            if (oldCTC !== newCTC || (employeeTemplate && employeeTemplate.template_id !== (salary_template_id || null))) {
                await commonQuery.createRecord(SalaryRevisionHistory, {
                    employee_id: employeeId,
                    previous_template_id: employeeTemplate?.template_id || null,
                    new_template_id: salary_template_id || null,
                    previous_ctc: oldCTC,
                    new_ctc: newCTC,
                    effective_date: effective_date || new Date(),
                    increment_amount: newCTC - oldCTC,
                    increment_percentage: oldCTC > 0 ? ((newCTC - oldCTC) / oldCTC) * 100 : 0,
                    remarks: revision_remarks || "Salary update",
                    status: 1, // Auto-approved for this manual update
                    approved_by: req.user?.id || 0,
                    company_id: req.user?.company_id || 0,
                    branch_id: req.user?.branch_id || 0,
                }, transaction);
            }

            // 3. Update Employee table with template ID and statutory eligibility
            const employeeUpdatePayload = {
                salary_template_id: salary_template_id || null,
                pf_eligible: statutory_config?.employee_pf?.enabled || false,
                esi_eligible: statutory_config?.employee_esi?.enabled || false,
                pt_eligible: statutory_config?.pt?.enabled || false,
                lwf_eligible: statutory_config?.employee_lwf?.enabled || false,
            };

            await commonQuery.updateRecordById(Employee, employeeId, employeeUpdatePayload, transaction);

            // 4. Update components
            if (Array.isArray(components)) {
                await commonQuery.hardDeleteRecords(EmployeeSalaryTemplateTransaction, {
                    employee_id: employeeId
                }, transaction);

                const getCalculationType = (comp) => {
                    const explicit = String(comp.calculation_type || '').toUpperCase().trim();
                    if (explicit) return explicit;
                    const calcLabel = String(comp.calculation || '').toUpperCase().trim();
                    if (calcLabel.startsWith('% OF')) return 'PERCENTAGE';
                    if (calcLabel === 'FORMULA') return 'FORMULA';
                    if (calcLabel === 'ATTENDANCE' || calcLabel === 'VARIABLE') return 'ATTENDANCE_BASED';
                    return 'FIXED';
                };

                const componentPayloads = components.map(comp => {
                    const calculation_type = getCalculationType(comp);
                    const component_category = (comp.component_category || (['FORMULA', 'ATTENDANCE_BASED', 'PERCENTAGE'].includes(calculation_type) ? 'VARIABLE' : 'FIXED')).toUpperCase();

                    return {
                        employee_id: employeeId,
                        employee_salary_template_id: employeeTemplate.id,
                        component_id: comp.component_id,
                        calculation_type,
                        formula: comp.formula || null,
                        percentage_of: comp.percentage_of || null,
                        percentage_value: parseFloat(comp.percentage_value) || 0,
                        component_category,
                        monthly_amount: parseFloat(comp.monthly_amount) || 0,
                        yearly_amount: parseFloat(comp.yearly_amount) || (parseFloat(comp.monthly_amount) * 12),
                        included_in_ctc: comp.included_in_ctc ?? true,
                        is_employer_contribution: comp.is_employer_contribution || false,
                        company_id: req.user?.company_id || 0,
                        user_id: req.user?.id || 0
                    };
                });

                await commonQuery.bulkCreate(EmployeeSalaryTemplateTransaction, componentPayloads, {}, transaction);
            }

            await transaction.commit();
            return res.success("Employee salary template updated successfully");
        } catch (error) {
            if (transaction) await transaction.rollback();
            return handleError(error, res, req);
        }
    },

    getRevisionHistory: async (req, res) => {
        try {
            const { employeeId } = req.params;
            const history = await commonQuery.findAllRecords(SalaryRevisionHistory, {
                employee_id: employeeId
            }, {
                order: [["effective_date", "DESC"]]
            });
            return res.success("Revision history fetched successfully", history);
        } catch (error) {
            return handleError(error, res, req);
        }
    }
};

module.exports = employeeSalaryTemplateController;
