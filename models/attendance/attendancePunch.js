module.exports = (sequelize, DataTypes) => {
  const AttendancePunch = sequelize.define(
    "AttendancePunch",
    {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        employee_id: { type: DataTypes.INTEGER, allowNull: false },
        day_id: { type: DataTypes.INTEGER, allowNull: false },
        punch_time: { type: DataTypes.DATE, allowNull: false },
        punch_type: { type: DataTypes.ENUM("IN", "OUT"), allowNull: false },
        image_name: DataTypes.STRING,
        device_id: DataTypes.STRING,
        latitude: DataTypes.DECIMAL(10, 7),
        longitude: DataTypes.DECIMAL(10, 7),
        ip_address: DataTypes.STRING,
        status: {
            type: DataTypes.SMALLINT,
            defaultValue: 0,
            comment: "0: Active, 1: Inactive, 2: Deleted",
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

  // AttendancePunch.associate = (models) => {
  //   AttendancePunch.belongsTo(models.AttendanceDay, { foreignKey: "day_id", as: "AttendanceDay" });
  // };

  return AttendancePunch;
};
