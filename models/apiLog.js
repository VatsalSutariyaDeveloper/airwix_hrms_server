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
      status: { type: DataTypes.INTEGER, allowNull: true, comment: "0 = Success, 1 = Error" },
      access_type: { type: DataTypes.STRING(50), allowNull: true, comment: "The source type: 'web login', 'attendance device', etc." },
      sql_query: { type: DataTypes.TEXT, allowNull: true, comment: "The raw SQL query executed" },
      caller: { type: DataTypes.TEXT, allowNull: true, comment: "The file and line where the query originated" },
    },
    {
      tableName: "api_logs",
      timestamps: true,
      underscored: true,
    }
  );

  ApiLog.associate = (models) => {
    ApiLog.belongsTo(models.User, { foreignKey: "user_id", as: "user" });
    ApiLog.belongsTo(models.DeviceMaster, { foreignKey: "user_id", as: "device" });
    ApiLog.belongsTo(models.CompanyMaster, { foreignKey: "company_id", as: "company" });
  };

  return ApiLog;
};
