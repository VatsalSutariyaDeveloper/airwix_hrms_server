const { User, Employee, RolePermission, DesignationMaster, LeaveTemplate, ResignationTemplate, EmployeeAttendanceTemplate, AttendanceTemplate, CompanySettings } = require("../models");
const { Op } = require("sequelize");
const commonQuery = require("./commonQuery");
const { constants } = require("./constants");

// Helper to query and format user information (Name + Designation/Role)
async function getApproverInfo(userId, companyId) {
    if (!userId) return null;
    try {
        const user = await commonQuery.findOneRecord(User, { id: userId }, {
            include: [
                { model: RolePermission, as: "RolePermission", attributes: ["role_name"] },
                {
                    model: Employee,
                    as: "Employee",
                    attributes: ["first_name", "employee_code"],
                    include: [{ model: DesignationMaster, as: "designation", attributes: ["designation_name"] }]
                }
            ]
        });

        if (!user) return null;

        let name = "";
        if (user.Employee) {
            name = (user.Employee.first_name || "").trim();
        } else {
            name = user.user_name || user.email;
        }

        const role = user.Employee?.designation?.designation_name ||
            user.RolePermission?.role_name ||
            (user.is_super_admin ? "Super Admin" : "System User");

        return { name, role };
    } catch (err) {
        console.error(`Error fetching approver info for userId ${userId}:`, err);
        return null;
    }
}

// Fetch all system Admin & Super Admin users
async function getAdmins(companyId) {
    try {
        const adminUsers = await commonQuery.findAllRecords(User, {
            company_id: companyId,
            status: 0,
            [Op.or]: [
                { is_super_admin: true },
                { '$RolePermission.role_key$': constants.ROLE_KEYS.BUSINESS_ADMIN },
                { '$RolePermission.role_key$': constants.ROLE_KEYS.ADMIN }
            ]
        }, {
            include: [
                { model: RolePermission, as: "RolePermission", attributes: ["role_name"] },
                {
                    model: Employee,
                    as: "Employee",
                    attributes: ["first_name", "employee_code"],
                    include: [{ model: DesignationMaster, as: "designation", attributes: ["designation_name"] }]
                }
            ]
        });

        return adminUsers.map(user => {
            let name = "";
            if (user.Employee) {
                name = (user.Employee.first_name || "").trim();
            } else {
                name = user.user_name || user.email;
            }

            const role = user.Employee?.designation?.designation_name ||
                user.RolePermission?.role_name ||
                (user.is_super_admin ? "Super Admin" : "System User");

            return { name, role };
        });
    } catch (err) {
        console.error("Error fetching admin users:", err);
        return [];
    }
}

/**
 * Resolves details about who a request is pending with.
 * @param {Object} request - The request object (LeaveRequest, OutDutyRequest, etc.)
 * @param {String} type - "LEAVE" | "OUT_DUTY" | "REGULARIZATION" | "REIMBURSEMENT" | "RESIGNATION"
 * @returns {Promise<Object>} - { pending_approvers: Array, pending_with_text: String }
 */
// async function resolvePendingApprovers(request, type) {
//     let approvers = [];
//     let label = "Pending Approver";

//     try {
//         // First, fetch the Employee object if not already fully included or if it is incomplete
//         let employee = request.employee;
//         const employeeId = request.employee_id || (employee && employee.id);

//         const isEmployeeIncomplete = !employee ||
//             employee.reporting_manager === undefined ||
//             employee.attendance_supervisor === undefined ||
//             employee.company_id === undefined ||
//             (type === "LEAVE" && employee.leaveTemplate === undefined) ||
//             (type === "REGULARIZATION" && employee.leaveTemplate === undefined) ||
//             (type === "OUT_DUTY" && employee.employeeAttendanceTemplate === undefined && employee.attendanceTemplate === undefined) ||
//             (type === "RESIGNATION" && employee.resignationTemplate === undefined);

//         if (isEmployeeIncomplete && employeeId) {
//             employee = await commonQuery.findOneRecord(Employee, { id: employeeId }, {
//                 include: [
//                     { model: LeaveTemplate, as: "leaveTemplate" },
//                     { model: ResignationTemplate, as: "resignationTemplate" },
//                     { model: EmployeeAttendanceTemplate, as: "employeeAttendanceTemplate", where: { status: 0 }, required: false },
//                     { model: AttendanceTemplate, as: "attendanceTemplate", required: false }
//                 ]
//             });
//         }

