
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
                            attributes: ["id", "component_name", "component_type", "component_category", "calculation_type", "is_taxable", "is_statutory", "is_lwp_impacted"]
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
                components
            } = req.body;

            // 1. Update or Create EmployeeSalaryTemplate
            let employeeTemplate = await commonQuery.findOneRecord(EmployeeSalaryTemplate, {
                employee_id: employeeId
            }, {}, transaction);

            const templatePayload = {
                employee_id: employeeId,
                template_id: salary_template_id || null,
                template_name,
                staff_type,
                salary_type,
                ctc_monthly,
                ctc_yearly,
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

            // 2. Update Employee table with template ID and statutory eligibility
            const employeeUpdatePayload = {
                salary_template_id: salary_template_id || 0,
                pf_eligible: statutory_config?.employee_pf?.enabled || false,
                esi_eligible: statutory_config?.employee_esi?.enabled || false,
                pt_eligible: statutory_config?.pt?.enabled || false,
                lwf_eligible: statutory_config?.employee_lwf?.enabled || false,
            };

            await commonQuery.updateRecordById(Employee, employeeId, employeeUpdatePayload, transaction);

            // 3. Update components (hard delete and bulk create for simplicity in employee-specific overrides)
            if (Array.isArray(components)) {
                await commonQuery.hardDeleteRecords(EmployeeSalaryTemplateTransaction, {
                    employee_id: employeeId
                }, transaction);

                const componentPayloads = components.map(comp => ({
                    employee_id: employeeId,
                    employee_salary_template_id: employeeTemplate.id,
                    component_id: comp.component_id,
                    component_category: comp.component_category,
                    monthly_amount: comp.monthly_amount,
                    yearly_amount: comp.yearly_amount,
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
            await transaction.rollback();
            return handleError(error, res, req);
        }
    }
};

module.exports = employeeSalaryTemplateController;
