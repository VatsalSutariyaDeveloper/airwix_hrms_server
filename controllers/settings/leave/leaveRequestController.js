const { LeaveRequest, EmployeeLeaveBalance, LeaveTemplate, LeaveTemplateCategory, Employee, User, sequelize, BranchMaster, AttendanceDay } = require("../../../models");
const { validateRequest, commonQuery, handleError, uploadFile, fileExists } = require("../../../helpers");
const { constants } = require("../../../helpers/constants");
const { Op } = require("sequelize");
const { rebuildAttendanceDay, getDayOffInfo } = require("../../../helpers/attendanceHelper");
const dayjs = require("dayjs");
const LeaveBalanceService = require("../../../services/leaveBalanceService");

/**
 * Controller for managing Leave Requests and Balance Deductions.
 */

// 1. Create a Leave Request (and Reserve Balance)
exports.create = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const requiredFields = {
            employee_id: "Employee ID",
            leave_category_id: "Leave Category",
            start_date: "Start Date",
            end_date: "End Date",
            total_days: "Total Days",
        };

        if (!req.body.employee_id) {
            req.body.employee_id = req.user.employee_id
        }

        const errors = await validateRequest(req.body, requiredFields, {}, transaction);
        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        let { employee_id, leave_category_id, start_date, end_date } = req.body;
        const currentYear = new Date(start_date).getFullYear();

        // Map requested total_days to preserved half-days/custom entries
        const requestedTotal = parseFloat(req.body.total_days || 0);
        const start = dayjs(start_date);
        const end = dayjs(end_date);
        const calendarDays = end.diff(start, 'day') + 1;

        let total_days = 0;
        let is_encashment = req.body.is_encashment === true || req.body.is_encashment === "true";

        if (is_encashment) {
            total_days = requestedTotal;
        } else {
            // --- Calculate total_days based on Sandwich Policy via Service ---
            const workingDays = await LeaveBalanceService.calculateWorkingDays(employee_id, start_date, end_date, transaction);

            const reduction = calendarDays - requestedTotal; // accounts for 0.5 or other reductions
            total_days = Math.max(0, workingDays - reduction);
            total_days = Math.round(total_days * 10) / 10;

            // Check for Overlapping Leaves (Only for regular leaves)
            const overlap = await commonQuery.findOneRecord(LeaveRequest, {
                employee_id,
                approval_status: { [Op.ne]: constants.LEAVE_APPROVAL_STATUS.REJECTED },
                status: 0,
                is_encashment: false,
                [Op.or]: [
                    {
                        start_date: { [Op.between]: [start_date, end_date] }
                    },
                    {
                        end_date: { [Op.between]: [start_date, end_date] }
                    },
                    {
                        [Op.and]: [
                            { start_date: { [Op.lte]: start_date } },
                            { end_date: { [Op.gte]: end_date } }
                        ]
                    }
                ]
            }, {}, transaction);

            if (overlap) {
                await transaction.rollback();
                return res.error("OVERLAP", { message: `Selected dates overlap with an existing leave request (${overlap.start_date} to ${overlap.end_date})` });
            }
        }

        // 2. Fetch specific employee balance record
        const employee = await commonQuery.findOneRecord(Employee, employee_id, {
            include: [{ model: LeaveTemplate, as: "leaveTemplate" }]
        }, transaction);

        if (!employee) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND, { message: "Employee not found" });
        }

        const category = await commonQuery.findOneRecord(LeaveTemplateCategory, leave_category_id, {}, transaction, false, { company_id: true });
        if (!category) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND, { message: "Leave category not found" });
        }

        // --- Automation Rules Validation ---
        const rules = category.automation_rules ? JSON.parse(category.automation_rules) : {};

        // 1. Generic Usage Limit (Monthly/Quarterly/Yearly - total days)
        if (rules.limit_window && rules.limit_window !== 'none' && rules.max_total_days) {
            const refDate = dayjs(start_date);
            let startDateRange, endDateRange;

            if (rules.limit_window === 'monthly') {
                startDateRange = refDate.startOf('month').format('YYYY-MM-DD');
                endDateRange = refDate.endOf('month').format('YYYY-MM-DD');
            } else if (rules.limit_window === 'quarterly') {
                startDateRange = refDate.startOf('quarter').format('YYYY-MM-DD');
                endDateRange = refDate.endOf('quarter').format('YYYY-MM-DD');
            } else if (rules.limit_window === 'yearly') {
                startDateRange = refDate.startOf('year').format('YYYY-MM-DD');
                endDateRange = refDate.endOf('year').format('YYYY-MM-DD');
            }

            if (startDateRange && endDateRange) {
                const totalUsed = await LeaveRequest.sum('total_days', {
                    where: {
                        employee_id,
                        leave_category_id,
                        approval_status: { [Op.ne]: constants.LEAVE_APPROVAL_STATUS.REJECTED },
                        status: 0,
                        start_date: { [Op.between]: [startDateRange, endDateRange] }
                    },
                    transaction
                }) || 0;

                if ((totalUsed + total_days) > rules.max_total_days) {
                    await transaction.rollback();
                    return res.error("RULE_VIOLATION", { message: `Usage exceeds limit. Max ${rules.max_total_days} days allowed per ${rules.limit_window}. Already used: ${totalUsed} days.` });
                }
            }
        }