//         if (!employee) {
//             console.log("resolvePendingApprovers DBG: No employee found");
//             return { pending_with: [] };
//         }

//         const companyId = request.company_id || employee.company_id;
//         console.log("resolvePendingApprovers DBG: companyId =", companyId, "type =", type);

//         if (type === "LEAVE" || type === "REGULARIZATION") {
//             const template = employee.leaveTemplate;
//             const currentLevel = request.current_level || 1;
//             const config = template ? (template.approval_config || []) : [];
//             const stage = config.find(c => c.level === currentLevel) || { type: "ANYONE", label: `Level ${currentLevel}` };

//             console.log("resolvePendingApprovers DBG: currentLevel =", currentLevel, "stage =", JSON.stringify(stage));

//             label = stage.label || `Level ${currentLevel}`;

//             if (stage.type === "REPORTING_MANAGER" && employee.reporting_manager) {
//                 console.log("resolvePendingApprovers DBG: REPORTING_MANAGER branch");
//                 const info = await getApproverInfo(employee.reporting_manager, companyId);
//                 if (info) approvers.push({ ...info, type: "Reporting Manager" });
//             } else if (stage.type === "ATTENDANCE_SUPERVISOR" && employee.attendance_supervisor) {
//                 console.log("resolvePendingApprovers DBG: ATTENDANCE_SUPERVISOR branch");
//                 const info = await getApproverInfo(employee.attendance_supervisor, companyId);
//                 if (info) approvers.push({ ...info, type: "Attendance Supervisor" });
//             } else if (stage.type === "ADMIN" || stage.type === "EMPLOYER") {
//                 console.log("resolvePendingApprovers DBG: ADMIN/EMPLOYER branch");
//                 const admins = await getAdmins(companyId);
//                 console.log("resolvePendingApprovers DBG: admins fetched =", admins.length);
//                 admins.forEach(admin => approvers.push({ ...admin, type: stage.type }));
//             } else if (stage.type === "ANYONE") {
//                 console.log("resolvePendingApprovers DBG: ANYONE branch");
//                 const addedUserIds = new Set();
//                 if (employee.reporting_manager) {
//                     const info = await getApproverInfo(employee.reporting_manager, companyId);
//                     if (info) {
//                         approvers.push({ ...info, type: "Reporting Manager" });
//                         addedUserIds.add(employee.reporting_manager);
//                     }
//                 }
//                 if (employee.attendance_supervisor && !addedUserIds.has(employee.attendance_supervisor)) {
//                     const info = await getApproverInfo(employee.attendance_supervisor, companyId);
//                     if (info) {
//                         approvers.push({ ...info, type: "Attendance Supervisor" });
//                         addedUserIds.add(employee.attendance_supervisor);
//                     }
//                 }
//                 const admins = await getAdmins(companyId);
//                 console.log("resolvePendingApprovers DBG: admins fetched in ANYONE =", admins.length);
//                 admins.forEach(admin => approvers.push({ ...admin, type: "Admin" }));
//             }
//         }
//         else if (type === "OUT_DUTY") {
//             const template = employee.employeeAttendanceTemplate || employee.attendanceTemplate;
//             const currentLevel = request.current_out_duty_level || 1;
//             let levelConfigs = template ? (template.out_duty_approval_config || []) : [];
//             if (typeof levelConfigs === "string") {
//                 try { levelConfigs = JSON.parse(levelConfigs); } catch (e) { levelConfigs = []; }
//             }
//             if (!Array.isArray(levelConfigs)) levelConfigs = [];
//             const stage = levelConfigs.find(c => c.level === currentLevel) || { type: "ANYONE", label: `Level ${currentLevel}` };

//             label = stage.label || `Level ${currentLevel}`;

