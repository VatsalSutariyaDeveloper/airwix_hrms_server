module.exports = (sequelize, DataTypes) => {
  const SalaryTemplateStatutory = sequelize.define("SalaryTemplateStatutory", {
    salary_template_id: { type: DataTypes.INTEGER },

    // =================================================================
    // 1. EMPLOYER CONFIGURATION
    // =================================================================
    er_pf_enabled: { type: DataTypes.BOOLEAN, defaultValue: true },
    er_esi_enabled: { type: DataTypes.BOOLEAN, defaultValue: true },
    er_esi_included_in_ctc: { type: DataTypes.BOOLEAN, defaultValue: false },
    er_pf_calculation_type: { type: DataTypes.SMALLINT, defaultValue: 1, comment: "1: Fixed Amount, 2: Percentage of Selected Components" },
    pf_included_component_ids: { type: DataTypes.JSONB, defaultValue: [], comment: "Array of component IDs (Basic, HRA, etc.) included in PF Wage" },
    er_lwf_enabled: { type: DataTypes.BOOLEAN, defaultValue: false },
    er_lwf_included_in_ctc: { type: DataTypes.BOOLEAN, defaultValue: false },
    er_pf_included_in_ctc: { type: DataTypes.BOOLEAN, defaultValue: true },
    er_pf_admin_charges_enabled: { type: DataTypes.BOOLEAN, defaultValue: true },
    er_pf_admin_included_in_ctc: { type: DataTypes.BOOLEAN, defaultValue: true },


    // =================================================================
    // 2. EMPLOYEE CONFIGURATION
    // =================================================================
    ee_pf_enabled: { type: DataTypes.BOOLEAN, defaultValue: true },
    ee_esi_enabled: { type: DataTypes.BOOLEAN, defaultValue: true },
    pt_enabled: { type: DataTypes.BOOLEAN, defaultValue: true },
    pt_state_id: { type: DataTypes.INTEGER, allowNull: true },
    ee_lwf_enabled: { type: DataTypes.BOOLEAN, defaultValue: false },
    lwf_state_id: { type: DataTypes.INTEGER, allowNull: true },
    tds_enabled: { type: DataTypes.BOOLEAN, defaultValue: true },
    
    status: { type: DataTypes.SMALLINT, defaultValue: 0, comment: "0: Active, 1: Inactive, 2: Deleted", },
    user_id: { type: DataTypes.INTEGER, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, defaultValue: 0 },

  }, {
    tableName: "salary_template_statutory",
    timestamps: true,
    underscored: true
  });

  SalaryTemplateStatutory.associate = models => {
    
    // Parent Template
    SalaryTemplateStatutory.belongsTo(models.SalaryTemplate, {
      foreignKey: "salary_template_id",
      as: "salary_template"
    });

    // Link to State Master for PT Rules
    SalaryTemplateStatutory.belongsTo(models.StateMaster, {
      foreignKey: "pt_state_id",
      as: "pt_state"
    });

    // Link to State Master for LWF Rules
    SalaryTemplateStatutory.belongsTo(models.StateMaster, {
      foreignKey: "lwf_state_id",
      as: "lwf_state"
    });
  };

  return SalaryTemplateStatutory;
};