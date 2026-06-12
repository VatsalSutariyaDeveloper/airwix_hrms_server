module.exports = (sequelize, DataTypes) => {
    const DeviceMaster = sequelize.define(
        "DeviceMaster",
        {
            device_name: { type: DataTypes.STRING, allowNull: false },
            device_id: { type: DataTypes.STRING, allowNull: true },
            ip_address: { type: DataTypes.STRING, allowNull: true },
            mobile_no: { type: DataTypes.STRING, allowNull: true },
            status: {
                type: DataTypes.SMALLINT,
                defaultValue: 1,
                comment: "0: Paired, 1: Unpaired, 2: Deleted, 3: Pairing"
            },
            password: { type: DataTypes.STRING, allowNull: true },
            user_id: { type: DataTypes.INTEGER, allowNull: true },
            
            company_id: { type: DataTypes.INTEGER, allowNull: true },
            last_login_at: { type: DataTypes.DATE, allowNull: true },
            device_type: {
                type: DataTypes.SMALLINT,
                defaultValue: 0,
                comment: "0: Attendance, 1: Canteen"
            },
            device_model: { type: DataTypes.STRING, allowNull: true },
            os_version: { type: DataTypes.STRING, allowNull: true },
            brand_name: { type: DataTypes.STRING, allowNull: true }
  }, {
    tableName: "device_master",
            timestamps: true,
            underscored: true,
        }
    );
    DeviceMaster.associate = (models) => {
        DeviceMaster.belongsTo(models.CompanyMaster, {
            foreignKey: "company_id",
            as: "Company",
        });
    };
    
    return DeviceMaster;
}