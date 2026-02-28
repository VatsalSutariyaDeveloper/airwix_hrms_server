
const {
    Employee,
    EmployeeSalaryTemplate,
    EmployeeSalaryTemplateTransaction,
    SalaryComponent,
    sequelize
} = require("../../models");
const { commonQuery, handleError } = require("../../helpers");
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
                            attributes: ["id", "component_name", "component_type", "component_category", "calculation_type", "is_taxable", "is_statutory", "is_lwp_impacted", "is_part_of_ctc", "is_part_of_gross", "is_part_of_take_home", "is_system_component"]
                        }]
                    }]
                }
            );

            if (!template) {
                return res.success(null, "No salary template assigned to this employee");
            }

            return res.success("Employee salary template fetched successfully", template);
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
                revision_remarks
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
                const { SalaryRevisionHistory } = require("../../models");
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

                const componentPayloads = components.map(comp => ({
                    employee_id: employeeId,
                    employee_salary_template_id: employeeTemplate.id,
                    component_id: comp.component_id,
                    component_category: (comp.component_category || 'FIXED').toUpperCase(),
                    monthly_amount: parseFloat(comp.monthly_amount) || 0,
                    yearly_amount: parseFloat(comp.yearly_amount) || (parseFloat(comp.monthly_amount) * 12),
                    included_in_ctc: comp.included_in_ctc ?? true,
                    is_employer_contribution: comp.is_employer_contribution || false,
                    company_id: req.user?.company_id || 0,
                    branch_id: req.user?.branch_id || 0,
                    user_id: req.user?.id || 0
                }));

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
            const { SalaryRevisionHistory } = require("../../models");
            const history = await SalaryRevisionHistory.findAll({
                where: { employee_id: employeeId },
                order: [["effective_date", "DESC"]]
            });
            return res.success("Revision history fetched successfully", history);
        } catch (error) {
            return handleError(error, res, req);
        }
    }
};

module.exports = employeeSalaryTemplateController;
