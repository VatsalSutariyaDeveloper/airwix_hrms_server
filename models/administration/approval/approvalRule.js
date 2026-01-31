module.exports = (sequelize, DataTypes) => {
  const ApprovalRule = sequelize.define("ApprovalRule", {
    workflow_id: { type: DataTypes.INTEGER, allowNull: false },
    field_name: { type: DataTypes.STRING(100), allowNull: false, comment: "e.g., total_amount" },
    operator: { type: DataTypes.STRING(10), allowNull: false, comment: ">, <, =, >=, <=" },
    value: { type: DataTypes.STRING(100), allowNull: false },
    logical_operator: { type: DataTypes.STRING(5), defaultValue: 'AND', comment: "And/OR" },
    sequence: { type: DataTypes.INTEGER, defaultValue: 0 },
    user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, defaultValue: 0 },
    status: { type: DataTypes.SMALLINT, defaultValue: 0, comment: "0=Active, 1=Inactive, 2=Deleted" },
  }, {
    tableName: "approval_rules",
    timestamps: true,
    underscored: true
  });

  return ApprovalRule;
};