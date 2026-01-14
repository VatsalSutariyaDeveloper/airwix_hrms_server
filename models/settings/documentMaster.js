module.exports = (sequelize, DataTypes) => {
  const DocumentMaster = sequelize.define("DocumentMaster", {
    document_name: { type: DataTypes.STRING(100), allowNull: false },
    status: {
      type: DataTypes.SMALLINT,
      defaultValue: 0,
      comment: "0: Active, 1: Inactive, 2: Deleted"
    },
    user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  }, {
    tableName: "document_master",
    timestamps: true,
    underscored: true,
  });

  return DocumentMaster;
};
