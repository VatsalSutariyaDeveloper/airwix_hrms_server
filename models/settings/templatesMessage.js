module.exports = (sequelize, DataTypes) => {
    const TemplatesMessage = sequelize.define("TemplatesMessage", {
        template_message_type: { type: DataTypes.SMALLINT, allowNull: false ,comment: "1: Email, 2: WhatsApp, 3: SMS"},
        name: { type: DataTypes.STRING(100), allowNull: false },
        content: { type: DataTypes.TEXT, allowNull: false },
        status: { type: DataTypes.SMALLINT, defaultValue: 0, comment: "0: Active, 1: Inactive, 2: Deleted" },
        is_default: { type: DataTypes.SMALLINT, defaultValue: 2, comment: "1: Yes, 2: No" },
        user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        company_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    }, {
    tableName: "templates_message",
    timestamps: true,
    underscored: true,
  });

    return TemplatesMessage;
}