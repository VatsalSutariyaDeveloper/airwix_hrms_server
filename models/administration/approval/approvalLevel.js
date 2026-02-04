module.exports = (sequelize, DataTypes) => {
  const ApprovalLevel = sequelize.define("ApprovalLevel", {
    workflow_id: { type: DataTypes.INTEGER, allowNull: false },
    level_sequence: { type: DataTypes.INTEGER, allowNull: false, comment: "1, 2, 3..." },
    approver_type: { type: DataTypes.STRING(20), allowNull: false, comment: "ROLE or USER" },
    approver_id: { type: DataTypes.INTEGER, allowNull: false, comment: "Ref ID of Role or User" },
    user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, defaultValue: 0 },
    status: { type: DataTypes.SMALLINT, defaultValue: 0, comment: "0=Active, 1=Inactive, 2=Deleted, 3=Pending Approval" },
  }, {
    tableName: "approval_levels",
    timestamps: true,
    underscored: true
  });

  return ApprovalLevel;
};