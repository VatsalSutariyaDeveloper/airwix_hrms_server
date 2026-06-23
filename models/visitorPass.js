module.exports = (sequelize, DataTypes) => {
  const VisitorPass = sequelize.define("VisitorPass", {
    pass_code: {
      type: DataTypes.STRING(50),
      allowNull: false,
      unique: true
    },
    visitor_name: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    visitor_email: {
      type: DataTypes.STRING(150),
      allowNull: true
    },
    visitor_phone: {
      type: DataTypes.STRING(20),
      allowNull: false
    },
    company_name: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    purpose: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    host_employee_id: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    scheduled_start_time: {
      type: DataTypes.DATE,
      allowNull: true
    },
    scheduled_end_time: {
      type: DataTypes.DATE,
      allowNull: true
    },
    status: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      comment: "0: Scheduled, 1: Checked In (Active), 2: Reserved for Delete, 3: Checked Out (Completed), 4: Cancelled"
    },
    check_in_time: {
      type: DataTypes.DATE,
      allowNull: true
    },
    check_out_time: {
      type: DataTypes.DATE,
      allowNull: true
    },
    remarks: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    branch_id: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    company_id: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    visitor_photo: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    security_remarks: {
      type: DataTypes.TEXT,
      allowNull: true
    }
  }, {
    tableName: "visitor_passes",
    underscored: true,
    timestamps: true
  });

  VisitorPass.associate = (models) => {
    VisitorPass.belongsTo(models.Employee, {
      foreignKey: "host_employee_id",
      as: "host"
    });
    VisitorPass.belongsTo(models.CompanyMaster, {
      foreignKey: "company_id",
      as: "company"
    });
    VisitorPass.belongsTo(models.BranchMaster, {
      foreignKey: "branch_id",
      as: "branch"
    });
  };

  return VisitorPass;
};
