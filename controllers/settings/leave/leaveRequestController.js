const { LeaveRequest, EmployeeLeaveBalance, LeaveTemplate, LeaveTemplateCategory, Employee, User, sequelize, BranchMaster, AttendanceDay, Department, DesignationMaster, EmployeeWeeklyOff, EmployeeHoliday } = require("../../../models");
const { validateRequest, commonQuery, handleError, uploadFile, fileExists } = require("../../../helpers");
const { constants } = require("../../../helpers/constants");
const { Op } = require("sequelize");
const { rebuildAttendanceDay, getDayOffInfo } = require("../../../helpers/attendanceHelper");
const dayjs = require("dayjs");
const isSameOrBefore = require("dayjs/plugin/isSameOrBefore");
dayjs.extend(isSameOrBefore);
const LeaveBalanceService = require("../../../services/leaveBalanceService");
const notificationService = require("../../../services/notificationService");

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

        let { employee_id, leave_category_id, start_date, end_date, start_session, end_session } = req.body;
        const currentYear = new Date(start_date).getFullYear();

        // 0=Full Day, 1=Session 1, 2=Session 2
        start_session = parseInt(start_session) || 0;
        end_session = parseInt(end_session) || 0;

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

            // Calculate session-based reduction
            let sessionReduction = 0;
            if (start_session !== 0) sessionReduction += 0.5;
            if (end_session !== 0 && !(start_date === end_date)) sessionReduction += 0.5;
            
            // If it's a single day leave and a session is selected, total is 0.5
            if (start_date === end_date && start_session !== 0) {
                total_days = workingDays > 0 ? 0.5 : 0;
            } else {
                total_days = Math.max(0, workingDays - sessionReduction);
            }
            
            total_days = Math.round(total_days * 10) / 10;

            // Check for Overlapping Leaves (Only for regular leaves)
            const overlap = await commonQuery.findOneRecord(LeaveRequest, {
                employee_id,
                approval_status: { [Op.notIn]: [constants.LEAVE_APPROVAL_STATUS.REJECTED, constants.LEAVE_APPROVAL_STATUS.CANCELLED, constants.LEAVE_APPROVAL_STATUS.DELETED] },
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

        const category = await commonQuery.findOneRecord(LeaveTemplateCategory, leave_category_id, {}, transaction);
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
                        approval_status: { [Op.notIn]: [constants.LEAVE_APPROVAL_STATUS.REJECTED, constants.LEAVE_APPROVAL_STATUS.CANCELLED, constants.LEAVE_APPROVAL_STATUS.DELETED] },
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

        // 4. Half Day / Full Day Restriction
        if (rules.allow_half_day === false || rules.allow_full_day === false) {
            const startSess = parseInt(req.body.start_session) || 0;
            const endSess = parseInt(req.body.end_session) || 0;
            const calendarDays = dayjs(end_date).diff(dayjs(start_date), 'day') + 1;

            if (rules.allow_half_day === false) {
                if (startSess !== 0 || endSess !== 0) {
                    await transaction.rollback();
                    return res.error("RULE_VIOLATION", { message: "Half-day leaves are not allowed for this category." });
                }
            }

            if (rules.allow_full_day === false) {
                if (calendarDays > 1) {
                    await transaction.rollback();
                    return res.error("RULE_VIOLATION", { message: "Full-day leaves are not allowed for this category. Please apply for a single half-day session." });
                }
                if (calendarDays === 1 && startSess === 0) {
                    await transaction.rollback();
                    return res.error("RULE_VIOLATION", { message: "Full-day leaves are not allowed for this category. Please select a session for half-day." });
                }
            }
        }
        
        // 3. Min Working Time & Late/Early Exit (Check Attendance)
        if (rules.min_working_time_mins || rules.max_late_early_mins) {
            const attDate = dayjs(start_date).format('YYYY-MM-DD');
            const isToday = attDate === dayjs().format('YYYY-MM-DD');
            const isPast = dayjs(attDate).isBefore(dayjs().startOf('day'));

            const attendance = await commonQuery.findOneRecord(AttendanceDay, {
                employee_id,
                attendance_date: attDate,
                status: { [Op.ne]: 2 }
            }, {}, transaction, null, false, { company_id: true });

            if (attendance) {
                if (rules.min_working_time_mins && (attendance.worked_minutes || 0) < rules.min_working_time_mins) {
                    await transaction.rollback();
                    return res.error("RULE_VIOLATION", { message: `Insufficient working time. Required: ${rules.min_working_time_mins} mins. Current: ${attendance.worked_minutes || 0} mins.` });
                }

                if (rules.max_late_early_mins) {
                    const fineMins = attendance.fine_minutes || 0;
                    if (fineMins > rules.max_late_early_mins) {
                        await transaction.rollback();
                        return res.error("RULE_VIOLATION", { message: `Late/Early exit exceeds allowed threshold of ${rules.max_late_early_mins} mins. Current: ${fineMins} mins.` });
                    }
                }
            } else {
                // If no attendance record exists for the selected date (past, present, or future), the rule is violated
                await transaction.rollback();
                return res.error("RULE_VIOLATION", { message: `Your Selected Date has no attendance record. Please add attendance first.` });
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
        }, {}, transaction);

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

        // Optional: Notify manager (Not explicitly asked but good to have)
        // ...

        return res.success("LEAVE_REQUESTED", leaveRequest);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Update Leave Request
exports.update = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.params;
        const requiredFields = {
            leave_category_id: "Leave Category",
            start_date: "Start Date",
            end_date: "End Date",
            total_days: "Total Days",
        };

        const errors = await validateRequest(req.body, requiredFields, {}, transaction);
        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        const leaveRequest = await commonQuery.findOneRecord(LeaveRequest, { id }, {}, transaction);
        if (!leaveRequest || leaveRequest.status === 2) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        if (leaveRequest.approval_status !== constants.LEAVE_APPROVAL_STATUS.PENDING && leaveRequest.approval_status !== constants.LEAVE_APPROVAL_STATUS.PARTIALLY_APPROVED) {
            await transaction.rollback();
            return res.error("INVALID_OPERATION", { message: "Only pending or partially approved requests can be updated" });
        }

        let { leave_category_id, start_date, end_date, start_session, end_session } = req.body;
        const employee_id = leaveRequest.employee_id;

        start_session = parseInt(start_session) || 0;
        end_session = parseInt(end_session) || 0;
        const requestedTotal = parseFloat(req.body.total_days || 0);

        let total_days = 0;
        let is_encashment = req.body.is_encashment === true || req.body.is_encashment === "true";

        if (is_encashment) {
            total_days = requestedTotal;
        } else {
            const workingDays = await LeaveBalanceService.calculateWorkingDays(employee_id, start_date, end_date, transaction);
            let sessionReduction = 0;
            if (start_session !== 0) sessionReduction += 0.5;
            if (end_session !== 0 && !(start_date === end_date)) sessionReduction += 0.5;
            
            if (start_date === end_date && start_session !== 0) {
                total_days = workingDays > 0 ? 0.5 : 0;
            } else {
                total_days = Math.max(0, workingDays - sessionReduction);
            }
            total_days = Math.round(total_days * 10) / 10;

            const overlap = await commonQuery.findOneRecord(LeaveRequest, {
                employee_id,
                id: { [Op.ne]: id },
                approval_status: { [Op.notIn]: [constants.LEAVE_APPROVAL_STATUS.REJECTED, constants.LEAVE_APPROVAL_STATUS.CANCELLED, constants.LEAVE_APPROVAL_STATUS.DELETED] },
                status: 0,
                is_encashment: false,
                [Op.or]: [
                    { start_date: { [Op.between]: [start_date, end_date] } },
                    { end_date: { [Op.between]: [start_date, end_date] } },
                    { [Op.and]: [{ start_date: { [Op.lte]: start_date } }, { end_date: { [Op.gte]: end_date } }] }
                ]
            }, {}, transaction);

            if (overlap) {
                await transaction.rollback();
                return res.error("OVERLAP", { message: `Selected dates overlap with an existing leave request (${overlap.start_date} to ${overlap.end_date})` });
            }
        }

        const category = await commonQuery.findOneRecord(LeaveTemplateCategory, leave_category_id, {}, transaction);
        if (!category) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND, { message: "Leave category not found" });
        }

        // --- Automation Rules Validation ---
        const rules = category.automation_rules ? JSON.parse(category.automation_rules) : {};

        // 4. Half Day / Full Day Restriction
        if (rules.allow_half_day === false || rules.allow_full_day === false) {
            const startSess = parseInt(req.body.start_session) || 0;
            const endSess = parseInt(req.body.end_session) || 0;
            const calendarDays = dayjs(end_date).diff(dayjs(start_date), 'day') + 1;

            if (rules.allow_half_day === false) {
                if (startSess !== 0 || endSess !== 0) {
                    await transaction.rollback();
                    return res.error("RULE_VIOLATION", { message: "Half-day leaves are not allowed for this category." });
                }
            }

            if (rules.allow_full_day === false) {
                if (calendarDays > 1) {
                    await transaction.rollback();
                    return res.error("RULE_VIOLATION", { message: "Full-day leaves are not allowed for this category. Please apply for a single half-day session." });
                }
                if (calendarDays === 1 && startSess === 0) {
                    await transaction.rollback();
                    return res.error("RULE_VIOLATION", { message: "Full-day leaves are not allowed for this category. Please select a session for half-day." });
                }
            }
        }

        const employee = await commonQuery.findOneRecord(Employee, employee_id, {
            include: [{ model: LeaveTemplate, as: "leaveTemplate" }]
        }, transaction);

        try {
            await LeaveBalanceService.adjustLeaveBalance(employee_id, leaveRequest.leave_category_id, -parseFloat(leaveRequest.total_days), transaction, dayjs(leaveRequest.start_date), employee);
            await LeaveBalanceService.adjustLeaveBalance(employee_id, leave_category_id, total_days, transaction, dayjs(start_date), employee);
        } catch (error) {
            await transaction.rollback();
            return res.error("INSUFFICIENT_BALANCE", { message: error.message });
        }

        const PUT = { 
            ...req.body, 
            total_days
        };

        if (req.files && Object.keys(req.files).length > 0) {
            const savedFiles = await uploadFile(req, res, constants.LEAVE_DOC_FOLDER, transaction);
            if (savedFiles.document) PUT.document = savedFiles.document;
        }

        await commonQuery.updateRecordById(LeaveRequest, id, PUT, transaction);

        await transaction.commit();
        return res.success("LEAVE_UPDATED");
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
            ["employee.first_name", true, false],
            ["employee.employee_code", true, false],
        ];

        // Add date filtering based on payload
        let whereClause = {};
        const leaveFilter = req.body?.leave_filter;
        
        if (leaveFilter) {
            const today = dayjs().toDate();
            
            switch (leaveFilter) {
                case 'previous':
                    // Previous: ended before today
                    whereClause.end_date = { [Op.lt]: today };
                    break;
                case 'upcoming':
                    // Upcoming: ends today or later
                    whereClause.end_date = { [Op.gte]: today };
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
                // removed where from options as it must be passed as customWhere (Arg 7)
                order: [['created_at', 'DESC']]
            },
            true, // requireTenantFields
            'created_at', // dateField
            whereClause // customWhere
        );

        // Add a "progression" summary for the UI and document URL
        data.items = data?.items?.map(row => {
            const raw = row.get ? row.get({ plain: true }) : row;
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
            const typeLabel = raw.request_type === 'CREDIT' ? " [EARNED]" : "";
            raw.tracking_summary = `${statusLabel}${typeLabel} (Stage ${raw.current_level} of ${total})`;

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

        const template = await commonQuery.findOneRecord(LeaveTemplate, raw.employee.leave_template);
        const totalLevels = template ? template.approval_levels : 1;
        const levelConfigs = template ? (template.approval_config || []) : [];
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
        const { approval_status, approved_by, approval_remark } = req.body;

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
                approval_history: history,
                approval_remark: approval_remark || ""
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

            // Send Notification to Employee
            const user = await commonQuery.findOneRecord(User, { employee_id: leaveRequest.employee_id }, {}, transaction);
            if (user) {
                await notificationService.createNotification({
                    user_id: user.id,
                    title: updateData.approval_status === constants.LEAVE_APPROVAL_STATUS.APPROVED ? "Leave Approved" : "Leave Partially Approved",
                    message: updateData.approval_status === constants.LEAVE_APPROVAL_STATUS.APPROVED 
                        ? `Your leave request for ${dayjs(leaveRequest.start_date).format('DD MMM')} to ${dayjs(leaveRequest.end_date).format('DD MMM')} has been approved.` 
                        : `Your leave request has been partially approved (Stage ${updateData.current_level}).`,
                    type: "LEAVE",
                    reference_id: id,
                    status_code: 0,
                    company_id: req.user.company_id,
                    branch_id: req.user.branch_id
                }, transaction);
            }

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
            }, {}, transaction);

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
                approval_remark: approval_remark || "",
                approval_history: history
            }, transaction);

            // Send Notification to Employee
            const user = await commonQuery.findOneRecord(User, { employee_id: leaveRequest.employee_id }, {}, transaction);
            if (user) {
                await notificationService.createNotification({
                    user_id: user.id,
                    title: `Leave ${approval_status === "REJECTED" ? "Rejected" : "Cancelled"}`,
                    message: `Your leave request from ${dayjs(leaveRequest.start_date).format('DD MMM')} has been ${approval_status}. ${approval_remark ? 'Remarks: ' + approval_remark : ''}`,
                    type: "LEAVE",
                    reference_id: id,
                    status_code: 1, // Warning
                    company_id: req.user.company_id,
                    branch_id: req.user.branch_id
                }, transaction);
            }
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
        // console.log("req.user",req.user)
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
                "status",
                "request_type",
                "is_encashment",
                "start_session",
                "end_session",
                "createdAt"
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
            if (!currentStage) currentStage = { type: "ANYONE" };
            
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
                            employee.attendance_supervisor === req.user.id ||
                            req.user.is_admin) {
                            isAuthorized = true;
                        }
                        break;
                }
            }
            if (isAuthorized) {
                const raw = request.get({ plain: true });
                
                // Add Progression Summary consistent with getAll
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
                const typeLabel = (raw.request_type === 'CREDIT' ? " [EARNED]" : "");
                raw.tracking_summary = `${statusLabel}${typeLabel} (Stage ${raw.current_level} of ${total})`;

                if (raw.document) {
                    const exists = fileExists(constants.LEAVE_DOC_FOLDER, raw.document);
                    raw.document_url = exists ? `${process.env.FILE_SERVER_URL}${constants.LEAVE_DOC_FOLDER}${raw.document}` : null;
                } else {
                    raw.document_url = null;
                }
                pendingForUser.push(raw);
            }
        }

        // --- 5. Apply Search filter ---
        const search = req.body.search ? req.body.search.toLowerCase() : null;
        const filteredPending = search 
            ? pendingForUser.filter(item => {
                const searchString = `${item.employee?.first_name} ${item.employee?.employee_code} ${item.category?.leave_category_name} ${item.reason} ${item.tracking_summary}`.toLowerCase();
                return searchString.includes(search);
            })
            : pendingForUser;

        return res.ok(filteredPending);
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

        // 3.5. Prevent cancelling an already-ended approved leave
        // (system should not allow cancelling once the leave window is in the past)
        if (
            Number(oldStatus) === constants.LEAVE_APPROVAL_STATUS.APPROVED &&
            dayjs(leaveRequest.end_date).isBefore(dayjs().startOf('day'))
        ) {
            await transaction.rollback();
            return res.error("INVALID_OPERATION", { message: "Cannot cancel a leave that has already ended." });
        }

        // 4. Restore Balance
        // We restore balance if the leave was previously PENDING, PARTIALLY_APPROVED, or APPROVED.
        if (
            Number(oldStatus) === constants.LEAVE_APPROVAL_STATUS.PENDING ||
            Number(oldStatus) === constants.LEAVE_APPROVAL_STATUS.PARTIALLY_APPROVED ||
            Number(oldStatus) === constants.LEAVE_APPROVAL_STATUS.APPROVED
        ) {
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
            }, {}, transaction);

            if (balance) {
                // To restore balance, we pass a negative total_days value to adjustLeaveBalance
                // which essentially adds it back (used_leaves - (-total_days) = used_leaves + total_days)
                // Actually, the service adjustLeaveBalance expects positive to deduct. We pass negative to restore.
                await LeaveBalanceService.adjustLeaveBalance(
                    leaveRequest.employee_id, 
                    leaveRequest.leave_category_id, 
                    -parseFloat(leaveRequest.total_days), 
                    transaction, 
                    dayjs(leaveRequest.start_date), 
                    employee
                );
            }
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
        // if (Number(oldStatus) === constants.LEAVE_APPROVAL_STATUS.APPROVED && !leaveRequest.is_encashment) {
        //     const start = dayjs(leaveRequest.start_date);
        //     const end = dayjs(leaveRequest.end_date);
        //     const diff = end.diff(start, 'day');
        //     for (let i = 0; i <= diff; i++) {
        //         const targetDate = start.add(i, 'day').format('YYYY-MM-DD');
        //         await rebuildAttendanceDay(leaveRequest.employee_id, targetDate, { user_id: req.user?.id }, transaction);
        //     }
        // }

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
        let { start_session, end_session } = req.body;
        start_session = parseInt(start_session) || 0;
        end_session = parseInt(end_session) || 0;

        const { leave_category_id } = req.body;
        if (leave_category_id) {
            const category = await commonQuery.findOneRecord(LeaveTemplateCategory, leave_category_id);
            if (category) {
                const rules = category.automation_rules ? JSON.parse(category.automation_rules) : {};
                if (rules.allow_half_day === false && (start_session !== 0 || end_session !== 0)) {
                    return res.error("RULE_VIOLATION", { message: "Half-day leaves are not allowed for this category." });
                }
                if (rules.allow_full_day === false) {
                    if (calendarDays > 1) {
                        return res.error("RULE_VIOLATION", { message: "Full-day leaves are not allowed for this category. Please apply for a single half-day session." });
                    }
                    if (calendarDays === 1 && start_session === 0) {
                        return res.error("RULE_VIOLATION", { message: "Full-day leaves are not allowed for this category. Please select a session for half-day." });
                    }
                }
            }
        }

        if (isEncashment) {
            workingDays = calendarDays;
            if (start_date === end_date && start_session !== 0) {
                workingDays = 0.5;
            } else {
                if (start_session !== 0) workingDays -= 0.5;
                if (end_session !== 0 && start_date !== end_date) workingDays -= 0.5;
            }
        } else {
            for (let i = 0; i < calendarDays; i++) {
                const curDate = start.add(i, 'day');
                const cur = curDate.format('YYYY-MM-DD');
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

                if (isWorking || countSandwich) {
                    let dayVal = 1;
                    if (i === 0 && start_session !== 0) {
                        dayVal = 0.5;
                    } else if (i === (calendarDays - 1) && end_session !== 0) {
                        dayVal = 0.5;
                    }
                    
                    // Handle single day session leave
                    if (calendarDays === 1 && start_session !== 0) {
                        dayVal = 0.5;
                    }

                    workingDays += dayVal;
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

// 12. Get Leave Report
exports.getLeaveReport = async (req, res) => {
    try {
        const { year, staff_type, branch_id } = req.body;

        if (!year) {
             return res.error(constants.VALIDATION_ERROR, "year is required");
        }

        const startDateStr = `${year}-01-01`;
        const endDateStr = `${year}-12-31`;
        const startDate = dayjs(startDateStr);
        const endDate = dayjs(endDateStr);

        // Fetch Employees
        const employeeWhere = { status: 0, company_id: req.user.company_id };
        if (branch_id && branch_id !== 'All' && branch_id !== 0 && branch_id !== '0') employeeWhere.branch_id = branch_id;
        if (staff_type) employeeWhere.employee_type = staff_type;

        // Fetch all branches for mapping since it's not directly included via model sometimes
        const branches = await commonQuery.findAllRecords(BranchMaster, { company_id: req.user.company_id });
        const branchMap = {};
        branches.forEach(b => branchMap[b.id] = b.branch_name);

        const employees = await commonQuery.findAllRecords(Employee, employeeWhere, {
            attributes: ['id', 'first_name', 'employee_code', 'mobile_no', 'joining_date', 'branch_id'],
            include: [
                { model: Department, as: 'department', attributes: ['name'] },
                { model: DesignationMaster, as: 'designation', attributes: ['designation_name'] },
            ]
        });

        if (employees.length === 0) return res.ok({ categories: [], reportData: [] });
        const employeeIds = employees.map(e => e.id);

        // Fetch LeaveBalances logic
        const balances = await commonQuery.findAllRecords(EmployeeLeaveBalance, {
            year: parseInt(year),
            employee_id: { [Op.in]: employeeIds },
            status: 0
        });

        const balancesByEmp = {};
        balances.forEach(b => {
            if(!balancesByEmp[b.employee_id]) balancesByEmp[b.employee_id] = {};
            const catName = b.leave_category_name;
            const assigned = parseFloat(b.total_allocated || 0) + parseFloat(b.carry_forward_leaves || 0);
            balancesByEmp[b.employee_id][catName] = assigned;
        });

        // Prepare categories
        const allLeaveCategories = await commonQuery.findAllRecords(LeaveTemplateCategory, { company_id: req.user.company_id, branch_id: req.user.branch_id, status: 0 });
        const leaveCatNames = allLeaveCategories.map(c => c.leave_category_name);
        const allCategories = ['Week Off', 'Holiday', ...leaveCatNames];

        // Fetch leaves, weekoffs, holidays
        const leaves = await commonQuery.findAllRecords(LeaveRequest, {
            employee_id: { [Op.in]: employeeIds },
            approval_status: constants.LEAVE_APPROVAL_STATUS.APPROVED,
            status: 0,
            [Op.or]: [
                { start_date: { [Op.between]: [startDateStr, endDateStr] } },
                { end_date: { [Op.between]: [startDateStr, endDateStr] } },
                { [Op.and]: [{ start_date: { [Op.lte]: startDateStr } }, { end_date: { [Op.gte]: endDateStr } }] }
            ]
        }, {
            include: [{ model: LeaveTemplateCategory, as: 'category', attributes: ['leave_category_name'] }]
        });

        const holidays = await commonQuery.findAllRecords(EmployeeHoliday, {
            employee_id: { [Op.in]: employeeIds },
            status: 0,
            date: { [Op.between]: [startDateStr, endDateStr] }
        });

        const weekOffs = await commonQuery.findAllRecords(EmployeeWeeklyOff, {
            employee_id: { [Op.in]: employeeIds },
            status: 0
        });

        const holidaysByEmp = {};
        holidays.forEach(h => {
            if(!holidaysByEmp[h.employee_id]) holidaysByEmp[h.employee_id] = [];
            holidaysByEmp[h.employee_id].push({ date: h.date, name: h.name });
        });

        const weekOffsByEmp = {};
        weekOffs.forEach(w => {
            if(!weekOffsByEmp[w.employee_id]) weekOffsByEmp[w.employee_id] = [];
            weekOffsByEmp[w.employee_id].push({ day: w.day_of_week, weekMask: w.week_no });
        });

        const leavesByEmp = {};
        leaves.forEach(l => {
            if(!leavesByEmp[l.employee_id]) leavesByEmp[l.employee_id] = [];
            leavesByEmp[l.employee_id].push({
                start: dayjs(l.start_date).isBefore(startDate) ? startDate : dayjs(l.start_date),
                end: dayjs(l.end_date).isAfter(endDate) ? endDate : dayjs(l.end_date),
                total_days: l.total_days,
                category: l.category?.leave_category_name || 'Other'
            });
        });

        const reportData = employees.map(emp => {
            const row = {
                employee_code: emp.employee_code || '-',
                employee_name: emp.first_name || '-',
                phone: emp.mobile_no || '-',
                branch: branchMap[emp.branch_id] || '-',
                department: emp.department?.name || '-',
                designation: emp.designation?.designation_name || '-',
                assigned: balancesByEmp[emp.id] || {},
                total_used: {},
                pending: {}, // [NEW] Track pending balance
                months: {}
            };
            
            allCategories.forEach(c => {
                row.total_used[c] = 0;
                row.pending[c] = 0;
            });
            for(let m=1; m<=12; m++) {
                row.months[m] = {};
                allCategories.forEach(c => row.months[m][c] = 0);
            }

            const empHolidays = holidaysByEmp[emp.id] || [];
            const empWeekOffs = weekOffsByEmp[emp.id] || [];
            const empLeaves = leavesByEmp[emp.id] || [];
            const leaveSet = new Set();
            
            empLeaves.forEach(lr => {
                let current = lr.start;
                const spanDays = lr.end.diff(lr.start, 'day') + 1;
                // If a leave started or ended out of year, total_days might be off, but approximation holds for split
                const dailyVal = parseFloat(lr.total_days || 0) / spanDays;
                
                while(current.isSameOrBefore(lr.end, 'day')) {
                    const m = current.month() + 1;
                    const cat = lr.category;
                    if (row.months[m][cat] !== undefined) {
                        row.months[m][cat] += dailyVal;
                        row.total_used[cat] += dailyVal;
                    }
                    if (dailyVal >= 0.5) leaveSet.add(current.format('YYYY-MM-DD'));
                    current = current.add(1, 'day');
                }
            });

            // Prevent checking dates before joining
            const empStartDate = emp.joining_date && dayjs(emp.joining_date).isAfter(startDate) 
                                ? dayjs(emp.joining_date) : startDate;

            for (let d = empStartDate; d.isSameOrBefore(endDate, 'day'); d = d.add(1, 'day')) {
                const dateStr = d.format('YYYY-MM-DD');
                if (leaveSet.has(dateStr)) continue; // skip weekoff count if actively on leave
                
                const m = d.month() + 1;
                
                const isHoli = empHolidays.find(h => h.date === dateStr);
                if (isHoli) {
                    row.months[m]['Holiday'] += 1;
                    row.total_used['Holiday'] += 1;
                    continue;
                }

                const weekOfMonth = Math.ceil(d.date() / 7);
                const isWO = empWeekOffs.find(w => {
                     return w.day === d.day() && (w.weekMask === 0 || w.weekMask === weekOfMonth);
                });

                if (isWO) {
                    row.months[m]['Week Off'] += 1;
                    row.total_used['Week Off'] += 1;
                }
            }

            // [NEW] Final calculation of rounded pending balances
            allCategories.forEach(c => {
                row.total_used[c] = parseFloat(row.total_used[c].toFixed(2));
                if (row.assigned[c] !== undefined) {
                    row.pending[c] = parseFloat((row.assigned[c] - row.total_used[c]).toFixed(2));
                } else {
                    row.pending[c] = '-'; // For categories like Week Off/Holiday that don't have a fixed allocation
                }
            });

            return row;
        });

        return res.ok({ categories: allCategories, reportData });
    } catch (err) {
        return handleError(err, res, req);
    }
};
