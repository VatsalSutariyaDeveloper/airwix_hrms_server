module.exports = (sequelize, DataTypes) => {
  const VisitorAttendance = sequelize.define("VisitorAttendance", {
    visitor_pass_id: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    visitor_name: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    visitor_phone: {
      type: DataTypes.STRING(20),
      allowNull: false
    },
    visitor_photo: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    check_in_time: {
      type: DataTypes.DATE,
      allowNull: true
    },
    check_out_time: {
      type: DataTypes.DATE,
      allowNull: true
    },
    security_remarks: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    status: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      comment: "1: Checked In, 3: Checked Out"
    }
  }, {
    tableName: "visitor_attendance",
    underscored: true,
    timestamps: true
  });

  VisitorAttendance.associate = (models) => {
    VisitorAttendance.belongsTo(models.VisitorPass, {
      foreignKey: "visitor_pass_id",
      as: "pass"
    });
  };

  return VisitorAttendance;
};
