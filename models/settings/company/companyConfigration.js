module.exports = (sequelize, DataTypes) => {
  const CompanyConfigration = sequelize.define("companyConfigration",{
      setting_key: { type: DataTypes.STRING(150), allowNull: false },
      setting_value: { type: DataTypes.TEXT, allowNull: true },
      status: {
        type: DataTypes.SMALLINT,
        defaultValue: 0,
        comment: "0 = active, 1 = inactive, 2 = deleted",
      },
      user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      branch_id: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 0 },
      company_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }
    },
    {
      tableName: "company_configration",
      timestamps: true,
      underscored: true,
    }
  );

  CompanyConfigration.associate = (models) => {
    CompanyConfigration.belongsTo(models.CompanySettingsMaster, { foreignKey: "setting_key",targetKey: "setting_key", as: "company_settings" });
  }
  return CompanyConfigration;
};