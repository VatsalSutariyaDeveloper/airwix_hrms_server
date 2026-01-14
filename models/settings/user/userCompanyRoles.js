module.exports = (sequelize, DataTypes) => {
  const UserCompanyRoles = sequelize.define("userCompanyRoles", {
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    role_id: { type: DataTypes.INTEGER, allowNull: false },
    branch_id: { type: DataTypes.INTEGER, allowNull: false },
    company_id: { type: DataTypes.INTEGER, allowNull: false },
    permissions: { type: DataTypes.TEXT, allowNull: false },
    status: {
      type: DataTypes.SMALLINT,
      defaultValue: 0,
      comment: "0: Active, 1: Inactive, 2: Deleted"
    },
  }, {
    tableName: "user_company_roles",
    timestamps: true,
    underscored: true
  });

  UserCompanyRoles.associate = (models) => {
    UserCompanyRoles.belongsTo(models.RolePermission, {
      foreignKey: "role_id",
      as: "role",
    });
    UserCompanyRoles.belongsTo(models.User, {
      foreignKey: "user_id",
      as: "user",
    });
    UserCompanyRoles.belongsTo(models.CompanyMaster, {
      foreignKey: "company_id",
      as: "company",
    });
  };
  
  return UserCompanyRoles;
};
