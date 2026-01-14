module.exports = (sequelize, DataTypes) => {
  const ChargesMaster = sequelize.define("ChargesMaster", {
    charge_name: { type: DataTypes.STRING(100), allowNull: false },
    hsn_code: { type: DataTypes.STRING(10) },
    tax_rate: { type: DataTypes.STRING(10) },
    intra_tax_group_id: { type: DataTypes.INTEGER, allowNull: true, defaultValue: null },
    inter_tax_group_id: { type: DataTypes.INTEGER, allowNull: true, defaultValue: null },
    tax_group_id: { type: DataTypes.INTEGER, allowNull: true, defaultValue: null },
    amount: { type: DataTypes.STRING(100) },
    amount_without_tax: { type: DataTypes.DECIMAL(15, 5), defaultValue: 0, comment: "Calculated Base Amount" },
    tax_type: { type: DataTypes.SMALLINT, defaultValue: 1, comment: "1 = With Tax (Inclusive), 2 = Without Tax (Exclusive)" },
    entity_ids: { type: DataTypes.STRING(100) },
    is_default: { type: DataTypes.SMALLINT, defaultValue: 2, comment: "1: Yes, 2: No", },
    status: {
      type: DataTypes.SMALLINT,
      defaultValue: 0,
      comment: "0: Active, 1: Inactive, 2: Deleted"
    },
    user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  }, {
    tableName: "charges_master",
    timestamps: true,
    underscored: true,
  });

  ChargesMaster.associate = (models) => {
    ChargesMaster.belongsTo(models.TaxGroup, {
      foreignKey: "intra_tax_group_id",
      as: "intraTaxGroup",
    });
    ChargesMaster.belongsTo(models.TaxGroup, {
      foreignKey: "inter_tax_group_id",
      as: "interTaxGroup",
    });
  };

  return ChargesMaster;
};