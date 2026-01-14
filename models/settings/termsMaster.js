module.exports = (sequelize, DataTypes) => {
  const TermsMaster = sequelize.define("TermsMaster", {
    terms_entity_id: { type: DataTypes.INTEGER, allowNull: false },
    template_name: { type: DataTypes.STRING(100), allowNull: false },
    terms_type: { type: DataTypes.SMALLINT, allowNull: false ,comment: "1. Terms 2. Notes"},
    terms: { type: DataTypes.TEXT, allowNull: false },
    priority: { type: DataTypes.INTEGER, defaultValue: 0 },
    status: { type: DataTypes.SMALLINT, defaultValue: 0, comment: "0: Active, 1: Inactive,2: Deleted" },
    is_default: { type: DataTypes.INTEGER,  defaultValue: 2,comment: "1: Yes, 2: No" },
    user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  }, {
    tableName: "terms_master",
    timestamps: true,
    underscored: true,
  });

    TermsMaster.associate = (models) => {
        TermsMaster.belongsTo(models.ModuleEntityMaster, {
            foreignKey: 'terms_entity_id',
            as: 'entity'
        });
    };

  return TermsMaster;
};
