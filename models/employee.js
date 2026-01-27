module.exports = (sequelize, DataTypes) => {
    const Employee = sequelize.define("Employee", {

        employee_type: {type: DataTypes.SMALLINT,defaultValue: 1, comment:"1:staff, 2:worker"},
        role_id: { type: DataTypes.INTEGER},

        // PROFILE INFORMATION
        profile_image: { type: DataTypes.STRING },
        employee_code: { type: DataTypes.STRING },
        first_name: { type: DataTypes.STRING },
        mobile_no: { type: DataTypes.STRING },
        designation:{ type: DataTypes.STRING },
        attendance_supervisor:{ type: DataTypes.INTEGER },
        is_attendance_supervisor:{ type: DataTypes.BOOLEAN, defaultValue: false },
        reporting_manager:{ type: DataTypes.INTEGER },
        is_reporting_manager:{ type: DataTypes.BOOLEAN, defaultValue: false },

        // GENERAL INFORMATION
        salary_cycle: { type: DataTypes.INTEGER },
        weekly_off_template: { type: DataTypes.INTEGER,defaultValue: 0, allowNull: false },
        holiday_template: { type: DataTypes.INTEGER,defaultValue: 0, allowNull: false },
        leave_template: { type: DataTypes.INTEGER,defaultValue: 0, allowNull: false },
        shift_template: { type: DataTypes.INTEGER,defaultValue: 0, allowNull: false },
        attendance_weekly_off_template: { type: DataTypes.INTEGER,defaultValue: 0, allowNull: false },
        geofence_template: { type: DataTypes.INTEGER,defaultValue: 0, allowNull: false },
        attendance_setting_template: { type: DataTypes.INTEGER,defaultValue: 0, allowNull: false },
        salary_access: { type: DataTypes.INTEGER },

        // PERSONAL INFORMATION
        gender: { type: DataTypes.SMALLINT, comment: "1: Male, 2: Female, 3: Others" },
        dob: { type: DataTypes.DATEONLY },
        email: { type: DataTypes.STRING, validate: { isEmail: true } },
        marital_status: { type: DataTypes.SMALLINT, comment: "1: Married, 2: Unmarried" },
        blood_group: { type: DataTypes.SMALLINT, comment: "1: A+, 2: A-, 3: B+, 4: B-, 5: O+, 6: O-, 7: AB+, 8: AB-" },
        physically_challenged: { type: DataTypes.BOOLEAN, defaultValue: false },
        emergency_contact_mobile: { type: DataTypes.STRING },
        father_name: { type: DataTypes.STRING },
        mother_name: { type: DataTypes.STRING },
        spouse_name: { type: DataTypes.STRING },

        // ADDRESS INFORMATION
        same_as_current: { type: DataTypes.BOOLEAN, defaultValue: false },
        permanent_address1: { type: DataTypes.STRING },
        permanent_address2: { type: DataTypes.STRING },
        permanent_city: { type: DataTypes.STRING },
        permanent_pincode: { type: DataTypes.STRING },
        permanent_state_id: { type: DataTypes.INTEGER },
        permanent_country_id: { type: DataTypes.INTEGER },
        permanent_address_proof_doc: { type: DataTypes.STRING },

        present_address1: { type: DataTypes.STRING },
        present_address2: { type: DataTypes.STRING },
        present_city: { type: DataTypes.STRING },
        present_pincode: { type: DataTypes.STRING },
        present_state_id: { type: DataTypes.INTEGER },
        present_country_id: { type: DataTypes.INTEGER },
        present_address_proof_doc: { type: DataTypes.STRING },

        // EMPLOYEEMENT INFORMATION
        joining_date: { type: DataTypes.DATEONLY },
        uan_number: { type: DataTypes.STRING },
        name_as_per_pan: { type: DataTypes.STRING },
        pan_number: { type: DataTypes.STRING },
        name_as_per_aadhaar: { type: DataTypes.STRING },
        aadhaar_number: { type: DataTypes.STRING(12) },
        pf_number: { type: DataTypes.STRING },
        pf_joining_date: { type: DataTypes.DATEONLY },
        pf_eligible: { type: DataTypes.BOOLEAN, defaultValue: false },
        esi_eligible: { type: DataTypes.BOOLEAN, defaultValue: false },
        esi_number: { type: DataTypes.STRING },
        pt_eligible: { type: DataTypes.BOOLEAN, defaultValue: false },
        lwf_eligible: { type: DataTypes.BOOLEAN, defaultValue: false },
        eps_eligible: { type: DataTypes.BOOLEAN, defaultValue: false },
        eps_joining_date: { type: DataTypes.DATEONLY },
        eps_exit_date: { type: DataTypes.DATEONLY },
        hps_eligible: { type: DataTypes.BOOLEAN, defaultValue: false },

        // BANK INFORMATION
        name_as_per_bank: { type: DataTypes.STRING },
        bank_name: { type: DataTypes.STRING },
        bank_account_number: { type: DataTypes.STRING(100) },
        bank_ifsc_code: { type: DataTypes.STRING(11) },
        bank_account_holder_name: { type: DataTypes.STRING },
        upi_id:{ type: DataTypes.STRING },
 
        // DOCUMENT UPLOAD
        aadhaar_doc: { type: DataTypes.STRING },
        pan_doc: { type: DataTypes.STRING },
        bank_proof_doc: { type: DataTypes.STRING },

        // OTHER INFORMATION
        marriage_date: { type: DataTypes.DATEONLY },
        country_of_origin: { type: DataTypes.STRING, defaultValue: 'India' },
        nationality: { type: DataTypes.STRING, defaultValue: 'Indian' },
        is_international_emp: { type: DataTypes.BOOLEAN, defaultValue: false },
        disability_type: { type: DataTypes.SMALLINT, comment: "1: Hearing, 2: Locomotive disability, 3: Visual, 4: None" },
        place_of_birth: { type: DataTypes.STRING },
        height: { type: DataTypes.INTEGER },
        weight: { type: DataTypes.INTEGER },
        identification_mark: { type: DataTypes.STRING },
        religion: { type: DataTypes.STRING },
        caste: { type: DataTypes.STRING },
        hobby: { type: DataTypes.STRING },
        
        emergency_contact_name: { type: DataTypes.STRING },
        emergency_contact_relation: { type: DataTypes.SMALLINT, comment: "1: Brother, 2: Sister, 3: Father, 4: Mother, 5: Spouse, 6: Son, 7: Daughter, 8: Other" },

        confirmation_date: { type: DataTypes.DATEONLY },
        probation_period_days: { type: DataTypes.INTEGER },
        notice_period_days: { type: DataTypes.INTEGER },
        referred_by: { type: DataTypes.STRING },

        passport_number: { type: DataTypes.STRING(9) },
        name_as_per_passport: { type: DataTypes.STRING },
        passport_expiry_date: { type: DataTypes.DATEONLY },
        passport_doc: { type: DataTypes.STRING },

        education_details: {
            type: DataTypes.JSONB,
            defaultValue: []
        },
        face_descriptor: {
            type: DataTypes.JSONB, 
            defaultValue: null,
            comment: "Stores the [0.12, -0.45, ...] vector from DeepFace"
        },

        status: {type: DataTypes.SMALLINT, defaultValue: 0, comment: "0: Active, 1: Inactive, 2: Deleted"},  
        user_id: { type: DataTypes.INTEGER, allowNull: true },
        branch_id: { type: DataTypes.INTEGER, allowNull: true },
        company_id: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'employees',
        timestamps: true,
        underscored: true
    });

    Employee.associate = function (models) {
        Employee.belongsTo(models.User, { foreignKey: "user_id", as: "created_by" });
        Employee.hasOne(models.User, { foreignKey: "employee_id", as: "linked_user" });
        Employee.hasMany(models.AttendancePunch, { foreignKey: "employee_id", as: "attendance_punches" });
        Employee.belongsTo(models.LeaveTemplate, { foreignKey: "leave_template", as: "leaveTemplate" });
        
        // Reporting Hierarchy
        Employee.belongsTo(models.Employee, { foreignKey: "reporting_manager", as: "manager" });
        Employee.belongsTo(models.Employee, { foreignKey: "attendance_supervisor", as: "supervisor" });
    };

    return Employee;
};