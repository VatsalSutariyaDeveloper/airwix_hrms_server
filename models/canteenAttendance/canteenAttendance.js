module.exports = (sequelize, DataTypes) => {
  const CanteenAttendance = sequelize.define(
    "CanteenAttendance",
    {
        employee_id: { type: DataTypes.INTEGER, allowNull: true },
        date: { type: DataTypes.DATEONLY, allowNull: true },
        status: { type: DataTypes.SMALLINT, defaultValue: 0, comment: "0: PRESENT, 1: ABSENT, 2: DELETED" },
        user_id: { type: DataTypes.INTEGER, allowNull: true},
        branch_id: { type: DataTypes.INTEGER, allowNull: true },
        company_id: { type: DataTypes.INTEGER, allowNull: true },
    },
    {
      tableName: "canteen_attendance",
      timestamps: true,
      underscored: true,
    }
  );

  CanteenAttendance.associate = (models) => {
    CanteenAttendance.belongsTo(models.Employee, { foreignKey: "employee_id", as: "employee" });
  };

  return CanteenAttendance;
};