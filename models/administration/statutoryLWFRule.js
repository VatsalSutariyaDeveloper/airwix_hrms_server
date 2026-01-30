module.exports = (sequelize, DataTypes) => {
  const StatutoryLWFRule = sequelize.define("StatutoryLWFRule", {
    state_id: { type: DataTypes.INTEGER, allowNull: false},
    employee_contribution: { type: DataTypes.DECIMAL(8,2), defaultValue: 0 },
    employer_contribution: { type: DataTypes.DECIMAL(8,2), defaultValue: 0 },
    deduction_months: { 
        type: DataTypes.JSONB, 
        allowNull: false,
        comment: "Array of months to deduct LWF, e.g., [6, 12]" 
    },
    status: {
      type: DataTypes.SMALLINT,
      defaultValue: 0,
      comment: "0: Active, 1: Inactive, 2: Deleted",
    },
    user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, },
    branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, },
    company_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, },
  }, { 
    tableName: "statutory_lwf_rules",
    timestamps: true 
  });
 
  StatutoryLWFRule.associate = (models) => {
    StatutoryLWFRule.belongsTo(models.StateMaster, { 
      foreignKey: "state_id",
      as: "state"
    });
  };

  return StatutoryLWFRule;
};