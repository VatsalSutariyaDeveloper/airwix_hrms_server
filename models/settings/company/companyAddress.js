module.exports = (sequelize, DataTypes) => {
  const CompanyAddress = sequelize.define("CompanyAddress", {
    company_id: { type: DataTypes.INTEGER, allowNull: false },
    // contact_person_name: { type: DataTypes.STRING(255), allowNull: false },
    // email: { type: DataTypes.STRING(100), allowNull: true },
    // mobile_no: { type: DataTypes.STRING(100), allowNull: true },
    address: { type: DataTypes.TEXT, allowNull: true },
    address2: { type: DataTypes.TEXT, allowNull: true },
    city: { type: DataTypes.STRING(100), allowNull: true },
    state_id: { type: DataTypes.INTEGER, allowNull: true },
    country_id: { type: DataTypes.INTEGER, allowNull: true },
    pincode: { type: DataTypes.STRING(10), allowNull: true },
    is_default: { type: DataTypes.INTEGER,  defaultValue: 2,comment: "1: Yes, 2: No" },
    address_type: { type: DataTypes.SMALLINT, defaultValue: 0, comment: "0: Billing Address, 1: Shipping Address" },
    status: {
      type: DataTypes.SMALLINT,
      defaultValue: 0,
      comment: "0: Active, 1: Inactive, 2: Deleted"
    },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    branch_id: { type: DataTypes.INTEGER, allowNull: false },
  }, {
    tableName: "company_address",
    timestamps: true,
    underscored: true,
  });

  CompanyAddress.associate = (models) => {
    CompanyAddress.belongsTo(models.CompanyMaster, { foreignKey: "company_id", as: "company" });
    CompanyAddress.belongsTo(models.StateMaster, { foreignKey: "state_id", as: "state" });
    CompanyAddress.belongsTo(models.CountryMaster, { foreignKey: "country_id", as: "country" });
  };

  return CompanyAddress;
};
