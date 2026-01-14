module.exports = (sequelize, DataTypes) => {
  const CommonCategoryMaster = sequelize.define(
    "CommonCategoryMaster",
    {
      category_name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        unique: true,
      },
      status: {
        type: DataTypes.SMALLINT,
        defaultValue: 0,
        comment: "0: Active, 1: Inactive, 2: Deleted",
      },
      user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      company_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
    },
    {
      tableName: "common_category_master",
      timestamps: true,
      underscored: true,
    }
  );

  return CommonCategoryMaster;
};
