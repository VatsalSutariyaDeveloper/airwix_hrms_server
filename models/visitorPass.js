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
    company_phone: {
      type: DataTypes.STRING(20),
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
    },
    visitor_type: {
      type: DataTypes.ENUM("VISITOR", "CONTRACTOR", "TPI"),
      defaultValue: "VISITOR",
      allowNull: false
    },
    valid_from: {
      type: DataTypes.DATEONLY,
      allowNull: true
    },
    valid_to: {
      type: DataTypes.DATEONLY,
      allowNull: true
    },
    visitor_document: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    visitor_photo_url: {
      type: DataTypes.VIRTUAL,
      get() {
        const photo = this.getDataValue("visitor_photo");
        if (!photo) return null;
        const fileServerUrl = process.env.FILE_SERVER_URL || "";
        return `${fileServerUrl}visitor_passes/${photo}`;
      }
    },
    visitor_document_url: {
      type: DataTypes.VIRTUAL,
      get() {
        const doc = this.getDataValue("visitor_document");
        if (!doc) return null;
        const fileServerUrl = process.env.FILE_SERVER_URL || "";
        return `${fileServerUrl}visitor_passes/${doc}`;
      }
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
    VisitorPass.hasMany(models.VisitorAttendance, {
      foreignKey: "visitor_pass_id",
      as: "attendances"
    });
  };

  return VisitorPass;
};
