module.exports = (sequelize, DataTypes) => {
  const ExpenseType = sequelize.define(
    "ExpenseType",
    {
      name: { type: DataTypes.STRING(100), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: true },
      status: { 
        type: DataTypes.SMALLINT, 
        defaultValue: 0, 
        comment: "0: Active, 1: Inactive, 2: Deleted" 
      },
      user_id: { type: DataTypes.BIGINT, allowNull: true },
      
      company_id: { type: DataTypes.BIGINT, allowNull: true }
  }, {
    tableName: "expense_type",
      timestamps: true,
      underscored: true,
    }
  );

  return ExpenseType;
};
