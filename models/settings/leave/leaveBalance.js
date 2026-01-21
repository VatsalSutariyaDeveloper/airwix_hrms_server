module.exports = (sequelize, DataTypes) => {
    const LeaveBalance = sequelize.define(
        "LeaveBalance",
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
            total_allocated: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
            used_leaves: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
            pending_leaves: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
            carry_forward_leaves: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
            status: { type: DataTypes.SMALLINT, defaultValue: 0 },
            company_id: { type: DataTypes.INTEGER, allowNull: true },
        },
        {
            tableName: "leave_balances",
            timestamps: true,
            underscored: true,
        }
    );

    LeaveBalance.associate = (models) => {
        LeaveBalance.belongsTo(models.Employee, { foreignKey: "employee_id", as: "employee" });
        LeaveBalance.belongsTo(models.LeaveTemplate, { foreignKey: "leave_template_id", as: "template" });
        LeaveBalance.belongsTo(models.LeaveTemplateCategory, { foreignKey: "leave_category_id", as: "category" });
    };

    return LeaveBalance;
};
