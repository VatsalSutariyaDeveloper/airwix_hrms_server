module.exports = (sequelize, DataTypes) => {
    const EmployeeLeaveCategory = sequelize.define(
        "EmployeeLeaveCategory",
        {
            employee_id: { type: DataTypes.INTEGER, allowNull: false, references: { model: 'employees', key: 'id' } },
            leave_template_id: { type: DataTypes.INTEGER, allowNull: true, references: { model: 'leave_templates', key: 'id' } },
            leave_category_name: { type: DataTypes.STRING(100), allowNull: false },
            leave_count: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
            unused_leave_rule: {
                type: DataTypes.ENUM('LAPSE', 'CARRY_FORWARD', 'ENCASH'),
                allowNull: false,
                defaultValue: 'LAPSE',
            },
            carry_forward_limit: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
            is_paid: { type: DataTypes.BOOLEAN, defaultValue: true },
            status: { type: DataTypes.SMALLINT, defaultValue: 0 },
            company_id: { type: DataTypes.INTEGER, allowNull: true },
        },
        {
            tableName: "employee_leave_categories",
            timestamps: true,
            underscored: true,
        }
    );

    EmployeeLeaveCategory.associate = (models) => {
        EmployeeLeaveCategory.belongsTo(models.Employee, { foreignKey: "employee_id", as: "employee" });
    };

    return EmployeeLeaveCategory;
};