//             if (stage.type === "REPORTING_MANAGER" && employee.reporting_manager) {
//                 const info = await getApproverInfo(employee.reporting_manager, companyId);
//                 if (info) approvers.push({ ...info, type: "Reporting Manager" });
//             } else if (stage.type === "ATTENDANCE_SUPERVISOR" && employee.attendance_supervisor) {
//                 const info = await getApproverInfo(employee.attendance_supervisor, companyId);
//                 if (info) approvers.push({ ...info, type: "Attendance Supervisor" });
//             } else if (stage.type === "ADMIN" || stage.type === "EMPLOYER") {
//                 const admins = await getAdmins(companyId);
//                 admins.forEach(admin => approvers.push({ ...admin, type: stage.type }));
//             } else if (stage.type === "ANYONE") {
//                 const addedUserIds = new Set();
//                 if (employee.reporting_manager) {
//                     const info = await getApproverInfo(employee.reporting_manager, companyId);
//                     if (info) {
//                         approvers.push({ ...info, type: "Reporting Manager" });
//                         addedUserIds.add(employee.reporting_manager);
//                     }
//                 }
//                 if (employee.attendance_supervisor && !addedUserIds.has(employee.attendance_supervisor)) {
//                     const info = await getApproverInfo(employee.attendance_supervisor, companyId);
//                     if (info) {
//                         approvers.push({ ...info, type: "Attendance Supervisor" });
//                         addedUserIds.add(employee.attendance_supervisor);
//                     }
//                 }
//                 const admins = await getAdmins(companyId);
//                 admins.forEach(admin => approvers.push({ ...admin, type: "Admin" }));
//             }
//         }
//         else if (type === "REIMBURSEMENT") {
//             label = `Level ${request.current_level || 1}`;
//             const addedUserIds = new Set();
//             if (employee.reporting_manager) {
//                 const info = await getApproverInfo(employee.reporting_manager, companyId);
//                 if (info) {
//                     approvers.push({ ...info, type: "Reporting Manager" });
//                     addedUserIds.add(employee.reporting_manager);
//                 }
//             }
//             if (employee.attendance_supervisor && !addedUserIds.has(employee.attendance_supervisor)) {
//                 const info = await getApproverInfo(employee.attendance_supervisor, companyId);
//                 if (info) {
//                     approvers.push({ ...info, type: "Attendance Supervisor" });
//                     addedUserIds.add(employee.attendance_supervisor);
//                 }
//             }
//             const admins = await getAdmins(companyId);
//             admins.forEach(admin => approvers.push({ ...admin, type: "Admin" }));
//         }
//         else if (type === "RESIGNATION") {
//             const template = employee.resignationTemplate;
//             const currentLevel = request.current_level || 1;
//             const config = template ? (template.approval_config || []) : [];
//             const stage = config.find(c => c.level === currentLevel) || { type: "ANYONE", label: `Level ${currentLevel}` };

//             label = stage.label || `Level ${currentLevel}`;

//             if (stage.type === "REPORTING_MANAGER" && employee.reporting_manager) {
//                 const info = await getApproverInfo(employee.reporting_manager, companyId);
//                 if (info) approvers.push({ ...info, type: "Reporting Manager" });
//             } else if (stage.type === "ATTENDANCE_SUPERVISOR" && employee.attendance_supervisor) {
//                 const info = await getApproverInfo(employee.attendance_supervisor, companyId);
//                 if (info) approvers.push({ ...info, type: "Attendance Supervisor" });
//             } else if (stage.type === "ADMIN" || stage.type === "EMPLOYER") {
//                 const admins = await getAdmins(companyId);
//                 admins.forEach(admin => approvers.push({ ...admin, type: stage.type }));
//             } else if (stage.type === "ANYONE") {
//                 const addedUserIds = new Set();
//                 if (employee.reporting_manager) {
//                     const info = await getApproverInfo(employee.reporting_manager, companyId);
//                     if (info) {
//                         approvers.push({ ...info, type: "Reporting Manager" });
//                         addedUserIds.add(employee.reporting_manager);
//                     }
//                 }
//                 if (employee.attendance_supervisor && !addedUserIds.has(employee.attendance_supervisor)) {
//                     const info = await getApproverInfo(employee.attendance_supervisor, companyId);
//                     if (info) {
//                         approvers.push({ ...info, type: "Attendance Supervisor" });
//                         addedUserIds.add(employee.attendance_supervisor);
//                     }
//                 }
//                 const admins = await getAdmins(companyId);
//                 admins.forEach(admin => approvers.push({ ...admin, type: "Admin" }));
//             }
//         }
//     } catch (err) {
//         console.error(`Error resolving pending approvers for request type ${type}:`, err);
//     }

//     const currentLevel = type === "OUT_DUTY" ? (request.current_out_duty_level || 1) : (request.current_level || 1);
//     const pending_with = approvers.map(a => ({
//         level: currentLevel,
//         name: a.name,
//         role: a.type
//     }));

