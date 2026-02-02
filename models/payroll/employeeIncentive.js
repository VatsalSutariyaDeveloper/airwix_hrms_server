module.exports = (sequelize, DataTypes) => {
  const EmployeeIncentive = sequelize.define(
    "EmployeeIncentive",
    {
      employee_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
      },

      incentive_type_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: "Reference to incentive master",
      },

      payroll_month: {
        type: DataTypes.DATEONLY,
        allowNull: false,
        comment: "Month in which incentive is applied",
      },

      amount: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
      },

      incentive_date: {
        type: DataTypes.DATEONLY,
        allowNull: false,
      },

      notes: {
        type: DataTypes.TEXT,
        allowNull: true,
      },

      adjusted_in_payroll: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },

      status: { 
        type: DataTypes.SMALLINT, 
        defaultValue: 0, 
        comment: "0: Active, 1: Inactive, 2: Deleted", 
      },

      user_id: {
        type: DataTypes.BIGINT,
        allowNull: true,
      },
      branch_id: {
        type: DataTypes.BIGINT,
        allowNull: true,
      },
      company_id: {
        type: DataTypes.BIGINT,
        allowNull: true,
      },
    },
    {
      tableName: "employee_incentives",
      timestamps: true,
      underscored: true,
    }
  );

  EmployeeIncentive.associate = (models) => {
    EmployeeIncentive.belongsTo(models.Employee, {
      foreignKey: "employee_id",
      as: "employee",
    });

    EmployeeIncentive.belongsTo(models.Company, {
      foreignKey: "company_id",
      as: "company",
    });

    EmployeeIncentive.belongsTo(models.IncentiveType, {
      foreignKey: "incentive_type_id",
      as: "incentiveType",
    });
  };

  return EmployeeIncentive;
};
