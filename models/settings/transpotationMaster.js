module.exports = (sequelize, DataTypes) => {
  const TranspotationMaster = sequelize.define("TranspotationMaster", {
    transpotation_name: { type: DataTypes.STRING(100), allowNull: false },
    transpotation_branch: { type: DataTypes.STRING(100), allowNull: true },
    email: { type: DataTypes.STRING(100), allowNull: true },
    mobile_no: { type: DataTypes.STRING(20), allowNull: true },
    address: { type: DataTypes.TEXT, allowNull: true },
    tax_no: { type: DataTypes.STRING(20), allowNull: true },
    status: { type: DataTypes.SMALLINT, defaultValue: 0, comment: "0: Active, 1: Inactive, 2: Deleted" },
    user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }
  }, {
    tableName: "transpotation_master",
    timestamps: true,
    underscored: true
  });

  return TranspotationMaster;
};