//     return {
//         pending_with
//     };
// }
/**
 * Resolves details about who a request is pending with.
 * @param {Object} request - The request object
 * @param {String} type - "LEAVE" | "OUT_DUTY" | "REIMBURSEMENT" | "LEAVE_ENCASHMENT"
 * @returns {Promise<Object>} - { pending_with: Array }
 */
async function resolvePendingApprovers(request, type) {
    let approvers = [];
    let label = "Pending Approver";

    try {
        let employee = request.employee;
        const employeeId = request.employee_id || (employee && employee.id);

        const needsLeaveTemplate = type === "LEAVE" && (!employee || !employee.leaveTemplate);
        const needsAttendanceTemplate = (type === "OUT_DUTY" || type === "REGULARIZATION" || type === "ATTENDANCE_APPROVAL") && (!employee || (!employee.employeeAttendanceTemplate && !employee.attendanceTemplate));
        const needsResignationTemplate = type === "RESIGNATION" && (!employee || !employee.resignationTemplate);

        // 1. Fetch complete employee details if missing or template is missing
        if ((!employee || needsLeaveTemplate || needsAttendanceTemplate || needsResignationTemplate) && employeeId) {
            employee = await commonQuery.findOneRecord(Employee, { id: employeeId }, {
                include: [
                    { model: LeaveTemplate, as: "leaveTemplate" },
                    { model: EmployeeAttendanceTemplate, as: "employeeAttendanceTemplate", where: { status: 0 }, required: false },
                    { model: AttendanceTemplate, as: "attendanceTemplate", required: false }
                ]
            });
        }

        if (!employee) return { pending_with: [] };

        const companyId = request.company_id || employee.company_id;

        // 2. ROUTING LOGIC: Find the exact configuration based on request type
        let rawConfig = [];
        let currentLevel = request.current_level || 1;

        if (type === "OUT_DUTY") {
            currentLevel = request.current_out_duty_level || request.current_level || 1;
        }

        switch (type) {
            case "LEAVE":
                const leaveTemplate = employee.leaveTemplate;
                rawConfig = leaveTemplate ? (leaveTemplate.approval_config || []) : [];
                break;

            case "OUT_DUTY":
                // Priority: Employee Attendance Template -> General Attendance Template
                const odTemplate = employee.employeeAttendanceTemplate || employee.attendanceTemplate;
                rawConfig = odTemplate ? (odTemplate.out_duty_approval_config || []) : [];
                break;

            case "REIMBURSEMENT": {
                // Fetches company settings ONLY when needed
                const companySettings = await commonQuery.findOneRecord(CompanySettings, { company_id: companyId, settings_name: "reimbursement_approval_config" });
                rawConfig = companySettings ? (companySettings.settings_value || []) : [];
                break;
            }

            case "LEAVE_ENCASHMENT": {
                // Fetches leave encashment approval config from company settings (supporting both names due to client mismatch)
                let encashmentSettings = await commonQuery.findOneRecord(CompanySettings, { company_id: companyId, settings_name: "leave_encashment_approval_config" });
                if (!encashmentSettings) {
                    encashmentSettings = await commonQuery.findOneRecord(CompanySettings, { company_id: companyId, settings_name: "encashment_approval_config" });
                }
                rawConfig = encashmentSettings ? (encashmentSettings.settings_value || []) : [];
                break;
            }

            case "REGULARIZATION": {
                const configRecord = await commonQuery.findOneRecord(CompanySettings, { company_id: companyId, settings_name: "regularization_approval_config" }, {}, null, false, false);
                let config = configRecord ? configRecord.settings_value : [];
                if (typeof config === "string") {
                    try { config = JSON.parse(config); } catch (e) { config = []; }
                }
                rawConfig = config;
                break;
            }

            case "ATTENDANCE_APPROVAL": {
                const configRecord = await commonQuery.findOneRecord(CompanySettings, { company_id: companyId, settings_name: "attendance_approval_config" }, {}, null, false, false);
                let config = configRecord ? configRecord.settings_value : [];
                if (typeof config === "string") {
                    try { config = JSON.parse(config); } catch (e) { config = []; }
                }
                if (config && !Array.isArray(config) && typeof config === "object" && Array.isArray(config.approval_config)) {
                    config = config.approval_config;
                }
                rawConfig = config;
                break;
            }
        }

        // 3. Safety Check: Parse JSON if the database returns a string
        let config = rawConfig;
        if (typeof config === "string") {
            try { config = JSON.parse(config); } catch (e) { config = []; }
        }
        if (!Array.isArray(config)) config = [];

        // 4. Identify the Required Approver Role for the Current Level
        // Defaults to "ANYONE" to allow Reporting Manager, Attendance Supervisor, Admin, and Super Admin to approve
        const stage = config.find(c => Number(c.level) === Number(currentLevel)) || {
            type: currentLevel > 1 ? "ADMIN" : "ANYONE",
            label: `Level ${currentLevel}`
        };
        label = stage.label || `Level ${currentLevel}`;

        let stageType = (stage.type || "REPORTING_MANAGER").toString().toUpperCase();
        if (stageType === "3") stageType = "REPORTING_MANAGER";
        if (stageType === "4") stageType = "ATTENDANCE_SUPERVISOR";

        // 5. Build the pending_with Array based on the identified stage type
        if (stageType === "REPORTING_MANAGER" && employee.reporting_manager) {
            const info = await getApproverInfo(employee.reporting_manager, companyId);
            if (info) approvers.push({ ...info, type: "Reporting Manager" });

        } else if (stageType === "ATTENDANCE_SUPERVISOR" && employee.attendance_supervisor) {
            const info = await getApproverInfo(employee.attendance_supervisor, companyId);
            if (info) approvers.push({ ...info, type: "Attendance Supervisor" });

        } else if (stageType === "ADMIN" || stageType === "EMPLOYER") {
            const admins = await getAdmins(companyId);
            admins.forEach(admin => approvers.push({ ...admin, type: admin.role || (stageType === "EMPLOYER" ? "Employer" : "Admin") }));

        } else if (stageType === "ANYONE") {
            const addedUserIds = new Set();
            if (employee.reporting_manager) {
                const info = await getApproverInfo(employee.reporting_manager, companyId);
                if (info) { approvers.push({ ...info, type: "Reporting Manager" }); addedUserIds.add(employee.reporting_manager); }
            }
            if (employee.attendance_supervisor && !addedUserIds.has(employee.attendance_supervisor)) {
                const info = await getApproverInfo(employee.attendance_supervisor, companyId);
                if (info) { approvers.push({ ...info, type: "Attendance Supervisor" }); addedUserIds.add(employee.attendance_supervisor); }
            }
            const admins = await getAdmins(companyId);
            admins.forEach(admin => approvers.push({ ...admin, type: admin.role || "Admin" }));
        }

    } catch (err) {
        console.error(`Error resolving pending approvers for request type ${type}:`, err);
    }

    return {
        pending_with: approvers.map(a => ({
            level: (type === "OUT_DUTY" ? (request.current_out_duty_level || request.current_level || 1) : (request.current_level || 1)),
            name: a.name,
            role: a.type
        }))
    };
}

