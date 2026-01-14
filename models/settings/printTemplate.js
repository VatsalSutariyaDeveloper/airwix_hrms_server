module.exports = (sequelize, DataTypes) => {
  const PrintTemplate = sequelize.define("PrintTemplate", {
    module_entity_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    template_name: { type: DataTypes.STRING(100), allowNull: false },
    template_component: { type: DataTypes.STRING(255), allowNull: false },
    priority: { type: DataTypes.INTEGER, defaultValue: 0 },
    status: {
      type: DataTypes.SMALLINT,
      defaultValue: 0,
      comment: "0: Active, 1: Inactive, 2: Deleted"
    },
    user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }
  }, {
    tableName: "print_templates",
    timestamps: true,
    underscored: true
  });

  PrintTemplate.associate = (models) => {
    PrintTemplate.belongsTo(models.ModuleEntityMaster, {
      foreignKey: "module_entity_id",
      as: "moduleEntity",
    });
  }

  return PrintTemplate;
};
