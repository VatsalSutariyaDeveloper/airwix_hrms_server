const {
    Employee,
    EmployeeFamilyMember,
    User,
    UserCompanyRoles,
    RolePermission,
    AttendancePunch,
    AttendanceDay,
    EmployeeSalaryTemplate,
    WeeklyOffTemplate,
    WeeklyOffTemplateDay,
    EmployeeSettings,
    AttendanceTemplate,
    HolidayTransaction,
    LeaveTemplate,
    LeaveTemplateCategory,
    SalaryTemplate,
    SalaryTemplateTransaction,
    ShiftTemplate
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
    whatsappService,
    fileExists,
    handleExport,
    streamExport
} = require("../../helpers");

const {

    calculateWorkingAndOffDays
} = require("../../helpers/functions/commonFunctions");


const { getContext } = require("../../utils/requestContext");
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const FormData = require('form-data');
const EmployeeTemplateService = require("../../services/employeeTemplateService");

const dayjs = require("dayjs");
const crypto = require("crypto");

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
    const fieldsToParse = ["education_details", "custom_fields"];

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
        if (body[field] === "") {
            body[field] = 0;
        }
        // else if (body[field] === null || body[field] === "null" || body[field] === undefined || body[field] === "undefined") {

        // }
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

        if (req.body.employee_code) {
            const employeeCodeExists = await Employee.findOne({
                where: {
                    employee_code: req.body.employee_code,
                },
                transaction,
            });

            if (employeeCodeExists) {
                await transaction.rollback();
                return res.error(constants.VALIDATION_ERROR, { employee_code: "Employee Code already exists" });
            }
        }

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

        if (POST.prefix || POST.number) {
            if (!POST.number) {
                await transaction.rollback();
                return res.error(constants.VALIDATION_ERROR, { message: "Number is required when storing employee settings" });
            }

            const settingsData = {
                settings_name: POST.prefix,
                settings_value: POST.number,
            };

            await commonQuery.createRecord(EmployeeSettings, settingsData, transaction);
        }

        // 3. Create Employee Record
        const employee = await commonQuery.createRecord(Employee, POST, transaction);

        if (!employee) {
            await transaction.rollback();
            return res.error(constants.DATABASE_ERROR, { errors: constants.FAILED_TO_CREATE_RECORD });
        }

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

        const joiningDateChanged = POST.joining_date !== undefined &&
            dayjs(POST.joining_date).isValid() &&
            dayjs(POST.joining_date).format('YYYY-MM-DD') !== dayjs(existingEmployee.joining_date).format('YYYY-MM-DD');

        for (const field of templateFields) {
            const hasManualData = POST[`manual_${field}_data`] !== undefined;
            const fieldValueChanged = POST[field] !== undefined && String(POST[field]) !== String(existingEmployee[field]);

            // For leave template, we also sync if joining date changed
            const shouldSyncLeave = field === 'leave_template' && (fieldValueChanged || joiningDateChanged);
            // For other templates, we sync if the value changed or if manual data is provided
            const shouldSyncOthers = field !== 'leave_template' && (fieldValueChanged || hasManualData);

            if (shouldSyncLeave || shouldSyncOthers || (field === 'leave_template' && hasManualData)) {
                const manualDataKey = `manual_${field}_data`;
                const manualData = POST[manualDataKey] || null;
                await EmployeeTemplateService.syncSpecificTemplate(id, field, POST[field] !== undefined ? POST[field] : existingEmployee[field], manualData, transaction);
            }
        }

        // 4. Sync User Status if provided
        if (POST.status !== undefined) {
            await commonQuery.updateRecordById(User, { employee_id: id }, { status: POST.status }, transaction, false, false);
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

        // 4. Soft Delete associated Users
        await commonQuery.softDeleteById(User, { employee_id: ids }, transaction);

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
                    { model: User, as: "created_by", attributes: ["user_name"], required: false },
                    { model: User, as: "linked_user", attributes: ["id", "is_activated"], required: false },
                ],
                attributes: [
                    "id",
                    "first_name",
                    "employee_code",
                    "mobile_no",
                    "joining_date",
                    "created_at",
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

exports.checkEmployeeCode = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { employee_code } = req.body;
        const emp = await commonQuery.findOneRecord(
            Employee,
            { employee_code },
            {},
            transaction
        );
        await transaction.commit();
        return res.ok({ exists: !!emp });
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
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
        const { employee_id } = POST;

        if (employee_id) {
            const data = await commonQuery.fetchPaginatedData(
                Employee,
                { ...POST, id: employee_id, status: { [Op.in]: [0, 1, 2] } },
                {},
                {},
                false,
            );
            return res.ok(data);
        } else {
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
        }
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

        // Update associated Users status
        await commonQuery.updateRecordById(User, { employee_id: ids }, { status }, transaction, false, false);

        await transaction.commit();
        return res.success(constants.EMPLOYEE_UPDATED);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

exports.assignRole = async (req, res) => {
    const transaction = await sequelize.transaction();
    const { company_id } = getContext();
    const POST = req.body;

    try {
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
            newRoleId = 4;
        } else if (field_name === 'is_attendance_supervisor') {
            newRoleId = 3;
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

    } catch (err) {
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
        let { field_name, employees, is_select_all, filter_params, target_value, excluded_ids } = req.body;

        if (is_select_all) {
            const where = {};

            // Example: Apply Search
            if (filter_params?.search) {
                where[Op.or] = [
                    { first_name: { [Op.like]: `%${filter_params.search}%` } },
                    // { last_name: { [Op.like]: `%${filter_params.search}%` } },
                    { employee_code: { [Op.like]: `%${filter_params.search}%` } } // Added common search field
                ];
            }

            // Exclude specifically deselected IDs
            if (Array.isArray(excluded_ids) && excluded_ids.length > 0) {
                where.id = { [Op.notIn]: excluded_ids };
            }

            // Example: Apply Tab Context (Assigned vs Unassigned)
            // If tab is 'unselected' (is_access: false), we find employees WITHOUT this template
            if (filter_params?.is_access === false) {
                where[field_name] = { [Op.or]: [null, 0] };
            }

            else if (filter_params?.is_access === true && filter_params?.value) {
                where[field_name] = filter_params.value;
            }

            // 2. Fetch ALL matching IDs from the database
            const allMatchingEmployees = await commonQuery.findAllRecords(
                Employee,
                where,
                ['id'], // Only select ID
                null,
                false
            );

            employees = allMatchingEmployees.map(emp => ({
                id: emp.id,
                value: target_value // The value to set (e.g., templateId or 0)
            }));
        }

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

        // 3. Pre-fetch Master Data and Employees for optimization
        const firstEmployee = employees[0];
        const commonValue = employees.every(e => e.value === firstEmployee.value) ? firstEmployee.value : null;

        let masterData = null;
        if (commonValue) {
            switch (field_name) {
                case 'attendance_setting_template':
                    masterData = await commonQuery.findOneRecord(AttendanceTemplate, commonValue, {}, transaction);
                    break;
                case 'holiday_template':
                    masterData = await commonQuery.findAllRecords(HolidayTransaction, { template_id: commonValue, status: 0 }, {}, transaction);
                    break;
                case 'weekly_off_template':
                    masterData = await commonQuery.findAllRecords(WeeklyOffTemplateDay, { template_id: commonValue, status: 0 }, {}, transaction);
                    break;
                case 'leave_template':
                    masterData = await commonQuery.findOneRecord(LeaveTemplate, commonValue, {
                        include: [{ model: LeaveTemplateCategory, as: "categories", where: { status: 0 } }]
                    }, transaction);
                    break;
                case 'salary_template_id':
                    masterData = await commonQuery.findOneRecord(SalaryTemplate, commonValue, {
                        include: [{ model: SalaryTemplateTransaction, as: "salaryTemplateTransactions" }]
                    }, transaction);
                    break;
                case 'shift_template':
                    masterData = await commonQuery.findOneRecord(ShiftTemplate, commonValue, {}, transaction);
                    break;
            }
        }

        // Pre-fetch all involved employees (needed for leave sync and attendance logic)
        const employeeIds = employees.map(e => e.id);
        const preFetchedEmployees = await commonQuery.findAllRecords(Employee, { id: { [Op.in]: employeeIds } }, {}, transaction);
        const empMap = new Map(preFetchedEmployees.map(e => [e.id, e]));

        // 4. Group employees by target value for bulk processing
        const groups = {};
        employees.forEach(emp => {
            if (emp.id && emp.value !== undefined) {
                if (!groups[emp.value]) groups[emp.value] = [];
                groups[emp.value].push(emp.id);
            }
        });

        const employeeIdsToRebuild = [];

        for (const [val, ids] of Object.entries(groups)) {
            const targetValue = val === 'null' ? null : parseInt(val);

            // 1. Bulk Update Employee table
            await commonQuery.updateRecordById(Employee, { id: { [Op.in]: ids } }, { [field_name]: targetValue }, transaction);

            // 2. Bulk Sync Templates (skip rebuild for now)
            const syncMeta = {
                preFetchedMaster: (targetValue === commonValue) ? masterData : null,
                skipRebuild: true
            };

            await EmployeeTemplateService.bulkSyncSpecificTemplate(ids, field_name, targetValue, transaction, syncMeta);

            // 3. Collect IDs for background rebuild
            employeeIdsToRebuild.push(...ids);

            // Special case: If weekly_off_template is updated, we MUST also re-sync shift_templates 
            // because shift day-wise settings (EmployeeShift) depend on weekly off days.
            if (field_name === 'weekly_off_template') {
                const employeesWithShifts = await commonQuery.findAllRecords(Employee, { id: { [Op.in]: ids }, status: 0 }, { attributes: ['id', 'shift_template'] }, transaction);
                const shiftGroups = {};
                employeesWithShifts.forEach(e => {
                    if (e.shift_template) {
                        if (!shiftGroups[e.shift_template]) shiftGroups[e.shift_template] = [];
                        shiftGroups[e.shift_template].push(e.id);
                    }
                });

                for (const [sId, sIds] of Object.entries(shiftGroups)) {
                    await EmployeeTemplateService.bulkSyncSpecificTemplate(sIds, 'shift_template', parseInt(sId), transaction, { skipRebuild: true });
                }
            }
        }

        await transaction.commit();

        // 4. Send Success Response immediately
        res.success(constants.EMPLOYEE_UPDATED);

        // 5. Trigger Background Rebuild (Fire and Forget)
        // Only necessary for templates that affect attendance calculations: Shift, Holiday, WeeklyOff
        if (['shift_template', 'holiday_template', 'weekly_off_template'].includes(field_name)) {
            (async () => {
                try {
                    console.log(`[Background] Starting attendance rebuild for ${employeeIdsToRebuild.length} employees...`);
                    // We process rebuilds in bulk using the optimized method
                    await EmployeeTemplateService.rebuildCurrentMonthAttendance(employeeIdsToRebuild, null);
                    console.log(`[Background] Completed attendance rebuild.`);
                } catch (err) {
                    console.error("[Background] Global error in attendance rebuild task:", err);
                }
            })();
        }

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
            filter[field_name] = { [Op.or]: [0, null] };
        }

        // 6. Fetch counts in parallel
        const assignFilter = { status: 0, [field_name]: value };
        const notAssignFilter = { status: 0, [field_name]: { [Op.or]: [0, null] } };

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
        if (DEBUG_MODE) console.log("❌ [Math] One of the vectors is null/undefined");
        return 1.0;
    }

    if (descriptor1.length !== descriptor2.length) {
        if (DEBUG_MODE) console.log(`❌ [Math] Length Mismatch: Live=${descriptor1.length}, Stored=${descriptor2.length}`);
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
        if (DEBUG_MODE) console.log("❌ [Math] Zero Norm detected (vector contains all zeros)");
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
            try { fs.unlinkSync(fullFilePath); } catch (e) { }

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
                } catch (e) {
                    if (DEBUG_MODE) console.log(`❌ [Parse Error] Emp ID ${emp.id}: Could not parse JSON string`);
                    continue;
                }
            }

            // Double check it's an array
            if (!Array.isArray(storedVector)) {
                if (DEBUG_MODE && logCounter < 3) console.log(`❌ [Type Error] Emp ID ${emp.id}: Vector is ${typeof storedVector}, not Array`);
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

exports.getWages = async (req, res) => {
    try {
        const { employee_id: employeeId, attendance_date: attendanceDate } = req.body;

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
                attendance_date: attendanceDate
            },
            {
                attributes: ['id', 'attendance_date', 'first_in', 'last_out', 'overtime_data', 'fine_data']
            }
        )

        if (!attendanceDay) {
            return res.error(constants.NOT_FOUND, { message: "Attendance record not found for today" });
        }

        // if(attendanceDay.first_in == null){
        //     return res.error(constants.NOT_FOUND, { message: "First punch-in not recorded for today" });
        // }

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

    } catch (err) {
        return handleError(err, res, req);
    }
}

