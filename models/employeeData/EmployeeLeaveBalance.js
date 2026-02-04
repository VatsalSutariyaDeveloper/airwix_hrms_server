module.exports = (sequelize, DataTypes) => {
    const EmployeeLeaveBalance = sequelize.define(
        "EmployeeLeaveBalance",
        {
            employee_id: {
                type: DataTypes.INTEGER,
                allowNull: false,
                references: { model: "employees", key: "id" },
            },
            leave_template_id: {
                type: DataTypes.INTEGER,
                allowNull: false,
                references: { model: "leave_templates", key: "id" },
            },
            leave_category_id: {
                type: DataTypes.INTEGER,
                allowNull: false,
                references: { model: "leave_template_categories", key: "id" },
            },
            year: { type: DataTypes.INTEGER, allowNull: false },
            leave_category_name: { type: DataTypes.STRING(100), allowNull: false },
            total_allocated: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
            used_leaves: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
            pending_leaves: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
            carry_forward_leaves: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
            unused_leave_rule: {
                type: DataTypes.ENUM('LAPSE', 'CARRY_FORWARD', 'ENCASH'),
                allowNull: false,
                defaultValue: 'LAPSE',
            },
            carry_forward_limit: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
            is_paid: { type: DataTypes.BOOLEAN, defaultValue: true },
            automation_rules: { type: DataTypes.TEXT, allowNull: true },
            status: { type: DataTypes.SMALLINT, defaultValue: 0 },
            company_id: { type: DataTypes.INTEGER, allowNull: true },
        },
        {
            tableName: "employee_leave_balances",
            timestamps: true,
            underscored: true,
        }
    );

    EmployeeLeaveBalance.associate = (models) => {
        EmployeeLeaveBalance.belongsTo(models.Employee, { foreignKey: "employee_id", as: "employee" });
        EmployeeLeaveBalance.belongsTo(models.LeaveTemplate, { foreignKey: "leave_template_id", as: "template" });
        EmployeeLeaveBalance.belongsTo(models.LeaveTemplateCategory, { foreignKey: "leave_category_id", as: "category" });
    };

    return EmployeeLeaveBalance;
};
