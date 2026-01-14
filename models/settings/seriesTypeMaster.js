module.exports = (sequelize, DataTypes) => {
  const SeriesTypeMaster = sequelize.define("SeriesTypeMaster", {
    series_type_name: { type: DataTypes.STRING(100), allowNull: false },
    series_entity_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    financial_year_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    start_series: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "0" },
    series_format: { type: DataTypes.INTEGER },
    format_value: { type: DataTypes.STRING(50) },
    end_format_value: { type: DataTypes.STRING(50)},
    is_default: { type: DataTypes.INTEGER,  defaultValue: 2,comment: "1: Yes, 2: No" },
    status: {
      type: DataTypes.SMALLINT,
      defaultValue: 0,
      comment: "0: Active, 1: Inactive, 2: Deleted"
    },
    user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  }, {
    tableName: "series_type_master",
    timestamps: true,
    underscored: true,
  });

  SeriesTypeMaster.associate = (models) => {
    SeriesTypeMaster.belongsTo(models.ModuleEntityMaster, {
      foreignKey: "series_entity_id",
      as: "entity",
    });
  };

  return SeriesTypeMaster;
};