/**
 * Generates a user account for an existing employee and provides a setup link.
 */
exports.inviteUser = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { employee_id } = req.body;

        if (!employee_id) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, { employee_id: "Employee ID is required" });
        }

        const employee = await commonQuery.findOneRecord(Employee, employee_id, {}, transaction);
        if (!employee) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND, { message: "Employee not found" });
        }

        // Check if user already exists
        let user = await commonQuery.findOneRecord(User, { employee_id }, {}, transaction);

        if (!user) {
            // This case should theoretically not happen with auto-creation, but handle it for legacy employees
            const role_id = 5;
            const rolePermission = await commonQuery.findOneRecord(RolePermission, role_id, {}, transaction);

            user = await commonQuery.createRecord(User, {
                user_name: employee.first_name,
                email: employee.email,
                mobile_no: employee.mobile_no,
                employee_id: employee.id,
                role_id: role_id,
                company_id: employee.company_id,
                branch_id: employee.branch_id,
                company_access: employee.company_id,
                permission: rolePermission ? rolePermission.permissions : null,
                status: 1,
                is_activated: false
            }, transaction);

            await commonQuery.createRecord(UserCompanyRoles, {
                user_id: user.id,
                role_id: role_id,
                branch_id: employee.branch_id,
                company_id: employee.company_id,
                permissions: user.permission,
                status: 0
            }, transaction);
        }

        // Generate Activation Code
        const activation_code = crypto.randomBytes(20).toString("hex");

        await commonQuery.updateRecordById(User, user.id, {
            activation_code: activation_code,
            is_activated: false, // Ensure it's reset to false
            status: 1 // Keep inactive
        }, transaction);

        await transaction.commit();

        const setupLink = `${process.env.FRONTEND_URL || 'https://yourhrms.com/'}activate?code=${activation_code}`;

        // Send WhatsApp Notification (Async)
        const whatsappRes = await whatsappService.sendInvitationLink(employee, setupLink);

        return res.success("Invitation generated successfully", {
            setup_link: setupLink,
            user_id: user.id,
            email: user.email,
            whatsapp_status: whatsappRes.success ? "Sent" : "Failed"
        });

    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Employee Export Field Definitions
