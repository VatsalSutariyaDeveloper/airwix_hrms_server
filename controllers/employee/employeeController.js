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
    RolePermission,
    AttendancePunch,    
    AttendanceDay,
    EmployeeSalaryTemplate,
    SalaryComponent,
    WeeklyOffTemplate,
    WeeklyOffTemplateDay
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
    fixDecimals,
    calculateWorkingAndOffDays
} = require("../../helpers/functions/commonFunctions");

const { ENTITIES } = require('../../helpers/constants');
const ApprovalEngine = require("../../helpers/approvalEngine");
const { MODULES } = require("../../helpers/moduleEntitiesConstants");
const bcrypt = require("bcrypt");
const { getContext } = require("../../utils/requestContext");
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const FormData = require('form-data');
const LeaveBalanceService = require("../../services/leaveBalanceService");
const EmployeeTemplateService = require("../../services/employeeTemplateService");
const { LOADIPHLPAPI } = require("dns/promises");

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://192.168.1.7:8000';
const FACE_MATCH_THRESHOLD = 0.40;

const DEBUG_MODE = true; 

// Helper for conditional logging
const debugLog = (tag, message, data = "") => {
    if (DEBUG_MODE) {
        console.log(`[DEBUG] 🔍 ${tag}:`, message, data ? JSON.stringify(data).substring(0, 200) + "..." : "");
    }
};

const STATUS = {
    ACTIVE: 0,
    INACTIVE: 1,
    DELETED: 2,
    PENDING_APPROVAL: 4
};

const ALLOWED_TEMPLATE_FIELDS = [
    "weekly_off_template",
    "holiday_template",
    "leave_template",
    "attendance_weekly_off_template",
    "geofence_template",
    "attendance_setting_template",
    "salary_template_id",
    "salary_access",
    "salary_cycle",
    "shift_template"
];

const FILE_COLUMNS = [
    'permanent_address_proof_doc',
    'present_address_proof_doc',
    'bank_proof_doc',
    'pan_doc',
    'aadhaar_doc',
    'aadhaar_doc',
    'passport_doc',
    'profile_image',
    'driving_license_doc',
    'voter_id_doc',
    'uan_doc'
];

