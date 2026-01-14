module.exports = (sequelize, DataTypes) => {
  const modulePermissionTypeMaster = sequelize.define("modulePermissionTypeMaster", {
    permission_type_name: { type: DataTypes.STRING(100), allowNull: false },
    priority: { type: DataTypes.INTEGER, defaultValue: 0 },
    status: {
      type: DataTypes.SMALLINT,
      defaultValue: 0,
      comment: "0: Active, 1: Inactive, 2: Deleted"
    },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    branch_id: { type: DataTypes.INTEGER, allowNull: false },
    company_id: { type: DataTypes.INTEGER, allowNull: false }
  }, {
    tableName: "module_permission_type_master",
    timestamps: true,
    underscored: true
  });

  return modulePermissionTypeMaster;
};
