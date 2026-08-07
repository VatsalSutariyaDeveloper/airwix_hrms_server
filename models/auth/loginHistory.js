module.exports = (sequelize, DataTypes) => {
  const LoginHistory = sequelize.define("LoginHistory", {
    user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    in_time: { type: DataTypes.DATE, allowNull: true },
    out_time: { type: DataTypes.DATE, allowNull: true },
    ip_address: { type: DataTypes.STRING, allowNull: true },
    browser: { type: DataTypes.STRING, allowNull: true },
    browser_version: { type: DataTypes.STRING, allowNull: true },
    os: { type: DataTypes.STRING, allowNull: true },
    city: { type: DataTypes.STRING, allowNull: true },
    state: { type: DataTypes.STRING, allowNull: true },
    country: { type: DataTypes.STRING, allowNull: true },
    longitude: { type: DataTypes.STRING, allowNull: true },
    latitude: { type: DataTypes.STRING, allowNull: true },

    access_by: { type: DataTypes.STRING(50), allowNull: true }, // "web login" | "application"
    login_method: { type: DataTypes.STRING(20), allowNull: true }, // PASSWORD | PIN | OTP | REGISTER
    device_type: { type: DataTypes.STRING(20), allowNull: true }, // web | mobile
    device_model: { type: DataTypes.STRING(100), allowNull: true },
    device_brand: { type: DataTypes.STRING(100), allowNull: true },
    os_version: { type: DataTypes.STRING(50), allowNull: true },
    user_agent: { type: DataTypes.TEXT, allowNull: true },
    logout_type: { type: DataTypes.STRING(20), allowNull: true }, // SELF | ADMIN_FORCED | EXPIRED
    logged_out_by: { type: DataTypes.INTEGER, allowNull: true }, // user_id, self-logout only
    logged_out_by_ip: { type: DataTypes.STRING(64), allowNull: true }, // requester IP, admin-forced logout

    status: { type: DataTypes.SMALLINT, defaultValue: 0 }, // 0 = Active, 1 = Inactive, 2 = Deleted
    branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }
  }, {
    tableName: "login_histories",
    timestamps: true,
    underscored: true
  });

  LoginHistory.associate = (models) => {
    LoginHistory.belongsTo(models.User, { foreignKey: "user_id", as: "user" });
    LoginHistory.belongsTo(models.CompanyMaster, { foreignKey: "company_id", as: "company" });
  };

  return LoginHistory;
};
