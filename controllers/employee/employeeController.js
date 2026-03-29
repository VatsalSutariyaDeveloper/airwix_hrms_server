const {
    Employee,
    EmployeeFamilyMember,
    User,
    UserCompanyRoles,
    RolePermission,
    AttendancePunch,
    AttendanceDay,
    EmployeeSalaryTemplate,
    EmployeeAttendanceTemplate,
    EmployeeHoliday,
    EmployeeWeeklyOff,
    EmployeeLeaveBalance,
    EmployeeShift,
    WeeklyOffTemplate,
    WeeklyOffTemplateDay,
    EmployeeSettings,
    AttendanceTemplate,
    HolidayTransaction,
    LeaveTemplate,
    LeaveTemplateCategory,
    SalaryTemplate,
    SalaryTemplateTransaction,
    ShiftTemplate,
    DesignationMaster,
    Department,
    HolidayTemplate,
    ResignationTemplate,
    DeviceMaster
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
    streamExport,
    writeLogToFile
} = require("../../helpers");

// helper for dealing with image uploads inside custom field arrays
const { handleCustomFieldImages, generateCustomFieldImageUrls } = require("../../helpers/customFieldImageHandler");

const {
    calculateWorkingAndOffDays
} = require("../../helpers/functions/commonFunctions");

const { punch, rebuildAttendanceDay } = require("../../helpers/attendanceHelper");

const { getContext } = require("../../utils/requestContext");
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const FormData = require('form-data');
const EmployeeTemplateService = require("../../services/employeeTemplateService");

const dayjs = require("dayjs");
const crypto = require("crypto");

