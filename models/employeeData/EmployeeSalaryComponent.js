module.exports = (sequelize, DataTypes) => {
    const EmployeeSalaryComponent = sequelize.define("EmployeeSalaryComponent", {
        employee_id: { type: DataTypes.INTEGER, allowNull: false, references: { model: 'employees', key: 'id' } },
        template_id: { type: DataTypes.INTEGER, allowNull: true, references: { model: 'salary_templates', key: 'id' } },
        component_id: { type: DataTypes.INTEGER, allowNull: false, references: { model: 'salary_components', key: 'id' } },
        component_category: {
            type: DataTypes.ENUM("FIXED", "VARIABLE", "STATUTORY"),
            allowNull: true
        },
        monthly_amount: { type: DataTypes.DECIMAL(12, 2) },
        yearly_amount: { type: DataTypes.DECIMAL(12, 2) },
        included_in_ctc: { type: DataTypes.BOOLEAN, defaultValue: true },
        status: { type: DataTypes.SMALLINT, defaultValue: 0 },
        user_id: { type: DataTypes.INTEGER, defaultValue: 0 },
        branch_id: { type: DataTypes.INTEGER, defaultValue: 0 },
        company_id: { type: DataTypes.INTEGER, defaultValue: 0 },
    }, {
        tableName: "employee_salary_components",
        timestamps: true,
        underscored: true
    });

    EmployeeSalaryComponent.associate = models => {
        EmployeeSalaryComponent.belongsTo(models.Employee, { foreignKey: "employee_id", as: "employee" });
        EmployeeSalaryComponent.belongsTo(models.SalaryComponent, { foreignKey: "component_id", as: "component" });
    };

    return EmployeeSalaryComponent;
};
