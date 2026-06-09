const { validateRequest, commonQuery, handleError, Op } = require("../../helpers");
const notificationService = require("../../services/notificationService");
const { constants } = require("../../helpers/constants");
const { sequelize, AttendanceRegularization , User, Employee, EmployeeAttendanceTemplate, AttendanceTemplate, LeaveTemplate } = require("../../models");
const { rebuildAttendanceDay } = require("../../helpers/attendanceHelper");
const dayjs = require("dayjs");

// 1. Create Attendance Regularization  Request
exports.create = async (req, res) => {
    const transaction = await sequelize.transaction();    
    try {
        const requiredFields = {
            employee_id: "Employee ID",
            attendance_date: "Attendance Date"
        };

        if (!req.body.employee_id) {
            req.body.employee_id = req.user.employee_id;
        }

        const errors = await validateRequest(req.body, requiredFields, {}, transaction);

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        await commonQuery.createRecord(
            AttendanceRegularization ,
            req.body,
            transaction
        );

        await transaction.commit();
        return res.success(constants.SUCCESS);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

// 2. Get Attendance Regularization  Summary (History)
exports.getAttendanceRegularizationSummary = async (req, res) => {
    try {
        let { employee_id } = req.body;
        if (!employee_id) {
            employee_id = req.user.employee_id;
        }

        if (!employee_id) {
            return res.error(constants.VALIDATION_ERROR, "Employee ID is required");
        }

        let isOwnRequest = employee_id == req.user.employee_id;

        // Fetch Requests for History (Ordered by date)
        const history = await commonQuery.findAllRecords(AttendanceRegularization , {
            employee_id,
            status: 0
        }, {
            include: [
                {
                    model: User,
                    as: "approvedBy",
                    attributes: ["id", "user_name"],
                    required: false
                }
            ],
            order: [["attendance_date", "DESC"]]
        }, null, isOwnRequest ? { applyHierarchy: false } : true);

        // Group History by Month
        const groupedHistory = [];
        history.forEach(request => {
            const monthYear = dayjs(request.attendance_date).format("MMM, YYYY");
            let group = groupedHistory.find(g => g.month_label === monthYear);
            
            if (!group) {
                group = {
                    month_label: monthYear,
                    total_requests: 0,
                    regularizations: []
                };
                groupedHistory.push(group);
            }

            group.total_requests += 1;
            
            const dateStr = dayjs(request.attendance_date).format("D MMM, ddd");

            const statusMap = {
                [constants.ATTENDANCE_REGULARIZATION_STATUS.PENDING]: "PENDING",
                [constants.ATTENDANCE_REGULARIZATION_STATUS.PARTIALLY_APPROVED]: "PARTIALLYAPPROVED",
                [constants.ATTENDANCE_REGULARIZATION_STATUS.APPROVED]: "APPROVED",
                [constants.ATTENDANCE_REGULARIZATION_STATUS.REJECTED]: "REJECTED",
                [constants.ATTENDANCE_REGULARIZATION_STATUS.CANCELLED]: "CANCELLED",
                [constants.ATTENDANCE_REGULARIZATION_STATUS.DELETED]: "DELETED",
            };

            const colorMap = {
                [constants.ATTENDANCE_REGULARIZATION_STATUS.APPROVED]: "#10B981",
                [constants.ATTENDANCE_REGULARIZATION_STATUS.REJECTED]: "#EF4444",
                [constants.ATTENDANCE_REGULARIZATION_STATUS.PENDING]: "#F59E0B",
                [constants.ATTENDANCE_REGULARIZATION_STATUS.PARTIALLY_APPROVED]: "#3B82F6",
                [constants.ATTENDANCE_REGULARIZATION_STATUS.CANCELLED]: "#6B7280",
                [constants.ATTENDANCE_REGULARIZATION_STATUS.DELETED]: "#9CA3AF",
            };

            group.regularizations.push({
                id: request.id,
                applied_date: request.createdAt,
                date: request.attendance_date,
                date_display: dateStr,
                reason: request.reason || "",
                status_id: request.approval_status,
                status: statusMap[request.approval_status],
                status_color: colorMap[request.approval_status] || "#F59E0B",
                approved_by: request.approvedBy?.user_name || null,
                approval_remark: request.approval_remark || ""
            });
        });

        return res.ok({
            regularization_summary: {
                total_requests_text: `${history.length} Requests`,
                total_requests: history.length
            },
            regularization_history: groupedHistory
        });

    } catch (err) {
        return handleError(err, res, req);
    }
};

// Get All Attendance Regularization  Requests (Paginated)
exports.getAll = async (req, res) => {
    try {
        const fieldConfig = [
            ["employee_id", true, true],
            ["employee.first_name", true, true],
            ["attendance_date", true, true],
            ["approval_status", true, true],
        ];

        // Add date filtering based on payload
        let whereClause = {};
        const leaveFilter = req.body?.leave_filter;
        
        if (leaveFilter) {
            const today = dayjs().toDate();
            
            switch (leaveFilter) {
                case 'previous':
                    // Previous: ended before today
                    whereClause.attendance_date = { [Op.lt]: today };
                    break;
                case 'upcoming':
                    // Upcoming: ends today or later
                    whereClause.attendance_date = { [Op.gte]: today };
                    break;
            }
        }

        const employeeWhere = { status: { [Op.in]: [0, 1, 2] } };
        
        let isOwnRequest = req.body.employee_id && (req.body.employee_id == req.user.employee_id);

        if (!req.user.is_super_admin && !req.user.is_admin && !isOwnRequest) {
            employeeWhere[Op.or] = [
                { attendance_supervisor: req.user.id },
                { reporting_manager: req.user.id }
            ];
        }

        const data = await commonQuery.fetchPaginatedData(
            AttendanceRegularization , 
            {...req.body}, 
            fieldConfig, 
            {
                include: [
                    {
                        model: Employee,
                        as: "employee",
                        where: employeeWhere,
                        attributes: ["id", "first_name", "employee_code"],
                        required: true
                    },
                    {
                        model: User,
                        as: "approvedBy",
                        attributes: ["id", "user_name"],
                        required: false
                    }
                ]
            },
            isOwnRequest ? { applyHierarchy: false } : true, // requireTenantFields
            'created_at', // dateField
            whereClause // customWhere
        );
        
        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// Get Pending Approvals
exports.getPendingApprovals = async (req, res) => {
    try {
        // Fetch all pending attendance regularization  requests with employee and template details
        const fieldConfig = [
            ["employee.first_name", true, false]
        ];

        const data = await commonQuery.fetchPaginatedData(
            AttendanceRegularization,
            req.body,
            fieldConfig,
            {
                include: [
                    {
                        model: Employee,
                        as: "employee",
                        attributes: ["id", "first_name", "employee_code", "reporting_manager", "attendance_supervisor"],
                    },
                    {
                        model: User,
                        as: "approvedBy",
                        attributes: ["id", "user_name"],
                        required: false
                    }
                ]
            },
            true, // requireTenantFields
            'created_at',
            {
                approval_status: { [Op.in]: [constants.ATTENDANCE_REGULARIZATION_STATUS.PENDING, constants.ATTENDANCE_REGULARIZATION_STATUS.PARTIALLY_APPROVED] },
                status: 0
            },
        );

        // Apply authorization logic - only return requests user can approve
        const pendingForUser = [];
        for (const request of data.items) {
            const employee = request.employee;
            if (!employee) continue;

            // Get leave template if employee has one (attendance regularization  uses same template as leave)
            const template = employee?.leaveTemplate;
            const currentLevel = request.current_level || 1;
            const config = template ? (template.approval_config || []) : [];

            let currentStage = config.find(c => c.level === currentLevel);
            if (!currentStage) currentStage = { type: "ANYONE" };

            // Reset authorization for each request to prevent cross-contamination
            let isAuthorized = false;
            const isOwnRequest = (request.employee_id === req.user.employee_id);

            if (req.user.is_super_admin && !isOwnRequest) {
                isAuthorized = true;
            } else {
                switch (currentStage.type) {
                    case 'REPORTING_MANAGER':
                    case 'ATTENDANCE_SUPERVISOR':
                        if (
                            ((req.user.role_key === constants.ROLE_KEYS.REPORTING_MANAGER || req.user.is_reporting_manager) && employee.reporting_manager === req.user.id) ||
                            ((req.user.role_key === constants.ROLE_KEYS.ATTENDANCE_SUPERVISOR || req.user.is_attendance_supervisor) && employee.attendance_supervisor === req.user.id)
                        ) {
                            isAuthorized = true;
                        }
                        break;
                    case 'ADMIN':
                        if (req.user.is_admin || req.user.is_super_admin) isAuthorized = true;
                        break;
                    case 'EMPLOYER':
                        if (req.user.is_admin || req.user.is_super_admin) isAuthorized = true;
                        break;
                    case 'ANYONE':
                        if (employee.reporting_manager === req.user.id ||
                            employee.attendance_supervisor === req.user.id ||
                            req.user.is_admin ||
                            req.user.is_super_admin) {
                            isAuthorized = true;
                        }
                        break;
                }
            }
            
            if (isAuthorized) {
                const raw = request.get({ plain: true });
                raw.approved_by_name = raw.approvedBy?.user_name || null;
                pendingForUser.push(raw);
            }
        }

        return res.ok(pendingForUser);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// 3. Update Status (Approve/Reject)
exports.updateStatus = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.params;
        const { approval_status, remarks } = req.body;

        const request = await commonQuery.findOneRecord(AttendanceRegularization , { id }, {
            include: [{ model: Employee, as: "employee" }]
        }, transaction);

        if (!request) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        let newStatus = approval_status;
        let newLevel = request.current_level || 1;

        // Multi-level Approval Logic (Assuming same pattern if template defines it)
        if (Number(approval_status) === constants.ATTENDANCE_REGULARIZATION_STATUS.APPROVED) {
            const employee = await commonQuery.findOneRecord(Employee, request.employee_id, {
                include: [
                    { model: EmployeeAttendanceTemplate, as: "employeeAttendanceTemplate", where: { status: 0 }, required: false },
                    { model: AttendanceTemplate, as: "attendanceTemplate", required: false }
                ]
            }, transaction);

            const template = employee?.employeeAttendanceTemplate || employee?.attendanceTemplate;
            const maxLevel = template ? (template.attendance_regularization_approval_level || 1) : 1;

            if ((request.current_level || 1) < maxLevel) {
                newStatus = constants.ATTENDANCE_REGULARIZATION_STATUS.PARTIALLY_APPROVED;
                newLevel = (request.current_level || 1) + 1;
            }
        }

        const history = request.approval_history || [];
        history.push({
            level: request.current_level || 1,
            action: (Number(approval_status) === constants.ATTENDANCE_REGULARIZATION_STATUS.APPROVED) ? "APPROVED" : "REJECTED",
            by: req.user.id,
            at: new Date(),
            remarks: remarks || ""
        });

        await commonQuery.updateRecordById(AttendanceRegularization , id, {
            approval_status: newStatus,
            current_level: newLevel,
            approval_history: history,
            approved_by: req.user.id,
            approval_remark: remarks || ""
        }, transaction);

        // Send Notification to Employee
        const user = await commonQuery.findOneRecord(User, { employee_id: request.employee_id }, {}, transaction);
        if (user) {
            await notificationService.createNotification({
                user_id: user.id,
                title: newStatus === constants.ATTENDANCE_REGULARIZATION_STATUS.APPROVED ? "Attendance Regularization Approved" : (newStatus === constants.ATTENDANCE_REGULARIZATION_STATUS.REJECTED ? "Attendance Regularization Rejected" : "Attendance Regularization Updated"),
                message: newStatus === constants.ATTENDANCE_REGULARIZATION_STATUS.APPROVED 
                    ? `Your attendance regularization for ${dayjs(request.attendance_date).format('DD MMM')} has been approved.` 
                    : `Your attendance regularization has been ${newStatus === constants.ATTENDANCE_REGULARIZATION_STATUS.REJECTED ? 'rejected' : 'updated'}. ${remarks ? 'Remarks: ' + remarks : ''}`,
                type: "REGULARIZATION",
                reference_id: id,
                status_code: newStatus === constants.ATTENDANCE_REGULARIZATION_STATUS.REJECTED ? 2 : 0,
                company_id: req.user.company_id,
                branch_id: req.user.branch_id
            }, transaction);
        }

        // Rebuild attendance day if fully approved just like leave-request
        if (Number(newStatus) === constants.ATTENDANCE_REGULARIZATION_STATUS.APPROVED || newStatus === "APPROVED") {
            const attDate = dayjs(request.attendance_date).format('YYYY-MM-DD');
            await rebuildAttendanceDay(request.employee_id, attDate, { user_id: req.user?.id }, transaction);
        }

        await transaction.commit();
        return res.success(constants.UPDATED);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Get Single Request Details
exports.getById = async (req, res) => {
    try {
        const { id } = req.params;
        const request = await commonQuery.findOneRecord(AttendanceRegularization , { id }, {
            include: [
                {
                    model: Employee,
                    as: "employee",
                    attributes: ["id", "first_name", "employee_code"],
                    required: false
                },
                {
                    model: User,
                    as: "approvedBy",
                    attributes: ["id", "user_name"],
                    required: false
                }
            ]
        });

        if (!request) return res.error(constants.NOT_FOUND);

        return res.ok(request);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// 4. Update Attendance Regularization  Request
exports.update = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.params;
        const requiredFields = {
            attendance_date: "Attendance Date"
        };

        const errors = await validateRequest(req.body, requiredFields, {}, transaction);
        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        const request = await commonQuery.findOneRecord(AttendanceRegularization , { id }, {}, transaction);
        if (!request || request.status === 2) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        if (request.approval_status !== constants.ATTENDANCE_REGULARIZATION_STATUS.PENDING && request.approval_status !== constants.ATTENDANCE_REGULARIZATION_STATUS.PARTIALLY_APPROVED) {
            await transaction.rollback();
            return res.error("INVALID_OPERATION", { message: "Only pending or partially approved requests can be updated" });
        }

        const employee_id = request.employee_id;

        // Check Employee's Attendance Template Settings
        const employee = await commonQuery.findOneRecord(Employee, employee_id, {
            include: [
                { model: EmployeeAttendanceTemplate, as: "employeeAttendanceTemplate", where: { status: 0 }, required: false },
                { model: AttendanceTemplate, as: "attendanceTemplate", required: false }
            ]
        }, transaction);

        const template = employee?.employeeAttendanceTemplate || employee?.attendanceTemplate;
        if (template && template.enable_attendance_regularization  === false) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, { message: "attendance regularization  requests are disabled for this employee's template." });
        }

        // Check for existing requests on the same date (excluding current request)
        const existingRequest = await commonQuery.findOneRecord(AttendanceRegularization , {
            employee_id,
            id: { [Op.ne]: id },
            attendance_date: req.body.attendance_date,
            approval_status: { [Op.notIn]: [constants.ATTENDANCE_REGULARIZATION_STATUS.REJECTED, constants.ATTENDANCE_REGULARIZATION_STATUS.CANCELLED, constants.ATTENDANCE_REGULARIZATION_STATUS.DELETED] },
            status: 0
        }, {}, transaction);

        if (existingRequest) {
            await transaction.rollback();
            return res.error("DUPLICATE_REQUEST", { message: `An attendance regularization  request already exists for ${dayjs(req.body.attendance_date).format('YYYY-MM-DD')}` });
        }

        const PUT = { ...req.body };

        await commonQuery.updateRecordById(AttendanceRegularization , id, PUT, transaction);

        await transaction.commit();
        return res.success("ATTENDANCE_REGULARIZATION _UPDATED");
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

// 5. Cancel Attendance Regularization  Request
exports.cancel = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.params;
        const employeeId = req.user.employee_id;

        // 1. Fetch Request
        const request = await commonQuery.findOneRecord(AttendanceRegularization , { id }, {}, transaction);
        if (!request || request.status === 2) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        // 2. Authorization Check (Only owner can cancel via this API)
        if (request.employee_id !== employeeId && !req.user.is_super_admin) {
            await transaction.rollback();
            return res.error("UNAUTHORIZED", { message: "You can only cancel your own attendance regularization  requests" });
        }

        // 3. Status Check
        if (
            Number(request.approval_status) === constants.ATTENDANCE_REGULARIZATION_STATUS.CANCELLED ||
            Number(request.approval_status) === constants.ATTENDANCE_REGULARIZATION_STATUS.REJECTED
        ) {
            await transaction.rollback();
            return res.error("INVALID_OPERATION", { message: `Request is already processed` });
        }

        // 4. Update Status to Cancelled
        await commonQuery.updateRecordById(AttendanceRegularization , id, {
            approval_status: constants.ATTENDANCE_REGULARIZATION_STATUS.CANCELLED
        }, transaction);

        await transaction.commit();
        return res.success(constants.UPDATED);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

// 6. Delete Attendance Regularization  Request
exports.delete = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const requiredFields = {
            ids: "Select Data"
        };

        const errors = await validateRequest(req.body, requiredFields, {}, transaction);
        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }
        let { ids } = req.body; // Accept array of ids

        // Validate that ids is an array and not empty
        if (!Array.isArray(ids) || ids.length === 0) {
            await transaction.rollback();
            return res.error(constants.INVALID_ID);
        }

        const deleted = await commonQuery.hardDeleteRecords(AttendanceRegularization , ids, transaction);
        if (!deleted) {
            await transaction.rollback();
            return res.error(constants.ALREADY_DELETED);
        }
        await transaction.commit();
        return res.success(constants.DELETED);
    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};
