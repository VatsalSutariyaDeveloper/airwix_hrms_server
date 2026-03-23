module.exports = (sequelize, DataTypes) => {
  const ApiLog = sequelize.define(
    "ApiLog",
    {
      company_id: { type: DataTypes.INTEGER, allowNull: true },
      branch_id: { type: DataTypes.INTEGER, allowNull: true },
      user_id: { type: DataTypes.INTEGER, allowNull: true },
      method: { type: DataTypes.STRING(10), allowNull: false },
      url: { type: DataTypes.TEXT, allowNull: false },
      status_code: { type: DataTypes.INTEGER, allowNull: true },
      ip_address: { type: DataTypes.STRING(50), allowNull: true },
      request_body: { type: DataTypes.JSONB, allowNull: true },
      response_body: { type: DataTypes.JSONB, allowNull: true },
      duration: { type: DataTypes.INTEGER, allowNull: true, comment: "Duration in milliseconds" },
      user_agent: { type: DataTypes.TEXT, allowNull: true },
      endpoint: { type: DataTypes.STRING(255), allowNull: true },
    },
    {
      tableName: "api_logs",
      timestamps: true,
      underscored: true,
    }
  );

  ApiLog.associate = (models) => {
    ApiLog.belongsTo(models.User, { foreignKey: "user_id", as: "user" });
    ApiLog.belongsTo(models.CompanyMaster, { foreignKey: "company_id", as: "company" });
  };

  return ApiLog;
};
