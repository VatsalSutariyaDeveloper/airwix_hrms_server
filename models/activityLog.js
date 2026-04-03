module.exports = (sequelize, DataTypes) => {
  const ActivityLog = sequelize.define(
    "ActivityLog",
    {
      company_id: { type: DataTypes.INTEGER, allowNull: true },
      branch_id: { type: DataTypes.INTEGER, allowNull: true },
      user_id: { type: DataTypes.INTEGER, allowNull: true },
      entity_name: { type: DataTypes.STRING(100), allowNull: false },
      action_type: { type: DataTypes.ENUM("CREATE", "UPDATE", "DELETE", "STATUS_CHANGE", "ERROR"), allowNull: false, },
      record_id: { type: DataTypes.INTEGER, allowNull: true, comment: "ID of the record affected" },
      log_message: { type: DataTypes.TEXT, allowNull: true },
      old_data: { type: DataTypes.JSONB, allowNull: true, comment: "JSON snapshot before update/delete" },
      new_data: { type: DataTypes.JSONB, allowNull: true, comment: "JSON snapshot after create/update" },
      ip_address: { type: DataTypes.STRING(50), allowNull: true },
      status: { type: DataTypes.SMALLINT, defaultValue: 0 },
      access_type: { type: DataTypes.STRING(50), allowNull: true, comment: "The source type: 'web login', 'attendance device', etc." },
      sql_query: { type: DataTypes.TEXT, allowNull: true, comment: "The raw SQL query executed" },
      caller: { type: DataTypes.TEXT, allowNull: true, comment: "The file and line where the query originated" },
    },
    {
      tableName: "activity_logs",
      timestamps: true,
      underscored: true,
    }
  );

  ActivityLog.associate = (models) => {
    ActivityLog.belongsTo(models.User, { foreignKey: "user_id", as: "user" });
    ActivityLog.belongsTo(models.DeviceMaster, { foreignKey: "user_id", as: "device" });
    ActivityLog.belongsTo(models.CompanyMaster, { foreignKey: "company_id", as: "company" });
  };

  return ActivityLog;
};