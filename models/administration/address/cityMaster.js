module.exports = (sequelize, DataTypes) => {
  const CityMaster = sequelize.define("CityMaster", {
    state_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    city_name: { type: DataTypes.STRING, allowNull: false },
    status: {
      type: DataTypes.SMALLINT,
      defaultValue: 0,
      comment: "0: Active, 1: Inactive, 2: Deleted"
    },
  }, {
    tableName: "city_master",
    timestamps: true,
    underscored: true
  });

  CityMaster.associate = (models) => {
    CityMaster.belongsTo(models.StateMaster, { foreignKey: "state_id", as: "state" });
  };
  
  return CityMaster;
};
