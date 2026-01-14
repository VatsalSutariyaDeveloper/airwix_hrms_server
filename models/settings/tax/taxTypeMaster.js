module.exports = (sequelize, DataTypes) => {
  const TaxTypeMaster = sequelize.define("TaxTypeMaster", {
    country_id: { type: DataTypes.INTEGER, allowNull: false },
    tax_type: { type: DataTypes.STRING(50), allowNull: false }, // GST, VAT, etc.
    tax_type_name: { type: DataTypes.STRING(100), allowNull: false }, // Friendly name
    description: { type: DataTypes.STRING(255), allowNull: true },
    use_for: { 
      type: DataTypes.SMALLINT, 
      defaultValue: 0, 
      comment: "0: Tax Template Create Time, 1: Parties Add Time" 
    },
    status: { type: DataTypes.SMALLINT, defaultValue: 0, comment: "0: Active, 1: Inactive" },
    user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  }, {
    tableName: "tax_type_master",
    timestamps: true,
    underscored: true,
  });

  return TaxTypeMaster;
};
