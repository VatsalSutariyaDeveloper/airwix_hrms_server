module.exports = (sequelize, DataTypes) => {
  const HSNMaster = sequelize.define("HSNMaster", {
    tax_group_id: { type: DataTypes.INTEGER, allowNull: true },
    inter_tax_group_id: { type: DataTypes.INTEGER, allowNull: true, defaultValue: null },
    intra_tax_group_id: { type: DataTypes.INTEGER, allowNull: true, defaultValue: null },
    hsn_code: { type: DataTypes.STRING(100), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    status: {
      type: DataTypes.SMALLINT,
      defaultValue: 0,
      comment: "0 = active, 1 = inactive, 2 = deleted"
    },
    user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }
  }, {
    tableName: "hsn_master",
    timestamps: true,
    underscored: true
  });

  HSNMaster.associate = (models) => {
    HSNMaster.belongsTo(models.TaxGroup, { foreignKey: "tax_group_id", as: 'taxGroup' });
    HSNMaster.belongsTo(models.TaxGroup, { foreignKey: "intra_tax_group_id", as: 'intraTaxGroup' });
    HSNMaster.belongsTo(models.TaxGroup, { foreignKey: "inter_tax_group_id", as: 'interTaxGroup' });
  };
  
  return HSNMaster;
};
