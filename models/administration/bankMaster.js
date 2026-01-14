module.exports = (sequelize, DataTypes) => {
  const BankMaster = sequelize.define("BankMaster", {
    bank_name: { type: DataTypes.STRING(100), allowNull: false },
    bank_code: { type: DataTypes.STRING(20), allowNull: true },
    country_id: { type: DataTypes.INTEGER, allowNull: true },
    status: {
      type: DataTypes.SMALLINT,
      defaultValue: 0,
      comment: "0: Active, 1: Inactive, 2: Deleted"
    },
    user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }
  }, {
    tableName: "bank_master",
    timestamps: true,
    underscored: true
  });

  BankMaster.associate = (models) => {
    BankMaster.belongsTo(models.CountryMaster, { foreignKey: "country_id", as: "country" });
    // BankMaster.hasMany(models.CompanyBank, { foreignKey: "bank_id", as: "company_banks" });
    // BankMaster.hasMany(models.PartiesBank, { foreignKey: "bank_id", as: "parties_banks" });
  };

  return BankMaster;
};
