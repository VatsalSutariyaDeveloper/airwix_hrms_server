module.exports = (sequelize, DataTypes) => {
  const ResourceMaster = sequelize.define("ResourceMaster", {
    resource_name: { type: DataTypes.STRING(200), allowNull: false },
    working_hours: { type: DataTypes.STRING(10) },
    hours_cost: { type: DataTypes.STRING(200) },
    resource_value: { type: DataTypes.STRING(255) },
    maintance_period_type: { type: DataTypes.SMALLINT, defaultValue: 0,comment: "1=Days, 2=Month, 3=Year"},
    maintance_period: { type: DataTypes.STRING(10)},
    employee_id: { type: DataTypes.STRING(100), comment: "A text box has been temporarily added. In the future, once the master record is available, its ID will be linked here." },
    shift_type: { type: DataTypes.STRING(100), comment: "A text box has been temporarily added. In the future, once the master record is available, its ID will be linked here." },
    remark: { type: DataTypes.TEXT, allowNull: false },
    status: { type: DataTypes.SMALLINT, defaultValue: 0, comment: "0: Active, 1: Inactive, 2: Deleted" },
    user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }  
  }, {
    tableName: "resource_master",
    timestamps: true,
    underscored: true
  });

  return ResourceMaster;
};
