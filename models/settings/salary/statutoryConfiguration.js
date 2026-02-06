module.exports = (sequelize, DataTypes) => {
  return sequelize.define("StatutoryConfiguration", {
    statutory_type: {
      type: DataTypes.ENUM("PF", "ESI", "PT", "LWF"),
      allowNull: false
    },
    employee_rate: { type: DataTypes.DECIMAL(6,2) },
    employer_rate: { type: DataTypes.DECIMAL(6,2) },
    wage_limit: { type: DataTypes.DECIMAL(12,2) },
    state_code: { type: DataTypes.STRING(10) },
    effective_from: { type: DataTypes.DATEONLY },
    effective_to: { type: DataTypes.DATEONLY },
    status: { type: DataTypes.SMALLINT, defaultValue: 0, comment: "0: Active, 1: Inactive, 2: Deleted", },
    user_id: { type: DataTypes.INTEGER, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, defaultValue: 0 },
  }, {
    tableName: "statutory_configurations",
    timestamps: true
  });
};