// Helper for conditional logging
const debugLog = (tag, message, data = "") => {
    if (process.env.DEBUG_MODE) {
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
    "shift_template",
    "resignation_template_id"
];

const FILE_COLUMNS = [
    'permanent_address_proof_doc',
    'present_address_proof_doc',
    'bank_proof_doc',
    'pan_doc',
    'aadhaar_doc',
    'passport_doc',
    'profile_image',
    'driving_license_doc',
    'voter_id_doc',
    'uan_doc'
];

// Helper: Parse JSON fields from Multipart/Form-Data
const parseJsonFields = (body) => {
    const fieldsToParse = ["education_details", "custom_fields", "access_branches"];

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
            uniqueCheck: [
                {
                    model: Employee,
                    fields: ["email", "mobile_no"],
                    excludeCompany: true,
                    excludeBranch: true,
                },
                {
                    model: User,
                    fields: ["email", "mobile_no"],
                    excludeCompany: true,
                    excludeBranch: true,
                }
            ]
        }, transaction);

        if (req.body.employee_code) {
            const employeeCodeExists = await commonQuery.findOneRecord(Employee, {
                employee_code: req.body.employee_code,
            }, {}, transaction);

            if (employeeCodeExists) {
                await transaction.rollback();
                return res.error(constants.VALIDATION_ERROR, { employee_code: "Employee Code already exists" });
            }
        }

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        // handle custom field images first (they may consume uploaded files)
        if (Array.isArray(POST.custom_fields)) {
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
            POST.custom_fields = await handleCustomFieldImages(
                req,
                res,
                POST.custom_fields,
                allFilesArray,
                constants.CUSTOM_FIELD_IMG_FOLDER,
                transaction
            );
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
            uniqueCheck: [{
                model: Employee,
                fields: ["email", "mobile_no"],
                excludeCompany: true,
                excludeBranch: true,
                excludeId: id
            },
            {
                model: User,
                fields: ["email", "mobile_no"],
                excludeCompany: true,
                excludeBranch: true,
                where: {
                    employee_id: {
                        [Op.ne]: id
                    }
                }
            }],
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

        // handle custom field images (existingEmployee used for cleanup info)
        if (Array.isArray(POST.custom_fields)) {
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
            POST.custom_fields = await handleCustomFieldImages(
                req,
                res,
                POST.custom_fields,
                allFilesArray,
                constants.CUSTOM_FIELD_IMG_FOLDER,
                transaction,
                existingEmployee
            );
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
        const updatedEmployee = await commonQuery.updateRecordById(Employee, id, POST, transaction, false, false);

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

             // Special handling for leave_template - reject pending requests BEFORE updating
            if (field === 'leave_template' && fieldValueChanged) {
                await EmployeeTemplateService.rejectPendingLeaveRequestsOnTemplateChange(id, req, transaction, existingEmployee[field]);
            }

            // For leave template, we also sync if joining date changed
            const shouldSyncLeave = field === 'leave_template' && (fieldValueChanged || joiningDateChanged);
            // For other templates, we sync if the value changed or if manual data is provided
            const shouldSyncOthers = field !== 'leave_template' && (fieldValueChanged || hasManualData);

            if (shouldSyncLeave || shouldSyncOthers || (field === 'leave_template' && hasManualData)) {
                const manualDataKey = `manual_${field}_data`;
                const manualData = POST[manualDataKey] || null;
                
                // Prepare meta data for syncLeaveTemplate to handle pending request rejection
                const meta = {
                    employee: existingEmployee,
                    preFetchedMaster: null,
                    req: req,
                    existingEmployee: existingEmployee
                };
                
                await EmployeeTemplateService.syncSpecificTemplate(
                    id, 
                    field, 
                    POST[field] !== undefined ? POST[field] : existingEmployee[field], 
                    manualData, 
                    transaction,
                    false,
                    meta
                );
            }
        }

        // 4. Sync User
        await commonQuery.updateRecordById(User, { employee_id: id }, { 
            user_name: POST.first_name,
            email: POST.email,
            mobile_no: POST.mobile_no,
            ...(POST.status !== undefined && { status: POST.status })
        }, transaction, false, false);


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
            {
                model: EmployeeAttendanceTemplate,
                as: 'employeeAttendanceTemplate',
                attributes: ['enble_on_duty'],
                required: false
            },
            {
                model: ResignationTemplate,
                as: 'resignationTemplate',
                attributes: ['id', 'template_name', 'notice_period_days'],
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
                const isProfileImg = field === 'profile_image';
                const folder = isProfileImg ? constants.EMPLOYEE_IMG_FOLDER : constants.EMPLOYEE_DOC_FOLDER;
                const fallback = isProfileImg ? constants.EMPLOYEE_DOC_FOLDER : constants.EMPLOYEE_IMG_FOLDER;

                let actualFolder = null;
                if (fileExists(folder, plainRecord[field])) {
                    actualFolder = folder;
                } else if (fileExists(fallback, plainRecord[field])) {
                    actualFolder = fallback;
                }

                if (actualFolder) {
                    plainRecord[field + '_url'] = `${process.env.FILE_SERVER_URL}${actualFolder}${plainRecord[field]}`;
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

        // also ensure custom_fields is parsed and convert any image references to URLs
        if (typeof plainRecord.custom_fields === 'string') {
            try {
                plainRecord.custom_fields = JSON.parse(plainRecord.custom_fields);
            } catch (e) {
                plainRecord.custom_fields = [];
            }
        }

        if (Array.isArray(plainRecord.custom_fields)) {
            plainRecord.custom_fields = generateCustomFieldImageUrls(
                plainRecord.custom_fields,
                constants.CUSTOM_FIELD_IMG_FOLDER
            );
        }

        return res.ok(plainRecord);
    } catch (err) {
        return handleError(err, res, req);
    }
};

/**
 * Gets the profile of the currently logged-in user (Employee context).
 */
exports.getProfile = async (req, res) => {
    try {
        const userId = req.user.id;
        const employeeId = req.user.employee_id;

        const where = employeeId ? { id: employeeId } : { user_id: userId };

        const record = await commonQuery.findOneRecord(Employee, where, {
            include: [
                { model: DesignationMaster, as: 'designation', attributes: ['designation_name'] },
                { model: Department, as: 'department', attributes: ['name'] },
                { model: User, as: 'linked_user', attributes: ['id', 'user_name', 'email', 'mobile_no', 'role_id'] },
                
                // Joins with Employee-specific Templates/Data
                { model: EmployeeSalaryTemplate, as: 'employeeSalaryTemplate', attributes: ['template_name', 'ctc_monthly', 'lwp_calculation_basis', 'salary_type', 'staff_type'] },
                { model: EmployeeAttendanceTemplate, as: 'employeeAttendanceTemplate' },
                
                // Master Template Joins (kept for names if not in employee-specific tables)
                { model: LeaveTemplate, as: "leaveTemplate", attributes: ["template_name"] },
                { model: HolidayTemplate, as: "holidayTemplate", attributes: ["name"] },
                { model: WeeklyOffTemplate, as: "weeklyOffTemplate", attributes: ["name"] },
                { model: ShiftTemplate, as: "shiftTemplate", attributes: ["shift_name"] }
            ]
        });

        if (!record) return res.error(constants.EMPLOYEE_NOT_FOUND);

        const plainRecord = record.get({ plain: true });

        // Helper to generate full file URLs
        const getFileUrl = (fileName, folder = constants.EMPLOYEE_IMG_FOLDER) => {
            if (!fileName) return null;
            
            // Check provided (preferred) folder first
            if (fileExists(folder, fileName)) {
                return `${process.env.FILE_SERVER_URL}${folder}${fileName}`;
            }
            
            // Fallback for files that might be in the other folder
            const fallback = folder === constants.EMPLOYEE_IMG_FOLDER ? constants.EMPLOYEE_DOC_FOLDER : constants.EMPLOYEE_IMG_FOLDER;
            if (fileExists(fallback, fileName)) {
                return `${process.env.FILE_SERVER_URL}${fallback}${fileName}`;
            }
            
            return null;
        };

        const profileData = {
            header: {
                id: plainRecord.id,
                employee_code: plainRecord.employee_code,
                full_name: plainRecord.first_name?.trim() || 'N/A',
                profile_image_url: getFileUrl(plainRecord.profile_image),
                designation: plainRecord.designation?.designation_name || 'N/A',
                department: plainRecord.department?.name || 'N/A',
            },
            account_settings: {
                user_name: plainRecord.linked_user?.user_name || 'N/A',
                email: plainRecord.email || plainRecord.linked_user?.email || 'N/A',
                mobile_no: plainRecord.mobile_no || plainRecord.linked_user?.mobile_no || 'N/A',
            },
            bank_details: {
                bank_name: plainRecord.bank_name || 'N/A',
                account_no: plainRecord.bank_account_number || 'N/A',
                ifsc: plainRecord.bank_ifsc_code || 'N/A',
                holder_name: plainRecord.bank_account_holder_name || 'N/A',
                upi_id: plainRecord.upi_id || 'N/A'
            },
            personal_info: {
                first_name: plainRecord.first_name,
                gender: plainRecord.gender === 1 ? 'Male' : (plainRecord.gender === 2 ? 'Female' : (plainRecord.gender === 3 ? 'Others' : 'N/A')),
                dob: plainRecord.dob || 'N/A',
                blood_group: ["A+", "A-", "B+", "B-", "O+", "O-", "AB+", "AB-"][plainRecord.blood_group - 1] || 'N/A',
                father_name: plainRecord.father_name || 'N/A',
                mother_name: plainRecord.mother_name || 'N/A',
                spouse_name: plainRecord.spouse_name || 'N/A',
                marriage_date: plainRecord.marriage_date || 'N/A',
                nationality: plainRecord.nationality || 'Indian',
            },
            general_info: {
                salary_cycle: plainRecord.employeeSalaryTemplate?.salary_type || 'N/A',
                weekly_off: plainRecord.weeklyOffTemplate?.name || 'N/A',
                holiday: plainRecord.holidayTemplate?.name || 'N/A',
                leave: plainRecord.leaveTemplate?.template_name || 'N/A',
                shift: plainRecord.shiftTemplate?.shift_name || 'N/A',
                salary_template: plainRecord.employeeSalaryTemplate?.template_name || 'N/A',
                lwp_basis: plainRecord.employeeSalaryTemplate?.lwp_calculation_basis === "DAYS_IN_MONTH" ? "Days in Month" : plainRecord.employeeSalaryTemplate?.lwp_calculation_basis === "FIXED_30_DAYS" ? "Fixed 30 Days" : "Working Days",
                attendance_mode: plainRecord.employeeAttendanceTemplate?.mode || 'N/A',
                attendance_supervisor: plainRecord.is_attendance_supervisor ? 'Yes' : 'No',
                reporting_manager: plainRecord.is_reporting_manager ? 'Yes' : 'No'
            },
            employment_info: {
                joining_date: plainRecord.joining_date || 'N/A',
                employee_type: ["Staff", "Worker", "Contractor"][plainRecord.employee_type - 1] || 'N/A',
                worker_type: ["On-Role", "Off-Role"][plainRecord.worker_type - 1] || 'N/A',
                uan: plainRecord.uan_number || 'N/A',
                pan: plainRecord.pan_number || 'N/A',
                aadhaar: plainRecord.aadhaar_number || 'N/A',
                pf_eligible: plainRecord.pf_eligible ? 'Yes' : 'No',
                pf_number: plainRecord.pf_number || 'N/A',
                pf_joining_date: plainRecord.pf_joining_date || 'N/A',
                esi_eligible: plainRecord.esi_eligible ? 'Yes' : 'No',
                esi_number: plainRecord.esi_number || 'N/A',
                pt_eligible: plainRecord.pt_eligible ? 'Yes' : 'No',
                lwf_eligible: plainRecord.lwf_eligible ? 'Yes' : 'No',
                eps_eligible: plainRecord.eps_eligible ? 'Yes' : 'No',
                eps_joining_date: plainRecord.eps_joining_date || 'N/A',
                eps_exit_date: plainRecord.eps_exit_date || 'N/A',
                hps_eligible: plainRecord.hps_eligible ? 'Yes' : 'No',
                // probation_period: plainRecord.probation_period_days ? `${plainRecord.probation_period_days} Days` : 'N/A',
                // notice_period: plainRecord.notice_period_days ? `${plainRecord.notice_period_days} Days` : 'N/A',
                // referred_by: plainRecord.referred_by || 'N/A'
            },
            address_info: {
                present: {
                    address: `${plainRecord.present_address1 || ''} ${plainRecord.present_address2 || ''}`.trim() || 'N/A',
                    city: plainRecord.present_city || 'N/A',
                    pincode: plainRecord.present_pincode || 'N/A'
                },
                permanent: {
                    address: `${plainRecord.permanent_address1 || ''} ${plainRecord.permanent_address2 || ''}`.trim() || 'N/A',
                    city: plainRecord.permanent_city || 'N/A',
                    pincode: plainRecord.permanent_pincode || 'N/A'
                }
            },
            emergency_contact: {
                name: plainRecord.emergency_contact_name || 'N/A',
                mobile: plainRecord.emergency_contact_mobile || 'N/A',
                relation: ["Brother", "Sister", "Father", "Mother", "Spouse", "Son", "Daughter", "Other"][plainRecord.emergency_contact_relation - 1] || 'N/A'
            },
            document_center: {
                aadhaar_doc: getFileUrl(plainRecord.aadhaar_doc, constants.EMPLOYEE_DOC_FOLDER),
                pan_doc: getFileUrl(plainRecord.pan_doc, constants.EMPLOYEE_DOC_FOLDER),
                driving_license_doc: getFileUrl(plainRecord.driving_license_doc, constants.EMPLOYEE_DOC_FOLDER),
                voter_id_doc: getFileUrl(plainRecord.voter_id_doc, constants.EMPLOYEE_DOC_FOLDER),
                uan_doc: getFileUrl(plainRecord.uan_doc, constants.EMPLOYEE_DOC_FOLDER),
            },
            education: plainRecord.education_details || [],
            custom_fields: plainRecord.custom_fields || {}
        };

        return res.ok(profileData);
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
            ["employee.mobile_no", true, false],
            ["joining_date", true, false],
        ];

        const data = await commonQuery.fetchPaginatedData(
            Employee,
            POST,
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
                    "branch_id",
                    "access_branches",
                    "profile_image",
                    "created_at",
                    "status",
                    "onboarding_status"
                ]
            },
            true,
            "joining_date"
        );

        data.items = data.items.map(item => {
            const plain = item.get ? item.get({ plain: true }) : item;
            if (plain.profile_image) {
                plain.profile_image_url = `${process.env.FILE_SERVER_URL}${constants.EMPLOYEE_IMG_FOLDER}${plain.profile_image}`;
            } else {
                plain.profile_image_url = null;
            }
            return plain;
        });

        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.checkEmployeeCode = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { employee_code } = req.body;
        const employeeCodeExists = await commonQuery.findOneRecord(Employee, {
            employee_code: employee_code,
        }, {}, transaction);
        await transaction.commit();
        return res.ok({ exists: !!employeeCodeExists });
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
                ["employee_code", true, true],
            ];

            const data = await commonQuery.fetchPaginatedData(
                Employee,
                { ...POST, status: 0 },
                fieldConfig,
                {
                    attributes: ["id", "first_name", "employee_code", "status"],
                },
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
        // const rolePermission = await commonQuery.findOneRecord(RolePermission, newRoleId, {}, transaction);

        // 5. Update all users and their roles
        const updatePromises = users.map(async (user) => {
            // Update user role_id
            await commonQuery.updateRecordById(User, user.id, { role_id: newRoleId }, transaction);

            // Update UserCompanyRoles with role_id and permissions
            // return commonQuery.updateRecordById(
            //     UserCompanyRoles,
            //     { user_id: user.id, company_id: company_id },
            //     {
            //         role_id: newRoleId,
            //         permissions: rolePermission.permissions
            //     },
            //     transaction, false, false
            // );
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

            // Special handling for leave_template - reject pending requests BEFORE updating
            if (field_name === 'leave_template') {
                for (const employeeId of ids) {
                    const empId = Number(employeeId);
                    const existingEmployee = empMap.get(empId);
                    if (existingEmployee && String(existingEmployee.leave_template) !== String(targetValue)) {
                        await EmployeeTemplateService.rejectPendingLeaveRequestsOnTemplateChange(empId, req, transaction, existingEmployee.leave_template);
                    }
                }
            }

            // 1. Bulk Update Employee table
            await commonQuery.updateRecordById(Employee, { id: { [Op.in]: ids } }, { [field_name]: targetValue }, transaction);

            // 2. Bulk Sync Templates (skip rebuild for now)
            const syncMeta = {
                preFetchedMaster: (targetValue === commonValue) ? masterData : null,
                skipRebuild: true
            };

            if (field_name === 'leave_template') {
                syncMeta.req = req;
                syncMeta.employees = empMap;
            }

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
        if (process.env.DEBUG_MODE) console.log("❌ [Math] One of the vectors is null/undefined");
        return 1.0;
    }

    if (descriptor1.length !== descriptor2.length) {
        if (process.env.DEBUG_MODE) console.log(`❌ [Math] Length Mismatch: Live=${descriptor1.length}, Stored=${descriptor2.length}`);
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
        if (process.env.DEBUG_MODE) console.log("❌ [Math] Zero Norm detected (vector contains all zeros)");
        return 1.0;
    }

    // 3. Calculate Similarity (0 to 1)
    const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));

    // 4. Return Distance
    // ArcFace cosine distance: 0 = Same, 1+ = Different
    const distance = 1 - similarity;

    // Log first few calculations to check if numbers are valid
    // if(process.env.DEBUG_MODE && Math.random() < 0.05) console.log(`🧮 [Math] Dist: ${distance.toFixed(4)} | Sim: ${similarity.toFixed(4)}`);

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

        if(req.user.access == "attendance device"){
            const device = await commonQuery.findOneRecord(DeviceMaster, req.user.device_id, {status: 0});
            if (!device) {
                return res.status(401).json({
                    success: false,
                    error: "UNAUTHORIZED",
                    message: "Device not Exist."
                });
            }
        }

        // Check if image file exists
        if (!req.files || (!req.files.image && !req.files['image'])) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, { message: "Image is required" });
        }

        const employee = await commonQuery.findOneRecord(Employee, id);
        if (!employee) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        // 1. Save File to Disk (Permanent Profile Image)
        // We use EMPLOYEE_IMG_FOLDER to store it in 'uploads/employee/images/'
        const savedFiles = await uploadFile(
            req,
            res,
            constants.EMPLOYEE_IMG_FOLDER, // ✅ Save to User Images folder
            transaction,
            employee.profile_image     // ✅ Delete old image if exists in IMG_FOLDER
        );

        const filename = savedFiles.image;

        if (!filename) {
            await transaction.rollback();
            return res.error(constants.SERVER_ERROR, { message: "File upload failed" });
        }

        // 1.1 Cleanup Old Image from alternative folder (DOC_FOLDER) 
        // In case it was previously uploaded via the general update API.
        if (employee.profile_image) {
            await deleteFile(req, res, constants.EMPLOYEE_IMG_FOLDER, employee.profile_image);
        }

        // 2. Send to Python to get Face Embedding
        // We read the file we just saved to ensure Python sees exactly what is on disk
        const fullFilePath = path.join(process.cwd(), "uploads", constants.EMPLOYEE_IMG_FOLDER, filename);

        let faceDescriptor;
        try {
            const fileBuffer = fs.readFileSync(fullFilePath);

            // const formData = new FormData();
            // formData.append('image', fileBuffer, filename);
            // const aiResponse = await axios.post(`${process.env.AI_SERVICE_URL}/generate-embedding`, formData, {
            //     headers: { ...formData.getHeaders() }
            // });

            //for fast python service which accepts raw buffer instead of form data to reduce overhead and latency
            const aiResponse = await axios.post(`${process.env.AI_SERVICE_URL}/generate-embedding`, fileBuffer, {
                headers: { 'Content-Type': 'application/octet-stream' }
            });

            if (aiResponse.data.status) {
                faceDescriptor = aiResponse.data.embedding;
            } else {
                throw new Error(aiResponse.data.message);
            }

            // 2.1 Unique Face Check
            const threshold = process.env.FACE_MATCH_THRESHOLD || 0.4;
            const employeesWithFaces = await commonQuery.findAllRecords(Employee, {
                status: 0,
                face_descriptor: { [Op.ne]: null },
                id: { [Op.ne]: id } 
            }, {
                attributes: ['id', 'first_name', 'branch_id', 'face_descriptor'],
                raw: true
            }, null, { company_id: true });

            for (const emp of employeesWithFaces) {
                let storedVector = emp.face_descriptor;
                if (typeof storedVector === 'string') {
                    try {
                        storedVector = JSON.parse(storedVector);
                    } catch (e) { continue; }
                }
                if (!Array.isArray(storedVector)) continue;

                const dist = calculateCosineDistance(faceDescriptor, storedVector);
                if (dist < threshold) {
                    const branch = await commonQuery.findOneRecord(BranchMaster, emp.branch_id, { attributes: ['branch_name'] }, null, false, { company_id: true });
                    const branchName = branch?.branch_name || "N/A";
                    
                    await transaction.rollback();
                    // Clean up the uploaded file since the process failed validation
                    try { fs.unlinkSync(fullFilePath); } catch (e) { }

                    return res.error(constants.VALIDATION_ERROR, { 
                        message: `${emp.first_name} already exist in ${branchName}` 
                    });
                }
            }
        } catch (aiError) {
            if (!transaction.finished) await transaction.rollback();
            // Optional: Delete the file we just wrote since the process failed
            try { fs.unlinkSync(fullFilePath); } catch (e) { }

            console.error("AI Service Error:", aiError.message);
            writeLogToFile('face_recognition.log', `[REGISTER_FAILED] ID: ${id}, Error: ${aiError.response?.data?.message || aiError.message}`);
            
            const friendlyMsg = aiError.response?.data?.message || "Face analysis failed. Please ensure your photo is clear and try again.";
            return res.error(constants.SERVER_ERROR, { message: friendlyMsg });
        }

        // 3. Update Employee Record
        // - Updates 'profile_image' (Visible in App/Admin)
        // - Updates 'face_descriptor' (Used for AI Matching)
        await employee.update({
            profile_image: filename,
            face_descriptor: faceDescriptor
        }, { transaction });

        await transaction.commit();

        writeLogToFile('face_recognition.log', `[REGISTER_SUCCESS] ID: ${id}, Filename: ${filename}`);

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
        const startTime = Date.now();
        const now = new Date();

        const time = now.toTimeString().split(' ')[0];

        console.log("start time",time)
        const timings = { 
            ai: 0, 
            db: 0, 
            matching: 0, 
            upload: 0, 
            total: 0 
        };

        if(req.user.access == "attendance device"){
            const device = await commonQuery.findOneRecord(DeviceMaster, req.user.id, {status: 0});
            if (!device) {
                return res.status(401).json({
                    success: false,
                    error: "UNAUTHORIZED",
                    message: "Device not Exist."
                });
            }
        }

        const files = req.files.image || req.files['image'];
        if (!files || files.length === 0) {
            return res.error(constants.VALIDATION_ERROR, { message: "Face image is required" });
        }

        const imageBuffer = files[0].buffer;
        const originalName = files[0].originalname;
        debugLog("Punch", `Image Size: ${imageBuffer.length} bytes`);

        // 🚀 PARALLEL TASK 1: Call AI Service (Optimized with Raw Buffer)
        const getEmbeddingTask = (async () => {
            const aiStart = Date.now();
            try {
                const formData = new FormData();
                formData.append('image', imageBuffer, originalName);

                debugLog("AI-Call", "Sending to Python...");
                // const aiResponse = await axios.post(`${process.env.AI_SERVICE_URL}/generate-embedding`, formData, {
                //     headers: { ...formData.getHeaders() }
                // });

                // for face punch python service accepts raw buffer instead of form data to reduce overhead and latency
                const aiResponse = await axios.post(`${process.env.AI_SERVICE_URL}/generate-embedding`, imageBuffer, {
                    headers: { 'Content-Type': 'application/octet-stream' }
                });

                timings.ai = Date.now() - aiStart;
                if (aiResponse.data.status) {
                    return aiResponse.data.embedding;
                } else {
                    throw new Error(aiResponse.data.message);
                }
            } catch (error) {
                const rawError = error.response?.data?.message || error.message;
                const time = now.toTimeString().split(' ')[0];
                console.log("end time",time)
                console.error("❌ AI Service Failed:", rawError);
                writeLogToFile('face_recognition.log', `❌ [AI Service Error] ${rawError}`);
                
                const friendlyMsg = error.response?.data?.message || "Face analysis failed. Please ensure your photo is clear and try again.";
                throw new Error(friendlyMsg);
            }
        })();

        // 🚀 PARALLEL TASK 2: Fetch Employees
        const getEmployeesTask = (async () => {
            const dbStart = Date.now();
            const companyId = req.user?.company_id;
            const res = await commonQuery.findAllRecords(Employee, {
                status: 0,
                face_descriptor: { [Op.ne]: null },
            }, {
                attributes: ['id', 'first_name', 'employee_code', 'face_descriptor', 'company_id', 'branch_id'],
                raw: true
            }, null, { company_id: true });
            timings.db = Date.now() - dbStart;
            return res;
        })();

        // ⚡ EXECUTE AI AND DB TASKS IN PARALLEL
        const [liveVector, employees] = await Promise.all([
            getEmbeddingTask,
            getEmployeesTask
        ]);

        debugLog("DB-Fetch", `Found ${employees.length} active employees with faces`);

        // --- MATCHING LOGIC ---
        const matchStart = Date.now();
        let bestMatch = null;
        let minDistance = 1.0;

        for (const emp of employees) {
            let storedVector = emp.face_descriptor;

            if (typeof storedVector === 'string') {
                try {
                    storedVector = JSON.parse(storedVector);
                } catch (e) { continue; }
            }

            if (!Array.isArray(storedVector)) continue;

            const dist = calculateCosineDistance(liveVector, storedVector);

            if (dist < minDistance) {
                minDistance = dist;
                bestMatch = emp;
            }
        }

        timings.matching = Date.now() - matchStart;
        const matchPercentage = ((1 - minDistance) * 100).toFixed(2);
        debugLog("Final-Result", `Best: ${bestMatch ? bestMatch.first_name : 'None'} | Score: ${matchPercentage}%`);

        // --- VALIDATION & CONDITIONAL FILE SAVING ---
        if (bestMatch && minDistance < (process.env.FACE_MATCH_THRESHOLD || 0.4)) {
            const transaction = await sequelize.transaction();
            try {
                // 1. Save image for attendance record
                const uploadStart = Date.now();
                const savedFiles = await uploadFile(req, res, constants.ATTENDANCE_FOLDER, transaction);
                timings.upload = Date.now() - uploadStart;

                const savedFilename = savedFiles.image || savedFiles['image'];

                // 2. Use the robust punch helper
                const punchResult = await punch(bestMatch.id, {
                    punch_time: new Date(),
                    image_name: savedFilename,
                    user_id: req.user?.access === 'attendance device' ? 0 : (req.user?.id || bestMatch.user_id),
                    company_id: req.user?.company_id || bestMatch.company_id,
                    branch_id: req.user?.branch_id || bestMatch.branch_id,
                    ip_address: req.ip,
                    latitude: req.body.latitude || null,
                    longitude: req.body.longitude || null,
                    device_id: req.user?.access === 'attendance device' ? req.user.id : (req.body.device_id || null),
                    attendance_by: 'face',
                    skipRebuild: true 
                }, transaction);

                await transaction.commit();

                // ⚡ 3. RUN REBUILD IN BACKGROUND (So user doesn't wait)
                setImmediate(() => {
                    const today = dayjs().format("YYYY-MM-DD");
                    rebuildAttendanceDay(bestMatch.id, today, {
                        user_id: req.user?.id || bestMatch.user_id,
                        company_id: req.user?.company_id || bestMatch.company_id,
                        branch_id: req.user?.branch_id || bestMatch.branch_id
                    }).catch(err => console.error("Background Rebuild Error:", err));
                });

                timings.total = Date.now() - startTime;
                const successMsg = `✅ [Punch Success] ${bestMatch.first_name} (${bestMatch.employee_code}) | Total: ${timings.total}ms | Match: ${matchPercentage}%`;
                console.log(successMsg);
                writeLogToFile('face_recognition.log', successMsg + ` | AI: ${timings.ai}ms | DB: ${timings.db}ms`);
                const time = now.toTimeString().split(' ')[0];
                console.log("end time2222",time)

                return res.success(`${bestMatch.first_name}: Punch Success (${matchPercentage}%)`, {
                    employee_name: bestMatch.first_name,
                    employee_code: bestMatch.employee_code,
                    // punch: punchResult,
                    image_url: `${process.env.FILE_SERVER_URL}${constants.ATTENDANCE_FOLDER}${savedFilename}`,
                    // match_score: matchPercentage,
                    // timings: timings
                });
            } catch (error) {
                const time = now.toTimeString().split(' ')[0];
                console.log("end time333",time)

                if (transaction && !transaction.finished) await transaction.rollback();
                console.error("Error creating attendance records:", error);
                writeLogToFile('face_recognition.log', `❌ [DB Error] Failed to create attendance records: ${error.message}`);
                return res.error(constants.SERVER_ERROR, { message: error.message || "Failed to create attendance records" });
            }
        } else {
            // 🚀 FAST FAIL: Return error immediately, log in background
            timings.total = Date.now() - startTime;
            const failMsg = `❌ [Punch Failed] Match: ${matchPercentage}% | Total: ${timings.total}ms | AI: ${timings.ai}ms | DB: ${timings.db}ms`;
            console.log(failMsg);
            writeLogToFile('face_recognition.log', failMsg);

            // Save to ATTENDANCE_LOG_FOLDER in background
            setImmediate(async () => {
                try {
                    const now = new Date();
                    const dateStr = dayjs(now).format('DD-MM-YYYY');
                    const timeStr = dayjs(now).format('hh:mm A');
                    const ext = path.extname(originalName);
                    const customFilename = `${Date.now()}_failed_${matchPercentage}%_${dateStr}__${timeStr}${ext}`;
                    await uploadFile(req, res, constants.ATTENDANCE_LOG_FOLDER, null, null, customFilename);
                } catch (e) { console.error("Failed to save recognition log:", e); }
            });

            return res.error(constants.FACE_NOT_RECOGNIZED, {
                message: `Face Not Recognized`,
                match_score: matchPercentage,
                timings: timings
            });
        }

    } catch (err) {
        console.error("💥 Server Error:", err);
        writeLogToFile('face_recognition.log', `💥 [CRITICAL] Server Error: ${err.message}`);
        const errorMsg = err.message || "Server Error";
        const statusCode = errorMsg.includes("Face") ? constants.VALIDATION_ERROR : constants.SERVER_ERROR;
        return res.error(statusCode, { message: errorMsg });
    }
};

