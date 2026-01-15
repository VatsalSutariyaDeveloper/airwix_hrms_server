module.exports = (sequelize, DataTypes) => {
    const Employee = sequelize.define("Employee", {
        // 1. PERSONAL INFORMATION
        father_name: { type: DataTypes.STRING },
        personal_email: { type: DataTypes.STRING, validate: { isEmail: true } },
        blood_group: { type: DataTypes.SMALLINT, comment: "1: A+, 2: A-, 3: B+, 4: B-, 5: O+, 6: O-, 7: AB+, 8: AB-" },
        marital_status: { type: DataTypes.SMALLINT, comment: "1: Married, 2: Separated, 3: Single, 4: Widowed" },
        marriage_date: { type: DataTypes.DATEONLY },
        spouse_name: { type: DataTypes.STRING },
        country_of_origin: { type: DataTypes.STRING, defaultValue: 'India' },
        nationality: { type: DataTypes.STRING, defaultValue: 'Indian' },
        is_international_emp: { type: DataTypes.BOOLEAN, defaultValue: false },
        physically_challenged: { type: DataTypes.BOOLEAN, defaultValue: false },
        disability_type: { type: DataTypes.SMALLINT, comment: "1: Hearing, 2: Locomotive disability, 3: Visual, 4: None" },
        gender: { type: DataTypes.SMALLINT, comment: "1: Male, 2: Female, 3: Others" },
        profile_image: { type: DataTypes.STRING }, // Added profile image
        dob: { type: DataTypes.DATEONLY },
        place_of_birth: { type: DataTypes.STRING },
        height: { type: DataTypes.STRING },
        weight: { type: DataTypes.STRING },
        identification_mark: { type: DataTypes.STRING },
        religion: { type: DataTypes.STRING },
        caste: { type: DataTypes.STRING },
        hobby: { type: DataTypes.STRING },

        // 2. EMERGENCY CONTACT
        emergency_contact_name: { type: DataTypes.STRING },
        emergency_contact_mobile: { type: DataTypes.STRING },
        emergency_contact_relation: { type: DataTypes.SMALLINT, comment: "1: Brother, 2: Sister, 3: Father, 4: Mother, 5: Spouse, 6: Son, 7: Daughter" },

        // ADDRESS
        permanent_address1: { type: DataTypes.STRING },
        permanent_address2: { type: DataTypes.STRING },
        permanent_city: { type: DataTypes.STRING },
        permanent_pincode: { type: DataTypes.STRING },
        permanent_state_id: { type: DataTypes.STRING },
        permanent_country_id: { type: DataTypes.STRING },
        permanent_address_proof_doc: { type: DataTypes.STRING },

        present_address1: { type: DataTypes.STRING },
        present_address2: { type: DataTypes.STRING },
        present_city: { type: DataTypes.STRING },
        present_pincode: { type: DataTypes.STRING },
        present_state_id: { type: DataTypes.STRING },
        present_country_id: { type: DataTypes.STRING },
        present_address_proof_doc: { type: DataTypes.STRING },

        // 4. JOINING & WORK STATUS
        joining_date: { type: DataTypes.DATEONLY },
        confirmation_date: { type: DataTypes.DATEONLY },
        probation_period_days: { type: DataTypes.INTEGER },
        notice_period_days: { type: DataTypes.INTEGER },
        referred_by: { type: DataTypes.STRING },

        // 5. BANK ACCOUNT DETAILS
        bank_country: { type: DataTypes.STRING, defaultValue: 'India' },
        bank_account_number: { type: DataTypes.STRING },
        bank_ifsc_code: { type: DataTypes.STRING },
        name_as_per_bank: { type: DataTypes.STRING },
        account_type: { type: DataTypes.SMALLINT, comment: "1: Savings, 2: Current, 3: Others" },
        bank_proof_doc: { type: DataTypes.STRING },

        // 6. STATUTORY & IDENTITIES
        previous_pf_number: { type: DataTypes.STRING },
        uan_number: { type: DataTypes.STRING },

        // PAN
        pan_number: { type: DataTypes.STRING },
        name_in_pan: { type: DataTypes.STRING },
        pan_doc: { type: DataTypes.STRING },

        // Aadhaar
        aadhaar_number: { type: DataTypes.STRING },
        name_in_aadhaar: { type: DataTypes.STRING },
        aadhaar_doc: { type: DataTypes.STRING },

        // PRAN
        pran_number: { type: DataTypes.STRING },
        name_in_pran: { type: DataTypes.STRING },

        // Passport
        passport_number: { type: DataTypes.STRING },
        name_in_passport: { type: DataTypes.STRING },
        passport_expiry_date: { type: DataTypes.DATEONLY },
        passport_doc: { type: DataTypes.STRING },

        // 7. EDUCATION DETAILS
        // Stores array of: { qualification, institute, from_date, to_date, grade, remarks }
        education_details: {
            type: DataTypes.JSONB,
            defaultValue: []
        },
        status: {
            type: DataTypes.SMALLINT,
            defaultValue: 0,
            comment: "0: Active, 1: Inactive, 2: Deleted"
        },
        user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        company_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    }, {
        tableName: 'employees',
        timestamps: true,
        underscored: true // Ensures snake_case for created_at, updated_at
    });

    Employee.associate = function (models) {
        Employee.belongsTo(models.User, { foreignKey: "user_id", as: "created_by" });
    };

    return Employee;
};