const ALL_POSSIBLE_FIELDS = {
    // Basic Information
    employee_code: {
        key: 'employee_code',
        header: 'Employee Code',
        formatter: (value) => value || 'N/A'
    },
    first_name: { key: 'first_name', header: 'First Name' },
    mobile_no: { key: 'mobile_no', header: 'Mobile Number' },
    email: { key: 'email', header: 'Email' },

    // Employment Details
    employee_type: {
        key: 'employee_type',
        header: 'Employee Type',
        formatter: (value) => value === 1 ? 'Staff' : value === 2 ? 'Worker' : value
    },
    department_id: {
        key: 'department.name',
        header: 'Department',
        include: 'department'
    },
    designation_id: { key: 'designation_id', header: 'Designation ID' },
    joining_date: {
        key: 'joining_date',
        header: 'Joining Date',
        formatter: (value) => value ? new Date(value).toLocaleDateString() : ''
    },
    confirmation_date: {
        key: 'confirmation_date',
        header: 'Confirmation Date',
        formatter: (value) => value ? new Date(value).toLocaleDateString() : ''
    },

    // Personal Information
    gender: {
        key: 'gender',
        header: 'Gender',
        formatter: (value) => value === 1 ? 'Male' : value === 2 ? 'Female' : value === 3 ? 'Others' : value
    },
    dob: {
        key: 'dob',
        header: 'Date of Birth',
        formatter: (value) => value ? new Date(value).toLocaleDateString() : ''
    },
    marital_status: {
        key: 'marital_status',
        header: 'Marital Status',
        formatter: (value) => value === 1 ? 'Married' : value === 2 ? 'Unmarried' : value
    },
    blood_group: {
        key: 'blood_group',
        header: 'Blood Group',
        formatter: (value) => {
            const groups = { 1: 'A+', 2: 'A-', 3: 'B+', 4: 'B-', 5: 'O+', 6: 'O-', 7: 'AB+', 8: 'AB-' };
            return groups[value] || value;
        }
    },
    physically_challenged: {
        key: 'physically_challenged',
        header: 'Physically Challenged',
        formatter: (value) => value ? 'Yes' : 'No'
    },

    // Contact Information
    emergency_contact_name: { key: 'emergency_contact_name', header: 'Emergency Contact Name' },
    emergency_contact_mobile: { key: 'emergency_contact_mobile', header: 'Emergency Contact Mobile' },
    emergency_contact_relation: {
        key: 'emergency_contact_relation',
        header: 'Emergency Contact Relation',
        formatter: (value) => {
            const relations = { 1: 'Brother', 2: 'Sister', 3: 'Father', 4: 'Mother', 5: 'Spouse', 6: 'Son', 7: 'Daughter', 8: 'Other' };
            return relations[value] || value;
        }
    },

    // Family Information
    father_name: { key: 'father_name', header: 'Father Name' },
    mother_name: { key: 'mother_name', header: 'Mother Name' },
    spouse_name: { key: 'spouse_name', header: 'Spouse Name' },

    // Address Information
    present_address1: { key: 'present_address1', header: 'Present Address 1' },
    present_address2: { key: 'present_address2', header: 'Present Address 2' },
    present_city: { key: 'present_city', header: 'Present City' },
    present_pincode: { key: 'present_pincode', header: 'Present Pincode' },
    permanent_address1: { key: 'permanent_address1', header: 'Permanent Address 1' },
    permanent_address2: { key: 'permanent_address2', header: 'Permanent Address 2' },
    permanent_city: { key: 'permanent_city', header: 'Permanent City' },
    permanent_pincode: { key: 'permanent_pincode', header: 'Permanent Pincode' },

    // Bank Information
    name_as_per_bank: { key: 'name_as_per_bank', header: 'Name as per Bank' },
    bank_name: { key: 'bank_name', header: 'Bank Name' },
    bank_account_number: { key: 'bank_account_number', header: 'Bank Account Number' },
    bank_ifsc_code: { key: 'bank_ifsc_code', header: 'Bank IFSC Code' },
    upi_id: { key: 'upi_id', header: 'UPI ID' },

    // Government IDs
    aadhaar_number: { key: 'aadhaar_number', header: 'Aadhaar Number' },
    pan_number: { key: 'pan_number', header: 'PAN Number' },
    uan_number: { key: 'uan_number', header: 'UAN Number' },
    pf_number: { key: 'pf_number', header: 'PF Number' },
    esi_number: { key: 'esi_number', header: 'ESI Number' },

    // Status
    status: {
        key: 'status',
        header: 'Status',
        formatter: (value) => value === 0 ? 'Active' : value === 1 ? 'Inactive' : value === 2 ? 'Deleted' : value
    },

    // Leave Information (added dynamically when leave: true)
    leave_category1: {
        key: 'leave_category1',
        header: 'Leave Category1',
        formatter: (value, record) => {
            // Empty column - no data fetching
            return '';
        }
    },
    leave_count1: {
        key: 'leave_count1',
        header: 'Leave Count1',
        formatter: (value, record) => {
            // Empty column - no data fetching
            return '';
        }
    },
    leave_category2: {
        key: 'leave_category2',
        header: 'Leave Category2',
        formatter: (value, record) => {
            // Empty column - no data fetching
            return '';
        }
    },
    leave_count2: {
        key: 'leave_count2',
        header: 'Leave Count2',
        formatter: (value, record) => {
            // Empty column - no data fetching
            return '';
        }
    },
    leave_category3: {
        key: 'leave_category3',
        header: 'Leave Category3',
        formatter: (value, record) => {
            // Empty column - no data fetching
            return '';
        }
    },
    leave_count3: {
        key: 'leave_count3',
        header: 'Leave Count3',
        formatter: (value, record) => {
            // Empty column - no data fetching
            return '';
        }
    },
    leave_category4: {
        key: 'leave_category4',
        header: 'Leave Category4',
        formatter: (value, record) => {
            // Empty column - no data fetching
            return '';
        }
    },
    leave_count4: {
        key: 'leave_count4',
        header: 'Leave Count4',
        formatter: (value, record) => {
            // Empty column - no data fetching
            return '';
        }
    },
    leave_category5: {
        key: 'leave_category5',
        header: 'Leave Category5',
        formatter: (value, record) => {
            // Empty column - no data fetching
            return '';
        }
    },
    leave_count5: {
        key: 'leave_count5',
        header: 'Leave Count5',
        formatter: (value, record) => {
            // Empty column - no data fetching
            return '';
        }
    }
};

