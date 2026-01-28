module.exports = (sequelize, DataTypes) => {
    const EmployeeWeeklyOff = sequelize.define(
        "EmployeeWeeklyOff",
        {
            employee_id: { type: DataTypes.INTEGER, allowNull: false, references: { model: 'employees', key: 'id' } },
            template_id: { type: DataTypes.INTEGER, allowNull: true, references: { model: 'weekly_off_templates', key: 'id' } },
            day_of_week: { type: DataTypes.SMALLINT, allowNull: false, comment: "0=Sunday, 1=Monday ... 6=Saturday" },
            week_no: { type: DataTypes.SMALLINT, allowNull: false, comment: "0=All, 1=1st week ... 5=5th week" },
            is_off: { type: DataTypes.BOOLEAN, defaultValue: false },
            status: { type: DataTypes.SMALLINT, defaultValue: 0 },
            user_id: { type: DataTypes.INTEGER, allowNull: true },
            branch_id: { type: DataTypes.INTEGER, allowNull: true },
            company_id: { type: DataTypes.INTEGER, allowNull: true },
        },
        {
            tableName: "employee_weekly_offs",
            timestamps: true,
            underscored: true
        }
    );

    EmployeeWeeklyOff.associate = (models) => {
        EmployeeWeeklyOff.belongsTo(models.Employee, { foreignKey: "employee_id", as: "employee" });
    };

    return EmployeeWeeklyOff;
};
