module.exports = (sequelize, DataTypes) => {
  const User = sequelize.define("User", {
    employee_id: { type: DataTypes.INTEGER, allowNull: true },
    role_id: { type: DataTypes.INTEGER, allowNull: true },
    user_name: { type: DataTypes.STRING(100), allowNull: false },
    email: { type: DataTypes.STRING(150) },
    password: { type: DataTypes.STRING(255) },
    mobile_no: { type: DataTypes.STRING(20) },
    profile_image: { type: DataTypes.STRING(255), allowNull: true },
    authorized_signature: { type: DataTypes.STRING(255), allowNull: true },
    report_to: { type: DataTypes.STRING(255), allowNull: true },
    company_access: { type: DataTypes.STRING(255) },
    device_id: { type: DataTypes.STRING(100), allowNull: true },
    ip_address: { type: DataTypes.STRING(50), allowNull: true },
    is_login: { type: DataTypes.INTEGER, defaultValue: 0, comment: "0 = No, 1 = Yes" },
    user_lock: { type: DataTypes.INTEGER, defaultValue: 0, comment: "0 = Unlocked, 1 = Locked" },
    reset_password_token: { type: DataTypes.STRING(255), allowNull: true },
    reset_password_expires: { type: DataTypes.DATE, allowNull: true },
    status: { type: DataTypes.INTEGER, defaultValue: 0, comment: "0: Active, 1: Inactive, 2: Deleted", },
    is_activated: { type: DataTypes.BOOLEAN, defaultValue: false },
    activation_code: { type: DataTypes.STRING(255), allowNull: true },
    user_id: { type: DataTypes.INTEGER, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, defaultValue: 0 },
  },
    {
      tableName: "users",
      underscored: true,
      timestamps: true,
    }
  );

  User.associate = (models) => {
    User.belongsTo(models.RolePermission, {
      foreignKey: "role_id",
      as: "RolePermission",
    });
    User.hasMany(models.UserCompanyRoles, {
      foreignKey: "user_id",
      as: "ComapanyRole",
    });
    User.belongsTo(models.Employee, {
      foreignKey: "employee_id",
      as: "Employee",
    });
  };
  return User;
};
