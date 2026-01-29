module.exports = (sequelize, DataTypes) => {
  const ShiftBreak = sequelize.define("ShiftBreak", {
    shift_template_id: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    category: {
      type: DataTypes.STRING(50),
      comment: "e.g., Shift Break, Casual Break"
    },
    break_name: {
      type: DataTypes.STRING(100)
    },
    pay_type: {
      type: DataTypes.ENUM("Paid", "Unpaid"),
      defaultValue: "Unpaid"
    },
    break_type: {
      type: DataTypes.ENUM("Intervals", "Duration"),
      defaultValue: "Intervals"
    },
    start_time: { type: DataTypes.TIME },
    end_time: { type: DataTypes.TIME },
    start_buffer: { type: DataTypes.TIME },
    buffer_end: { type: DataTypes.TIME },
    duration: { 
      type: DataTypes.STRING(10), 
      comment: "hh:mm format for duration types" 
    },
    status: {
      type: DataTypes.SMALLINT,
      defaultValue: 0,
      comment: "0: Active, 1: Inactive, 2: Deleted"
    },
    user_id: { type: DataTypes.INTEGER, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, defaultValue: 0 },
  }, {
    tableName: "shift_breaks",
    timestamps: true,
    underscored: true
  });

  ShiftBreak.associate = (models) => {
    ShiftBreak.belongsTo(models.ShiftTemplate, {
      foreignKey: "shift_template_id"
    });
  };

  return ShiftBreak;
};
