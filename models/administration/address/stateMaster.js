module.exports = (sequelize, DataTypes) => {
  const StateMaster = sequelize.define("StateMaster", {
    country_id: { type: DataTypes.INTEGER, allowNull: true },
    state_name: { type: DataTypes.STRING, allowNull: false },
    code: { type: DataTypes.STRING, allowNull: true, defaultValue: 0 },
    status: {
      type: DataTypes.SMALLINT,
      defaultValue: 0,
      comment: "0: Active, 1: Inactive, 2: Deleted"
    },
    user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }
  }, {
    tableName: "state_master",
    timestamps: true,
    underscored: true
  });

  StateMaster.associate = (models) => {
    // StateMaster.belongsTo(models.CountryMaster, { foreignKey: "country_id", as: "country" });
    // StateMaster.hasMany(models.CityMaster, { foreignKey: "state_id", as: "cities" });
  };


  return StateMaster;
};
