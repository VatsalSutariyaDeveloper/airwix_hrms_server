module.exports = (sequelize, DataTypes) => {
  const ClientLog = sequelize.define(
    "ClientLog",
    {
      company_id: { type: DataTypes.INTEGER, allowNull: true },
      branch_id: { type: DataTypes.INTEGER, allowNull: true },
      user_id: { type: DataTypes.INTEGER, allowNull: true },
      employee_id: { type: DataTypes.INTEGER, allowNull: true },
      event: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: "api_401 | auto_logout | manual_logout | base_url_switch | app_error"
      },
      reason: { type: DataTypes.TEXT, allowNull: true, comment: "Why the event happened, as reported by the app" },
      endpoint: { type: DataTypes.TEXT, allowNull: true, comment: "METHOD path of the request that triggered the event" },
      status_code: { type: DataTypes.INTEGER, allowNull: true },
      server_message: { type: DataTypes.TEXT, allowNull: true, comment: "The server response message the app saw" },
      base_url: { type: DataTypes.TEXT, allowNull: true, comment: "The backend base URL the app was pointed at" },
      is_erp: { type: DataTypes.BOOLEAN, allowNull: true },
      access: { type: DataTypes.STRING(50), allowNull: true, comment: "employee | attendance | canteen" },
      device_id: { type: DataTypes.STRING(100), allowNull: true, comment: "device_id from the (unverified) JWT, if present" },
      token_valid: { type: DataTypes.BOOLEAN, allowNull: true, comment: "Whether the Bearer token verified against JWT_SECRET" },
      app_version: { type: DataTypes.STRING(50), allowNull: true },
      device_os: { type: DataTypes.STRING(100), allowNull: true },
      device_brand: { type: DataTypes.STRING(100), allowNull: true },
      device_model: { type: DataTypes.STRING(100), allowNull: true },
      ip_address: { type: DataTypes.STRING(50), allowNull: true },
      client_time: { type: DataTypes.DATE, allowNull: true, comment: "Device clock at the moment of the event" },
      payload: { type: DataTypes.JSONB, allowNull: true, comment: "Full raw body as sent by the app" },
    },
    {
      tableName: "client_logs",
      timestamps: true,
      underscored: true,
    }
  );

  // constraints: false is REQUIRED, not an optimisation. These ids come from a
  // JWT that may reference a user/company which does not exist on THIS server
  // — that is precisely the failure being diagnosed (an app pointed at the
  // wrong backend). With real foreign keys the insert is rejected and the
  // log is lost exactly when it matters most. The associations are kept only
  // so master-admin queries can still JOIN for display names.
  ClientLog.associate = (models) => {
    ClientLog.belongsTo(models.User, { foreignKey: "user_id", as: "user", constraints: false });
    ClientLog.belongsTo(models.CompanyMaster, { foreignKey: "company_id", as: "company", constraints: false });
  };

  return ClientLog;
};
