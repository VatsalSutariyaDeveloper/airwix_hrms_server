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
        status: {
            type: DataTypes.SMALLINT,
            defaultValue: 0,
            comment: "0: PRESENT, 1: HALF_DAY, 3: WEEKLY_OFF, 4: HOLIDAY, 5: ABSENT, 6: LEAVE",
        },
        overtime_minutes: { type: DataTypes.INTEGER, defaultValue: 0 },
        fine_amount: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
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
    AttendanceDay.belongsTo(models.Shift, { foreignKey: "shift_id", as: "Shift" });
    AttendanceDay.belongsTo(models.Employee, { foreignKey: "employee_id", as: "Employee" });
  };

  return AttendanceDay;
};
