module.exports = (sequelize, DataTypes) => {
  const ApprovalLog = sequelize.define("ApprovalLog", {
    request_id: { type: DataTypes.INTEGER, allowNull: false },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    action: { type: DataTypes.STRING(20), allowNull: false, comment: "APPROVED, REJECTED" },
    comment: { type: DataTypes.TEXT },
    level_sequence: { type: DataTypes.INTEGER },
    branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, defaultValue: 0 }
  }, {
    tableName: "approval_logs",
    timestamps: true,
    underscored: true
  });

  ApprovalLog.associate = (models) => {
    ApprovalLog.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
  };

  return ApprovalLog;
};