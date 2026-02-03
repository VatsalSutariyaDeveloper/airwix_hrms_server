module.exports = (sequelize, DataTypes) => {
  const IncentiveType = sequelize.define("IncentiveType", {
    name: { type: DataTypes.STRING(100), allowNull: false },
    description: DataTypes.TEXT,
    status: { type: DataTypes.SMALLINT, defaultValue: 0, comment: "0: Active, 1: Inactive, 2: Deleted" },
    user_id: { type: DataTypes.BIGINT, allowNull: true },
    branch_id: { type: DataTypes.BIGINT, allowNull: true },
    company_id: { type: DataTypes.BIGINT, allowNull: true },
  }, {
    tableName: "incentive_type_master",
    timestamps: true,
    underscored: true,
  });
  return IncentiveType;
};