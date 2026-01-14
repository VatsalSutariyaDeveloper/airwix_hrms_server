module.exports = (sequelize, DataTypes) => {
  const ApprovalRequest = sequelize.define("ApprovalRequest", {
    module_entity_id: { type: DataTypes.INTEGER, allowNull: false },
    entity_id: { type: DataTypes.INTEGER, allowNull: false, comment: "ID of the specific record (e.g. SalesOrderID)" },
    workflow_id: { type: DataTypes.INTEGER, allowNull: false },
    current_level_sequence: { type: DataTypes.INTEGER, defaultValue: 1 },
    status: { type: DataTypes.STRING(20), defaultValue: 'PENDING', comment: "PENDING, APPROVED, REJECTED" },
    user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, defaultValue: 0 }
  }, {
    tableName: "approval_requests",
    timestamps: true,
    underscored: true
  });

  ApprovalRequest.associate = (models) => {
    ApprovalRequest.belongsTo(models.ModuleEntityMaster, { foreignKey: 'module_entity_id', as: 'module_entity' });
    ApprovalRequest.belongsTo(models.ApprovalWorkflow, { foreignKey: 'workflow_id', as: 'workflow' });
  };

  return ApprovalRequest;
};