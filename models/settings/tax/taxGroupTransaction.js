module.exports = (sequelize, DataTypes) => {
  const TaxGroupTransaction = sequelize.define("TaxGroupTransaction", {
    tax_group_id: { type: DataTypes.INTEGER, allowNull: false },
    tax_id: { type: DataTypes.INTEGER, allowNull: false },
    status: { type: DataTypes.SMALLINT, defaultValue: 0, comment: "0: Active, 1: Inactive" },
    user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  }, {
    tableName: "tax_group_transaction",
    timestamps: true,
    underscored: true,
  });

  TaxGroupTransaction.associate = (models) => {
    TaxGroupTransaction.belongsTo(models.Taxes, { 
      foreignKey: "tax_id",
      as: "taxes",
    });

    TaxGroupTransaction.belongsTo(models.TaxGroup, { 
      foreignKey: "tax_group_id",
      as: "taxGroup",
    });
  };

  return TaxGroupTransaction;
};