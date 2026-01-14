module.exports = (sequelize, DataTypes) => {
  const User = sequelize.define("User", {
    role_id: { type: DataTypes.INTEGER, defaultValue: 0 },
    user_name: { type: DataTypes.STRING(100), allowNull: false },
    // login_type: { type: DataTypes.INTEGER, defaultValue: 1,comment: "1 = Mobile, 2 = Email & Password" },
    email: { type: DataTypes.STRING(150) },
    password: { type: DataTypes.STRING(255) },
    mobile_no: { type: DataTypes.STRING(20) },
    address: { type: DataTypes.STRING(255) },
    city: { type: DataTypes.STRING(100), allowNull: true },
    state_id: { type: DataTypes.INTEGER, defaultValue: 0 },
    country_id: { type: DataTypes.INTEGER, defaultValue: 0 },
    pincode: { type: DataTypes.STRING(10) },
    user_key: { type: DataTypes.STRING(100) },
    profile_image: { type: DataTypes.STRING(255), allowNull: true },
    authorized_signature: { type: DataTypes.STRING(255), allowNull: true },
    report_to: { type: DataTypes.STRING(255), allowNull: true },
    company_access: { type: DataTypes.STRING(255)},
    permission: { type: DataTypes.JSONB, allowNull: true } ,
    // temp_otp: { type: DataTypes.STRING(10), allowNull: true },
    device_id: { type: DataTypes.STRING(100), allowNull: true },
    ip_address: { type: DataTypes.STRING(50), allowNull: true },
    user_access_date: { type: DataTypes.DATE, allowNull: true },
    is_login: { type: DataTypes.INTEGER, defaultValue: 0, comment: "0 = No, 1 = Yes" },
    user_lock: { type: DataTypes.INTEGER, defaultValue: 0, comment: "0 = Unlocked, 1 = Locked" },
    reset_password_token: { type: DataTypes.STRING(255), allowNull: true},
    reset_password_expires: { type: DataTypes.DATE, allowNull: true},
    status: {type: DataTypes.INTEGER, defaultValue: 0, comment: "0: Active, 1: Inactive, 2: Deleted",},
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
  };
  return User;
};
