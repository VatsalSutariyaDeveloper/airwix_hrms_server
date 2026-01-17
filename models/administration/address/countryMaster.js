module.exports = (sequelize, DataTypes) => {
  const CountryMaster = sequelize.define("CountryMaster", {
    country_name: { type: DataTypes.STRING, allowNull: false },
    country_code: { type: DataTypes.STRING(10), allowNull: false },
    isd_code: { type: DataTypes.STRING(10), allowNull: false },
    country_image: { type: DataTypes.STRING(100) },
    currency_id: { type: DataTypes.INTEGER, allowNull: true },
    mask: { type: DataTypes.STRING(50), allowNull: true, defaultValue: null, comment: "Phone number mask format" },
    digit: { type: DataTypes.INTEGER, allowNull: true, defaultValue: null, comment: "Mobile number length without country code" },
    status: {
      type: DataTypes.SMALLINT,
      defaultValue: 0,
      comment: "0: Active, 1: Inactive, 2: Deleted"
    },
    user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }
  }, {
    tableName: "country_master",
    timestamps: true,
    underscored: true
  });

  CountryMaster.associate = (models) => {
    CountryMaster.hasMany(models.StateMaster, { foreignKey: "country_id", as: "states" });
    CountryMaster.belongsTo(models.CurrencyMaster, { foreignKey: "currency_id", as: "currency" });
  };

  return CountryMaster;
};