exports.getWages = async (req, res) => {
    try {
        const { employee_id: employeeId, attendance_date: attendanceDate } = req.body;
        const dayjs = require("dayjs");

        if (!employeeId) {
            return res.error(constants.VALIDATION_ERROR, { message: "Employee ID is required" });
        }

        const targetDate = attendanceDate || dayjs().format("YYYY-MM-DD");

        // Fetch attendance day record for employeeId and specified date
        const attendanceDay = await commonQuery.findOneRecord(
            AttendanceDay,
            {
                employee_id: employeeId,
                attendance_date: targetDate
            },
            {
                attributes: ['id', 'attendance_date', 'first_in', 'last_out', 'overtime_data', 'fine_data']
            },
            null,
            false,
            { company_id: true }
        );

        if (!attendanceDay) {
            return res.error(constants.NOT_FOUND, { message: "Attendance record not found for the selected date" });
        }

        const employee = await commonQuery.findOneRecord(Employee, employeeId, {
            attributes: ['id', 'salary_template_id', 'company_id', 'weekly_off_template', 'shift_template']
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
                attributes: ['id', 'company_id', 'ctc_monthly', 'lwp_calculation_basis', 'salary_type', 'daily_rate', 'hourly_rate']
            }
        );

        // Only calculate wages if employeeSalaryTemplate exists
        if (!employeeSalaryTemplate) {
            const responseData = {
                last_out: attendanceDay.last_out || null,
                overtime_data: attendanceDay?.overtime_data || null,
                fine_data: attendanceDay?.fine_data || null,
            };
            return res.success(constants.SUCCESS, responseData);
        }

        // --- FETCH SHIFT INFO FOR UNIT WORKING HOURS ---
        const dateObj = dayjs(targetDate);
        const dayOfWeek = dateObj.day();

        const empShift = await commonQuery.findOneRecord(EmployeeShift, {
            employee_id: employeeId,
            day_of_week: dayOfWeek,
            status: 0,
        });

        let shift = null;
        if (empShift && empShift.shift_id) {
            shift = await commonQuery.findOneRecord(ShiftTemplate, empShift.shift_id);
        } else if (!empShift && employee.shift_template) {
            shift = await commonQuery.findOneRecord(ShiftTemplate, employee.shift_template);
        } else if (empShift && !empShift.shift_id) {
            shift = empShift; // Manual shift configuration
        }

        let unitWorkingHours = 8;
        if (shift) {
            if (parseFloat(shift.total_payable_hours) > 0) {
                unitWorkingHours = parseFloat(shift.total_payable_hours) / 60;
            } else if (shift.min_full_day_minutes > 0) {
                unitWorkingHours = shift.min_full_day_minutes / 60;
            }
        }
        // -------------------------------------------

        let dailyWage = null;
        let hourlyWage = null;
        let monthDays = null;
        let workingDays = null;
        const ctcMonthly = parseFloat(employeeSalaryTemplate.ctc_monthly || 0);
        const salaryType = employeeSalaryTemplate.salary_type || "Monthly";
        if (salaryType === "Daily") {
            dailyWage = parseFloat(employeeSalaryTemplate.daily_rate || 0);
            hourlyWage = dailyWage / unitWorkingHours;
        } else if (salaryType === "Hourly") {
            hourlyWage = parseFloat(employeeSalaryTemplate.hourly_rate || 0);
            dailyWage = hourlyWage * unitWorkingHours;
        } else {
            // Monthly calculation
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
                        const result = calculateWorkingAndOffDays(weeklyOffTemplate.days, dateObj.toDate());
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
                monthDays = dateObj.daysInMonth();
                dailyWage = ctcMonthly / monthDays;
            } else if (employeeSalaryTemplate.lwp_calculation_basis === 'FIXED_30_DAYS') {
                monthDays = 30;
                dailyWage = ctcMonthly / 30;
            }
            hourlyWage = dailyWage ? dailyWage / unitWorkingHours : null;
        }

        const responseData = {
            ...employeeSalaryTemplate.toJSON(),
            daily_wage: dailyWage ? parseFloat(dailyWage.toFixed(2)) : null,
            hourly_wage: hourlyWage ? parseFloat(hourlyWage.toFixed(2)) : null,
            calculation_basis: employeeSalaryTemplate.lwp_calculation_basis,
            month_days: monthDays,
            working_days: workingDays,
            unit_working_hours: unitWorkingHours,
            last_out: attendanceDay.last_out || null,
            overtime_data: attendanceDay?.overtime_data || null,
            overtime_amount: attendanceDay?.overtime_amount || 0,
            fine_data: attendanceDay?.fine_data || null,
            fine_amount: attendanceDay?.fine_amount || 0,
        };

        return res.success(constants.SUCCESS, responseData);

    } catch (err) {
        return handleError(err, res, req);
    }
};

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

        if (!employee.mobile_no) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, { mobile_no: "Mobile number is required to invite this employee." });
        }

        // Check if user already exists
        let user = await commonQuery.findOneRecord(User, { employee_id }, {}, transaction);

        if (!user) {
            // This case should theoretically not happen with auto-creation, but handle it for legacy employees
            user = await commonQuery.createRecord(User, {
                user_name: employee.first_name,
                email: employee.email,
                mobile_no: employee.mobile_no,
                employee_id: employee.id,
                role_id: 5,
                company_id: employee.company_id,
                branch_id: employee.branch_id,
                company_access: employee.company_id,
                status: 0,
                is_activated: true
            }, transaction);

            // await commonQuery.createRecord(UserCompanyRoles, {
            //     user_id: user.id,
            //     role_id: role_id,
            //     branch_id: employee.branch_id,
            //     company_id: employee.company_id,
            //     permissions: user.permission,
            //     status: 0
            // }, transaction);
        }

        // Generate Activation Code
        const activation_code = crypto.randomBytes(20).toString("hex");

        await commonQuery.updateRecordById(User, user.id, {
            activation_code: activation_code,
            is_activated: true, // Ensure it's reset to false
            status: 0 // Keep inactive
        }, transaction);

        await transaction.commit();

        const setupLink = `${process.env.FRONTEND_URL || 'https://loadly.io/airwix-payroll/'}activate?code=${activation_code}`;

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

