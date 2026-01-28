module.exports = (sequelize, DataTypes) => {
    const EmployeePrintTemplate = sequelize.define("EmployeePrintTemplate", {
        employee_id: { type: DataTypes.INTEGER, allowNull: false, references: { model: 'employees', key: 'id' } },
        template_id: { type: DataTypes.INTEGER, allowNull: true, references: { model: 'print_templates', key: 'id' } },
        module_entity_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        template_name: { type: DataTypes.STRING(100), allowNull: false },
        template_component: { type: DataTypes.STRING(255), allowNull: false },
        priority: { type: DataTypes.INTEGER, defaultValue: 0 },
        status: { type: DataTypes.SMALLINT, defaultValue: 0 },
        user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        company_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }
    }, {
        tableName: "employee_print_templates",
        timestamps: true,
        underscored: true
    });

    EmployeePrintTemplate.associate = (models) => {
        EmployeePrintTemplate.belongsTo(models.Employee, { foreignKey: "employee_id", as: "employee" });
        EmployeePrintTemplate.belongsTo(models.PrintTemplate, { foreignKey: "template_id" });
    };

    return EmployeePrintTemplate;
};
