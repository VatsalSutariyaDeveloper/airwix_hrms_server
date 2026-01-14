module.exports = (sequelize, DataTypes) => {
  const Taxes = sequelize.define("Taxes", {
    tax_name: { type: DataTypes.STRING(100), allowNull: false }, // e.g. "Standard GST 18%"
    tax_value: { type: DataTypes.DECIMAL(15,5), allowNull: false, defaultValue: 0 },
    tax_value_type: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 1, comment: "1: Percentage, 2: Amount" },
    currency_id: { type: DataTypes.INTEGER, allowNull: false },
    tax_type_id: { 
      type: DataTypes.INTEGER, 
      allowNull: true, 
      references: { model: "tax_type_master", key: "id" }, 
      onDelete: "CASCADE" 
    },
    status: { type: DataTypes.SMALLINT, defaultValue: 0, comment: "0: Active, 1: Inactive" },
    user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  }, {
    tableName: "taxes",
    timestamps: true,
    underscored: true,
  });

  Taxes.associate = (models) => {
    Taxes.belongsTo(models.TaxTypeMaster, { 
      foreignKey: "tax_type_id",
      as: "taxType",
    });
  };

  return Taxes;
};