/**
 * Calculates progression state for a multi-level approval request.
 * 
 * @param {Object} options
 * @param {String|Number} options.targetStatus - The requested action (e.g. APPROVED, REJECTED, CANCELLED constants)
 * @param {Number} options.currentLevel - The current approval level
 * @param {Number} options.totalLevels - The maximum/configured levels of approval
 * @param {Boolean} options.isSuperAdmin - Whether the action is performed by a super admin
 * @param {Array} options.approvalHistory - Current approval history array
 * @param {Object} options.statusMapping - Map containing keys: APPROVED, PARTIALLY_APPROVED, REJECTED, CANCELLED
 * @param {Object} options.historyItem - The template/attributes of the history item to push (must include action, by/approved_by, etc.)
 * @param {Object} options.bypassOptions - Controlling how super-admin bypass is noted:
 *                 - {Boolean} attachToPreviousItem: If true, sets note on the last item in history *before* pushing the new one.
 *                 - {Boolean} attachToNewItem: If true, includes note inside the pushed history item itself.
 *                 - {String} note: The note text, defaults to "Bypassed remaining levels via Super Admin"
 * @returns {Object} { newStatus, newLevel, isBypass, updatedHistory }
 */
function getNextApprovalState({
    targetStatus,
    currentLevel,
    totalLevels,
    isSuperAdmin,
    approvalHistory = [],
    statusMapping,
    historyItem,
    bypassOptions = {}
}) {
    const isApproved = String(targetStatus) === String(statusMapping.APPROVED) || targetStatus === "APPROVED";

    let newStatus;
    let newLevel = currentLevel;
    let isBypass = false;

    if (isApproved) {
        if (currentLevel < totalLevels && !isSuperAdmin) {
            newStatus = statusMapping.PARTIALLY_APPROVED;
            newLevel = currentLevel + 1;
        } else {
            newStatus = statusMapping.APPROVED;
            if (isSuperAdmin && currentLevel < totalLevels) {
                isBypass = true;
                newLevel = totalLevels;
            } else {
                newLevel = totalLevels;
            }
        }
    } else {
        const isRejected = targetStatus === "REJECTED" || String(targetStatus) === String(statusMapping.REJECTED);
        newStatus = isRejected ? statusMapping.REJECTED : statusMapping.CANCELLED;
    }

    const updatedHistory = [...(approvalHistory || [])];

    if (historyItem) {
        const itemToPush = { ...historyItem };

        if (isBypass) {
            const noteText = bypassOptions.note || "Bypassed remaining levels via Super Admin";

            if (bypassOptions.attachToNewItem) {
                itemToPush.note = noteText;
            } else if (bypassOptions.attachToPreviousItem && updatedHistory.length > 0) {
                updatedHistory[updatedHistory.length - 1] = {
                    ...updatedHistory[updatedHistory.length - 1],
                    note: noteText
                };
            }
        }

        updatedHistory.push(itemToPush);

        // Default bypass mode (after push, like leave / reimbursement)
        if (isBypass && !bypassOptions.attachToNewItem && !bypassOptions.attachToPreviousItem && updatedHistory.length > 0) {
            updatedHistory[updatedHistory.length - 1].note = bypassOptions.note || "Bypassed remaining levels via Super Admin";
        }
    }

    return {
        newStatus,
        newLevel,
        isBypass,
        updatedHistory
    };
}

