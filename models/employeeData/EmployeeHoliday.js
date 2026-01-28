module.exports = (sequelize, DataTypes) => {
    const EmployeeHoliday = sequelize.define(
        "EmployeeHoliday",
        {
            employee_id: { type: DataTypes.INTEGER, allowNull: false, references: { model: 'employees', key: 'id' } },
            template_id: { type: DataTypes.INTEGER, allowNull: true, references: { model: 'holiday_templates', key: 'id' } },
            name: { type: DataTypes.STRING(100), allowNull: true },
            date: { type: DataTypes.DATEONLY, allowNull: true },
            holiday_type: { type: DataTypes.SMALLINT, defaultValue: 1, comment: "1: Mandatory, 2: Restricted" },
            color: { type: DataTypes.STRING(20), defaultValue: "#E11D48" },
            status: { type: DataTypes.SMALLINT, defaultValue: 0 },
            user_id: { type: DataTypes.INTEGER, allowNull: true },
            branch_id: { type: DataTypes.INTEGER, allowNull: true },
            company_id: { type: DataTypes.INTEGER, allowNull: true }
        },
        {
            tableName: "employee_holidays",
            timestamps: true,
            underscored: true,
        }
    );

    EmployeeHoliday.associate = (models) => {
        EmployeeHoliday.belongsTo(models.Employee, { foreignKey: "employee_id", as: "employee" });
    };

    return EmployeeHoliday;
}