/**
 * Gets the list of employees for the branch corresponding to the logged-in device/user.
 * Returns: { id, first_name, employee_code, has_face_descriptor }
 */
exports.getEmployeesByDeviceBranch = async (req, res) => {
    try {
        const { branch_id, company_id } = req.user;
        const { search } = req.query || req.body;

        if (!branch_id) {
            return res.error(constants.VALIDATION_ERROR, { message: "No branch identifier found in session." });
        }

        const where = {
            branch_id,
            company_id,
            status: STATUS.ACTIVE
        };

        if (search) {
            where[Op.or] = [
                { first_name: { [Op.iLike]: `%${search}%` } },
                { employee_code: { [Op.iLike]: `%${search}%` } }
            ];
        }

        const employees = await Employee.findAll({
            where,
            attributes: ['id', 'first_name', 'employee_code', 'face_descriptor', 'profile_image'],
            order: [['first_name', 'ASC']]
        });

        const employeeList = employees.map(emp => ({
            id: emp.id,
            employee_name: emp.first_name,
            employee_code: emp.employee_code,
            face_descriptor: emp.face_descriptor,
            has_face_descriptor: !!emp.face_descriptor,
            profile_image_url: emp.profile_image ? `${process.env.FILE_SERVER_URL}${constants.EMPLOYEE_IMG_FOLDER}${emp.profile_image}` : null
        }));

        return res.success("Employee list fetched successfully", { employees: employeeList });

    } catch (err) {
        return handleError(err, res, req);
    }
};

/**
 * Get employee holidays by employee ID using commonQuery findAllRecords mode
 */
exports.getEmployeeHolidays = async (req, res) => {
    try {
        let employeeId = req.params.id;
        if (!employeeId) {
            employeeId = req.user.employee_id;
        }

        if (!employeeId) {
            return res.error(constants.VALIDATION_ERROR, { message: "Employee ID is required" });
        }

        // Verify employee exists
        const employee = await commonQuery.findOneRecord(Employee, employeeId);
        if (!employee) {
            return res.error(constants.NOT_FOUND, { message: "Employee not found" });
        }

        // Get holidays for the employee using commonQuery findAllRecords
        const holidays = await commonQuery.findAllRecords(
            EmployeeHoliday, 
            {
                employee_id: employeeId
            }
        );

        return res.success("Employee holidays retrieved successfully", { holidays });

    } catch (err) {
        return handleError(err, res, req);
    }
};