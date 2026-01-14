module.exports = (sequelize, DataTypes) => {
  const ApprovalWorkflow = sequelize.define("ApprovalWorkflow", {
    module_entity_id: { type: DataTypes.INTEGER, allowNull: false, comment: "Ref to ModuleEntityMaster" },
    workflow_name: { type: DataTypes.STRING(100), allowNull: false },
    description: { type: DataTypes.TEXT },
    priority: { type: DataTypes.INTEGER, defaultValue: 999 },
    status: { type: DataTypes.SMALLINT, defaultValue: 1, comment: "1: Active, 0: Inactive" },
    user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, defaultValue: 0 }
  }, {
    tableName: "approval_workflows",
    timestamps: true,
    underscored: true
  });

  ApprovalWorkflow.associate = (models) => {
    ApprovalWorkflow.hasMany(models.ApprovalRule, { foreignKey: 'workflow_id', as: 'rules' });
    ApprovalWorkflow.hasMany(models.ApprovalLevel, { foreignKey: 'workflow_id', as: 'levels' });
    ApprovalWorkflow.belongsTo(models.ModuleEntityMaster, { foreignKey: 'module_entity_id', as: 'module_entity' });
  };

  return ApprovalWorkflow;
};