// Sequelize Include Definitions
const ALL_SEQUELIZE_INCLUDES = {
    department: {
        model: require("../../models").Department,
        as: 'department',
        attributes: ['id', 'name'],
        required: false
    }
};

exports.exportData = async (req, res) => {
    try {
        const { limit, fields, leave } = req.body;

        // Validate req.user exists
        if (!req.user || !req.user.company_id) {
            return res.status(401).json({
                success: false,
                error: "UNAUTHORIZED",
                message: "User authentication required"
            });
        }

        const { company_id, id: user_id, branch_id } = req.user;

        const commonData = { company_id, user_id, branch_id };

        // 1. Parse Fields
        let requestedFields = typeof fields === 'string' ? JSON.parse(fields) : fields;
        if (!requestedFields || Object.keys(requestedFields).length === 0) {
            return res.error("VALIDATION_ERROR", { errors: ["The 'fields' parameter is required."] });
        }

        // 2. Add leave fields if leave: true
        if (leave === true) {
            // Add 5 pairs of leave columns to existing fields
            requestedFields = {
                ...requestedFields,
                leave_category1: 'leave_category1',
                leave_count1: 'leave_count1',
                leave_category2: 'leave_category2',
                leave_count2: 'leave_count2',
                leave_category3: 'leave_category3',
                leave_count3: 'leave_count3',
                leave_category4: 'leave_category4',
                leave_count4: 'leave_count4',
                leave_category5: 'leave_category5',
                leave_count5: 'leave_count5'
            };
        }

        const dynamicMappers = [];
        const neededIncludes = new Set();
        const fieldNamesInOrder = Object.values(requestedFields);

        for (const fieldName of fieldNamesInOrder) {
            const masterField = ALL_POSSIBLE_FIELDS[fieldName];
            if (masterField) {
                dynamicMappers.push(masterField);
                if (masterField.include) neededIncludes.add(masterField.include);
            }
        }

        if (dynamicMappers.length === 0) {
            return res.error("VALIDATION_ERROR", { errors: ["None of the requested fields are valid for export."] });
        }

        const sequelizeIncludes = Array.from(neededIncludes).map(key => ALL_SEQUELIZE_INCLUDES[key]).filter(Boolean);

        // 3. Select Attributes
        const userRequestedMainAttributes = dynamicMappers
            .filter(m => !m.key.includes('.') && !m.include && !['leave_category1', 'leave_count1', 'leave_category2', 'leave_count2', 'leave_category3', 'leave_count3', 'leave_category4', 'leave_count4', 'leave_category5', 'leave_count5'].includes(m.key)) // Direct fields only, exclude virtual fields
            .map(m => m.key);

        const requiredForeignKeys = sequelizeIncludes.flatMap(inc => {
            const association = Employee.associations[inc.as];
            return association ? [association.foreignKey] : [];
        });
        const selectAttributes = [...new Set([...userRequestedMainAttributes, ...requiredForeignKeys, 'id'])];

        const baseQueryOptions = {
            where: { ...commonData, status: 0 },
            include: sequelizeIncludes,
            attributes: selectAttributes,
        };

        // 4. Handle Export
        if (limit) {
            const recordLimit = parseInt(limit, 10);
            const exportConfig = {
                model: Employee,
                mappers: dynamicMappers,
                queryOptions: {
                    ...baseQueryOptions,
                    limit: recordLimit,
                    order: [['id', 'DESC']],
                },
                ...commonData
            };

            const { jsonData } = await handleExport(exportConfig);
            return res.success(constants.EMPLOYEE_EXPORTED, {
                message: `Successfully fetched ${jsonData.length} employees for export.`,
                count: jsonData.length,
                data: jsonData,
            });

        } else {
            // Full Export Mode (Stream Excel)
            const exportConfig = {
                model: Employee,
                sheetName: 'Employees',
                mappers: dynamicMappers,
                queryOptions: baseQueryOptions,
                ...commonData
            };

            try {
                await streamExport(exportConfig, res);
            } catch (streamErr) {
                console.error("Stream export failed:", streamErr);
                // Don't send response if headers already sent
                if (!res.headersSent) {
                    if (streamErr.message === "No records found to export.") {
                        return res.error("NOT_FOUND", { errors: [streamErr.message] });
                    }
                    return handleError(streamErr, res, req);
                }
            }
            return; // Exit early for stream export
        }

    } catch (err) {
        console.error("Export failed:", err);
        if (!res.headersSent) {
            if (err.message === "No records found to export.") {
                return res.error("NOT_FOUND", { errors: [err.message] });
            }
            return handleError(err, res, req);
        }
    }
};