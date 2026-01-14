module.exports = (sequelize, DataTypes) => {
  const Signature = sequelize.define("Signature", {
    name: { type: DataTypes.STRING(100), allowNull: true },
    image: { type: DataTypes.STRING(255), allowNull: true },
    is_default: { type: DataTypes.INTEGER, defaultValue: 2, comment: "1: Yes, 2: No" },
    status: { type: DataTypes.SMALLINT, defaultValue: 0, comment: "0: Active, 1: Inactive, 2: Deleted" },
    user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }
  }, {
    tableName: "signature",
    timestamps: true,
    underscored: true
  });

  return Signature;
};
