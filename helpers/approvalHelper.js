const { User, Employee, RolePermission, DesignationMaster, LeaveTemplate, ResignationTemplate, EmployeeAttendanceTemplate, AttendanceTemplate } = require("../models");
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
async function resolvePendingApprovers(request, type) {
    let approvers = [];
    let label = "Pending Approver";

    try {
        // First, fetch the Employee object if not already fully included or if it is incomplete
        let employee = request.employee;
        const employeeId = request.employee_id || (employee && employee.id);

        const isEmployeeIncomplete = !employee || 
            employee.reporting_manager === undefined || 
            employee.attendance_supervisor === undefined ||
            employee.company_id === undefined ||
            (type === "LEAVE" && employee.leaveTemplate === undefined) ||
            (type === "REGULARIZATION" && employee.leaveTemplate === undefined) ||
            (type === "OUT_DUTY" && employee.employeeAttendanceTemplate === undefined && employee.attendanceTemplate === undefined) ||
            (type === "RESIGNATION" && employee.resignationTemplate === undefined);

        if (isEmployeeIncomplete && employeeId) {
            employee = await commonQuery.findOneRecord(Employee, { id: employeeId }, {
                include: [
                    { model: LeaveTemplate, as: "leaveTemplate" },
                    { model: ResignationTemplate, as: "resignationTemplate" },
                    { model: EmployeeAttendanceTemplate, as: "employeeAttendanceTemplate", where: { status: 0 }, required: false },
                    { model: AttendanceTemplate, as: "attendanceTemplate", required: false }
                ]
            });
        }

        if (!employee) {
            console.log("resolvePendingApprovers DBG: No employee found");
            return { pending_with: [] };
        }

        const companyId = request.company_id || employee.company_id;
        console.log("resolvePendingApprovers DBG: companyId =", companyId, "type =", type);

        if (type === "LEAVE" || type === "REGULARIZATION") {
            const template = employee.leaveTemplate;
            const currentLevel = request.current_level || 1;
            const config = template ? (template.approval_config || []) : [];
            const stage = config.find(c => c.level === currentLevel) || { type: "ANYONE", label: `Level ${currentLevel}` };

            console.log("resolvePendingApprovers DBG: currentLevel =", currentLevel, "stage =", JSON.stringify(stage));

            label = stage.label || `Level ${currentLevel}`;

            if (stage.type === "REPORTING_MANAGER" && employee.reporting_manager) {
                console.log("resolvePendingApprovers DBG: REPORTING_MANAGER branch");
                const info = await getApproverInfo(employee.reporting_manager, companyId);
                if (info) approvers.push({ ...info, type: "Reporting Manager" });
            } else if (stage.type === "ATTENDANCE_SUPERVISOR" && employee.attendance_supervisor) {
                console.log("resolvePendingApprovers DBG: ATTENDANCE_SUPERVISOR branch");
                const info = await getApproverInfo(employee.attendance_supervisor, companyId);
                if (info) approvers.push({ ...info, type: "Attendance Supervisor" });
            } else if (stage.type === "ADMIN" || stage.type === "EMPLOYER") {
                console.log("resolvePendingApprovers DBG: ADMIN/EMPLOYER branch");
                const admins = await getAdmins(companyId);
                console.log("resolvePendingApprovers DBG: admins fetched =", admins.length);
                admins.forEach(admin => approvers.push({ ...admin, type: stage.type }));
            } else if (stage.type === "ANYONE") {
                console.log("resolvePendingApprovers DBG: ANYONE branch");
                const addedUserIds = new Set();
                if (employee.reporting_manager) {
                    const info = await getApproverInfo(employee.reporting_manager, companyId);
                    if (info) {
                        approvers.push({ ...info, type: "Reporting Manager" });
                        addedUserIds.add(employee.reporting_manager);
                    }
                }
                if (employee.attendance_supervisor && !addedUserIds.has(employee.attendance_supervisor)) {
                    const info = await getApproverInfo(employee.attendance_supervisor, companyId);
                    if (info) {
                        approvers.push({ ...info, type: "Attendance Supervisor" });
                        addedUserIds.add(employee.attendance_supervisor);
                    }
                }
                const admins = await getAdmins(companyId);
                console.log("resolvePendingApprovers DBG: admins fetched in ANYONE =", admins.length);
                admins.forEach(admin => approvers.push({ ...admin, type: "Admin" }));
            }
        } 
        else if (type === "OUT_DUTY") {
            const template = employee.employeeAttendanceTemplate || employee.attendanceTemplate;
            const currentLevel = request.current_out_duty_level || 1;
            let levelConfigs = template ? (template.out_duty_approval_config || []) : [];
            if (typeof levelConfigs === "string") {
                try { levelConfigs = JSON.parse(levelConfigs); } catch (e) { levelConfigs = []; }
            }
            if (!Array.isArray(levelConfigs)) levelConfigs = [];
            const stage = levelConfigs.find(c => c.level === currentLevel) || { type: "ANYONE", label: `Level ${currentLevel}` };

            label = stage.label || `Level ${currentLevel}`;

            if (stage.type === "REPORTING_MANAGER" && employee.reporting_manager) {
                const info = await getApproverInfo(employee.reporting_manager, companyId);
                if (info) approvers.push({ ...info, type: "Reporting Manager" });
            } else if (stage.type === "ATTENDANCE_SUPERVISOR" && employee.attendance_supervisor) {
                const info = await getApproverInfo(employee.attendance_supervisor, companyId);
                if (info) approvers.push({ ...info, type: "Attendance Supervisor" });
            } else if (stage.type === "ADMIN" || stage.type === "EMPLOYER") {
                const admins = await getAdmins(companyId);
                admins.forEach(admin => approvers.push({ ...admin, type: stage.type }));
            } else if (stage.type === "ANYONE") {
                const addedUserIds = new Set();
                if (employee.reporting_manager) {
                    const info = await getApproverInfo(employee.reporting_manager, companyId);
                    if (info) {
                        approvers.push({ ...info, type: "Reporting Manager" });
                        addedUserIds.add(employee.reporting_manager);
                    }
                }
                if (employee.attendance_supervisor && !addedUserIds.has(employee.attendance_supervisor)) {
                    const info = await getApproverInfo(employee.attendance_supervisor, companyId);
                    if (info) {
                        approvers.push({ ...info, type: "Attendance Supervisor" });
                        addedUserIds.add(employee.attendance_supervisor);
                    }
                }
                const admins = await getAdmins(companyId);
                admins.forEach(admin => approvers.push({ ...admin, type: "Admin" }));
            }
        } 
        else if (type === "REIMBURSEMENT") {
            label = `Level ${request.current_level || 1}`;
            const addedUserIds = new Set();
            if (employee.reporting_manager) {
                const info = await getApproverInfo(employee.reporting_manager, companyId);
                if (info) {
                    approvers.push({ ...info, type: "Reporting Manager" });
                    addedUserIds.add(employee.reporting_manager);
                }
            }
            if (employee.attendance_supervisor && !addedUserIds.has(employee.attendance_supervisor)) {
                const info = await getApproverInfo(employee.attendance_supervisor, companyId);
                if (info) {
                    approvers.push({ ...info, type: "Attendance Supervisor" });
                    addedUserIds.add(employee.attendance_supervisor);
                }
            }
            const admins = await getAdmins(companyId);
            admins.forEach(admin => approvers.push({ ...admin, type: "Admin" }));
        } 
        else if (type === "RESIGNATION") {
            const template = employee.resignationTemplate;
            const currentLevel = request.current_level || 1;
            const config = template ? (template.approval_config || []) : [];
            const stage = config.find(c => c.level === currentLevel) || { type: "ANYONE", label: `Level ${currentLevel}` };

            label = stage.label || `Level ${currentLevel}`;

            if (stage.type === "REPORTING_MANAGER" && employee.reporting_manager) {
                const info = await getApproverInfo(employee.reporting_manager, companyId);
                if (info) approvers.push({ ...info, type: "Reporting Manager" });
            } else if (stage.type === "ATTENDANCE_SUPERVISOR" && employee.attendance_supervisor) {
                const info = await getApproverInfo(employee.attendance_supervisor, companyId);
                if (info) approvers.push({ ...info, type: "Attendance Supervisor" });
            } else if (stage.type === "ADMIN" || stage.type === "EMPLOYER") {
                const admins = await getAdmins(companyId);
                admins.forEach(admin => approvers.push({ ...admin, type: stage.type }));
            } else if (stage.type === "ANYONE") {
                const addedUserIds = new Set();
                if (employee.reporting_manager) {
                    const info = await getApproverInfo(employee.reporting_manager, companyId);
                    if (info) {
                        approvers.push({ ...info, type: "Reporting Manager" });
                        addedUserIds.add(employee.reporting_manager);
                    }
                }
                if (employee.attendance_supervisor && !addedUserIds.has(employee.attendance_supervisor)) {
                    const info = await getApproverInfo(employee.attendance_supervisor, companyId);
                    if (info) {
                        approvers.push({ ...info, type: "Attendance Supervisor" });
                        addedUserIds.add(employee.attendance_supervisor);
                    }
                }
                const admins = await getAdmins(companyId);
                admins.forEach(admin => approvers.push({ ...admin, type: "Admin" }));
            }
        }
    } catch (err) {
        console.error(`Error resolving pending approvers for request type ${type}:`, err);
    }

    const currentLevel = type === "OUT_DUTY" ? (request.current_out_duty_level || 1) : (request.current_level || 1);
    const pending_with = approvers.map(a => ({
        level: currentLevel,
        name: a.name,
        role: a.type
    }));

    return {
        pending_with
    };
}

module.exports = {
    resolvePendingApprovers
};
