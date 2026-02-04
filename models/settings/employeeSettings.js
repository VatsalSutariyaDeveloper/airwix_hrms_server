module.exports = (sequelize, DataTypes) => {
  const EmployeeSettings = sequelize.define("employee_settings", {
    settings_name: { type: DataTypes.STRING(255) },
    settings_value: { type: DataTypes.JSONB },
    status: { type: DataTypes.SMALLINT, defaultValue: 0, comment: "0: Active, 1: Inactive, 2: Deleted" },
    user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }
  }, {
    tableName: "employee_settings",
    timestamps: true,
    underscored: true
  });

  return EmployeeSettings;
};
