const crypto = require('crypto');
const { Employee, DesignationMaster, Department, sequelize, CompanyMaster, CustomField, StateMaster, CountryMaster } = require("../../models");
const { constants, handleError, commonQuery, Op, v4: uuidv4, whatsappService, uploadFile, writeLogToFile } = require("../../helpers");
const { generateCustomFieldImageUrls, handleCustomFieldImages, handleDetailAttachments } = require("../../helpers/customFieldImageHandler");
const { MODULES } = require("../../helpers/moduleEntitiesConstants");
const emailService = require("../../services/emailService");

const FILE_COLUMNS = [
    'aadhaar_doc', 'aadhaar_back_doc', 'pan_doc', 'bank_proof_doc', 'driving_license_doc', 'voter_id_doc', 'uan_doc', 'signature_doc'
];

/**
 * Helper: Parse JSON fields from Multipart/Form-Data
 */
const parseJsonFields = (body) => {
    const fieldsToParse = ["custom_fields", "education_details", "family_details", "experience_details", "professional_reference"];

    fieldsToParse.forEach((field) => {
        if (body[field] && typeof body[field] === "string") {
            try {
                body[field] = JSON.parse(body[field]);
            } catch (error) {
                console.error(`Error parsing JSON for field ${field}:`, error);
                body[field] = [];
            }
        }
    });
};


/**
 * Initiate onboarding for a new candidate
 */
