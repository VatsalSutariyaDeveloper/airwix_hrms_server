module.exports = (sequelize, DataTypes) => {
  const RolePermission = sequelize.define("rolePermission", {
    role_name: { type: DataTypes.STRING(100), allowNull: false },
    permissions: { type: DataTypes.TEXT, allowNull: false },
    status: {
      type: DataTypes.SMALLINT,
      defaultValue: 0,
      comment: "0: Active, 1: Inactive, 2: Deleted"
    },
    user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }
  }, {
    tableName: "role_permission",
    timestamps: true,
    underscored: true
  });

  RolePermission.associate = (models) => {
    RolePermission.hasMany(models.User, {
      foreignKey: "role_id",
      as: "users",
    });

  };
  
  return RolePermission;
};
