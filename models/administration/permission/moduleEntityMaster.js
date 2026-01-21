module.exports = (sequelize, DataTypes) => {
  const ModuleEntityMaster = sequelize.define(
    "ModuleEntityMaster",
    {
      module_id: { type: DataTypes.INTEGER, allowNull: true },
      entity_name: { type: DataTypes.STRING(100), allowNull: false },
      cust_entity_name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: "Customized Entity Name For Parties",
      },
      entity_url: { type: DataTypes.TEXT, allowNull: true },
      entity_description: { type: DataTypes.TEXT, allowNull: true },
      entity_permmision_type_ids: { type: DataTypes.TEXT, allowNull: true },
      priority: { type: DataTypes.INTEGER, defaultValue: 0 },
      entity_icon_name: { type: DataTypes.STRING(50), allowNull: true },
      entity_visiblity: { type: DataTypes.SMALLINT, defaultValue: 1, comment: "1: Yes, 2: No" },
      status: {
        type: DataTypes.SMALLINT,
        defaultValue: 0,
        comment: "0: Active, 1: Inactive, 2: Deleted",
      },
      user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      company_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
    },
    {
      tableName: "module_entity_master",
      timestamps: true,
      underscored: true,
    }
  );

  ModuleEntityMaster.associate = (models) => {
    ModuleEntityMaster.belongsTo(models.ModulePermissionTypeMaster, {
      foreignKey: "entity_permmision_type_ids",
      as: "permissionType",
    });

    ModuleEntityMaster.belongsTo(models.ModuleMaster, {
      foreignKey: "module_id",
      as: "moduleMaster",
    });

    ModuleEntityMaster.hasMany(models.Permission, {
      foreignKey: "entity_id",
      as: "permissions",
    });

  };

  return ModuleEntityMaster;
};
