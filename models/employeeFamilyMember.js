module.exports = (sequelize, DataTypes) => {
    const EmployeeFamilyMember = sequelize.define("EmployeeFamilyMember", {
        employee_id: { type: DataTypes.INTEGER, allowNull: false },
        name: { type: DataTypes.STRING, allowNull: false },
        relationship: { type: DataTypes.SMALLINT, comment: "1: Brother, 2: Sister, 3: Father, 4: Mother, 5: Spouse, 6: Son, 7: Daughter" },
        dob: { type: DataTypes.DATEONLY },
        gender: { type: DataTypes.SMALLINT, comment: "1: Male, 2: Female, 3: Others" },
        blood_group: { type: DataTypes.SMALLINT, comment: "1: A+, 2: A-, 3: B+, 4: B-, 5: O+, 6: O-, 7: AB+, 8: AB-" },
        nationality: { type: DataTypes.STRING, defaultValue: 'Indian' },
        is_minor: { type: DataTypes.BOOLEAN, defaultValue: false },
        has_illness: { type: DataTypes.BOOLEAN, defaultValue: false },
        status: {
            type: DataTypes.SMALLINT,
            defaultValue: 0,
            comment: "0: Active, 1: Inactive, 2: Deleted"
        },
        user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        company_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    }, {
        tableName: 'employee_family_members',
        timestamps: true,
        underscored: true // Ensures snake_case for created_at, updated_at
    });

    return EmployeeFamilyMember;
};