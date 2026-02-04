module.exports = (sequelize, DataTypes) => {
  const AttendanceDay = sequelize.define(
    "AttendanceDay",
    {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        employee_id: DataTypes.INTEGER,
        attendance_date: DataTypes.DATEONLY,
        shift_id: DataTypes.INTEGER,
        first_in: DataTypes.TIME,
        last_out: DataTypes.TIME,
        worked_minutes: DataTypes.INTEGER,
        late_minutes: DataTypes.INTEGER,
        early_out_minutes: DataTypes.INTEGER,
        early_overtime_minutes: { type: DataTypes.INTEGER, defaultValue: 0 },
        total_break_minutes: { type: DataTypes.INTEGER, defaultValue: 0 },
        status: {
            type: DataTypes.SMALLINT,
            defaultValue: 0,
            comment: "0: PRESENT, 1: HALF_DAY, 3: WEEKLY_OFF, 4: HOLIDAY, 5: ABSENT, 6: LEAVE, 7: OVERTIME, 8: FINE",
        },
        overtime_minutes: { type: DataTypes.INTEGER, defaultValue: 0 },
        fine_amount: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
        leave_category_id: { type: DataTypes.INTEGER, allowNull: true },
        leave_session: { type: DataTypes.SMALLINT, allowNull: true, comment: "1: Session 1, 2: Session 2" },
        overtime_data: { type: DataTypes.JSONB, allowNull: true },
        fine_data: { type: DataTypes.JSONB, allowNull: true },
        note: { type: DataTypes.TEXT, allowNull: true },
        is_locked: { type: DataTypes.BOOLEAN, defaultValue: false },
        user_id: { type: DataTypes.INTEGER, defaultValue: 0 },
        branch_id: { type: DataTypes.INTEGER, defaultValue: 0 },
        company_id: { type: DataTypes.INTEGER, defaultValue: 0 },
    },
    {
      tableName: "attendance_day",
      timestamps: true,
      underscored: true,
    }
  );

  AttendanceDay.associate = (models) => {
    AttendanceDay.belongsTo(models.ShiftTemplate, { foreignKey: "shift_id", as: "ShiftTemplate" });
    AttendanceDay.belongsTo(models.Employee, { foreignKey: "employee_id", as: "Employee" });
    AttendanceDay.belongsTo(models.LeaveTemplateCategory, { foreignKey: "leave_category_id", as: "LeaveCategory" });
    AttendanceDay.hasMany(models.AttendancePunch, { foreignKey: "day_id", as: "AttendancePunches" });
  };

  return AttendanceDay;
};
