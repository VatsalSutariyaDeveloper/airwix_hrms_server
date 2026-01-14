module.exports = (sequelize, DataTypes) => {
  const ChargesTransaction = sequelize.define("ChargesTransaction", {
    charges_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    entity_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    entity_transaction_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    tax_group_id: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 0 },
    currency_id: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 0 },
    currency_rate: { type: DataTypes.DECIMAL(15,5), allowNull: true, defaultValue: 0 },
    tax_rate: { type: DataTypes.DECIMAL(15,5), allowNull: false, defaultValue: 0 },
    charges_percentage: { type: DataTypes.DECIMAL(15,5), allowNull: true, defaultValue: 0 },
    taxable_amount: { type: DataTypes.DECIMAL(15,5), defaultValue: 0 },
    taxable_convert_amount: { type: DataTypes.DECIMAL(15,5), defaultValue: 0 },
    tax_amount: { type: DataTypes.DECIMAL(15,5), defaultValue: 0 },
    tax_convert_amount: { type: DataTypes.DECIMAL(15,5), defaultValue: 0 },
    total_amount: { type: DataTypes.DECIMAL(15,5), allowNull: false, defaultValue: 0 },
    total_convert_amount: { type: DataTypes.DECIMAL(15,5), allowNull: true, defaultValue: 0 },
    status: {
      type: DataTypes.SMALLINT,
      defaultValue: 0,
      comment: "0: Active, 1 = Inactive, 2: Deleted"
    },
    user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  }, {
    tableName: "charges_transactions",
    timestamps: true,
    underscored: true,
  });

  ChargesTransaction.associate = (models) => {
    ChargesTransaction.hasMany(models.TaxTransaction, {
      foreignKey: "ref_id",
      scope: {
        ref_type: 2 // 2 for charges transactions
      },
      as: "taxTransactions",
    });
    ChargesTransaction.belongsTo(models.TaxGroup, { 
      foreignKey: "tax_group_id",
      as: "taxGroup",
    });
    ChargesTransaction.belongsTo(models.ChargesMaster, { foreignKey: 'charges_id', as: 'charge' });
  };

  return ChargesTransaction;
};