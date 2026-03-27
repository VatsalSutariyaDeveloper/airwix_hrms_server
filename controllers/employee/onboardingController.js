const { Employee, User, DesignationMaster, Department, sequelize, CompanyMaster } = require("../../models");
const { constants, handleError, commonQuery, Op, v4: uuidv4, whatsappService } = require("../../helpers");
const { uploadFile } = require("../../helpers/fileUpload");
const crypto = require("crypto");
const emailService = require("../../services/emailService");

// Document field constants for onboarding
const FILE_COLUMNS = [
    'aadhaar_doc', 'pan_doc', 'bank_proof_doc', 'driving_license_doc', 'voter_id_doc', 'uan_doc'
];

/**
 * Initiate onboarding for a new candidate
 */
exports.initiate = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { first_name, email, mobile_no, joining_date, department_id, designation_id, employee_type, worker_type } = req.body;
        const companyId = req.user.company_id;

        // Validation
        if (!first_name || !email || !mobile_no || !joining_date) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, { message: "Required fields missing" });
        }

        // Check if email or mobile already exists
        const existing = await Employee.findOne({
            where: {
                [Op.or]: [{ email }, { mobile_no }],
                company_id: companyId,
                status: {
                    [Op.ne]: 2
                }
            },
            transaction
        });

        if (existing) {
            await transaction.rollback();
            return res.error(constants.ALREADY_EXISTS, { message: "Employee with this email or mobile already exists" });
        }

        // Generate a unique token
        const onboarding_token = crypto.randomBytes(32).toString('hex');

        // Create Employee record in Onboarding status (3)
        const employee = await commonQuery.createRecord(Employee, {
            first_name,
            email,
            mobile_no,
            joining_date,
            department_id,
            designation_id,
            employee_type: employee_type || 1,
            worker_type: worker_type || null,
            status: 3, // Onboarding
            onboarding_token,
            onboarding_step: 1,
            company_id: companyId
        }, transaction);

        // Send Email/WhatsApp with the link
        const onboardingLink = `${process.env.FRONTEND_URL}onboarding/form/${onboarding_token}`;
        await emailService.sendOnboardingInvite(email, first_name, onboardingLink, companyId);
        
        // Also send on WhatsApp
        if (mobile_no) {
            await whatsappService.sendOnboardingInvite(mobile_no, first_name, onboardingLink);
        }

        await transaction.commit();
        return res.success("Onboarding initiated successfully", { employee_id: employee.id, onboarding_token });
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

/**
 * Get onboarding details for the candidate (Public API via token)
 */
exports.getDetailsByToken = async (req, res) => {
    try {
        const { token } = req.params;

        const employee = await commonQuery.findOneRecord(
            Employee,
            {
                onboarding_token: token, 
                status: 3
            },
            {include: [
                { model: DesignationMaster, as: 'designation', attributes: ['designation_name'] },
                { model: Department, as: 'department', attributes: ['name'] },
                { model: CompanyMaster, as: 'company', attributes: ['company_name'] }
            ]},
            null,
            true,
            {}
        );

        if (!employee) {
            return res.error(constants.NOT_FOUND, { message: "Invalid or expired onboarding link" });
        }

        // Check if onboarding is already completed
        if (employee.onboarding_status === 3) {
            return res.error(constants.ONBOARDING_ALREADY_COMPLETED, { message: "Onboarding already completed" });
        }

        // Token Validity Check (24 Hours expiry)
        const twentyFourHoursAgo = new Date(Date.now() - (24 * 60 * 60 * 1000));
        if (new Date(employee.created_at) < twentyFourHoursAgo) {
            return res.error(constants.NOT_FOUND, { message: "The onboarding link has expired. Please contact HR for a new one." });
        }

        return res.ok(employee);
    } catch (err) {
        return handleError(err, res, req);
    }
};

/**
 * Submit onboarding details by candidate
 */
