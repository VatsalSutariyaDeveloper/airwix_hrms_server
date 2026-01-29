module.exports = (sequelize, DataTypes) => {
  const StatutoryPTRule = sequelize.define("StatutoryPTRule", {
    // We use String for state to keep it simple, or you can link to a State model
    state_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: "e.g., Gujarat, Maharashtra, Karnataka"
    },
    // The Salary Slab Range
    min_salary: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
    max_salary: { type: DataTypes.DECIMAL(12, 2), allowNull: true }, // Null means "Above this amount"
    // The Tax Amount for this slab
    monthly_amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },

    // Special case for March (Some states like Maharashtra deduct more in March)
    march_amount: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    gender: {
      type: DataTypes.TINYINT,
      defaultValue: 3,
      comment: "1: Male, 2: Female, 3: All (Some states have different tax for women)"
    },

    // active: { type: DataTypes.BOOLEAN, defaultValue: true }
    status: {
      type: DataTypes.SMALLINT,
      defaultValue: 0,
      comment: "0: Active, 1: Inactive, 2: Deleted",
    },
    user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, },
    branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, },
    company_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, },
  }, {
    tableName: "statutory_pt_rules",
    timestamps: true // These are static rules, rarely change
  });

  return StatutoryPTRule;
};