console.log("rules", rules);
console.log("start_date", start_date);
console.log("end_date", end_date);
        // 3. Min Working Time & Late/Early Exit (Check Attendance)
        if (rules.min_working_time_mins || rules.max_late_early_mins) {
            const attDate = dayjs(start_date).format('YYYY-MM-DD');
            const isToday = attDate === dayjs().format('YYYY-MM-DD');
            const isPast = dayjs(attDate).isBefore(dayjs().startOf('day'));

            const attendance = await commonQuery.findOneRecord(AttendanceDay, {
                employee_id,
                attendance_date: attDate,
                status: { [Op.ne]: 2 }
            }, {}, transaction);

            if (attendance) {
                if (rules.min_working_time_mins && (attendance.worked_minutes || 0) < rules.min_working_time_mins) {
                    await transaction.rollback();
                    return res.error("RULE_VIOLATION", { message: `Insufficient working time. Required: ${rules.min_working_time_mins} mins. Current: ${attendance.worked_minutes || 0} mins.` });
                }

                if (rules.max_late_early_mins) {
                    const lateMins = attendance.late_minutes || 0;
                    const earlyMins = attendance.early_out_minutes || 0;
                    if (lateMins > rules.max_late_early_mins || earlyMins > rules.max_late_early_mins) {
                        await transaction.rollback();
                        return res.error("RULE_VIOLATION", { message: `Late/Early exit exceeds allowed threshold of ${rules.max_late_early_mins} mins.` });
                    }
                }
            } else if (isToday || isPast) {
                // If no attendance record exists for today or a past date, the rule is violated
                await transaction.rollback();
                return res.error("RULE_VIOLATION", { message: `This leave requires a valid attendance record for the day (Minimum working time or Late/Early exit check).` });
            }
        }

        const template = employee.leaveTemplate;
        const cycleType = template ? template.leave_policy_cycle : 'CALENDAR_YEAR';
        const cycleDates = LeaveBalanceService.getCycleDates(employee.joining_date, cycleType, dayjs(start_date));

        const balance = await commonQuery.findOneRecord(EmployeeLeaveBalance, {
            employee_id,
            leave_category_id,
            year: cycleDates.end.year(),
            month: cycleType === 'MONTHLY' ? cycleDates.end.month() + 1 : null,
            status: 0
        }, {}, transaction, false, { company_id: true });

        if (!balance) {
            await transaction.rollback();
            return res.error("BALANCE_NOT_FOUND", { message: "No leave balance found for this category. Please check employee's leave balance." });
        }

        // 2. Adjust Balance via Service
        try {
            await LeaveBalanceService.adjustLeaveBalance(employee_id, leave_category_id, total_days, transaction, start_date, employee);
        } catch (error) {
            await transaction.rollback();
            return res.error("INSUFFICIENT_BALANCE", { message: error.message });
        }

        // Create Leave Request
        const POST = { 
            ...req.body, 
            total_days,
            branch_id: req.body.branch_id || employee.branch_id,
            company_id: req.body.company_id || employee.company_id,
            user_id: req.body.user_id || req.user.id
        };

        // Handle File Upload
        if (req.files && Object.keys(req.files).length > 0) {
            const savedFiles = await uploadFile(req, res, constants.LEAVE_DOC_FOLDER, transaction);
            if (savedFiles.document) {
                POST.document = savedFiles.document;
            }
        }

        const leaveRequest = await commonQuery.createRecord(LeaveRequest, {
            ...POST,
            approval_status: constants.LEAVE_APPROVAL_STATUS.PENDING,
            current_level: 1,
            approval_history: []
        }, transaction);

        await transaction.commit();
        return res.success("LEAVE_REQUESTED", leaveRequest);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