exports.submitDetails = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { token } = req.params;
        const data = req.body;

        const employee = await commonQuery.findOneRecord(
            Employee,
            {
                onboarding_token: token,
                status: 3
            },
            [],
            transaction,
            false,
            {}
        );

        if (!employee) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND, { message: "Onboarding record not found" });
        }

        // Update employee record with candidate-filled data
        // Fields allowed to be updated by candidate:
        const candidateFields = [
            'gender', 'dob', 'marital_status', 'blood_group', 'physically_challenged',
            'emergency_contact_mobile', 'father_name', 'mother_name', 'spouse_name',
            'same_as_current',
            'present_address1', 'present_address2', 'present_city', 'present_state_id', 'present_country_id', 'present_pincode',
            'permanent_address1', 'permanent_address2', 'permanent_city', 'permanent_state_id', 'permanent_country_id', 'permanent_pincode',
            'bank_name', 'bank_ifsc_code', 'bank_account_number', 'bank_account_holder_name', 'upi_id', 'name_as_per_bank',
            'uan_number', 'pan_number', 'aadhaar_number', 'name_as_per_aadhaar', 'name_as_per_pan',
            'aadhaar_doc', 'pan_doc', 'bank_proof_doc', 'driving_license_doc', 'voter_id_doc', 'uan_doc'
        ];

        const updateData = {};
        candidateFields.forEach(field => {
            if (data[field] !== undefined) {
                updateData[field] = data[field];
            }
        });

        if (req.files && Object.keys(req.files).length > 0) {
            console.log("Files received:", Object.keys(req.files));
            const savedFiles = await uploadFile(req, res, constants.EMPLOYEE_DOC_FOLDER, transaction);
            console.log("Saved files:", savedFiles);

            FILE_COLUMNS.forEach(col => {
                if (savedFiles[col]) {
                    updateData[col] = savedFiles[col];
                    console.log(`Updating ${col} with filename: ${savedFiles[col]}`);
                }
            });
        }
        
        if (data.is_final_submission) {
            updateData.onboarding_status = 1;
        }

        await commonQuery.updateRecordById(Employee, { id: employee.id }, updateData, transaction, false, {});

        await transaction.commit();
        return res.success("Details saved successfully");
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

/**
 * Approve onboarding and activate employee (HR Side)
 */
exports.approve = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.params;
        const { employee_code, ...templateData } = req.body;
        const companyId = req.user.company_id;

        const employee = await commonQuery.findOneRecord(
            Employee,
            {
                id,
                status: 3
            },
            {
                include: [
                    { model: DesignationMaster, as: 'designation', attributes: ['designation_name'] },
                    { model: Department, as: 'department', attributes: ['name'] }
                ]
            },
            transaction,
            false
        );

        if (!employee) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND, { message: "Onboarding record not found" });
        }

        if (!employee_code) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, { message: "Employee Code is required for activation" });
        }

        // Update employee to Active status and assign code/templates
        await commonQuery.updateRecordById(
            Employee,
            { id: employee.id },
            {
                status: 0,
                employee_code,
                onboarding_status: 3,
                onboarding_token: null,
                ...templateData
            },
            transaction,
            false
        );

        // Send approval email with department and designation names
        const departmentName = employee.department?.name || 'N/A';
        const designationName = employee.designation?.designation_name || 'N/A';
        
        await emailService.sendOnboardingApproval(
            employee.email,
            employee.first_name,
            employee_code,
            departmentName,
            designationName,
            employee.joining_date,
            companyId
        );

        // TODO: Sync templates and create User if necessary
        // await EmployeeTemplateService.syncAllTemplates(employee.id, transaction);

        await transaction.commit();
        return res.success("Employee onboarding approved and activated successfully");
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

/**
 * Reject onboarding and generate new token for resubmission (HR Side)
 */
