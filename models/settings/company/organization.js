module.exports = (sequelize, DataTypes) => {
  const Organization = sequelize.define("Organization", {
    name: { type: DataTypes.STRING(100), allowNull: false },
    code: { type: DataTypes.STRING(50), allowNull: false, unique: true },
    logo: { type: DataTypes.STRING(255), allowNull: true },
    status: {
      type: DataTypes.SMALLINT,
      defaultValue: 0,
      comment: "0: Active, 1: Inactive, 2: Deleted",
    },
  }, {
    tableName: "organizations",
    timestamps: true,
    underscored: true,
  });

  Organization.associate = (models) => {
    Organization.hasMany(models.CompanyMaster, {
      as: "companies",
      foreignKey: "organization_id",
    });
  };

  return Organization;
};
