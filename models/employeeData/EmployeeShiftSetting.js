module.exports = (sequelize, DataTypes) => {
    const EmployeeShiftSetting = sequelize.define("EmployeeShiftSetting",
        {
            employee_id: { type: DataTypes.INTEGER, allowNull: false, references: { model: 'employees', key: 'id' } },
            shift_id: { type: DataTypes.INTEGER, allowNull: true, references: { model: 'shift_template', key: 'id' } },
            day_of_week: { type: DataTypes.SMALLINT, allowNull: false, comment: "0=Sunday, 1=Monday ... 6=Saturday" },
            shift_name: { type: DataTypes.STRING, allowNull: false },
            shift_type: { type: DataTypes.STRING, defaultValue: "Fixed Shift" },
            start_time: { type: DataTypes.TIME, allowNull: false },
            end_time: { type: DataTypes.TIME, allowNull: false },
            punch_in: { type: DataTypes.SMALLINT, defaultValue: 0 },
            punch_out: { type: DataTypes.SMALLINT, defaultValue: 0 },
            punch_in_time: { type: DataTypes.TIME },
            punch_out_time: { type: DataTypes.TIME },
            first_possible_punch_in: { type: DataTypes.TIME },
            last_possible_punch_out: { type: DataTypes.TIME },
            more_settings: { type: DataTypes.JSONB, defaultValue: {} },
            total_payable_hours: { type: DataTypes.DECIMAL(5, 2) },
            max_break_minutes: { type: DataTypes.INTEGER, defaultValue: 0 },
            grace_minutes: { type: DataTypes.INTEGER, defaultValue: 0 },
            early_exit_grace: { type: DataTypes.INTEGER, defaultValue: 0 },
            min_half_day_minutes: { type: DataTypes.INTEGER, defaultValue: 240 },
            min_full_day_minutes: { type: DataTypes.INTEGER, defaultValue: 480 },
            color: { type: DataTypes.STRING, defaultValue: "#4F46E5" },
            is_night_shift: { type: DataTypes.BOOLEAN, defaultValue: false },
            status: { type: DataTypes.SMALLINT, defaultValue: 0 },
            user_id: { type: DataTypes.INTEGER, defaultValue: 0 },
            branch_id: { type: DataTypes.INTEGER, defaultValue: 0 },
            company_id: { type: DataTypes.INTEGER, defaultValue: 0 },
        },
        {
            tableName: "employee_shift_settings",
            timestamps: true,
            underscored: true,
        }
    );

    EmployeeShiftSetting.associate = (models) => {
        EmployeeShiftSetting.belongsTo(models.Employee, { foreignKey: "employee_id", as: "employee" });
    };

    return EmployeeShiftSetting;
};
