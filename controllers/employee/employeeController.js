const {
    Employee,
    EmployeeFamilyMember,
    User,
    ModuleEntityMaster,
    ApprovalRequest,
    StateMaster,     // Assuming you have these for Address includes
    CountryMaster,
    UserCompanyRoles,
    CompanyConfigration,
    RolePermission
} = require("../../models");

const {
    validateRequest,
    commonQuery,
    handleError,
    uploadFile,
    deleteFile,
    sequelize,
    constants,
    Op,
    fileExists
} = require("../../helpers");

const {
    generateSeriesNumber,
    updateSeriesNumber,
    fixDecimals
} = require("../../helpers/functions/commonFunctions");

const { ENTITIES } = require('../../helpers/constants');
const ApprovalEngine = require("../../helpers/approvalEngine");
const { MODULES } = require("../../helpers/moduleEntitiesConstants");
const bcrypt = require("bcrypt");
const { getContext } = require("../../utils/requestContext");

const STATUS = {
    ACTIVE: 0,
    INACTIVE: 1,
    DELETED: 2,
    PENDING_APPROVAL: 4
};

// Helper: Parse JSON fields from Multipart/Form-Data
const parseJsonFields = (body) => {
    // 'education_details' is a column in Employee (JSONB)
    // 'family_details' is NOT a column, but we send it as JSON to process into FamilyMember table
    const fieldsToParse = ["education_details", "family_details"];

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
 * Creates a new Employee and their Family Members.
 */
exports.create = async (req, res) => {
    const transaction = await sequelize.transaction();

    try {
        parseJsonFields(req.body);
        const ctx = getContext();
        const POST = req.body;

        // Validate Required Fields
        const requiredFields = {
            series_id: "Series",
            first_name: "First Name", // Assuming 'first_name' is mapped to 'father_name' or you add a name field
            email: "Personal Email",
            joining_date: "Joining Date",
            mobile_no: "Mobile Number"
        };

        const errors = await validateRequest(POST, requiredFields, {
            uniqueCheck: {
                model: Employee,
                fields: ["email", "mobile_no"],
            },
            customFieldConfig: {
                // entity_id: ENTITIES.EMPLOYEE.ID,
            }
        }, transaction);

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        // 1. Handle File Uploads
        // We map the uploaded file keys to the database column names
        if (req.files && req.files.length > 0) {
            const savedFiles = await uploadFile(req, res, constants.ATTACHMENT_FOLDER, transaction);

            const fileColumns = [
                'permanent_address_proof_doc',
                'present_address_proof_doc',
                'bank_proof_doc',
                'pan_doc',
                'aadhaar_doc',
                'pan_doc',
                'aadhaar_doc',
                'passport_doc',
                'profile_image' // Added profile_image
            ];

            fileColumns.forEach(col => {
                if (savedFiles[col]) {
                    POST[col] = savedFiles[col];
                }
            });
        }

        // 2. Generate Employee Code
        POST.employee_code = await generateSeriesNumber(POST.series_id, transaction, Employee, "employee_code");

        // 3. Create Employee Record
        const employee = await commonQuery.createRecord(Employee, POST, transaction);

        if (!employee) {
            await transaction.rollback();
            return res.error(constants.DATABASE_ERROR, { errors: constants.FAILED_TO_CREATE_RECORD });
        }

        // 4. Update Series
        await updateSeriesNumber(POST.series_id, transaction);

        // 5. Create Family Members (Bulk Create)
        if (Array.isArray(POST.family_details) && POST.family_details.length > 0) {
            const familyData = POST.family_details.map(member => ({
                ...member,
                employee_id: employee.id,
                status: STATUS.ACTIVE
            }));

            await commonQuery.bulkCreate(EmployeeFamilyMember, familyData, {}, transaction);
        }

        // ------------------------------------------------------------------
        // 🚀 APPROVAL INTEGRATION
        // ------------------------------------------------------------------
        const workflow = await ApprovalEngine.checkApprovalRequired(
            MODULES.HR.EMPLOYEE.ID,
            employee.toJSON()
        );

        let approvalMsg = constants.EMPLOYEE_CREATED;

        if (workflow) {
            await ApprovalEngine.initiateApproval(
                MODULES.HR.EMPLOYEE.ID,
                employee.id,
                workflow.id,
                transaction
            );

            // We assume 'approval_status' exists on Employee or is handled via mixin
            await commonQuery.updateRecordById(Employee, employee.id, { approval_status: STATUS.PENDING_APPROVAL }, transaction, true)
            approvalMsg = constants.EMPLOYEE_CREATED_SEND_FOR_APPROVAL;
        }

        // 6. Create User Account if requested OR if role is allowed in Company Configuration
        const companyConfig = await commonQuery.findOneRecord(CompanyConfigration, {
            setting_key: 'app_access_roles',
            status: 0
        }, {}, transaction);

        let rolesNeedingUser = [];
        if (companyConfig && companyConfig.setting_value) {
            try {
                // Expecting JSON array or comma-separated string
                rolesNeedingUser = typeof companyConfig.setting_value === 'string' 
                    ? JSON.parse(companyConfig.setting_value) 
                    : companyConfig.setting_value;
                if (!Array.isArray(rolesNeedingUser)) {
                    rolesNeedingUser = companyConfig.setting_value.split(',').map(id => parseInt(id.trim()));
                }
            } catch (e) {
                rolesNeedingUser = companyConfig.setting_value.split(',').map(id => parseInt(id.trim()));
            }
        }
        
        const isAppAccessRole = rolesNeedingUser.includes(parseInt(POST.role_id));
        if (isAppAccessRole) {
            // Validation for user fields
            const userRequiredFields = { role_id: "Role" };

            const loginType = parseInt(POST.login_type) || 1;
            if (loginType === 1) {
                userRequiredFields.mobile_no = "Mobile No";
            } else if (loginType === 2) {
                userRequiredFields.email = "Email";
                userRequiredFields.password = "Password";
            }

            const userErrors = await validateRequest(POST, userRequiredFields, {}, transaction);
            if (userErrors) {
                await transaction.rollback();
                return res.error(constants.VALIDATION_ERROR, userErrors);
            }

            // Get permissions from role
            const rolePermission = await commonQuery.findOneRecord(
                RolePermission,
                POST.role_id,
                {},
                transaction
            );

            const userData = {
                ...POST,
                user_name: POST.first_name,
                comapny_access: ctx.companyId,
                employee_id: employee.id,
                status: 0
            };

            if (POST.password) {
                const salt = await bcrypt.genSalt(10);
                userData.password = await bcrypt.hash(POST.password, salt);
            }

            const newUser = await commonQuery.createRecord(User, userData, transaction);

            await commonQuery.createRecord(UserCompanyRoles, {
                user_id: newUser.id,
                role_id: POST.role_id,
                permissions: rolePermission ? rolePermission.permissions : null,
                status: 0
            }, transaction);
        }

        await transaction.commit();
        return res.success(approvalMsg, employee.id);

    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

/**
 * Updates an existing Employee and syncs Family Members.
 */
exports.update = async (req, res) => {
    const transaction = await sequelize.transaction();

    try {
        parseJsonFields(req.body);

        const ctx = getContext();
        const { id } = req.params;
        const POST = req.body;

        // Validation
        const requiredFields = {
            email: "Personal Email"
        };

        const errors = await validateRequest(POST, requiredFields, {
            uniqueCheck: {
                model: Employee,
                fields: ["email", "mobile_no"],
                excludeId: id
            },
            customFieldConfig: {
                // entity_id: ENTITIES.EMPLOYEE.ID,
            }
        }, transaction);

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, { errors });
        }

        // Fetch existing data to handle file deletion
        const existingEmployee = await commonQuery.findOneRecord(Employee, id, {}, transaction);

        if (!existingEmployee) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        // 1. Handle File Uploads & Cleanup
        if (req.files && req.files.length > 0) {
            const savedFiles = await uploadFile(req, res, constants.ATTACHMENT_FOLDER, transaction);

            const fileColumns = [
                'permanent_address_proof_doc',
                'present_address_proof_doc',
                'bank_proof_doc',
                'pan_doc',
                'aadhaar_doc',
                'aadhaar_doc',
                'passport_doc',
                'profile_image'
            ];

            for (const col of fileColumns) {
                // If new file uploaded for this column
                if (savedFiles[col]) {
                    // Delete old file from disk if it exists
                    if (existingEmployee[col]) {
                        await deleteFile(req, res, constants.ATTACHMENT_FOLDER, existingEmployee[col]);
                    }
                    // Assign new filename to POST data
                    POST[col] = savedFiles[col];
                }
            }
        }

        // 2. Update Employee Record
        // Note: 'education_details' is in POST and will be updated automatically as it's a JSONB column
        const updatedEmployee = await commonQuery.updateRecordById(Employee, id, POST, transaction);

        // 3. Sync Family Members
        const incomingFamily = POST.family_details || [];
        const incomingIds = incomingFamily.map((d) => d.id).filter(Boolean);

        // A. Soft Delete removed members
        // Find members currently in DB but NOT in incoming IDs
        await commonQuery.softDeleteById(
            EmployeeFamilyMember,
            {
                employee_id: id,
                id: { [Op.notIn]: incomingIds }
            },
            null,
            transaction
        );

        // B. Update or Create members
        for (const member of incomingFamily) {
            const memberPayload = {
                ...member,
                employee_id: id
            };

            if (member.id) {
                await commonQuery.updateRecordById(EmployeeFamilyMember, member.id, memberPayload, transaction);
            } else {
                await commonQuery.createRecord(EmployeeFamilyMember, memberPayload, transaction);
            }
        }

        // ------------------------------------------------------------------
        // 🚀 RE-APPROVAL LOGIC
        // ------------------------------------------------------------------

        // Cancel any existing PENDING requests
        await ApprovalRequest.update(
            { status: 'CANCELLED' },
            {
                where: {
                    entity_id: id,
                    module_entity_id: MODULES.HR.EMPLOYEE.ID,
                    status: 'PENDING'
                },
                transaction
            }
        );

        // Check Approval Again
        const workflow = await ApprovalEngine.checkApprovalRequired(
            MODULES.HR.EMPLOYEE.ID,
            updatedEmployee.toJSON()
        );

        if (workflow) {
            await ApprovalEngine.initiateApproval(
                MODULES.HR.EMPLOYEE.ID,
                id,
                workflow.id,
                transaction
            );

            await commonQuery.updateRecordById(Employee, id, { approval_status: STATUS.PENDING_APPROVAL }, transaction);
        } else {
            await commonQuery.updateRecordById(Employee, id, { approval_status: STATUS.ACTIVE }, transaction);
        }

        // 4. Create/Update User Account if requested OR if role is allowed in Company Configuration
        const companyConfig = await commonQuery.findOneRecord(CompanyConfigration, {
            setting_key: 'app_access_roles',
            status: 0
        }, {}, transaction);

        let rolesNeedingUser = [];
        if (companyConfig && companyConfig.setting_value) {
            try {
                rolesNeedingUser = typeof companyConfig.setting_value === 'string' 
                    ? JSON.parse(companyConfig.setting_value) 
                    : companyConfig.setting_value;
                if (!Array.isArray(rolesNeedingUser)) {
                    rolesNeedingUser = companyConfig.setting_value.split(',').map(id => parseInt(id.trim()));
                }
            } catch (e) {
                rolesNeedingUser = companyConfig.setting_value.split(',').map(id => parseInt(id.trim()));
            }
        }

        const isAppAccessRole = rolesNeedingUser.includes(parseInt(POST.role_id));

        if (isAppAccessRole) {
            const loginType = parseInt(POST.login_type) || 1;

            // Check if user already exists for this employee
            let existingUser = await commonQuery.findOneRecord(User, { employee_id: id }, {}, transaction);

            const userData = {
                ...POST,
                user_name: POST.first_name,
                comapny_access: ctx.companyId,
                employee_id: id,
                status: 0
            };

            if (POST.role_id) {
                const rolePermission = await commonQuery.findOneRecord(
                    RolePermission,
                    POST.role_id,
                    {},
                    transaction
                );
                userData.permission = rolePermission ? rolePermission.permissions : null;
            }

            if (POST.password) {
                const salt = await bcrypt.genSalt(10);
                userData.password = await bcrypt.hash(POST.password, salt);
            }

            if (existingUser) {
                await commonQuery.updateRecordById(User, existingUser.id, userData, transaction);

                // Update UserCompanyRoles if role changed
                if (POST.role_id) {
                    await UserCompanyRoles.update(
                        { role_id: POST.role_id, permissions: userData.permission },
                        { where: { user_id: existingUser.id }, transaction }
                    );
                }
            } else {
                // Validation for new user
                const userRequiredFields = { role_id: "Role" };
                if (loginType === 1) userRequiredFields.mobile_no = "Mobile No";
                else if (loginType === 2) {
                    userRequiredFields.email = "Email";
                    userRequiredFields.password = "Password";
                }

                const userErrors = await validateRequest(POST, userRequiredFields, {}, transaction);
                if (userErrors) {
                    await transaction.rollback();
                    return res.error(constants.VALIDATION_ERROR, userErrors);
                }

                const newUser = await commonQuery.createRecord(User, userData, transaction);
                await commonQuery.createRecord(UserCompanyRoles, {
                    user_id: newUser.id,
                    role_id: POST.role_id,
                    permissions: userData.permission,
                    status: 0
                }, transaction);
            }
        } else {
            await commonQuery.softDeleteById(User, { employee_id: id }, transaction);
        }

        await transaction.commit();
        return res.success(constants.EMPLOYEE_UPDATED, updatedEmployee.id);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

/**
 * Gets a single Employee by ID with all relations and File URLs.
 */
exports.getById = async (req, res) => {
    try {
        const { id } = req.params;

        const dynamicIncludes = [
            {
                model: EmployeeFamilyMember,
                as: 'family_members', // Ensure this alias matches your models/index.js association
                where: { status: { [Op.in]: [0, 1] } }, // Active or Inactive, not Deleted
                required: false
            },
            {
                model: User,
                as: 'linked_user',
                attributes: ['id', 'user_name', 'email', 'mobile_no', 'role_id'],
                required: false
            },
            // If you have State/Country relations for addresses, include them here:
            // { model: StateMaster, as: 'permanent_state', attributes: ['state_name'] },
            // { model: CountryMaster, as: 'permanent_country', attributes: ['country_name'] },
        ];

        const record = await commonQuery.findOneRecord(Employee, id, { include: dynamicIncludes });

        if (!record || record.status === STATUS.DELETED) return res.error(constants.EMPLOYEE_NOT_FOUND);

        const plainRecord = record.get({ plain: true });

        // 1. Generate Full URLs for Documents
        const fileColumns = [
            'permanent_address_proof_doc',
            'present_address_proof_doc',
            'bank_proof_doc',
            'pan_doc',
            'aadhaar_doc',
            'aadhaar_doc',
            'passport_doc',
            'profile_image'
        ];

        fileColumns.forEach(field => {
            if (plainRecord[field]) {
                const exists = fileExists(constants.ATTACHMENT_FOLDER, plainRecord[field]);
                if (exists) {
                    plainRecord[field + '_url'] = `${process.env.FILE_SERVER_URL}${constants.ATTACHMENT_FOLDER}${plainRecord[field]}`;
                } else {
                    plainRecord[field + '_url'] = null;
                }
            } else {
                plainRecord[field + '_url'] = null;
            }
        });

        // 2. Parse Education JSON if needed (Sequelize usually returns object for JSONB)
        // Adding safety check just in case
        if (typeof plainRecord.education_details === 'string') {
            try {
                plainRecord.education_details = JSON.parse(plainRecord.education_details);
            } catch (e) {
                plainRecord.education_details = [];
            }
        }

        return res.ok(plainRecord);
    } catch (err) {
        return handleError(err, res, req);
    }
};

/**
 * Soft deletes Employees and cleans up files.
 */
exports.delete = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { ids } = req.body;

        if (!Array.isArray(ids) || ids.length === 0) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, { errors: [constants.REQUIRED] });
        }

        // 1. Find records to identify files to delete
        const employeesToDelete = await Employee.findAll({
            where: { id: { [Op.in]: ids } },
            attributes: ['permanent_address_proof_doc', 'present_address_proof_doc', 'bank_proof_doc', 'pan_doc', 'aadhaar_doc', 'passport_doc']
        });

        // 2. Soft Delete Employees
        const count = await commonQuery.softDeleteById(Employee, ids, null, transaction);

        if (count === 0) {
            await transaction.rollback();
            return res.error(constants.NO_RECORDS_FOUND);
        }

        // 3. Soft Delete associated Family Members
        await commonQuery.softDeleteById(EmployeeFamilyMember, { employee_id: ids }, null, transaction);

        // 4. Delete Physical Files
        const fileColumns = [
            'permanent_address_proof_doc',
            'present_address_proof_doc',
            'bank_proof_doc',
            'pan_doc',
            'aadhaar_doc',
            'aadhaar_doc',
            'passport_doc',
            'profile_image'
        ];

        for (const emp of employeesToDelete) {
            for (const field of fileColumns) {
                if (emp[field]) {
                    await deleteFile(req, res, constants.ATTACHMENT_FOLDER, emp[field]);
                }
            }
        }

        await transaction.commit();
        return res.success(constants.EMPLOYEE_DELETED);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

/**
 * Retrieves Paginated List of Employees.
 */
exports.getAll = async (req, res) => {
    try {
        const fieldConfig = [
            ["father_name", true, true],
            ["email", true, false],
            ["mobile_no", true, false],
        ];

        const data = await commonQuery.fetchPaginatedData(
            Employee,
            req.body,
            fieldConfig,
            {
                include: [
                    { model: User, as: "created_by", attributes: [], required: false },
                ],
                attributes: [
                    "id",
                    "father_name", // or first_name if you have it
                    "email",
                    "joining_date",
                    "status",
                    // "approval_status", // Uncomment if column exists
                    // "designation",
                    "created_at",
                    "created_by.user_name"
                ]
            },
            true,
            "joining_date"
        );

        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};

/**
 * Dropdown list for Select inputs.
 */
exports.dropdownList = async (req, res) => {
    try {
        const fieldConfig = [
            ["father_name", true, true]
        ];

        const data = await commonQuery.fetchPaginatedData(
            Employee,
            { ...req.body, status: STATUS.ACTIVE },
            fieldConfig,
            { attributes: ["id", "father_name"] },
            true
        );

        if (data.list) {
            data.list = data.list.map(emp => ({
                id: emp.id,
                label: emp.father_name
            }));
        }

        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};

/**
 * Update Status (Active/Inactive).
 */
exports.updateStatus = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { ids, status } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, { errors: constants.INVALID_INPUT });
        }

        const count = await commonQuery.updateRecordById(Employee, ids, { status }, transaction);

        if (count === null) {
            await transaction.rollback();
            return res.error(constants.NO_RECORDS_FOUND);
        }

        await transaction.commit();
        return res.success(constants.EMPLOYEE_UPDATED);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};