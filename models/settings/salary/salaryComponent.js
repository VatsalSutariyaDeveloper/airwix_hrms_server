module.exports = (sequelize, DataTypes) => {
  const SalaryComponent = sequelize.define("SalaryComponent", {
    component_code: { type: DataTypes.STRING(50), unique: true },
    component_name: { type: DataTypes.STRING(150), allowNull: false },
    component_type: {
      type: DataTypes.ENUM("EARNING", "DEDUCTION"),
      allowNull: false
    },
    component_category: {
      type: DataTypes.ENUM("FIXED", "VARIABLE", "STATUTORY"),
      allowNull: false
    },
    calculation_type: {
      type: DataTypes.ENUM("FIXED", "PERCENTAGE", "FORMULA", "SYSTEM"),
      allowNull: false
    },
    percentage_of: {
      type: DataTypes.ENUM("BASIC", "GROSS", "CTC"),
      allowNull: true
    },
    percentage_value: { type: DataTypes.DECIMAL(6,2) },
    fixed_amount: { type: DataTypes.DECIMAL(12,2) },
    min_limit: { type: DataTypes.DECIMAL(12,2) },
    max_limit: { type: DataTypes.DECIMAL(12,2) },
    rounding_rule: {
      type: DataTypes.ENUM("ROUND", "CEIL", "FLOOR"),
      defaultValue: "ROUND"
    },
    is_taxable: { type: DataTypes.BOOLEAN, defaultValue: true },
    is_statutory: { type: DataTypes.BOOLEAN, defaultValue: false },
    sort_order: { type: DataTypes.INTEGER, defaultValue: 0 },
    status: { type: DataTypes.SMALLINT, defaultValue: 0, comment: "0: Active, 1: Inactive, 2: Deleted", },
    user_id: { type: DataTypes.INTEGER, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, defaultValue: 0 },
  }, {
    tableName: "salary_components",
    timestamps: true
  });

  return SalaryComponent;
};
