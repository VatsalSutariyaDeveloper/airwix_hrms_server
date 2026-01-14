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
      ip_address: { type: DataTypes.STRING(50), allowNull: true },
      is_resolved: { type: DataTypes.SMALLINT, defaultValue: 0, comment: "0=Pending, 1=Resolved (For Errors)" },
    },
    {
      tableName: "logs", 
      timestamps: true,
      underscored: true,
    }
  );

  Logs.associate = (models) => {
    Logs.belongsTo(models.User, { foreignKey: "user_id", as: "user" });
    Logs.belongsTo(models.CompanyMaster, { foreignKey: "company_id", as: "company" });
  };

  return Logs;
};