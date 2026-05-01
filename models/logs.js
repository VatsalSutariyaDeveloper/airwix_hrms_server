module.exports = (sequelize, DataTypes) => {
  const Logs = sequelize.define("Logs",{
      company_id: { type: DataTypes.INTEGER, allowNull: true },
      branch_id: { type: DataTypes.INTEGER, allowNull: true },
      user_id: { type: DataTypes.INTEGER, allowNull: true },
      entity_name: { type: DataTypes.STRING(100), allowNull: false },//(e.g., 'ItemMaster', 'LoginController')
      action_type: { type: DataTypes.ENUM("CREATE", "UPDATE", "DELETE", "STATUS_CHANGE", "ERROR", "BULK_CREATE"), allowNull: false, },
      record_id: { type: DataTypes.INTEGER, allowNull: true }, // ID of the record affected (Null if it's a general error)
      log_message: { type: DataTypes.TEXT, allowNull: true },
      old_data: { type: DataTypes.JSONB, allowNull: true, comment: "Data before update/delete" },
      new_data: { type: DataTypes.JSONB, allowNull: true, comment: "Data after create/update OR Error Request Body" },
      stack_trace: { type: DataTypes.JSONB, allowNull: true, comment: "Error stack trace" }, // ONLY used if action_type == 'ERROR'
      sql_query: { type: DataTypes.TEXT, allowNull: true, comment: "The raw SQL query executed" },
      ip_address: { type: DataTypes.STRING(50), allowNull: true },
      is_resolved: { type: DataTypes.SMALLINT, defaultValue: 0, comment: "0=Pending, 1=Resolved (For Errors)" },
      status: { type: DataTypes.INTEGER, defaultValue: 0, allowNull: true, comment: "0 = Success, 1 = Error" },
      access_type: { type: DataTypes.STRING(50), allowNull: true, comment: "The source type: 'web login', 'attendance device', etc." },
      endpoint: { type: DataTypes.STRING(255), allowNull: true, comment: "The API endpoint requested" },
      user_agent: { type: DataTypes.TEXT, allowNull: true, comment: "Device/Browser details" },
      caller: { type: DataTypes.TEXT, allowNull: true, comment: "The file and line where the query originated" },
      batch_id: { type: DataTypes.INTEGER, allowNull: true, comment: "Links to cron_job_runs.id for batch operations" },
    },
    {
      tableName: "logs", 
      timestamps: true,
      underscored: true,
    }
  );

  Logs.associate = (models) => {
    Logs.belongsTo(models.User, { foreignKey: "user_id", as: "user" });
    Logs.belongsTo(models.DeviceMaster, { foreignKey: "user_id", as: "device" });
    Logs.belongsTo(models.CompanyMaster, { foreignKey: "company_id", as: "company" });
  };

  return Logs;
};