// Helper: Parse JSON fields from Multipart/Form-Data
const parseJsonFields = (body) => {
    // 'education_details' is a column in Employee (JSONB)
    // 'family_details' is NOT a column, but we send it as JSON to process into FamilyMember table
    const fieldsToParse = ["education_details"];

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

// Helper: Set template fields to 0 if they are null
const sanitizeTemplateFields = (body) => {
    ALLOWED_TEMPLATE_FIELDS.forEach((field) => {
        if (body[field] === null || body[field] === "null" || body[field] === undefined || body[field] === "undefined" || body[field] === "") {
            body[field] = 0;
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
        sanitizeTemplateFields(req.body);
        const POST = req.body;

        // Validate Required Fields
        const requiredFields = {
            first_name: "First Name",
            joining_date: "Joining Date",
        };

        const errors = await validateRequest(POST, requiredFields, {
            uniqueCheck: {
                model: Employee,
                fields: ["email", "mobile_no"],
            },
        }, transaction);

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        // 1. Handle File Uploads
        // We map the uploaded file keys to the database column names
        if (req.files && Object.keys(req.files).length > 0) {
            const savedFiles = await uploadFile(req, res, constants.EMPLOYEE_DOC_FOLDER, transaction);

            FILE_COLUMNS.forEach(col => {
                if (savedFiles[col]) {
                    POST[col] = savedFiles[col];
                }
            });
        }

        // 2. Generate Employee Code
        // POST.employee_code = await generateSeriesNumber(POST.series_id, transaction, Employee, "employee_code");

        // 3. Create Employee Record
        const employee = await commonQuery.createRecord(Employee, POST, transaction);

        if (!employee) {
            await transaction.rollback();
            return res.error(constants.DATABASE_ERROR, { errors: constants.FAILED_TO_CREATE_RECORD });
        }

        // Initialize all templates to user-wise tables (including leave balances)
        await EmployeeTemplateService.syncAllTemplates(employee.id, transaction);

        // 4. Update Series
        // await updateSeriesNumber(POST.series_id, transaction);

        // 5. Create Family Members (Bulk Create)
        if (Array.isArray(POST.family_details) && POST.family_details.length > 0) {
            const familyData = POST.family_details.map(member => ({
                ...member,
                employee_id: employee.id,
                status: 0
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
        // const companyConfig = await commonQuery.findOneRecord(CompanyConfigration, {
        //     setting_key: 'app_access_roles',
        //     status: 0
        // }, {}, transaction);

        // let rolesNeedingUser = [];
        // if (companyConfig && companyConfig.setting_value) {
        //     try {
        //         // Expecting JSON array or comma-separated string
        //         rolesNeedingUser = typeof companyConfig.setting_value === 'string' 
        //             ? JSON.parse(companyConfig.setting_value) 
        //             : companyConfig.setting_value;
        //         if (!Array.isArray(rolesNeedingUser)) {
        //             rolesNeedingUser = companyConfig.setting_value.split(',').map(id => parseInt(id.trim()));
        //         }
        //     } catch (e) {
        //         rolesNeedingUser = companyConfig.setting_value.split(',').map(id => parseInt(id.trim()));
        //     }
        // }
        POST.role_id = 2;
        // const isAppAccessRole = rolesNeedingUser.includes(parseInt(POST.role_id));
        if (POST.employee_type == 1) {
            // Validation for user fields
            const userRequiredFields = { role_id: "Role" };
            userRequiredFields.mobile_no = "Mobile No";

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
                comapny_access: req.user.companyId,
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
        return res.success(constants.EMPLOYEE_CREATED);

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
        sanitizeTemplateFields(req.body);

        const { id } = req.params;
        const POST = req.body;

        // Validation
        const requiredFields = {
            // first_name: "First Name",
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
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        // Fetch existing data to handle file deletion
        const existingEmployee = await commonQuery.findOneRecord(Employee, id, {}, transaction);

        if (!existingEmployee) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        // 1. Handle File Uploads & Cleanup
        if (req.files && (Array.isArray(req.files) ? req.files.length > 0 : Object.keys(req.files).length > 0)) {
            const savedFiles = await uploadFile(req, res, constants.EMPLOYEE_DOC_FOLDER, transaction);

            for (const col of FILE_COLUMNS) {
                // If new file uploaded for this column
                if (savedFiles[col]) {
                    // Delete old file from disk if it exists
                    if (existingEmployee[col]) {
                        await deleteFile(req, res, constants.EMPLOYEE_DOC_FOLDER, existingEmployee[col]);
                    }
                    // Assign new filename to POST data
                    POST[col] = savedFiles[col];
                }
            }
        }

        // 2. Update Employee Record
        // Note: 'education_details' is in POST and will be updated automatically as it's a JSONB column
        const updatedEmployee = await commonQuery.updateRecordById(Employee, id, POST, transaction);

        // Sync specific templates if they were updated in POST
        const templateFields = [
            "weekly_off_template",
            "holiday_template",
            "leave_template",
            "attendance_setting_template",
            "salary_template_id",
            "shift_template"
        ];

        for (const field of templateFields) {
            if (POST[field] !== undefined) {
                // If the user passed manual data for this template (e.g., in a field like 'manual_leave_data')
                const manualDataKey = `manual_${field}_data`;
                const manualData = POST[manualDataKey] || null;
                
                await EmployeeTemplateService.syncSpecificTemplate(id, field, POST[field], manualData, transaction);
            }
        }


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
        await commonQuery.updateRecordById(ApprovalRequest, {
            entity_id: id,
            module_entity_id: MODULES.HR.EMPLOYEE.ID,
            status: 'PENDING'
        }, { status: 'CANCELLED' }, transaction);

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
            await commonQuery.updateRecordById(Employee, id, { approval_status: 0 }, transaction);
        }

        // 4. Create/Update User Account if requested OR if role is allowed in Company Configuration
        // const companyConfig = await commonQuery.findOneRecord(CompanyConfigration, {
        //     setting_key: 'app_access_roles',
        //     status: 0
        // }, {}, transaction);

        // let rolesNeedingUser = [];
        // if (companyConfig && companyConfig.setting_value) {
        //     try {
        //         rolesNeedingUser = typeof companyConfig.setting_value === 'string' 
        //             ? JSON.parse(companyConfig.setting_value) 
        //             : companyConfig.setting_value;
        //         if (!Array.isArray(rolesNeedingUser)) {
        //             rolesNeedingUser = companyConfig.setting_value.split(',').map(id => parseInt(id.trim()));
        //         }
        //     } catch (e) {
        //         rolesNeedingUser = companyConfig.setting_value.split(',').map(id => parseInt(id.trim()));
        //     }
        // }

        // const isAppAccessRole = rolesNeedingUser.includes(parseInt(POST.role_id));
        POST.role_id = 2;
        if (POST.employee_type == 1) {
            const loginType = parseInt(POST.login_type) || 1;

            // Check if user already exists for this employee
            let existingUser = await commonQuery.findOneRecord(User, { employee_id: id }, {}, transaction);

            const userData = {
                ...POST,
                user_name: POST.first_name,
                comapny_access: req.user.companyId,
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

                if (POST.role_id) {
                    await commonQuery.updateRecordById(UserCompanyRoles, { user_id: existingUser.id }, {
                        role_id: POST.role_id,
                        permissions: userData.permission
                    }, transaction);
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
        return res.success(constants.EMPLOYEE_UPDATED);
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

        FILE_COLUMNS.forEach(field => {
            if (plainRecord[field]) {
                const exists = fileExists(constants.EMPLOYEE_DOC_FOLDER, plainRecord[field]);
                if (exists) {
                    plainRecord[field + '_url'] = `${process.env.FILE_SERVER_URL}${constants.EMPLOYEE_DOC_FOLDER}${plainRecord[field]}`;
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
        const employeesToDelete = await commonQuery.findAllRecords(Employee, { id: { [Op.in]: ids } }, {
            attributes: ['permanent_address_proof_doc', 'present_address_proof_doc', 'bank_proof_doc', 'pan_doc', 'aadhaar_doc', 'passport_doc']
        }, transaction);

        // 2. Soft Delete Employees
        const count = await commonQuery.softDeleteById(Employee, ids, transaction);

        if (count === 0) {
            await transaction.rollback();
            return res.error(constants.NO_RECORDS_FOUND);
        }

        // 3. Soft Delete associated Family Members
        await commonQuery.softDeleteById(EmployeeFamilyMember, { employee_id: ids }, null, transaction);

        // // 4. Delete Physical Files
        // const fileColumns = [
        //     'permanent_address_proof_doc',
        //     'present_address_proof_doc',
        //     'bank_proof_doc',
        //     'pan_doc',
        //     'aadhaar_doc',
        //     'passport_doc',
        //     'profile_image'
        // ];

        // for (const emp of employeesToDelete) {
        //     for (const field of fileColumns) {
        //         if (emp[field]) {
        //             await deleteFile(req, res, constants.EMPLOYEE_DOC_FOLDER, emp[field]);
        //         }
        //     }
        // }

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
        const POST = req.body;
        const fieldConfig = [
            ["first_name", true, true],
            ["employee_code", true, true],
        ];

        const data = await commonQuery.fetchPaginatedData(
            Employee,
            { ...POST, status: 0 },
            fieldConfig,
            {
                include: [
                    { model: User, as: "created_by", attributes: [], required: false },
                ],
                attributes: [
                    "id",
                    "first_name",
                    "employee_code",
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


exports.getPunch = async (req, res) => {
    try {
        const fieldConfig = [
            ["first_name", true, true],
            ["punch_time", true, true],
            ["punch_type", true, false],
        ];

        const data = await commonQuery.fetchPaginatedData(
            Employee,
            req.body,
            fieldConfig,
            {
                include: [
                    {
                        model: AttendancePunch,
                        as: 'attendance_punches',
                        attributes: [
                            'id', 
                            'punch_time', 
                            'punch_type', 
                            'image_name', 
                            'device_id', 
                        ],
                        required: false,
                        order: [['punch_time', 'DESC']]
                    }
                ],
                attributes: [
                    "id",
                    "first_name", 
                    "employee_code",
                    "created_at",
                ]
            },
            true,
            "joining_date"
        );

        // Generate image URLs for attendance punches
        if (data.items && data.items.length > 0) {
            data.items = data.items.map(employee => {                
                const plainEmployee = employee.toJSON ? employee.toJSON() : employee;                
                if (plainEmployee.attendance_punches && plainEmployee.attendance_punches.length > 0) {
                    plainEmployee.attendance_punches = plainEmployee.attendance_punches.map(punch => {
                        const plainPunch = punch.toJSON ? punch.toJSON() : punch;
                        if (plainPunch.image_name) {
                            plainPunch.image_name_url = `${process.env.FILE_SERVER_URL}${constants.ATTENDANCE_FOLDER}${plainPunch.image_name}`;
                        }
                        return plainPunch;
                    });
                }
                return plainEmployee;
            });
        }
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
    const POST = req.body;
      const fieldConfig = [
          ["first_name", true, true],
        ];

    const data = await commonQuery.fetchPaginatedData(
      Employee,
      { ...POST, status: 0 },
      fieldConfig,
      {},
      false,
    );
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
            return res.error(constants.INVALID_ID);
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

exports.assignRole = async(req, res) => {
    const transaction = await sequelize.transaction();
    const { company_id } = getContext();
    const POST = req.body;

     try{
        const { ids, field_name } = req.body;

        const requiredFields = {
            field_name: "Field Name",
            ids: "Ids",
        };

        const errors = await validateRequest(POST, requiredFields, {}, transaction);

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        if (field_name && !['is_attendance_supervisor', 'is_reporting_manager'].includes(field_name)) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, { message: "Invalid field_name. Must be 'is_attendance_supervisor' or 'is_reporting_manager'" });
        }
         
        // 1. Update employees field to true for all provided IDs
        const employeeUpdateData = { [field_name]: true };
        const updatedEmployees = await commonQuery.updateRecordById(Employee, ids, employeeUpdateData, transaction);
        
        if (!updatedEmployees) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND, { message: "No employees found" });
        }
        
        // 2. Find associated users for all updated employees
        const users = await commonQuery.findAllRecords(User, { employee_id: { [Op.in]: ids } }, {}, transaction);
        
        if (!users || users.length === 0) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND, { message: "No users found for the provided employees" });
        }
      
        // 3. Determine role_id based on field_name
        let newRoleId;
        if (field_name === 'is_reporting_manager') {
            newRoleId = 13;
        } else if (field_name === 'is_attendance_supervisor') {
            newRoleId = 12;
        }
        
        // 4. Get permissions from RolePermission table
        const rolePermission = await commonQuery.findOneRecord(RolePermission, newRoleId, {}, transaction);
        
        // 5. Update all users and their roles
        const updatePromises = users.map(async (user) => {
            // Update user role_id
            await commonQuery.updateRecordById(User, user.id, { role_id: newRoleId }, transaction);
            
            // Update UserCompanyRoles with role_id and permissions
            return commonQuery.updateRecordById(
                UserCompanyRoles,
                { user_id: user.id, company_id: company_id },
                { 
                    role_id: newRoleId,
                    permissions: rolePermission.permissions
                },
                transaction, false, false
            );
        });
        
        await Promise.all(updatePromises);
        
        await transaction.commit();
        return res.success(constants.EMPLOYEE_UPDATED);
        
     }catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
}   

/**
 * Bulk Update Template for Employees
 */
exports.assignTemplate = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { field_name, employees } = req.body;

        // 1. Allowed Fields Whitelist
        if (!ALLOWED_TEMPLATE_FIELDS.includes(field_name)) {
            await transaction.rollback();
            return res.error(constants.INVALID_FIELD_NAME);
        }

        // 2. Validate Input
        if (!Array.isArray(employees) || employees.length === 0) {
            await transaction.rollback();
            return res.error(constants.EMPLOYEE_DATA_IS_REQUIRED_AND_MUST_BE_AN_ARRAY);
        }

        // 3. Process Updates
        for (const emp of employees) {
            if (emp.id && emp.value !== undefined) {
                // Fetch current record to check if template is actually changing

                const existing = await commonQuery.findOneRecord(Employee, emp.id, { attributes: ['id', 'leave_template'] }, transaction);

                if (!existing) {
                    continue;
                }
                // Update each employee record
                await commonQuery.updateRecordById(Employee, emp.id, { [field_name]: emp.value }, transaction);

                // Sync the specific template that was assigned
                await EmployeeTemplateService.syncSpecificTemplate(emp.id, field_name, emp.value, null, transaction);

                // Special handling for leave_template assignments
                if (field_name === 'leave_template') {
                    const oldVal = existing ? existing.leave_template : null;
                    const newVal = emp.value;

                    if (parseInt(oldVal) !== parseInt(newVal)) {
                        await LeaveBalanceService.syncEmployeeBalances(emp.id, newVal, transaction);
                    }
                }
            }
        }

        await transaction.commit();
        return res.success(constants.EMPLOYEE_UPDATED);

    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

/**
 * Get Employees by Template Field
 */
exports.getEmployeesByTemplate = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { field_name, value, is_access } = req.body;
    
    const fieldConfig = [
        ["first_name", true, true],
        ["employee_code", true, true],
    ];

    // 1. Validate field name
    if (!ALLOWED_TEMPLATE_FIELDS.includes(field_name)) {
      await transaction.rollback();
      return res.error(constants.INVALID_FIELD_NAME);
    }

    // 2. Validate is_access
    if (is_access === undefined || is_access === null) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, {
        message: "is_access is required"
      });
    }

    // 3. Validate value
    if (value === undefined || value === null) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, {
        message: "Value is required"
      });
    }

    // 4. Base filter
    const filter = {
      status: 0
    };

    const accessFlag = is_access === true || is_access === "true";

    // 5. Apply condition
    if (accessFlag) {
      filter[field_name] = value;
    } else {
      filter[field_name] = 0;
    }

    // 6. Fetch counts in parallel
    const assignFilter = { status: 0, [field_name]: value };
    const notAssignFilter = { status: 0, [field_name]: 0 };

    const [assignedCount, notAssignedCount] = await Promise.all([
      commonQuery.countRecords(Employee, assignFilter, {}, false),
      commonQuery.countRecords(Employee, notAssignFilter, {}, false)
    ]);

    // 7. Fetch employees
    const employees = await commonQuery.fetchPaginatedData(
      Employee,
      { ...req.body, filter },
      fieldConfig,
      {
        attributes: ["id", "first_name", "employee_code", field_name]
      },
      false
    );

    // 8. Add computed flag
    if (employees?.items?.length) {
      employees.items = employees.items.map(emp => {
        const plainEmp = emp.toJSON();
        return {
          ...plainEmp,
          [`is_${field_name}`]: plainEmp[field_name] == value
        };
      });
    }

    // 9. Attach counts
    employees.assign_staff_count = assignedCount;
    employees.not_assign_staff_count = notAssignedCount;

    await transaction.commit();
    return res.ok(employees);

  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};

const calculateCosineDistance = (descriptor1, descriptor2) => {
    // 1. Safety Check
    if (!descriptor1 || !descriptor2) {
        if(DEBUG_MODE) console.log("❌ [Math] One of the vectors is null/undefined");
        return 1.0; 
    }
    
    if (descriptor1.length !== descriptor2.length) {
        if(DEBUG_MODE) console.log(`❌ [Math] Length Mismatch: Live=${descriptor1.length}, Stored=${descriptor2.length}`);
        return 1.0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < descriptor1.length; i++) {
        dotProduct += descriptor1[i] * descriptor2[i];
        normA += descriptor1[i] * descriptor1[i];
        normB += descriptor2[i] * descriptor2[i];
    }

    // 2. Avoid division by zero
    if (normA === 0 || normB === 0) {
        if(DEBUG_MODE) console.log("❌ [Math] Zero Norm detected (vector contains all zeros)");
        return 1.0;
    }

    // 3. Calculate Similarity (0 to 1)
    const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));

    // 4. Return Distance
    // ArcFace cosine distance: 0 = Same, 1+ = Different
    const distance = 1 - similarity;
    
    // Log first few calculations to check if numbers are valid
    // if(DEBUG_MODE && Math.random() < 0.05) console.log(`🧮 [Math] Dist: ${distance.toFixed(4)} | Sim: ${similarity.toFixed(4)}`);
    
    return distance; 
};

/**
 * Register Face
 * 1. Saves image to 'users/images/' (Permanent Profile Picture).
 * 2. Deletes old profile image if it exists.
 * 3. Sends image to Python to get the Face Vector.
 * 4. Updates Employee record with new Profile Image AND Face Vector.
 */
exports.registerFace = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.body;

        // Check if image file exists
        if (!req.files || (!req.files.image && !req.files['image'])) { 
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, { message: "Image is required" });
        }

        const employee = await commonQuery.findOneRecord(Employee, id);
        if (!employee) {
            await transaction.rollback();
            return res.error(constants.EMPLOYEE_NOT_FOUND);
        }

        // 1. Save File to Disk (Permanent Profile Image)
        // We use EMPLOYEE_IMG_FOLDER to store it in 'uploads/users/images/'
        // We pass 'employee.profile_image' as the last argument so 'uploadFile' automatically deletes the OLD photo.
        const savedFiles = await uploadFile(
            req, 
            res, 
            constants.EMPLOYEE_IMG_FOLDER, // ✅ Save to User Images folder
            transaction,
            employee.profile_image     // ✅ Delete old image if exists
        );

        const filename = savedFiles.image; 
        
        if (!filename) {
            await transaction.rollback();
            return res.error(constants.SERVER_ERROR, { message: "File upload failed" });
        }

        // 2. Send to Python to get Face Embedding
        // We read the file we just saved to ensure Python sees exactly what is on disk
        const fullFilePath = path.join(process.cwd(), "uploads", constants.EMPLOYEE_IMG_FOLDER, filename);
        
        let faceDescriptor;
        try {
            const fileBuffer = fs.readFileSync(fullFilePath);

            const formData = new FormData();
            formData.append('image', fileBuffer, filename); 

            const aiResponse = await axios.post(`${AI_SERVICE_URL}/generate-embedding`, formData, {
                headers: { ...formData.getHeaders() }
            });

            if (aiResponse.data.status) {
                faceDescriptor = aiResponse.data.embedding;
            } else {
                throw new Error(aiResponse.data.message);
            }
        } catch (aiError) {
            await transaction.rollback(); 
            // Optional: Delete the file we just wrote since the process failed
            try { fs.unlinkSync(fullFilePath); } catch(e) {}

            console.error("AI Service Error:", aiError.message);
            return res.error(constants.SERVER_ERROR, { message: "AI Processing Failed: " + aiError.message });
        }

        // 3. Update Employee Record
        // - Updates 'profile_image' (Visible in App/Admin)
        // - Updates 'face_descriptor' (Used for AI Matching)
        await employee.update({
            profile_image: filename,
            face_descriptor: faceDescriptor
        }, { transaction });

        await transaction.commit();

        return res.success("Face Registered & Profile Picture Updated", {
            image_url: `${process.env.FILE_SERVER_URL}${constants.EMPLOYEE_IMG_FOLDER}${filename}`
        });

    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};
/**
 * Face Punch (Attendance)
 * - Uses 'uploadFile' utility to save to 'uploads/attendance/'
 * - Runs in PARALLEL with AI and DB for maximum speed.
 */
exports.facePunch = async (req, res) => {
    try {
        debugLog("Punch", "Request received");

        const files = req.files.image || req.files['image'];
        if (!files || files.length === 0) {
            return res.error(constants.VALIDATION_ERROR, { message: "Face image is required" });
        }

        const imageBuffer = files[0].buffer;
        const originalName = files[0].originalname;
        debugLog("Punch", `Image Size: ${imageBuffer.length} bytes`);

        // 🚀 PARALLEL TASK 1: Call AI Service
        const getEmbeddingTask = (async () => {
            const formData = new FormData();
            formData.append('image', imageBuffer, originalName); 
            
            try {
                debugLog("AI-Call", "Sending to Python...");
                const aiResponse = await axios.post(`${AI_SERVICE_URL}/generate-embedding`, formData, {
                    headers: { ...formData.getHeaders() }
                });
                
                if (aiResponse.data.status) {
                    const vec = aiResponse.data.embedding;
                    debugLog("AI-Res", `Got Vector. Length: ${vec.length}, First 3 vals: [${vec[0]}, ${vec[1]}, ${vec[2]}]`);
                    return vec;
                } else {
                    throw new Error(aiResponse.data.message);
                }
            } catch (error) {
                const pyError = error.response?.data?.message || error.message;
                console.error("❌ AI Service Failed:", pyError);
                throw new Error(pyError);
            }
        })();

        // 🚀 PARALLEL TASK 2: Fetch Employees
        // NOTE: Make sure attributes match your DB Column names exactly
        const getEmployeesTask = commonQuery.findAllRecords(Employee, {
            status: 0,
            face_descriptor: { [Op.ne]: null }
        }, {
            attributes: ['id', 'first_name', 'employee_code', 'face_descriptor'], // Changed first_name to father_name based on your prev code
            raw: true 
        });

        // ⚡ EXECUTE AI AND DB TASKS IN PARALLEL
        const [liveVector, employees] = await Promise.all([
            getEmbeddingTask,
            getEmployeesTask
        ]);

        debugLog("DB-Fetch", `Found ${employees.length} active employees with faces`);

        // --- MATCHING LOGIC ---
        let bestMatch = null;
        let minDistance = 1.0; 

        // Loop Counter to limit debug logs
        let logCounter = 0; 

        for (const emp of employees) {
            let storedVector = emp.face_descriptor;
            
            // 🔍 DEBUGGING DATA TYPES
            // Often DB returns JSONB as Object, but sometimes Text as String.
            const typeBefore = typeof storedVector;
            
            if (typeof storedVector === 'string') {
                try { 
                    storedVector = JSON.parse(storedVector); 
                } catch(e) {
                    if(DEBUG_MODE) console.log(`❌ [Parse Error] Emp ID ${emp.id}: Could not parse JSON string`);
                    continue; 
                }
            }
            
            // Double check it's an array
            if (!Array.isArray(storedVector)) {
                if(DEBUG_MODE && logCounter < 3) console.log(`❌ [Type Error] Emp ID ${emp.id}: Vector is ${typeof storedVector}, not Array`);
                continue;
            }

            const dist = calculateCosineDistance(liveVector, storedVector);

            // Log the first 3 comparisons to see what's happening
            if (DEBUG_MODE && logCounter < 3) {
                console.log(`👤 [Compare] ID: ${emp.id} | Name: ${emp.first_name} | Dist: ${dist.toFixed(4)}`);
                logCounter++;
            }

            if (dist < minDistance) {
                minDistance = dist;
                bestMatch = emp;
                debugLog("Match-Update", `New Best Match: ${emp.first_name} (Dist: ${dist})`);
            }
        }

        const matchPercentage = ((1 - minDistance) * 100).toFixed(2);
        debugLog("Final-Result", `Best: ${bestMatch ? bestMatch.first_name : 'None'} | Score: ${matchPercentage}%`);

        // --- VALIDATION & CONDITIONAL FILE SAVING ---
        let savedFilename;
        if (bestMatch && minDistance < FACE_MATCH_THRESHOLD) {
            const transaction = await sequelize.transaction();
            
            try {
                const savedFiles = await uploadFile(req, res, constants.ATTENDANCE_FOLDER);
                savedFilename = savedFiles.image || savedFiles['image'];
                
                const now = new Date();
                const attendancePunch = await commonQuery.createRecord(AttendancePunch, {
                    employee_id: bestMatch.id,
                    punch_time: now,
                    punch_type: "IN", 
                    image_name: savedFilename
                }, transaction);
                
                const today = now.toISOString().split('T')[0];
               
                await commonQuery.createRecord(AttendanceDay, {
                    employee_id: bestMatch.id,
                    attendance_date: today,
                }, transaction);
            
                await transaction.commit();                
                
                return res.success("Punch Successful", {
                    employee: bestMatch.first_name,
                    employee_code: bestMatch.employee_code,
                    confidence: matchPercentage + "%",
                    image_url: `${process.env.FILE_SERVER_URL}${constants.ATTENDANCE_FOLDER}${savedFilename}`,
                    attendance_punch_id: attendancePunch.id
                });
            } catch (error) {
                await transaction.rollback();
                console.error("Error creating attendance records:", error);
                return res.error(constants.SERVER_ERROR, { message: "Failed to create attendance records" });
            }
        } else {
            // Save to ATTENDANCE_LOG_FOLDER for failed face recognition with custom timestamp
            const now = new Date();
            const day = String(now.getDate()).padStart(2, '0');
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const year = now.getFullYear();
            let hours = now.getHours();
            const minutes = String(now.getMinutes()).padStart(2, '0');
            const ampm = hours >= 12 ? 'PM' : 'AM';
            hours = hours % 12;
            hours = hours ? hours : 12; 
            const timeStr = `${String(hours).padStart(2, '0')}:${minutes} ${ampm}`;
            const dateStr = `${day}-${month}-${year}`;
            const ext = path.extname(originalName);
            const customFilename = `${Date.now()}_punch_${dateStr}__${timeStr}${ext}`;
            
            // Use uploadFile with custom filename
            const savedFiles = await uploadFile(req, res, constants.ATTENDANCE_LOG_FOLDER, null, null, customFilename);
            savedFilename = savedFiles.image || savedFiles['image'];
            
            return res.error(constants.FACE_NOT_RECOGNIZED, { 
                message: `Face Not Recognized (Match: ${matchPercentage}%)` 
            });
        }

    } catch (err) {
        console.error("💥 Server Error:", err);
        const errorMsg = err.message || "Server Error";
        const statusCode = errorMsg.includes("Face") ? constants.VALIDATION_ERROR : constants.SERVER_ERROR;
        return res.error(statusCode, { message: errorMsg });
    }
};

exports.getWages = async(req, res) =>{
    try{
        const { employee_id : employeeId  } = req.body;
        
        if (!employeeId) {
            return res.error(constants.VALIDATION_ERROR, { message: "Employee ID is required" });
        }

        // Get current date and format it as YYYY-MM-DD for database query
        const currentDate = new Date().toISOString().split('T')[0];

        // Fetch attendance day record for employeeId and current date
        const attendanceDay = await commonQuery.findOneRecord(
            AttendanceDay,
            {
                employee_id: employeeId,
                attendance_date: currentDate
            },
            {
                attributes: ['id', 'attendance_date', 'first_in', 'last_out', 'overtime_data', 'fine_data']
            }
        )

        if(!attendanceDay ){
            return res.error(constants.NOT_FOUND, { message: "Attendance record not found for today" });
        }

        if(attendanceDay.first_in == null){
            return res.error(constants.NOT_FOUND, { message: "First punch-in not recorded for today" });
        }

        const employee = await commonQuery.findOneRecord(Employee, employeeId, {
            attributes: ['id', 'salary_template_id', 'company_id', 'weekly_off_template']
        });

        if (!employee) {
            return res.error(constants.NOT_FOUND, { message: "Employee not found" });
        }

        const employeeSalaryTemplate = await commonQuery.findOneRecord(
            EmployeeSalaryTemplate, 
            { 
                employee_id: employeeId,
                company_id: employee.company_id,
                status: 0
            },
            {
                attributes: ['id', 'company_id', 'ctc_monthly', 'lwp_calculation_basis']
            }
        );

        if (!employeeSalaryTemplate) {
            return res.error(constants.NOT_FOUND, { message: "Salary template not found for this employee" });
        }

        let dailyWage = null;
        let monthDays = null;
        let workingDays = null;
        const ctcMonthly = parseFloat(employeeSalaryTemplate.ctc_monthly);
        
        if (employeeSalaryTemplate.lwp_calculation_basis === 'WORKING_DAYS') { 

            if (employee && employee.weekly_off_template) {
                const weeklyOffTemplate = await commonQuery.findOneRecord(
                    WeeklyOffTemplate, 
                    employee.weekly_off_template, 
                    {
                        include: [{ model: WeeklyOffTemplateDay, as: "days" }]
                    }
                );
                
                if (weeklyOffTemplate) {
                    const currentDate = new Date();                    
                    const result = calculateWorkingAndOffDays(weeklyOffTemplate.days, currentDate);
                    workingDays = result.working_days;
                    monthDays = result.total_days_in_month;
                    
                    if (workingDays && workingDays > 0) {
                        dailyWage = ctcMonthly / workingDays;
                    }
                }
            }
            
            if (!workingDays) {
                workingDays = 30;
                monthDays = 30;
                dailyWage = ctcMonthly / 30;
            }
        } else if (employeeSalaryTemplate.lwp_calculation_basis === 'DAYS_IN_MONTH') {
            const currentDate = new Date();
            const year = currentDate.getFullYear();
            const month = currentDate.getMonth();
            monthDays = new Date(year, month + 1, 0).getDate();
            dailyWage = ctcMonthly / monthDays;
        } else if (employeeSalaryTemplate.lwp_calculation_basis === 'FIXED_30_DAYS') {
            monthDays = 30;
            dailyWage = ctcMonthly / 30;
        }

        const hourlyWage = dailyWage ? dailyWage / 8 : null;

        const responseData = {
            ...employeeSalaryTemplate.toJSON(),
            daily_wage: dailyWage ? parseFloat(dailyWage.toFixed(2)) : null,
            hourly_wage: hourlyWage ? parseFloat(hourlyWage.toFixed(2)) : null,
            calculation_basis: employeeSalaryTemplate.lwp_calculation_basis,
            month_days: monthDays,
            working_days: workingDays,
            last_out: attendanceDay.last_out || null,
            overtime_data: attendanceDay?.overtime_data || null,
            fine_data: attendanceDay?.fine_data || null,
        };

        return res.success(constants.SUCCESS, responseData);

    }catch(err){
        return handleError(err, res, req);
    }
}

exports.getEmployeeCode = async (req, res) => {
    try {
        const employee = await commonQuery.findAllRecords(Employee, {
            status: 0, 
            employee_code: { [Op.ne]: null }
        }, {
            attributes: ['employee_code'],
            order: [['id', 'DESC']],
            limit: 1
        });

        if (!employee || employee.length === 0) {
            return res.error(constants.NOT_FOUND, { message: "No employees found" });
        }

        const lastEmployeeCode = employee[0].employee_code;
        
        // Check if the code ends with digits
        const match = lastEmployeeCode.match(/(\d+)$/);
        
        if (match) {
            // Code has numeric part, increment it (e.g., "EM-11" -> "EM-12")
            const numericPart = parseInt(match[1]);
            const newNumericPart = numericPart + 1;
            const newEmployeeCode = lastEmployeeCode.replace(/\d+$/, newNumericPart);
            return res.success(constants.SUCCESS, { employee_code: newEmployeeCode });
        } else {
            // Code has no numeric part, add 1 (e.g., "EMP" -> "EMP-1")
            const newEmployeeCode = lastEmployeeCode + "-1";
            return res.success(constants.SUCCESS, { employee_code: newEmployeeCode });
        }
        
    } catch (err) {
        return handleError(err, res, req);
    }
}
