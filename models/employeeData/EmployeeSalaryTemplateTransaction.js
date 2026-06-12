module.exports = (sequelize, DataTypes) => {
    const EmployeeSalaryTemplateTransaction = sequelize.define("EmployeeSalaryTemplateTransaction", {
        employee_id: { type: DataTypes.INTEGER, allowNull: false },
        employee_salary_template_id: { type: DataTypes.INTEGER, allowNull: true, references: { model: 'employee_salary_templates', key: 'id' } },
        component_id: { type: DataTypes.INTEGER, allowNull: true, references: { model: 'salary_components', key: 'id' } },
        component_category: {
            type: DataTypes.ENUM("FIXED", "VARIABLE", "STATUTORY", "EMPLOYER_CONTRIBUTION", "VARIABLE_EARNING", "BENEFIT", "ANNUAL_COMPONENT"),
            allowNull: true
        },
        monthly_amount: { type: DataTypes.DECIMAL(12, 2) },
        yearly_amount: { type: DataTypes.DECIMAL(12, 2) },
        included_in_ctc: { type: DataTypes.BOOLEAN, defaultValue: true },
        is_employer_contribution: { type: DataTypes.BOOLEAN, defaultValue: false },
        calculation_type: {
            type: DataTypes.ENUM("FIXED", "PERCENTAGE", "FORMULA", "ATTENDANCE_BASED", "CANTEEN_BASED"),
            allowNull: true
        },
        formula: { type: DataTypes.TEXT },
        percentage_of: {
            type: DataTypes.ENUM("BASIC", "GROSS", "CTC"),
            allowNull: true
        },
        percentage_value: { type: DataTypes.DECIMAL(10, 2) },
        status: { type: DataTypes.SMALLINT, defaultValue: 0 },
        user_id: { type: DataTypes.INTEGER, defaultValue: 0 },
        
        company_id: { type: DataTypes.INTEGER, defaultValue: 0 }
  }, {
    tableName: "employee_salary_template_transactions",
        timestamps: true,
        underscored: true
    });

    EmployeeSalaryTemplateTransaction.associate = models => {
        EmployeeSalaryTemplateTransaction.belongsTo(models.EmployeeSalaryTemplate, { foreignKey: "employee_salary_template_id", as: "salary_template" });
        EmployeeSalaryTemplateTransaction.belongsTo(models.SalaryComponent, { foreignKey: "component_id", as: "component" });
        EmployeeSalaryTemplateTransaction.belongsTo(models.Employee, { foreignKey: "employee_id", as: "employee" });
    };

    return EmployeeSalaryTemplateTransaction;
};