// 2. Get All Requests (Paginated)
exports.getAll = async (req, res) => {
    try {
        const fieldConfig = [
            ["approval_status", true, true],
            ["first_name", true, false],
            ["employee_code", true, false],
        ];

        // Add date filtering based on payload
        let whereClause = {};
        const { filter } = req.body;
        
        if (filter) {
            const today = dayjs().startOf('day');
            const todayEnd = dayjs().endOf('day');
            
            switch (filter) {
                case 'previous':
                    // Previous: before today
                    whereClause.start_date = {
                        [Op.lt]: today.format('YYYY-MM-DD HH:mm:ss')
                    };
                    break;
                case 'upcoming':
                    // Upcoming: after today
                    whereClause.start_date = {
                        [Op.gt]: todayEnd.format('YYYY-MM-DD HH:mm:ss')
                    };
                    break;
            }
        }

        const data = await commonQuery.fetchPaginatedData(
            LeaveRequest,
            req.body,
            fieldConfig,
            {
                include: [
                    {
                        model: Employee,
                        as: "employee",
                        attributes: ["first_name", "employee_code"],
                        include: [{ model: LeaveTemplate, as: "leaveTemplate", attributes: ["approval_levels"] }],
                        where: { status: { [Op.in]: [0, 1, 2] } }
                    },
                    { model: LeaveTemplateCategory, as: "category", attributes: ["leave_category_name"] },
                    { model: User, as: "approvedBy", attributes: ["id", "user_name"], required: false }
                ],
                attributes: { exclude: ['reason'] },
                where: whereClause,
                order: [['created_at', 'DESC']]
            }
        );

        // Add a "progression" summary for the UI and document URL
        data.rows = data?.rows?.map(row => {
            const raw = row.get({ plain: true });
            const statusLabels = {
                [constants.LEAVE_APPROVAL_STATUS.PENDING]: "PENDING",
                [constants.LEAVE_APPROVAL_STATUS.PARTIALLY_APPROVED]: "PARTIALLY APPROVED",
                [constants.LEAVE_APPROVAL_STATUS.APPROVED]: "APPROVED",
                [constants.LEAVE_APPROVAL_STATUS.REJECTED]: "REJECTED",
                [constants.LEAVE_APPROVAL_STATUS.CANCELLED]: "CANCELLED",
                [constants.LEAVE_APPROVAL_STATUS.DELETED]: "DELETED",
            };
            const statusLabel = statusLabels[raw.approval_status] || "PENDING";
            const total = raw.employee?.leaveTemplate?.approval_levels || 1;
            raw.tracking_summary = `${statusLabel} (Stage ${raw.current_level} of ${total})`;

            if (raw.document) {
                const exists = fileExists(constants.LEAVE_DOC_FOLDER, raw.document);
                raw.document_url = exists ? `${process.env.FILE_SERVER_URL}${constants.LEAVE_DOC_FOLDER}${raw.document}` : null;
            } else {
                raw.document_url = null;
            }

            // Add approver name if available
            raw.approved_by = raw.approvedBy?.user_name || null;

            return raw;
        });

        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// 3. Get Single Request Details
exports.getById = async (req, res) => {
    try {
        const { id } = req.params;
        const leaveRequest = await commonQuery.findOneRecord(LeaveRequest, { id }, {
            include: [
                { model: Employee, as: "employee", attributes: ["first_name", "employee_code", "leave_template"] },
                { model: LeaveTemplateCategory, as: "category" },
                { model: User, as: "approvedBy", attributes: ["id", "user_name"], required: false }
            ]
        });

        if (!leaveRequest) return res.error(constants.NOT_FOUND);

        const raw = leaveRequest.get({ plain: true });

        // Add document URL
        if (raw.document) {
            const exists = fileExists(constants.LEAVE_DOC_FOLDER, raw.document);
            raw.document_url = exists ? `${process.env.FILE_SERVER_URL}${constants.LEAVE_DOC_FOLDER}${raw.document}` : null;
        } else {
            raw.document_url = null;
        }

        // Add approver name if available
        raw.approved_by = raw.approvedBy?.user_name || null;

        const template = await commonQuery.findOneRecord(LeaveTemplate, raw.employee.leave_template, {}, null, false, { company_id: true });
        const totalLevels = template ? template.approval_levels : 1;
        const levelConfigs = template ? (template.levels || []) : [];
        const approvers = await commonQuery.findAllRecords(User, { status: 0 });

        const history = raw.approval_history || [];
        const timeline = [];

        for (let i = 1; i <= totalLevels; i++) {
            const levelConfig = levelConfigs.find(l => l.level === i) || {};
            const levelHistory = history.find(h => h.level === i);
            let stageStatus = "UPCOMING";
            let actionPersonnel = "-";

            if (i < raw.current_level) {
                stageStatus = "COMPLETED";
                const user = approvers.find(u => u.id === (levelHistory?.approved_by || levelHistory?.by));
                if (user) actionPersonnel = user.user_name;
            } else if (i === raw.current_level) {
                if (raw.approval_status === constants.LEAVE_APPROVAL_STATUS.REJECTED || raw.approval_status === constants.LEAVE_APPROVAL_STATUS.CANCELLED) {
                    stageStatus = levelHistory ? "REJECTED" : "CANCELLED";
                } else if (raw.approval_status === constants.LEAVE_APPROVAL_STATUS.APPROVED) {
                    stageStatus = "COMPLETED";
                } else {
                    stageStatus = "PENDING";
                }
            }

            timeline.push({
                level: i,
                status: stageStatus,
                required_role: levelConfig.type,
                personnel: actionPersonnel,
                label: levelConfig.label || `Level ${i}`,
                history: levelHistory || null
            });
        }

        raw.timeline = timeline;
        raw.next_action_at_level = totalLevels === raw.current_level &&
            [constants.LEAVE_APPROVAL_STATUS.APPROVED, constants.LEAVE_APPROVAL_STATUS.REJECTED, constants.LEAVE_APPROVAL_STATUS.CANCELLED].includes(Number(raw.approval_status))
            ? null : raw.current_level;

        return res.ok(raw);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// 4. Update Status (Approve/Reject)
exports.updateStatus = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.params;
        const { approval_status, approved_by } = req.body;

        const leaveRequest = await commonQuery.findOneRecord(LeaveRequest, { id }, {}, transaction);
        if (!leaveRequest || leaveRequest.status === 2) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        const oldStatus = leaveRequest.approval_status;
        if (oldStatus !== constants.LEAVE_APPROVAL_STATUS.PENDING && oldStatus !== constants.LEAVE_APPROVAL_STATUS.PARTIALLY_APPROVED) {
            await transaction.rollback();
            return res.error("INVALID_OPERATION", { message: "Only pending or partially approved requests can be updated" });
        }

        const employee = await commonQuery.findOneRecord(Employee, { id: leaveRequest.employee_id }, {
            include: [{ model: LeaveTemplate, as: "leaveTemplate" }]
        }, transaction);

        if (!employee) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        const template = employee.leaveTemplate;
        const currentLevel = leaveRequest.current_level;
        const totalLevels = template?.approval_levels || 1;

        if (String(approval_status) === String(constants.LEAVE_APPROVAL_STATUS.APPROVED) || approval_status === "APPROVED") {
            const history = leaveRequest.approval_history || [];
            history.push({
                level: currentLevel,
                approved_by: req.user?.id,
                approved_at: new Date(),
                action: "APPROVED"
            });

            const updateData = {
                approval_history: history
            };

            if (currentLevel < totalLevels && !req.user?.is_super_admin) {
                updateData.approval_status = constants.LEAVE_APPROVAL_STATUS.PARTIALLY_APPROVED;
                updateData.current_level = currentLevel + 1;
            } else {
                updateData.approval_status = constants.LEAVE_APPROVAL_STATUS.APPROVED;
                updateData.approved_by = approved_by || req.user?.id;

                if (req.user?.is_super_admin && currentLevel < totalLevels) {
                    if (history.length > 0) history[history.length - 1].note = "Bypassed remaining levels via Super Admin";
                    updateData.approval_history = history;
                    updateData.current_level = totalLevels;
                }
            }
            await commonQuery.updateRecordById(LeaveRequest, leaveRequest.id, updateData, transaction);

            if (Number(updateData.approval_status) === constants.LEAVE_APPROVAL_STATUS.APPROVED && !leaveRequest.is_encashment) {
                const start = dayjs(leaveRequest.start_date);
                const end = dayjs(leaveRequest.end_date);
                const diff = end.diff(start, 'day');
                for (let i = 0; i <= diff; i++) {
                    const targetDate = start.add(i, 'day').format('YYYY-MM-DD');
                    await rebuildAttendanceDay(leaveRequest.employee_id, targetDate, { user_id: req.user?.id }, transaction);
                }
            }
        }
        else if (
            String(approval_status) === String(constants.LEAVE_APPROVAL_STATUS.REJECTED) ||
            String(approval_status) === String(constants.LEAVE_APPROVAL_STATUS.CANCELLED) ||
            approval_status === "REJECTED" ||
            approval_status === "CANCELLED"
        ) {
            const cycleType = template?.leave_policy_cycle || 'CALENDAR_YEAR';
            const cycleDates = LeaveBalanceService.getCycleDates(employee.joining_date, cycleType, dayjs(leaveRequest.start_date));

            const balance = await commonQuery.findOneRecord(EmployeeLeaveBalance, {
                employee_id: leaveRequest.employee_id,
                leave_category_id: leaveRequest.leave_category_id,
                year: cycleDates.end.year(),
                month: cycleType === 'MONTHLY' ? cycleDates.end.month() + 1 : null,
                status: 0
            }, {}, transaction, false, { company_id: true });

            if (balance) {
                await LeaveBalanceService.adjustLeaveBalance(leaveRequest.employee_id, leaveRequest.leave_category_id, -parseFloat(leaveRequest.total_days), transaction, dayjs(leaveRequest.start_date), employee);
            }

            const history = leaveRequest.approval_history || [];
            history.push({
                level: currentLevel,
                action: approval_status,
                by: req.user?.id,
                at: new Date()
            });

            await commonQuery.updateRecordById(LeaveRequest, leaveRequest.id, {
                approval_status: (approval_status === "REJECTED" || Number(approval_status) === constants.LEAVE_APPROVAL_STATUS.REJECTED) ? constants.LEAVE_APPROVAL_STATUS.REJECTED : constants.LEAVE_APPROVAL_STATUS.CANCELLED,
                approved_by: approved_by || req.user?.id,
                approval_history: history
            }, transaction);
        }

        await transaction.commit();
        return res.success("STATUS_UPDATED", { id: leaveRequest.id, approval_status });
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

// 6. Get Pending Approvals
exports.getPendingApprovals = async (req, res) => {
    try {
        console.log("req.user",req.user)
        // const employeeId = req.body.employee_id;
        const requests = await commonQuery.findAllRecords(LeaveRequest, {
            approval_status: { [Op.in]: [constants.LEAVE_APPROVAL_STATUS.PENDING, constants.LEAVE_APPROVAL_STATUS.PARTIALLY_APPROVED] },
            status: 0
        }, {
            attributes: [
                "id",
                "employee_id",
                "leave_category_id",
                "start_date",
                "end_date",
                "total_days",
                "reason",
                "approval_status",
                "current_level",
                "approval_history",
                "approved_by",
                "document",
                "branch.branch_name",
                "status"
            ],
            include: [
                {
                    model: Employee,
                    as: "employee",
                    attributes: ["id", "first_name", "employee_code", "reporting_manager", "attendance_supervisor"],
                    include: [{ model: LeaveTemplate, as: "leaveTemplate" }]
                },
                {
                    model: LeaveTemplateCategory,
                    as: "category",
                    attributes: ["leave_category_name"]
                },
                {
                    model: User,
                    as: "approvedBy",
                    attributes: ["id", "user_name"],
                    required: false
                },
                {
                    model: BranchMaster,
                    as: "branch",
                    attributes: []
                }
            ],
        });

        const pendingForUser = [];

        for (const request of requests) {
            const employee = request.employee;
            // The initial query already includes employee.leaveTemplate
            if (!employee) continue;

            const template = employee?.leaveTemplate;
            const currentLevel = request.current_level;
            const config = template ? (template.approval_config || []) : [];

            let currentStage = config.find(c => c.level === currentLevel);
            if (!currentStage) currentStage = "ANYONE";
            
            let isAuthorized = false;
            if (req.user.is_super_admin) {
                isAuthorized = true;
            } else {
            
                switch (currentStage.type) {
                    case 'REPORTING_MANAGER':
                        if (req.user.role_id === constants.REPORTING_MANAGER_ROLE_ID && employee.reporting_manager === req.user.id) isAuthorized = true;
                        break;
                    case 'ATTENDANCE_SUPERVISOR':
                        if (req.user.role_id === constants.ATTENDANCE_SUPERVISOR_ROLE_ID && employee.attendance_supervisor === req.user.id) isAuthorized = true;
                        break;
                    case 'ADMIN':
                        if (req.user.is_admin) isAuthorized = true;
                        break;
                    case 'EMPLOYER':
                        isAuthorized = true;
                        break;
                    case 'ANYONE':
                        // Anyone of Reporting Manager, Supervisor, Admin, etc.
                        if (employee.reporting_manager === req.user.id ||
                            employee.attendance_supervisor === req.user.id) {
                            isAuthorized = true;
                        }
                        break;
                }
            }
            if (isAuthorized) {
                const raw = request.get({ plain: true });
                if (raw.document) {
                    const exists = fileExists(constants.LEAVE_DOC_FOLDER, raw.document);
                    raw.document_url = exists ? `${process.env.FILE_SERVER_URL}${constants.LEAVE_DOC_FOLDER}${raw.document}` : null;
                } else {
                    raw.document_url = null;
                }
                raw.approved_by_name = raw.approvedBy?.user_name || null;
                pendingForUser.push(raw);
            }
        }

        return res.ok(pendingForUser);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// 7. Cancel Leave Request (by Employee)
exports.cancelLeave = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.params;
        const employeeId = req.user.employee_id;

        // 1. Fetch Request
        const leaveRequest = await commonQuery.findOneRecord(LeaveRequest, { id }, {}, transaction);
        if (!leaveRequest || leaveRequest.status === 2) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        // 2. Authorization Check (Only owner can cancel via this API)
        if (leaveRequest.employee_id !== employeeId && !req.user.is_super_admin) {
            await transaction.rollback();
            return res.error("UNAUTHORIZED", { message: "You can only cancel your own leave requests" });
        }

        // 3. Status Check
        if (
            Number(leaveRequest.approval_status) === constants.LEAVE_APPROVAL_STATUS.CANCELLED ||
            Number(leaveRequest.approval_status) === constants.LEAVE_APPROVAL_STATUS.REJECTED
        ) {
            await transaction.rollback();
            return res.error("INVALID_OPERATION", { message: `Request is already processed` });
        }

        const oldStatus = leaveRequest.approval_status;

        // 4. Restore Balance
        const employee = await commonQuery.findOneRecord(Employee, leaveRequest.employee_id, {
            include: [{ model: LeaveTemplate, as: "leaveTemplate" }]
        }, transaction);

        const template = employee?.leaveTemplate;
        const cycleType = template?.leave_policy_cycle || 'CALENDAR_YEAR';
        const cycleDates = LeaveBalanceService.getCycleDates(employee?.joining_date, cycleType, dayjs(leaveRequest.start_date));

        const balance = await commonQuery.findOneRecord(EmployeeLeaveBalance, {
            employee_id: leaveRequest.employee_id,
            leave_category_id: leaveRequest.leave_category_id,
            year: cycleDates.end.year(),
            month: cycleType === 'MONTHLY' ? cycleDates.end.month() + 1 : null,
            status: 0
        }, {}, transaction, false, { company_id: true });

        if (balance) {
            await LeaveBalanceService.adjustLeaveBalance(leaveRequest.employee_id, leaveRequest.leave_category_id, -parseFloat(leaveRequest.total_days), transaction, dayjs(leaveRequest.start_date), employee);
        }

        // 5. Update Request Status immediately so rebuildAttendanceDay sees the change
        const history = leaveRequest.approval_history || [];
        history.push({
            level: leaveRequest.current_level,
            action: "CANCELLED_BY_EMPLOYEE",
            by: req.user?.id,
            at: new Date()
        });

        await commonQuery.updateRecordById(LeaveRequest, leaveRequest.id, {
            approval_status: constants.LEAVE_APPROVAL_STATUS.CANCELLED,
            approval_history: history
        }, transaction);

        // 6. If it was already APPROVED, Rebuild Attendance to remove Leave status
        if (Number(oldStatus) === constants.LEAVE_APPROVAL_STATUS.APPROVED && !leaveRequest.is_encashment) {
            const start = dayjs(leaveRequest.start_date);
            const end = dayjs(leaveRequest.end_date);
            const diff = end.diff(start, 'day');
            for (let i = 0; i <= diff; i++) {
                const targetDate = start.add(i, 'day').format('YYYY-MM-DD');
                await rebuildAttendanceDay(leaveRequest.employee_id, targetDate, { user_id: req.user?.id }, transaction);
            }
        }

        await transaction.commit();
        return res.success("LEAVE_CANCELLED");
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

// 8. Calculate Leave Days (Frontend Helper)
exports.calculateLeaveDays = async (req, res) => {
    try {
        let { employee_id, start_date, end_date } = req.body;
        if(!employee_id){
            employee_id = req.user.employee_id;
            req.body.employee_id = employee_id;
        }

        const requiredFields = {
            employee_id: "Employee",
            start_date: "Start Date",
            end_date: "End Date"
        };

        const errors = await validateRequest(req.body, requiredFields, {}, null);

        if (errors) {
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        const employee = await commonQuery.findOneRecord(Employee, employee_id, {
            include: [{ model: LeaveTemplate, as: "leaveTemplate" }]
        });

        if (!employee) {
            return res.error(constants.NOT_FOUND, { message: "Employee not found" });
        }

        const template = employee.leaveTemplate;
        const countSandwich = template ? template.count_sandwich_leaves : false;

        const start = dayjs(start_date);
        const end = dayjs(end_date);
        const calendarDays = end.diff(start, 'day') + 1;

        let workingDays = 0;
        const dateWiseBreakdown = [];
        const isEncashment = req.body.is_encashment === true || req.body.is_encashment === "true";

        if (isEncashment) {
            workingDays = calendarDays;
        } else {
            for (let i = 0; i < calendarDays; i++) {
                const cur = start.add(i, 'day').format('YYYY-MM-DD');
                const dayOff = await getDayOffInfo(employee, cur);

                let dayStatus = "Working Day";
                let isWorking = true;

                if (dayOff.isHoliday) {
                    dayStatus = dayOff.holidayDetails?.name || "Holiday";
                    isWorking = false;
                } else if (dayOff.isWeeklyOff) {
                    dayStatus = "Week Off";
                    isWorking = false;
                }

                dateWiseBreakdown.push({
                    date: cur,
                    name: dayStatus,
                    is_working: isWorking
                });

                if (countSandwich) {
                    workingDays += 1;
                } else {
                    if (isWorking) {
                        workingDays += 1;
                    }
                }
            }
        }

        return res.success("Working days calculated", { 
            total_days: workingDays,
            breakdown: dateWiseBreakdown
        });
    } catch (err) {
        return handleError(err, res, req);
    }
};
