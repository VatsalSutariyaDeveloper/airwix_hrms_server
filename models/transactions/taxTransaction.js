module.exports = (sequelize, DataTypes) => {
  const TaxTransaction = sequelize.define(
    "TaxTransaction",
    {
      tax_id: { 
        type: DataTypes.INTEGER, 
        allowNull: false 
      },
      tax_value: { 
        type: DataTypes.DECIMAL(15,5), 
        allowNull: false, 
        defaultValue: 0 
      },
      tax_amount: { 
        type: DataTypes.DECIMAL(15,5), 
        allowNull: false, 
        defaultValue: 0 
      },
      tax_amount_converted: { 
        type: DataTypes.DECIMAL(15,5), 
        allowNull: false, 
        defaultValue: 0 
      },
      entity_id: { 
        type: DataTypes.INTEGER, 
        allowNull: false,
        comment: "entity_id is id of entity like quotation / sales Order"
      },
      entity_transaction_id: { 
        type: DataTypes.INTEGER, 
        allowNull: false,
        comment: "entity_transaction_id is id of entity transaction like  quotation_id / sales_order_id"
      },
      ref_id: { 
        type: DataTypes.INTEGER, 
        defaultValue: 0, 
        comment: "ref_id is id of ref_type"
      },
      ref_type: { 
        type: DataTypes.SMALLINT, 
        defaultValue: 0,
        comment: "1 = Item, 2 = Charges"
      },
      currency_id: { 
        type: DataTypes.INTEGER, 
        defaultValue: 0 
      },
      currency_rate: { 
        type: DataTypes.DECIMAL(15,5), 
        defaultValue: 0 
      },
      taxable_value: { 
        type: DataTypes.DECIMAL(15,5), 
        defaultValue: 0 
      },
      taxable_value_converted: { 
        type: DataTypes.DECIMAL(15,5), 
        defaultValue: 0 
      },
      status: {
        type: DataTypes.SMALLINT,
        defaultValue: 0,
        comment: "0 = Active, 1 = Inactive, 2 = Deleted, 3 = Hold",
      },
      user_id: { 
        type: DataTypes.INTEGER, 
        allowNull: false, 
        defaultValue: 0 
      },
      branch_id: { 
        type: DataTypes.INTEGER, 
        allowNull: false, 
        defaultValue: 0 
      },
      company_id: { 
        type: DataTypes.INTEGER, 
        allowNull: false, 
        defaultValue: 0 
      },
    },
    {
      tableName: "tax_transaction",
      timestamps: true,
      underscored: true,
    }
  );

  TaxTransaction.associate = (models) => {
    TaxTransaction.belongsTo(models.Taxes, { 
      foreignKey: "tax_id",
      as: "taxes",
    });
  };

  return TaxTransaction;
};
