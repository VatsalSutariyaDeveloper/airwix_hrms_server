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
        status: DataTypes.STRING,
        source: { type: DataTypes.STRING, defaultValue: "AUTO" },
        status: {
            type: DataTypes.SMALLINT,
            defaultValue: 0,
            comment: "0: PRESENT, 1: HALF_DAY, 2: ABSENT, 3: LOP",
        },
        user_id: { type: DataTypes.INTEGER, defaultValue: 0 },
        branch_id: { type: DataTypes.INTEGER, defaultValue: 0 },
        company_id: { type: DataTypes.INTEGER, defaultValue: 0 },
    },
    {
      tableName: "attendance_punch",
      timestamps: true,
      underscored: true,
    }
  );

  return AttendanceDay;
};
