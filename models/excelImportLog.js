module.exports = (sequelize, DataTypes) => {
    const ExcelImportLog = sequelize.define("ExcelImportLog", {
        entity_name: {
            type: DataTypes.STRING(100),
            allowNull: false
        },
        file_name: {
            type: DataTypes.STRING(255),
            allowNull: true
        },
        total_records: {
            type: DataTypes.INTEGER,
            defaultValue: 0
        },
        success_count: {
            type: DataTypes.INTEGER,
            defaultValue: 0
        },
        failed_count: {
            type: DataTypes.INTEGER,
            defaultValue: 0
        },
        error_key: {
            type: DataTypes.STRING(255),
            allowNull: true
        },
        status: { 
            type: DataTypes.SMALLINT, 
            defaultValue: 0, 
            comment: "0: Success, 1: Completed with Errors, 2: Failed/Aborted" 
        },
        user_id: { type: DataTypes.INTEGER, allowNull: true },
        branch_id: { type: DataTypes.INTEGER, allowNull: true },
        company_id: { type: DataTypes.INTEGER, allowNull: true },
        error_details: { type: DataTypes.TEXT, allowNull: true },
        import_parameters: { type: DataTypes.TEXT, allowNull: true }
    }, {
        tableName: "excel_import_logs",
        underscored: true,
        timestamps: true
    });

    ExcelImportLog.associate = (models) => {
        ExcelImportLog.belongsTo(models.User, {
            foreignKey: "user_id",
            as: "user"
        });
    };

    return ExcelImportLog;
};
