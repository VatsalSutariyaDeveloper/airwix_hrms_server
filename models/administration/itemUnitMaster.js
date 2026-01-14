module.exports = (sequelize, DataTypes) => {
  const ItemUnitMaster = sequelize.define("ItemUnitMaster", {
    unit_name: { type: DataTypes.STRING(100),allowNull: false, comment: "This will be also Used for e-way bill generation"},
    unit_full_name: { type: DataTypes.STRING,allowNull: true, },
    status: {
      type: DataTypes.SMALLINT,
      defaultValue: 0,
      comment: "0: Active, 1: Inactive, 2: Deleted"
    },
    user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  }, {
    tableName: "item_unit_masters",
    timestamps: true,
    underscored: true,
  });

   ItemUnitMaster.associate = (models) => {
    // Reverse relation
    ItemUnitMaster.hasMany(models.ItemMaster, {
      foreignKey: "primary_unit",
      as: "items",
    });
  };

  return ItemUnitMaster;
};