exports.reject = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.params;
        const { reject_note } = req.body;
        const companyId = req.user.company_id;

        if (!reject_note) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, { message: "Reject note is required" });
        }

        const employee = await commonQuery.findOneRecord(
            Employee,
            {
                id,
                status: 3
            },
            {},
            transaction,
            false
        );

        if (!employee) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND, { message: "Onboarding record not found" });
        }

        // Generate new token for resubmission
        const onboarding_token = crypto.randomBytes(32).toString('hex');

        // Update employee to Rejected status with new token
        await commonQuery.updateRecordById(
            Employee,
            { id: employee.id },
            {
                onboarding_status: 2,
                reject_note,
                onboarding_token,
            },
            transaction,
            false
        );

        // Send Email/WhatsApp with the new link
        const onboardingLink = `${process.env.FRONTEND_URL}onboarding/form/${onboarding_token}`;
        await emailService.sendOnboardingRejection(employee.email, employee.first_name, reject_note, onboardingLink, companyId);
        
        // Also send on WhatsApp
        if (employee.mobile_no) {
            await whatsappService.sendOnboardingInvite(employee.mobile_no, employee.first_name, onboardingLink);
        }

        await transaction.commit();
        return res.success("Employee onboarding rejected and new invitation sent successfully");
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

/**
 * Resend onboarding token with new link (HR Side)
 */
exports.resendToken = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.params;
        const companyId = req.user.company_id;

        const employee = await commonQuery.findOneRecord(
            Employee,
            {
                id,
                status: 3
            },
            {},
            transaction,
            false
        );

        if (!employee) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND, { message: "Onboarding record not found" });
        }

        // Generate new token
        const onboarding_token = crypto.randomBytes(32).toString('hex');

        // Update only the onboarding_token
        await commonQuery.updateRecordById(
            Employee,
            { id: employee.id },
            {
                onboarding_token
            },
            transaction,
            false
        );

        // Send Email/WhatsApp with the new link
        const onboardingLink = `${process.env.FRONTEND_URL}onboarding/form/${onboarding_token}`;
        await emailService.sendOnboardingInvite(employee.email, employee.first_name, onboardingLink, companyId);
        
        // Also send on WhatsApp
        if (employee.mobile_no) {
            await whatsappService.sendOnboardingInvite(employee.mobile_no, employee.first_name, onboardingLink);
        }

        await transaction.commit();
        return res.success("New onboarding token sent successfully");
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

/**
 * List pending onboardings (HR Side)
 */
exports.getPendingList = async (req, res) => {
    try {
        const POST = req.body;
        const fieldConfig = [
            ["first_name", true, true],
            ["email", true, true],
            ["mobile_no", true, false],
        ];

        const data = await commonQuery.fetchPaginatedData(
            Employee,
            POST,
            fieldConfig,
            {
                where: { status: 3 },
                include: [
                    { model: DesignationMaster, as: 'designation', attributes: ['designation_name'] },
                    { model: Department, as: 'department', attributes: ['name'] }
                ],
                attributes: ["id", "first_name", "email", "mobile_no", "joining_date", "onboarding_step", "onboarding_status", "created_at"]
            }
        );

        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};

/**
 * Get detailed onboarding record by ID (HR Side)
 */
exports.getOnboardingById = async (req, res) => {
    try {
        const { id } = req.params;

        const employee = await commonQuery.findOneRecord(
            Employee,
            {
                id,
                status: 3
            },
            {
                include: [
                    { model: DesignationMaster, as: 'designation', attributes: ['designation_name'] },
                    { model: Department, as: 'department', attributes: ['name'] }
                ]
            }
        );

        if (!employee) {
            return res.error(constants.NOT_FOUND, { message: "Onboarding record not found" });
        }

        return res.ok(employee);
    } catch (err) {
        return handleError(err, res, req);
    }
};

/**
 * Resend onboarding invite email
 */
exports.resendInvite = async (req, res) => {
    try {
        const { id } = req.body;
        const companyId = req.user.company_id;

        const employee = await commonQuery.findOneRecord(
            Employee,
            {
                id,
                status: 3
            },
            {},
            null,
            false
        );

        if (!employee) {
            return res.error(constants.NOT_FOUND, { message: "Onboarding record not found" });
        }

        const onboardingLink = `${process.env.FRONTEND_URL}onboarding/form/${employee.onboarding_token}`;
        await emailService.sendOnboardingInvite(employee.email, employee.first_name, onboardingLink, companyId);

        // Also resend on WhatsApp
        if (employee.mobile_no) {
            await whatsappService.sendOnboardingInvite(employee.mobile_no, employee.first_name, onboardingLink);
        }

        return res.success("Invitation resent successfully");
    } catch (err) {
        return handleError(err, res, req);
    }
};
