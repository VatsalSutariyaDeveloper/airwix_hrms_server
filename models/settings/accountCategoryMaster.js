module.exports = (sequelize, DataTypes) => {
  const AccountCategoryMaster = sequelize.define("AccountCategoryMaster", {
    id: { type: DataTypes.BIGINT, allowNull: false, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(150), allowNull: false },
    type: { type: DataTypes.SMALLINT, allowNull: false, comment: "1: Expense, 2: Income" },
    parent_id: { type: DataTypes.BIGINT, allowNull: true },
    description: { type: DataTypes.TEXT, allowNull: true },
    status: {
      type: DataTypes.SMALLINT,
      defaultValue: 0,
      comment: "0: Active, 1: InActive, 2: Delete",
    }, user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }
  }, {
    tableName: "account_category_master",
    timestamps: true,
    underscored: true
  });

  AccountCategoryMaster.associate = (models) => {
    AccountCategoryMaster.belongsTo(models.AccountCategoryMaster, {
      as: "parentid",
      foreignKey: "parent_id",
    });

    AccountCategoryMaster.hasMany(models.AccountCategoryMaster, {
      as: "subCategories",
      foreignKey: "parent_id",
    });
  };


  return AccountCategoryMaster;
};
