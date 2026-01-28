module.exports = (sequelize, DataTypes) => {
const ShiftTemplate = sequelize.define("ShiftTemplate",
    {
        shift_name: { type: DataTypes.STRING, allowNull: false },
        start_time: { type: DataTypes.TIME, allowNull: false },
        end_time: { type: DataTypes.TIME, allowNull: false },
        punch_in: { type: DataTypes.SMALLINT, defaultValue: 0, comment: "0: Anytime, 1: Restricted" },
        punch_out: { type: DataTypes.SMALLINT, defaultValue: 0, comment: "0: Anytime, 1: Restricted" },
        punch_in_time: { type: DataTypes.TIME },
        punch_out_time: { type: DataTypes.TIME },
        grace_minutes: { type: DataTypes.INTEGER, defaultValue: 0, comment: "Late arrival grace" },
        early_exit_grace: { type: DataTypes.INTEGER, defaultValue: 0, comment: "Early departure grace" },
        min_half_day_minutes: { type: DataTypes.INTEGER, defaultValue: 240 },
        min_full_day_minutes: { type: DataTypes.INTEGER, defaultValue: 480 },
        color: { type: DataTypes.STRING, defaultValue: "#4F46E5" },
        is_night_shift: { type: DataTypes.BOOLEAN, defaultValue: false },
        status: {
            type: DataTypes.SMALLINT,
            defaultValue: 0,
            comment: "0: Active, 1: Inactive, 2: Deleted"
        },
        user_id: { type: DataTypes.INTEGER, defaultValue: 0 },
        branch_id: { type: DataTypes.INTEGER, defaultValue: 0 },
        company_id: { type: DataTypes.INTEGER, defaultValue: 0 },
    },
    {
        tableName: "shift_template",
        timestamps: true,
        underscored: true,
    }
);

    return ShiftTemplate;
};

