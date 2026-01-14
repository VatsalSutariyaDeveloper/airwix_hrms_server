module.exports = (sequelize, DataTypes) => {
  const PrintSettings = sequelize.define("PrintSettings", {
    print_name: { type: DataTypes.STRING(100), allowNull: true },
    entity_id: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 0, comment: "Entity ID" },
    file_name: { type: DataTypes.STRING(255), allowNull: true },
    config: { type: DataTypes.JSONB,  allowNull: true },
    status: { type: DataTypes.SMALLINT, defaultValue: 0, comment: "0: Active, 1: Inactive, 2: Deleted" },
    user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }
  }, {
    tableName: "print_settings",
    timestamps: true,
    underscored: true
  });

  return PrintSettings;
};