/**
 * Verifies if a user is authorized to approve/reject a request at the current template stage.
 * 
 * @param {Object} options
 * @param {Object} options.user - The logged-in user object (req.user)
 * @param {Object} options.employee - The employee record associated with the request (with reporting_manager, etc.)
 * @param {String} options.stageType - The type of stage (REPORTING_MANAGER, ATTENDANCE_SUPERVISOR, ADMIN, EMPLOYER, ANYONE)
 * @param {Boolean} options.isOwnRequest - True if the employee ID of the request matches the user's employee ID
 * @param {Boolean} options.useEmployeeIdForManager - If true, compares employee.reporting_manager against user.employee_id instead of user.id
 * @param {Boolean} options.allowCrossRoleManagerSupervisor - If true, allows either reporting manager or supervisor to match for manager/supervisor stage types (resignation flow)
 * @returns {Boolean}
 */
function isUserAuthorizedForStage({
    user,
    employee,
    stageType,
    isOwnRequest = false,
    useEmployeeIdForManager = false,
    allowCrossRoleManagerSupervisor = false
}) {
    const isSuperAdmin = (user.role_key === 'BUSINESS_ADMIN' && user.is_super_admin) || user.is_super_admin;
    if (isSuperAdmin && !isOwnRequest) {
        return true;
    }

    let type = (stageType || "ANYONE").toString().toUpperCase();
    if (type === "3") type = "REPORTING_MANAGER";
    if (type === "4") type = "ATTENDANCE_SUPERVISOR";

    const managerId = useEmployeeIdForManager ? user.employee_id : user.id;
    const supervisorId = useEmployeeIdForManager ? user.employee_id : user.id;
    const isAdmin = user.role_key === 'ADMIN' || user.is_admin || isSuperAdmin;

    const isMatchReportingManager = employee.reporting_manager === managerId;
    const isMatchAttendanceSupervisor = employee.attendance_supervisor === supervisorId;

    switch (type) {
        case 'REPORTING_MANAGER':
            if (allowCrossRoleManagerSupervisor) {
                return isMatchReportingManager || isMatchAttendanceSupervisor || isSuperAdmin;
            }
            return isMatchReportingManager || isSuperAdmin;

        case 'ATTENDANCE_SUPERVISOR':
            if (allowCrossRoleManagerSupervisor) {
                return isMatchReportingManager || isMatchAttendanceSupervisor || isSuperAdmin;
            }
            return isMatchAttendanceSupervisor || isSuperAdmin;

        case 'ADMIN':
        case 'EMPLOYER':
            return isAdmin;

        case 'ANYONE':
            return isMatchReportingManager || isMatchAttendanceSupervisor || isSuperAdmin;

        default:
            return false;
    }
}

module.exports = {
    resolvePendingApprovers,
    getNextApprovalState,
    isUserAuthorizedForStage
};
