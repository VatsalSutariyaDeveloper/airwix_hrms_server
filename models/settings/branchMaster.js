module.exports = (sequelize, DataTypes) => {
  const BranchMaster = sequelize.define("BranchMaster", {
    branch_name: { type: DataTypes.STRING(100), allowNull: false },
    country_id: { type: DataTypes.STRING(100), allowNull: true },
    state_id: { type: DataTypes.STRING(100), allowNull: true },
    city: { type: DataTypes.STRING(100), allowNull: true },
    pincode: { type: DataTypes.STRING(20), allowNull: true },
    zone_id: { type: DataTypes.STRING(100), allowNull: true },
    status: {
      type: DataTypes.SMALLINT,
      defaultValue: 0,
      comment: "0 = active, 1 = inactive, 2 = deleted"
    },
    user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }
  }, {
    tableName: "branch_master",
    timestamps: true,
    underscored: true
  });

  // BranchMaster.associate = (models) => {
  //   BranchMaster.belongsTo(models.CountryMaster, { foreignKey: "country_id", as: "country", constraints: false });
  //   BranchMaster.belongsTo(models.StateMaster, { foreignKey: "state_id", as: "state" });
  //   BranchMaster.belongsTo(models.ZoneMaster, { foreignKey: "zone_id", as: "zone" });
  // };

  return BranchMaster;
};
