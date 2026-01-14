module.exports = (sequelize, DataTypes) => {
  const TaxGroup = sequelize.define("TaxGroup", {
    tax_group_name: { type: DataTypes.STRING(100), allowNull: false },
    group_value: { type: DataTypes.DECIMAL(15,5), allowNull: false, defaultValue: 0 },
    status: { type: DataTypes.SMALLINT, defaultValue: 0, comment: "0: Active, 1: Inactive" },
    user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  }, {
    tableName: "tax_group",
    timestamps: true,
    underscored: true,
  });

  TaxGroup.associate = (models) => {
    TaxGroup.hasMany(models.TaxGroupTransaction, { 
      foreignKey: "tax_group_id",
      as: "transactions",
    });
  };

  return TaxGroup;
};
