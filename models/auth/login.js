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

    status: { type: DataTypes.SMALLINT, defaultValue: 0 }, // 0 = Active, 1 = Inactive, 2 = Deleted
    branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }
  }, {
    tableName: "login_histories",
    timestamps: true,
    underscored: true
  });

  return LoginHistory;
};