exports.initiate = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { first_name, email, mobile_no, joining_date, department_id, designation_id, employee_type, worker_type } = req.body;
        const companyId = req.user.company_id;

        // Validation
        if (!first_name || !email || !mobile_no) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, { message: "Required fields missing" });
        }

        // Check if email or mobile already exists
        const existing = await Employee.findOne({
            where: {
                [Op.or]: [{ email }, { mobile_no }],
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
            {
                include: [
                    { model: DesignationMaster, as: 'designation', attributes: ['designation_name'] },
                    { model: Department, as: 'department', attributes: ['name'] },
                    { model: CompanyMaster, as: 'company', attributes: ['company_name'] }
                ]
            },
            null,
            true,
            {}
        );

        if (!employee) {
            return res.error(constants.NOT_FOUND, { message: "Invalid or expired onboarding link" });
        }

        const company_id = employee.company_id;
        const branch_id = employee.branch_id;

        // Check if onboarding is already completed
        if (employee.onboarding_status === 3) {
            return res.error(constants.ONBOARDING_ALREADY_COMPLETED, { message: "Onboarding already completed" });
        }

        // Token Validity Check (24 Hours expiry)
        const twentyFourHoursAgo = new Date(Date.now() - (24 * 60 * 60 * 1000));
        if (new Date(employee.created_at) < twentyFourHoursAgo) {
            return res.error(constants.NOT_FOUND, { message: "The onboarding link has expired. Please contact HR for a new one." });
        }

        const baseUrl = process.env.IMG_URL || `${req.protocol}://${req.get('host')}/`;
        const FILE_COLUMNS = ['aadhaar_doc', 'aadhaar_back_doc', 'pan_doc', 'bank_proof_doc', 'driving_license_doc', 'voter_id_doc', 'uan_doc', 'signature_doc'];

        FILE_COLUMNS.forEach(col => {
            if (employee[col] && !employee[col].startsWith('http')) {
                employee[col] = `${process.env.FILE_SERVER_URL}${constants.EMPLOYEE_DOC_FOLDER}${employee[col].replace(/^\/+/, '')}`;
            }
        });

        // Process experience_details to add full attachment URLs
        if (employee.experience_details && Array.isArray(employee.experience_details)) {
            employee.experience_details = employee.experience_details.map(detail => {
                const updatedDetail = { ...detail };
                if (updatedDetail.attachments && Array.isArray(updatedDetail.attachments)) {
                    updatedDetail.attachments = updatedDetail.attachments.map(attachment => {
                        if (attachment && !attachment.startsWith('http')) {
                            return `${process.env.FILE_SERVER_URL}${constants.EMPLOYEE_DOC_FOLDER}${attachment.replace(/^\/+/, '')}`;
                        }
                        return attachment;
                    });
                }
                return updatedDetail;
            });
        }

        const customFields = await CustomField.findAll({
            where: {
                entity_id: MODULES.EMPLOYEE.ID,
                company_id: company_id,
                branch_id: branch_id,
                status: 0
            },
            attributes: ['id', 'field_label', 'field_name', 'field_type', 'is_mandatory', 'is_readonly', 'default_value', 'placeholder', 'options', 'validation_regex', 'priority', 'description', "branch_id", "company_id"],
            order: [['priority', 'ASC'], ['id', 'ASC']]
        });

        // Process custom fields to add URL for image type default_values
        const processedCustomFields = customFields.map(field => {
            const fieldData = field.toJSON();
            
            // If field type is image and has default_value, add URL and folder
            if (fieldData.field_type === 'image' && fieldData.default_value) {
                if (!fieldData.default_value.startsWith('http')) {
                    fieldData.default_value = {
                        url: `${process.env.FILE_SERVER_URL}${constants.CUSTOM_FIELD_IMG_FOLDER}${fieldData.default_value.replace(/^\/+/, '')}`,
                        folder: constants.CUSTOM_FIELD_IMG_FOLDER,
                        filename: fieldData.default_value
                    };
                }
            }
            
            return fieldData;
        });

        // Add custom fields to response
        const employeeData = employee.toJSON();

        // 1. Process employee's own custom_fields data (JSONB)
        if (employeeData.custom_fields && Array.isArray(employeeData.custom_fields)) {
            employeeData.custom_fields = generateCustomFieldImageUrls(
                employeeData.custom_fields,
                constants.CUSTOM_FIELD_IMG_FOLDER
            );
        }

        // 2. Prepare the final response with separate keys for data and definitions
        const response = {
            ...employeeData,
            custom_field_definitions: processedCustomFields
        };


        return res.ok(response);
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
        parseJsonFields(req.body);
        const data = req.body;


        const employee = await commonQuery.findOneRecord(
            Employee,
            {
                onboarding_token: token,
                status: 3
            },
            {},
            transaction
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
            'aadhaar_doc', 'aadhaar_back_doc', 'pan_doc', 'bank_proof_doc', 'driving_license_doc', 'voter_id_doc', 'signature_doc', 'uan_doc',
            "custom_fields", "education_details", "family_details", "experience_details", "professional_reference"
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

            // Handle experience_details attachments from savedFiles
            if (Array.isArray(updateData.experience_details)) {
                updateData.experience_details = updateData.experience_details.map((detail, detailIndex) => {
                    const updatedDetail = { ...detail };
                    if (updatedDetail.attachments && Array.isArray(updatedDetail.attachments)) {
                        updatedDetail.attachments = updatedDetail.attachments.map(attachmentKey => {
                            if (savedFiles[attachmentKey]) {
                                console.log(`Found saved file for ${attachmentKey}: ${savedFiles[attachmentKey]}`);
                                return savedFiles[attachmentKey];
                            }
                            return attachmentKey;
                        }).filter(a => a !== null);
                    }
                    return updatedDetail;
                });
            }
        }

        if (data.is_final_submission) {
            updateData.onboarding_status = 1;
        }

        // Prepare all files array for detail attachments
        const allFilesArray = [];
        if (req.files) {
            if (Array.isArray(req.files)) {
                allFilesArray.push(...req.files);
            } else {
                Object.values(req.files).forEach(v => {
                    if (Array.isArray(v)) allFilesArray.push(...v);
                    else allFilesArray.push(v);
                });
            }
        }

        // Handle custom field images (they may consume uploaded files)
        if (Array.isArray(updateData.custom_fields)) {
            writeLogToFile("onboarding_debug.log", `[OnboardingSubmit] Custom fields before handling: ${JSON.stringify(updateData.custom_fields)}`);
            writeLogToFile("onboarding_debug.log", `[OnboardingSubmit] All files available for custom fields: ${allFilesArray.map(f => f.fieldname).join(", ")}`);
            updateData.custom_fields = await handleCustomFieldImages(
                req,
                res,
                updateData.custom_fields,
                allFilesArray,
                constants.CUSTOM_FIELD_IMG_FOLDER,
                transaction,
                employee
            );
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
        
        if (employee.onboarding_status === 2) {
            await emailService.sendOnboardingRejection(employee.email, employee.first_name, employee.reject_note, onboardingLink, companyId);
        } else {
            await emailService.sendOnboardingInvite(employee.email, employee.first_name, onboardingLink, companyId);
        }

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

        let employee = await commonQuery.findOneRecord(
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

        const customFieldDefinitions = await commonQuery.findAllRecords(
            CustomField,
            {
                entity_id: MODULES.EMPLOYEE.ID,
                status: 0
            },
            {
                attributes: ['id', 'field_label', 'field_name', 'field_type', 'is_mandatory', 'is_readonly', 'default_value', 'placeholder', 'options', 'validation_regex', 'priority', 'description']
            }
        );

        if (!employee) {
            return res.error(constants.NOT_FOUND, { message: "Onboarding record not found" });
        }

        const FILE_COLUMNS = ['aadhaar_doc', 'aadhaar_back_doc', 'pan_doc', 'bank_proof_doc', 'driving_license_doc', 'voter_id_doc', 'uan_doc', 'signature_doc'];

        if (employee.get) {
            employee = employee.get({ plain: true });
        }

        FILE_COLUMNS.forEach(col => {
            if (employee[col] && !employee[col].startsWith('http')) {
                employee[col] = `${process.env.FILE_SERVER_URL}${constants.EMPLOYEE_DOC_FOLDER}${employee[col].replace(/^\/+/, '')}`;
            }
        });

        // Process custom fields to add full image URLs
        if (employee.custom_fields && Array.isArray(employee.custom_fields)) {
            employee.custom_fields = generateCustomFieldImageUrls(employee.custom_fields, constants.CUSTOM_FIELD_IMG_FOLDER);
        }

        // Process experience_details to add full attachment URLs
        if (employee.experience_details && Array.isArray(employee.experience_details)) {
            employee.experience_details = employee.experience_details.map(detail => {
                const updatedDetail = { ...detail };
                if (updatedDetail.attachments && Array.isArray(updatedDetail.attachments)) {
                    updatedDetail.attachments = updatedDetail.attachments.map(attachment => {
                        if (attachment && !attachment.startsWith('http')) {
                            return `${process.env.FILE_SERVER_URL}${constants.EMPLOYEE_DOC_FOLDER}${attachment.replace(/^\/+/, '')}`;
                        }
                        return attachment;
                    });
                }
                return updatedDetail;
            });
        }

        // Fetch state and country names for permanent address
        if (employee.permanent_state_id) {
            const permanentState = await StateMaster.findOne({
                where: { id: employee.permanent_state_id },
                attributes: ['state_name']
            });
            employee.permanent_state_name = permanentState ? permanentState.state_name : null;
        }

        if (employee.permanent_country_id) {
            const permanentCountry = await CountryMaster.findOne({
                where: { id: employee.permanent_country_id },
                attributes: ['country_name']
            });
            employee.permanent_country_name = permanentCountry ? permanentCountry.country_name : null;
        }

        // Fetch state and country names for present address
        if (employee.present_state_id) {
            const presentState = await StateMaster.findOne({
                where: { id: employee.present_state_id },
                attributes: ['state_name']
            });
            employee.present_state_name = presentState ? presentState.state_name : null;
        }

        if (employee.present_country_id) {
            const presentCountry = await CountryMaster.findOne({
                where: { id: employee.present_country_id },
                attributes: ['country_name']
            });
            employee.present_country_name = presentCountry ? presentCountry.country_name : null;
        }

        const response = {
            employee,
            custom_field_definitions: customFieldDefinitions
        };

        return res.ok(response);
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
