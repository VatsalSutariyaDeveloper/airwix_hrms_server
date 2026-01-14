module.exports = (sequelize, DataTypes) => {
  const ModuleMaster = sequelize.define("ModuleMaster", {
    module_name: { type: DataTypes.STRING(100), allowNull: false },
    cust_module_name: { type: DataTypes.STRING(100), allowNull: false, comment: "Customized Module Name For Parties" },
    priority: { type: DataTypes.INTEGER, defaultValue: 0 },
    module_icon_name: { type: DataTypes.STRING(100), allowNull: true },
    module_url: { type: DataTypes.TEXT, allowNull: true },
    status: {
      type: DataTypes.SMALLINT,
      defaultValue: 0,
      comment: "0: Active, 1: Inactive, 2: Deleted"
    },
    user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }
  }, {
    tableName: "module_master",
    timestamps: true,
    underscored: true
  });

  ModuleMaster.associate = (models) => {
    ModuleMaster.hasMany(models.ModuleEntityMaster, {
      foreignKey: 'module_id',
      as: 'entities',
    });
  };


  return ModuleMaster;
};
