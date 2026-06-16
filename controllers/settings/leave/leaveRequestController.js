const { LeaveRequest, EmployeeLeaveBalance, LeaveTemplate, LeaveTemplateCategory, Employee, User, sequelize, BranchMaster, AttendanceDay, AttendancePunch, Department, DesignationMaster, EmployeeWeeklyOff, EmployeeHoliday, RolePermission, EmployeeAttendanceTemplate, AttendanceTemplate } = require("../../../models");
const { validateRequest, commonQuery, handleError, uploadFile, fileExists, formatDateTime, getCompanySetting } = require("../../../helpers");
const { constants } = require("../../../helpers/constants");
const { Op } = require("sequelize");
const { rebuildAttendanceDay, getDayOffInfo } = require("../../../helpers/attendanceHelper");
const dayjs = require("dayjs");
const isSameOrBefore = require("dayjs/plugin/isSameOrBefore");
dayjs.extend(isSameOrBefore);
const LeaveBalanceService = require("../../../services/leaveBalanceService");
const notificationService = require("../../../services/notificationService");

const getApproversForLeaveRequest = async (employeeId, currentLevel, transaction) => {
    try {
        const employee = await commonQuery.findOneRecord(Employee, employeeId, {
            include: [{ model: LeaveTemplate, as: "leaveTemplate" }]
        }, transaction);

        if (!employee) return [];

        const template = employee.leaveTemplate;
        const config = template ? (template.approval_config || []) : [];
        const currentStage = config.find(c => c.level === currentLevel) || { type: "ANYONE" };
        const { type } = currentStage;

        const userIds = new Set();

        if (type === 'REPORTING_MANAGER' || type === 'ATTENDANCE_SUPERVISOR' || type === 'ANYONE') {
            if (employee.reporting_manager) {
                userIds.add(employee.reporting_manager);
            }
            if (employee.attendance_supervisor) {
                userIds.add(employee.attendance_supervisor);
            }
        }

        if (type === 'ADMIN' || type === 'ANYONE' || type === 'EMPLOYER') {
            const adminFilters = {
                status: 0,
                [Op.or]: [
                    { is_super_admin: true },
                    { '$RolePermission.role_key$': constants.ROLE_KEYS.BUSINESS_ADMIN },
                    { '$RolePermission.role_key$': constants.ROLE_KEYS.ADMIN }
                ]
            };
            const admins = await commonQuery.findAllRecords(User, adminFilters, {
                include: [{ model: RolePermission, as: 'RolePermission', attributes: [] }],
                attributes: ['id'],
                raw: true
            }, transaction);

            admins.forEach(a => userIds.add(a.id));
        }

        return [...userIds];
    } catch (err) {
        console.error("Error in getApproversForLeaveRequest:", err);
        return [];
    }
};

const sendApprovalNotifications = async (leaveRequest, employee, actionType, transaction) => {
    try {
        if (!employee && leaveRequest.employee_id) {
            employee = await commonQuery.findOneRecord(Employee, leaveRequest.employee_id, {}, transaction);
        }
        let employeeEmail = employee?.email;
        if (!employeeEmail && employee) {
            const linkedUser = await commonQuery.findOneRecord(User, { employee_id: employee.id }, { attributes: ["email"] }, transaction);
            if (linkedUser) {
                employeeEmail = linkedUser.email;
            }
        }
        const userIds = await getApproversForLeaveRequest(leaveRequest.employee_id, leaveRequest.current_level, transaction);
        if (!userIds || userIds.length === 0) return;

        const employeeName = employee ? `${employee.first_name || ""} ${employee.last_name || ""}`.trim() : "An employee";
        const startDateStr = formatDateTime(leaveRequest.start_date, 'DD MMM YYYY');
        const endDateStr = formatDateTime(leaveRequest.end_date, 'DD MMM YYYY');

        // Fetch company settings to see if email sending for comp-off credit is enabled
        const companySettings = await getCompanySetting(leaveRequest.company_id);
        const sendEmail = companySettings && (
            companySettings.send_email_compoff_credit === true ||
            companySettings.send_email_compoff_credit === "true" ||
            companySettings.send_email_compoff_credit === 1 ||
            companySettings.send_email_compoff_credit === "1"
        );

        let title = "";
        let message = "";
        let statusCode = 0;

        if (actionType === "CREATE") {
            title = "New Leave Request Pending Approval";
            message = `${employeeName} has requested leave from ${startDateStr} to ${endDateStr}.`;
            statusCode = 0;
        } else if (actionType === "UPDATE") {
            title = "Leave Request Updated";
            message = `${employeeName} has updated their leave request from ${startDateStr} to ${endDateStr}.`;
            statusCode = 0;
        } else if (actionType === "CANCEL") {
            title = "Leave Request Cancelled";
            message = `${employeeName} has cancelled their leave request from ${startDateStr} to ${endDateStr}.`;
            statusCode = 1; // Warning / Cancelled
        }

        for (const userId of userIds) {
            // Avoid notifying the employee themselves about their own action
            const user = await commonQuery.findOneRecord(User, { id: userId }, { attributes: ["employee_id", "email", "user_name"] }, transaction);
            if (user && user.employee_id === leaveRequest.employee_id) {
                continue;
            }

            await notificationService.createNotification({
                user_id: userId,
                title,
                message,
                type: "LEAVE",
                reference_id: leaveRequest.id,
                status_code: statusCode,
                company_id: leaveRequest.company_id,
                branch_id: leaveRequest.branch_id
            }, transaction);

            // Send Comp-off credit email to manager if setting is enabled
            if (leaveRequest.request_type === 'CREDIT' && sendEmail && actionType === "CREATE" && user && user.email) {
                const template = employee?.leaveTemplate;
                const totalLevels = template?.approval_levels || 1;
                const emailService = require("../../../services/emailService");

                emailService.sendCompOffCreditApprovalEmail({
                    companyId: leaveRequest.company_id,
                    employeeName,
                    employeeEmail,
                    approverEmail: user.email,
                    approverName: user.user_name || "Manager",
                    date: startDateStr,
                    totalDays: parseFloat(leaveRequest.total_days || 0),
                    level: leaveRequest.current_level,
                    totalLevels
                }).catch(err => {
                    console.error("[Email] Failed to send comp-off credit approval email to:", user.email, err);
                });
            }
        }
    } catch (err) {
        console.error("Error sending approval level notifications:", err);
    }
};

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

        // Fetch employee & category upfront
        const employee = await commonQuery.findOneRecord(Employee, employee_id, {
            include: [
                { model: LeaveTemplate, as: "leaveTemplate" },
                { model: EmployeeAttendanceTemplate, as: "employeeAttendanceTemplate", where: { status: 0 }, required: false },
                { model: AttendanceTemplate, as: "attendanceTemplate", required: false }
            ]
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
        let is_credit = req.body.request_type === 'CREDIT';

        if (is_encashment) {
            total_days = requestedTotal;
        } else if (is_credit) {
            if (start_date !== end_date) {
                await transaction.rollback();
                return res.error("INVALID_DATE_RANGE", { message: "Comp-off credit request must be applied day-by-day (start date and end date must be same)." });
            }

            const attTemplate = employee.employeeAttendanceTemplate || employee.attendanceTemplate;
            if (!attTemplate || attTemplate.holiday_policy !== 'COMP_OFF') {
                await transaction.rollback();
                return res.error("RULE_VIOLATION", { message: "Your attendance template does not support Comp-Off leaves." });
            }

            const { isHoliday, isWeeklyOff } = await getDayOffInfo(employee, start_date, transaction);
            if (!isHoliday && !isWeeklyOff) {
                await transaction.rollback();
                return res.error("RULE_VIOLATION", { message: "Comp-off can only be claimed for working on Holidays or Weekly Offs." });
            }

            const attendance = await commonQuery.findOneRecord(AttendanceDay, {
                employee_id,
                attendance_date: start_date,
                status: { [Op.ne]: 2 }
            }, {}, transaction);

            if (!attendance) {
                await transaction.rollback();
                return res.error("NO_ATTENDANCE", { message: "No attendance record found for this day. You must punch in/out to claim Comp-Off." });
            }

            const workedMins = parseFloat(attendance.worked_minutes || 0);
            const minCompOff = attTemplate.comp_off_min_working_mins || 0;
            const maxCompOff = attTemplate.comp_off_max_working_mins || 0;

            if (workedMins >= maxCompOff && maxCompOff > 0) {
                total_days = 1.0;
            } else if (workedMins >= minCompOff && minCompOff > 0) {
                total_days = 0.5;
            } else {
                await transaction.rollback();
                return res.error("RULE_VIOLATION", { message: `Insufficient working minutes on this day to earn Comp-Off. Worked: ${workedMins} mins, Required min: ${minCompOff} mins.` });
            }

            // Check for duplicate CREDIT request for the same day
            const overlap = await commonQuery.findOneRecord(LeaveRequest, {
                employee_id,
                request_type: 'CREDIT',
                start_date: start_date,
                approval_status: { [Op.notIn]: [constants.LEAVE_APPROVAL_STATUS.REJECTED, constants.LEAVE_APPROVAL_STATUS.CANCELLED, constants.LEAVE_APPROVAL_STATUS.DELETED] },
                status: 0
            }, {}, transaction);

            if (overlap) {
                await transaction.rollback();
                return res.error("OVERLAP", { message: "Selected date already has a compensatory off credit request." });
            }
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

            if (total_days <= 0) {
                await transaction.rollback();
                return res.error("INVALID_TOTAL_DAYS", { message: "Calculated leave days must be greater than 0. Selected dates might be holidays or weekly-offs." });
            }

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
                return res.error("OVERLAP", { message: `Selected dates overlap with an existing leave request (${formatDateTime(overlap.start_date)} to ${formatDateTime(overlap.end_date)})` });
            }
        }

        const template = employee.leaveTemplate;
        const cycleType = template ? template.leave_policy_cycle : 'CALENDAR_YEAR';

        // Check if the current leave template cycle ends this month/period, and restrict next month's leave to only unpaid categories.
        const currentCycle = LeaveBalanceService.getCycleDates(employee.joining_date, cycleType, dayjs());
        const leaveStartDate = dayjs(start_date);
        if (!is_credit && currentCycle.end.isBefore(leaveStartDate) && category.is_paid) {
            await transaction.rollback();
            return res.error("RULE_VIOLATION", {
                message: "Only unpaid leaves can be applied for the next cycle/month."
            });
        }

        // --- Automation Rules Validation ---
        if (!is_credit) {
            const rules = category.automation_rules ? JSON.parse(category.automation_rules) : {};

            // 1. Generic Usage Limit (Monthly/Quarterly/Yearly - total days)
            if (rules.limit_window && rules.limit_window !== 'none' && rules.max_total_days) {
                const refDate = dayjs(start_date);
                let startDateRange, endDateRange;
                let totalMaxDays = parseFloat(rules.max_total_days);

                if (rules.limit_window === 'monthly') {
                    startDateRange = refDate.startOf('month').format('YYYY-MM-DD');
                    endDateRange = refDate.endOf('month').format('YYYY-MM-DD');

                    if (rules.carry_forward) {
                        const template = employee.leaveTemplate;
                        const cycleType = template ? template.leave_policy_cycle : 'CALENDAR_YEAR';
                        const cycleDates = LeaveBalanceService.getCycleDates(employee.joining_date, cycleType, refDate);

                        // If the cycle itself is monthly, carry forward doesn't apply across months unless we anchor to a year
                        // But usually, carry_forward for monthly limits implies an annual cycle.
                        if (cycleType !== 'MONTHLY') {
                            startDateRange = cycleDates.start.format('YYYY-MM-DD');
                            const monthsPassed = refDate.endOf('month').diff(cycleDates.start.startOf('month'), 'month') + 1;
                            totalMaxDays = parseFloat(rules.max_total_days) * monthsPassed;
                        }
                    }
                } else if (rules.limit_window === 'quarterly') {
                    startDateRange = refDate.startOf('quarter').format('YYYY-MM-DD');
                    endDateRange = refDate.endOf('quarter').format('YYYY-MM-DD');

                    if (rules.carry_forward) {
                        const template = employee.leaveTemplate;
                        const cycleType = template ? template.leave_policy_cycle : 'CALENDAR_YEAR';
                        const cycleDates = LeaveBalanceService.getCycleDates(employee.joining_date, cycleType, refDate);

                        if (cycleType !== 'MONTHLY' && cycleType !== 'QUARTERLY') {
                            startDateRange = cycleDates.start.format('YYYY-MM-DD');
                            const quartersPassed = Math.floor(refDate.endOf('month').diff(cycleDates.start.startOf('month'), 'month') / 3) + 1;
                            totalMaxDays = parseFloat(rules.max_total_days) * quartersPassed;
                        }
                    }
                } else if (rules.limit_window === 'yearly') {
                    startDateRange = refDate.startOf('year').format('YYYY-MM-DD');
                    endDateRange = refDate.endOf('year').format('YYYY-MM-DD');
                } else if (rules.limit_window.endsWith('_month')) {
                    const months = parseInt(rules.limit_window.split('_')[0]);
                    if (!isNaN(months) && months > 0) {
                        startDateRange = refDate.subtract(months - 1, 'month').startOf('month').format('YYYY-MM-DD');
                        endDateRange = refDate.endOf('month').format('YYYY-MM-DD');
                    }
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

                    if ((totalUsed + total_days) > totalMaxDays) {
                        await transaction.rollback();
                        const limitLabel = rules.carry_forward ? `accumulated ${rules.limit_window}` : rules.limit_window.replace('_', ' ');
                        return res.error("RULE_VIOLATION", { message: `Usage exceeds limit. Max ${totalMaxDays} days allowed for ${limitLabel}. Already used: ${totalUsed} days.` });
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

                    const fineData = attendance.fine_data || {};
                    const lateEntry = fineData.late_entry?.minutes || 0;
                    const earlyExit = fineData.early_exit?.minutes || 0;
                    const excessBreaks = fineData.excess_breaks?.minutes || 0;

                    const formatMinutesToHours = (mins) => {
                        if (mins >= 60) {
                            const hrs = Math.floor(mins / 60);
                            const remMins = mins % 60;
                            return remMins > 0 ? `${hrs}hr ${remMins} minutes` : `${hrs}hr`;
                        }
                        return `${mins} minutes`;
                    };

                    const parts = [];
                    if (lateEntry > 0) {
                        parts.push(`Late Entry ${formatMinutesToHours(lateEntry)}`);
                    }
                    if (earlyExit > 0) {
                        parts.push(`Early Exit ${formatMinutesToHours(earlyExit)}`);
                    }
                    if (excessBreaks > 0) {
                        parts.push(`Excess Break Time ${formatMinutesToHours(excessBreaks)}`);
                    }

                    if (parts.length > 0) {
                        const dynamicReason = `leave Request for ${parts.join(" and ")}`;
                        req.body.reason = req.body.reason ? `${req.body.reason} - ${dynamicReason}` : dynamicReason;
                    }
                } else {
                    // If no attendance record exists for the selected date (past, present, or future), the rule is violated
                    await transaction.rollback();
                    return res.error("RULE_VIOLATION", { message: `Your Selected Date has no attendance record. Please add attendance first.` });
                }
            }
        }

        const leaveTemplate = employee.leaveTemplate;
        const leaveCycleType = leaveTemplate ? leaveTemplate.leave_policy_cycle : 'CALENDAR_YEAR';
        const leaveCycleDates = LeaveBalanceService.getCycleDates(employee.joining_date, leaveCycleType, dayjs(start_date));

        let balance = await commonQuery.findOneRecord(EmployeeLeaveBalance, {
            employee_id,
            leave_category_id,
            year: leaveCycleDates.end.year(),
            month: leaveCycleType === 'MONTHLY' ? leaveCycleDates.end.month() + 1 : null,
            status: 0
        }, {}, transaction);

        // If no balance exists yet (e.g. for a future month/quarter), initialize it on-the-fly
        if (!balance && employee.leave_template) {
            console.log(`[LeaveRequest] Auto-initializing future balance for Emp=${employee_id}, Cat=${leave_category_id} as of ${start_date}`);
            await LeaveBalanceService.initializeBalance(
                employee_id,
                employee.leave_template,
                transaction,
                employee,
                null,
                dayjs(start_date).toDate()
            );

            // Re-fetch the newly created future balance
            balance = await commonQuery.findOneRecord(EmployeeLeaveBalance, {
                employee_id,
                leave_category_id,
                year: leaveCycleDates.end.year(),
                month: leaveCycleType === 'MONTHLY' ? leaveCycleDates.end.month() + 1 : null,
                status: 0
            }, {}, transaction);
        }

        if (!balance) {
            await transaction.rollback();
            return res.error("BALANCE_NOT_FOUND", { message: "No leave balance found for this category. Please check employee's leave balance." });
        }

        // 2. Adjust Balance via Service (Only for DEBIT leaves)
        if (!is_credit) {
            try {
                await LeaveBalanceService.adjustLeaveBalance(employee_id, leave_category_id, total_days, transaction, start_date, employee);
            } catch (error) {
                await transaction.rollback();
                return res.error("INSUFFICIENT_BALANCE", { message: error.message });
            }
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
            try {
                const savedFiles = await uploadFile(req, res, constants.LEAVE_DOC_FOLDER, transaction);
                if (savedFiles.document) {
                    POST.document = savedFiles.document;
                }
            } catch (error) {
                if (!transaction.finished) await transaction.rollback();
                return handleError(error, res, req);
            }
        }

        const leaveRequest = await commonQuery.createRecord(LeaveRequest, {
            ...POST,
            approval_status: constants.LEAVE_APPROVAL_STATUS.PENDING,
            current_level: 1,
            approval_history: []
        }, transaction);

        // Notify approval level users
        await sendApprovalNotifications(leaveRequest, employee, "CREATE", transaction);

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

        // Fetch employee & category upfront
        const employee = await commonQuery.findOneRecord(Employee, employee_id, {
            include: [
                { model: LeaveTemplate, as: "leaveTemplate" },
                { model: EmployeeAttendanceTemplate, as: "employeeAttendanceTemplate", where: { status: 0 }, required: false },
                { model: AttendanceTemplate, as: "attendanceTemplate", required: false }
            ]
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

        start_session = parseInt(start_session) || 0;
        end_session = parseInt(end_session) || 0;
        const requestedTotal = parseFloat(req.body.total_days || 0);

        let total_days = 0;
        let is_encashment = req.body.is_encashment === true || req.body.is_encashment === "true";
        let is_credit = req.body.request_type === 'CREDIT';

        if (is_encashment) {
            total_days = requestedTotal;
        } else if (is_credit) {
            if (start_date !== end_date) {
                await transaction.rollback();
                return res.error("INVALID_DATE_RANGE", { message: "Comp-off credit request must be applied day-by-day (start date and end date must be same)." });
            }

            const attTemplate = employee.employeeAttendanceTemplate || employee.attendanceTemplate;
            if (!attTemplate || attTemplate.holiday_policy !== 'COMP_OFF') {
                await transaction.rollback();
                return res.error("RULE_VIOLATION", { message: "Your attendance template does not support Comp-Off leaves." });
            }

            const { isHoliday, isWeeklyOff } = await getDayOffInfo(employee, start_date, transaction);
            if (!isHoliday && !isWeeklyOff) {
                await transaction.rollback();
                return res.error("RULE_VIOLATION", { message: "Comp-off can only be claimed for working on Holidays or Weekly Offs." });
            }

            const attendance = await commonQuery.findOneRecord(AttendanceDay, {
                employee_id,
                attendance_date: start_date,
                status: { [Op.ne]: 2 }
            }, {}, transaction);

            if (!attendance) {
                await transaction.rollback();
                return res.error("NO_ATTENDANCE", { message: "No attendance record found for this day. You must punch in/out to claim Comp-Off." });
            }

            const workedMins = parseFloat(attendance.worked_minutes || 0);
            const minCompOff = attTemplate.comp_off_min_working_mins || 0;
            const maxCompOff = attTemplate.comp_off_max_working_mins || 0;

            if (workedMins >= maxCompOff && maxCompOff > 0) {
                total_days = 1.0;
            } else if (workedMins >= minCompOff && minCompOff > 0) {
                total_days = 0.5;
            } else {
                await transaction.rollback();
                return res.error("RULE_VIOLATION", { message: `Insufficient working minutes on this day to earn Comp-Off. Worked: ${workedMins} mins, Required min: ${minCompOff} mins.` });
            }

            // Check for duplicate CREDIT request for the same day (excluding this request)
            const overlap = await commonQuery.findOneRecord(LeaveRequest, {
                employee_id,
                id: { [Op.ne]: id },
                request_type: 'CREDIT',
                start_date: start_date,
                approval_status: { [Op.notIn]: [constants.LEAVE_APPROVAL_STATUS.REJECTED, constants.LEAVE_APPROVAL_STATUS.CANCELLED, constants.LEAVE_APPROVAL_STATUS.DELETED] },
                status: 0
            }, {}, transaction);

            if (overlap) {
                await transaction.rollback();
                return res.error("OVERLAP", { message: "Selected date already has a compensatory off credit request." });
            }
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

            if (total_days <= 0) {
                await transaction.rollback();
                return res.error("INVALID_TOTAL_DAYS", { message: "Calculated leave days must be greater than 0. Selected dates might be holidays or weekly-offs." });
            }

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
                return res.error("OVERLAP", { message: `Selected dates overlap with an existing leave request (${formatDateTime(overlap.start_date)} to ${formatDateTime(overlap.end_date)})` });
            }
        }

        // --- Automation Rules Validation ---
        if (!is_credit) {
            const rules = category.automation_rules ? JSON.parse(category.automation_rules) : {};

            // 1. Generic Usage Limit (Monthly/Quarterly/Yearly - total days)
            if (rules.limit_window && rules.limit_window !== 'none' && rules.max_total_days) {
                const refDate = dayjs(start_date);
                let startDateRange, endDateRange;
                let totalMaxDays = parseFloat(rules.max_total_days);

                if (rules.limit_window === 'monthly') {
                    startDateRange = refDate.startOf('month').format('YYYY-MM-DD');
                    endDateRange = refDate.endOf('month').format('YYYY-MM-DD');

                    if (rules.carry_forward) {
                        const template = employee.leaveTemplate;
                        const cycleType = template ? template.leave_policy_cycle : 'CALENDAR_YEAR';
                        const cycleDates = LeaveBalanceService.getCycleDates(employee.joining_date, cycleType, refDate);

                        if (cycleType !== 'MONTHLY') {
                            startDateRange = cycleDates.start.format('YYYY-MM-DD');
                            const monthsPassed = refDate.endOf('month').diff(cycleDates.start.startOf('month'), 'month') + 1;
                            totalMaxDays = parseFloat(rules.max_total_days) * monthsPassed;
                        }
                    }
                } else if (rules.limit_window === 'quarterly') {
                    startDateRange = refDate.startOf('quarter').format('YYYY-MM-DD');
                    endDateRange = refDate.endOf('quarter').format('YYYY-MM-DD');

                    if (rules.carry_forward) {
                        const template = employee.leaveTemplate;
                        const cycleType = template ? template.leave_policy_cycle : 'CALENDAR_YEAR';
                        const cycleDates = LeaveBalanceService.getCycleDates(employee.joining_date, cycleType, refDate);

                        if (cycleType !== 'MONTHLY' && cycleType !== 'QUARTERLY') {
                            startDateRange = cycleDates.start.format('YYYY-MM-DD');
                            const quartersPassed = Math.floor(refDate.endOf('month').diff(cycleDates.start.startOf('month'), 'month') / 3) + 1;
                            totalMaxDays = parseFloat(rules.max_total_days) * quartersPassed;
                        }
                    }
                } else if (rules.limit_window === 'yearly') {
                    startDateRange = refDate.startOf('year').format('YYYY-MM-DD');
                    endDateRange = refDate.endOf('year').format('YYYY-MM-DD');
                } else if (rules.limit_window.endsWith('_month')) {
                    const months = parseInt(rules.limit_window.split('_')[0]);
                    if (!isNaN(months) && months > 0) {
                        startDateRange = refDate.subtract(months - 1, 'month').startOf('month').format('YYYY-MM-DD');
                        endDateRange = refDate.endOf('month').format('YYYY-MM-DD');
                    }
                }

                if (startDateRange && endDateRange) {
                    const totalUsed = await LeaveRequest.sum('total_days', {
                        where: {
                            employee_id,
                            id: { [Op.ne]: id }, // Exclude current request
                            leave_category_id,
                            approval_status: { [Op.notIn]: [constants.LEAVE_APPROVAL_STATUS.REJECTED, constants.LEAVE_APPROVAL_STATUS.CANCELLED, constants.LEAVE_APPROVAL_STATUS.DELETED] },
                            status: 0,
                            start_date: { [Op.between]: [startDateRange, endDateRange] }
                        },
                        transaction
                    }) || 0;

                    if ((totalUsed + total_days) > totalMaxDays) {
                        await transaction.rollback();
                        const limitLabel = rules.carry_forward ? `accumulated ${rules.limit_window}` : rules.limit_window.replace('_', ' ');
                        return res.error("RULE_VIOLATION", { message: `Usage exceeds limit. Max ${totalMaxDays} days allowed for ${limitLabel}. Already used: ${totalUsed} days.` });
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
        }

        const template = employee?.leaveTemplate;
        const cycleType = template ? template.leave_policy_cycle : 'CALENDAR_YEAR';

        // Check if the current leave template cycle ends this month/period, and restrict next month's leave to only unpaid categories.
        const currentCycle = LeaveBalanceService.getCycleDates(employee.joining_date, cycleType, dayjs());
        const leaveStartDate = dayjs(start_date);
        if (!is_credit && currentCycle.end.isBefore(leaveStartDate) && category.is_paid) {
            await transaction.rollback();
            return res.error("RULE_VIOLATION", {
                message: "Only unpaid leaves can be applied for the next cycle/month."
            });
        }

        if (!is_credit) {
            try {
                await LeaveBalanceService.adjustLeaveBalance(employee_id, leaveRequest.leave_category_id, -parseFloat(leaveRequest.total_days), transaction, dayjs(leaveRequest.start_date), employee);
                await LeaveBalanceService.adjustLeaveBalance(employee_id, leave_category_id, total_days, transaction, dayjs(start_date), employee);
            } catch (error) {
                await transaction.rollback();
                return res.error("INSUFFICIENT_BALANCE", { message: error.message });
            }
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

        // Notify approval level users
        await sendApprovalNotifications(leaveRequest, employee, "UPDATE", transaction);

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

        // If status filter is sent from useTableData, map it to approval_status
        if (req.body?.status !== undefined && req.body?.status !== null && req.body?.status !== '') {
            const statusVal = req.body.status;
            delete req.body.status;

            if (statusVal !== "All") {
                if (!req.body.filter) {
                    req.body.filter = {};
                }
                req.body.filter.approval_status = statusVal;
            }
        }

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

        // Extract custom date filters if provided
        const startDate = req.body?.startDate;
        const endDate = req.body?.endDate;
        if (startDate || endDate) {
            delete req.body.startDate;
            delete req.body.endDate;

            if (startDate && endDate) {
                if (!whereClause[Op.and]) {
                    whereClause[Op.and] = [];
                }
                whereClause[Op.and].push(
                    { start_date: { [Op.lte]: dayjs(endDate).endOf('day').toDate() } },
                    { end_date: { [Op.gte]: dayjs(startDate).startOf('day').toDate() } }
                );
            } else if (startDate) {
                whereClause.end_date = { ...(whereClause.end_date || {}), [Op.gte]: dayjs(startDate).startOf('day').toDate() };
            } else if (endDate) {
                whereClause.start_date = { ...(whereClause.start_date || {}), [Op.lte]: dayjs(endDate).endOf('day').toDate() };
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
            LeaveRequest,
            req.body,
            fieldConfig,
            {
                include: [
                    {
                        model: Employee,
                        as: "employee",
                        attributes: ["id", "first_name", "employee_code", "profile_image", "joining_date", "employment_type"],
                        include: [{ model: LeaveTemplate, as: "leaveTemplate", attributes: ["approval_levels"] }],
                        where: employeeWhere,
                        required: true
                    },
                    { model: LeaveTemplateCategory, as: "category", attributes: ["leave_category_name"] },
                    { model: User, as: "approvedBy", attributes: ["id", "user_name"], required: false }
                ],
                attributes: { exclude: ['reason'] },
                // removed where from options as it must be passed as customWhere (Arg 7)
                order: [['created_at', 'DESC']]
            },
            isOwnRequest ? { applyHierarchy: false } : true, // requireTenantFields
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

            if (raw.employee) {
                raw.employee.profile_image_url = raw.employee.profile_image
                    ? `${process.env.FILE_SERVER_URL}${constants.EMPLOYEE_IMG_FOLDER}${raw.employee.profile_image}`
                    : null;
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

        if (raw.request_type === 'CREDIT') {
            const { AttendancePunch } = require("../../../models");
            const attendance = await commonQuery.findOneRecord(AttendanceDay, {
                employee_id: raw.employee_id,
                attendance_date: raw.start_date,
                status: { [Op.ne]: 2 }
            }, {
                include: [
                    {
                        model: AttendancePunch,
                        as: "attendancePunches",
                        where: { status: 0 },
                        required: false
                    }
                ]
            });
            raw.worked_minutes = attendance ? parseFloat(attendance.worked_minutes || 0) : 0;
            raw.punches = attendance?.attendancePunches || [];

            const { EmployeeAttendanceTemplate, AttendanceTemplate } = require("../../../models");
            const empWithTemplates = await commonQuery.findOneRecord(Employee, raw.employee_id, {
                include: [
                    { model: EmployeeAttendanceTemplate, as: "employeeAttendanceTemplate", where: { status: 0 }, required: false },
                    { model: AttendanceTemplate, as: "attendanceTemplate", required: false }
                ]
            });
            const attTemplate = empWithTemplates?.employeeAttendanceTemplate || empWithTemplates?.attendanceTemplate;
            raw.comp_off_min_working_mins = attTemplate ? (attTemplate.comp_off_min_working_mins || 0) : 0;
            raw.comp_off_max_working_mins = attTemplate ? (attTemplate.comp_off_max_working_mins || 0) : 0;
        }

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

        raw.approval_history = (raw.approval_history || []).map(h => {
            const user = approvers.find(u => u.id === (h.approved_by || h.by));
            return {
                ...h,
                user_name: user ? user.user_name : null
            };
        });

        const history = raw.approval_history;
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
        const { approval_status, approved_by, approval_remark, total_days } = req.body;

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

            if (leaveRequest.request_type === 'CREDIT' && total_days !== undefined) {
                const parsedDays = parseFloat(total_days);
                updateData.total_days = parsedDays;
                leaveRequest.total_days = parsedDays; // Update local reference for subsequent balance adjustment
            }

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
                        ? `Your leave request for ${formatDateTime(leaveRequest.start_date, 'DD MMM')} to ${formatDateTime(leaveRequest.end_date, 'DD MMM')} has been approved.`
                        : `Your leave request has been partially approved (Stage ${updateData.current_level}).`,
                    type: "LEAVE",
                    reference_id: id,
                    status_code: 0,
                    company_id: req.user.company_id,
                    branch_id: req.user.branch_id
                }, transaction);
            }

            if (updateData.approval_status === constants.LEAVE_APPROVAL_STATUS.PARTIALLY_APPROVED) {
                // Notify the next approval level users
                const rawRequest = leaveRequest.get ? leaveRequest.get({ plain: true }) : leaveRequest;
                await sendApprovalNotifications({
                    ...rawRequest,
                    current_level: updateData.current_level
                }, employee, "CREATE", transaction);
            }

            if (Number(updateData.approval_status) === constants.LEAVE_APPROVAL_STATUS.APPROVED) {
                if (leaveRequest.request_type === 'CREDIT') {
                    try {
                        await LeaveBalanceService.adjustLeaveBalance(
                            leaveRequest.employee_id,
                            leaveRequest.leave_category_id,
                            -parseFloat(leaveRequest.total_days),
                            transaction,
                            dayjs(leaveRequest.start_date),
                            employee,
                            true
                        );
                    } catch (balErr) {
                        await transaction.rollback();
                        return res.error("RULE_VIOLATION", { message: balErr.message || balErr });
                    }
                } else if (!leaveRequest.is_encashment) {
                    const start = dayjs(leaveRequest.start_date);
                    const end = dayjs(leaveRequest.end_date);
                    const diff = end.diff(start, 'day');
                    const todayStr = dayjs().format('YYYY-MM-DD');
                    for (let i = 0; i <= diff; i++) {
                        const targetDate = start.add(i, 'day').format('YYYY-MM-DD');
                        if (targetDate <= todayStr) {
                            await rebuildAttendanceDay(leaveRequest.employee_id, targetDate, { user_id: req.user?.id }, transaction);
                        }
                    }
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
                try {
                    if (leaveRequest.request_type === 'CREDIT') {
                        if (Number(oldStatus) === constants.LEAVE_APPROVAL_STATUS.APPROVED) {
                            await LeaveBalanceService.adjustLeaveBalance(
                                leaveRequest.employee_id,
                                leaveRequest.leave_category_id,
                                parseFloat(leaveRequest.total_days),
                                transaction,
                                dayjs(leaveRequest.start_date),
                                employee,
                                true
                            );
                        }
                    } else {
                        await LeaveBalanceService.adjustLeaveBalance(
                            leaveRequest.employee_id,
                            leaveRequest.leave_category_id,
                            -parseFloat(leaveRequest.total_days),
                            transaction,
                            dayjs(leaveRequest.start_date),
                            employee
                        );
                    }
                } catch (balErr) {
                    await transaction.rollback();
                    return res.error("RULE_VIOLATION", { message: balErr.message || balErr });
                }
            }

            const actionStr = (approval_status === "REJECTED" || Number(approval_status) === constants.LEAVE_APPROVAL_STATUS.REJECTED) ? "REJECTED" : "CANCELLED";
            const history = leaveRequest.approval_history || [];
            history.push({
                level: currentLevel,
                action: actionStr,
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
                    message: `Your leave request from ${formatDateTime(leaveRequest.start_date, 'DD MMM')} has been ${approval_status}. ${approval_remark ? 'Remarks: ' + approval_remark : ''}`,
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
        const isEncashment = req.body.is_encashment === true || req.body.request_type === 'ENCASHMENT';

        const whereClause = {
            approval_status: { [Op.in]: [constants.LEAVE_APPROVAL_STATUS.PENDING, constants.LEAVE_APPROVAL_STATUS.PARTIALLY_APPROVED] },
            status: 0
        };

        if (isEncashment) {
            whereClause.is_encashment = true;
            whereClause.request_type = 'ENCASHMENT';
        } else {
            whereClause.request_type = { [Op.ne]: 'ENCASHMENT' };
        }

        const requests = await commonQuery.findAllRecords(LeaveRequest, whereClause, {
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
                        // Anyone of Reporting Manager, Supervisor, Admin, etc.
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
                let typeLabel = "";
                if (raw.request_type === 'CREDIT') typeLabel = " [EARNED]";
                else if (raw.request_type === 'ENCASHMENT') typeLabel = " [ENCASHMENT]";
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
        // if (
        //     Number(oldStatus) === constants.LEAVE_APPROVAL_STATUS.APPROVED &&
        //     dayjs(leaveRequest.end_date).isBefore(dayjs().startOf('day'))
        // ) {
        //     await transaction.rollback();
        //     return res.error("INVALID_OPERATION", { message: "Cannot cancel a leave that has already ended." });
        // }

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
                try {
                    if (leaveRequest.request_type === 'CREDIT') {
                        if (Number(oldStatus) === constants.LEAVE_APPROVAL_STATUS.APPROVED) {
                            await LeaveBalanceService.adjustLeaveBalance(
                                leaveRequest.employee_id,
                                leaveRequest.leave_category_id,
                                parseFloat(leaveRequest.total_days),
                                transaction,
                                dayjs(leaveRequest.start_date),
                                employee,
                                true
                            );
                        }
                    } else {
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
                } catch (balErr) {
                    await transaction.rollback();
                    return res.error("RULE_VIOLATION", { message: balErr.message || balErr });
                }
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

        // Notify approval level users about the cancellation
        const employee = await commonQuery.findOneRecord(Employee, leaveRequest.employee_id, {
            include: [{ model: LeaveTemplate, as: "leaveTemplate" }]
        }, transaction);
        await sendApprovalNotifications(leaveRequest, employee, "CANCEL", transaction);

        await transaction.commit();
        return res.success("LEAVE_CANCELLED");

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
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

// 8. Calculate Leave Days (Frontend Helper)
exports.calculateLeaveDays = async (req, res) => {
    try {
        let { employee_id, start_date, end_date } = req.body;
        if (!employee_id) {
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
        let rules = {};
        if (leave_category_id) {
            const category = await commonQuery.findOneRecord(LeaveTemplateCategory, leave_category_id);
            if (category) {
                rules = category.automation_rules ? JSON.parse(category.automation_rules) : {};
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
            breakdown: dateWiseBreakdown,
            is_allow_full_day: rules?.allow_full_day ?? true,
            is_allow_half_day: rules?.allow_half_day ?? true
        });
    } catch (err) {
        return handleError(err, res, req);
    }
};

// Delete Leave Requests
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

        // Fetch leave requests to be deleted
        const leaveRequests = await commonQuery.findAllRecords(LeaveRequest, {
            id: { [Op.in]: ids }
        }, {}, transaction);

        const employeeCache = {};

        for (const leaveRequest of leaveRequests) {
            const empId = leaveRequest.employee_id;
            if (!employeeCache[empId]) {
                employeeCache[empId] = await commonQuery.findOneRecord(Employee, empId, {
                    include: [{ model: LeaveTemplate, as: "leaveTemplate" }]
                }, transaction);
            }
            const employee = employeeCache[empId];
            const oldStatus = leaveRequest.approval_status;

            try {
                if (leaveRequest.request_type === 'CREDIT') {
                    // For CREDIT requests, we only adjust the balance if they were APPROVED
                    if (Number(oldStatus) === constants.LEAVE_APPROVAL_STATUS.APPROVED) {
                        await LeaveBalanceService.adjustLeaveBalance(
                            leaveRequest.employee_id,
                            leaveRequest.leave_category_id,
                            parseFloat(leaveRequest.total_days),
                            transaction,
                            dayjs(leaveRequest.start_date),
                            employee,
                            true
                        );
                    }
                } else {
                    // For DEBIT requests, we restore/refund the balance if they were PENDING, PARTIALLY_APPROVED, or APPROVED
                    if (
                        Number(oldStatus) === constants.LEAVE_APPROVAL_STATUS.PENDING ||
                        Number(oldStatus) === constants.LEAVE_APPROVAL_STATUS.PARTIALLY_APPROVED ||
                        Number(oldStatus) === constants.LEAVE_APPROVAL_STATUS.APPROVED
                    ) {
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
            } catch (balErr) {
                await transaction.rollback();
                return res.error("RULE_VIOLATION", { message: balErr.message || balErr });
            }

            // Rebuild attendance if the deleted request was an APPROVED DEBIT leave
            if (
                leaveRequest.request_type !== 'CREDIT' &&
                Number(oldStatus) === constants.LEAVE_APPROVAL_STATUS.APPROVED &&
                !leaveRequest.is_encashment
            ) {
                const start = dayjs(leaveRequest.start_date);
                const end = dayjs(leaveRequest.end_date);
                const diff = end.diff(start, 'day');
                for (let i = 0; i <= diff; i++) {
                    const targetDate = start.add(i, 'day').format('YYYY-MM-DD');
                    await rebuildAttendanceDay(leaveRequest.employee_id, targetDate, { user_id: req.user?.id }, transaction);
                }
            }
        }

        const deleted = await commonQuery.hardDeleteRecords(LeaveRequest, ids, transaction);
        if (!deleted) {
            await transaction.rollback();
            return res.error(constants.ALREADY_DELETED);
        }
        await transaction.commit();
        return res.success(constants.DELETED);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

exports.getEligibleCompOffDates = async (req, res) => {
    try {
        let employeeId = req.query.employee_id || req.user?.employee_id;
        if (!employeeId) {
            return res.error(constants.VALIDATION_ERROR, { message: "Employee ID is required" });
        }

        const isOwnRequest = employeeId == req.user?.employee_id;

        const employee = await commonQuery.findOneRecord(Employee, employeeId, {
            include: [
                { model: LeaveTemplate, as: "leaveTemplate" },
                { model: EmployeeAttendanceTemplate, as: "employeeAttendanceTemplate", where: { status: 0 }, required: false },
                { model: AttendanceTemplate, as: "attendanceTemplate", required: false }
            ]
        }, null, false, isOwnRequest ? { applyHierarchy: false } : true);

        if (!employee) {
            return res.error(constants.NOT_FOUND, { message: "Employee not found" });
        }

        const attTemplate = employee.employeeAttendanceTemplate || employee.attendanceTemplate;
        if (!attTemplate || attTemplate.holiday_policy !== 'COMP_OFF') {
            return res.success("No comp-off policy", []);
        }

        const minCompOff = attTemplate.comp_off_min_working_mins || 0;
        const maxCompOff = attTemplate.comp_off_max_working_mins || 0;

        // Fetch past 90 days of attendance
        const ninetyDaysAgo = dayjs().subtract(90, 'day').format('YYYY-MM-DD');
        const todayStr = dayjs().format('YYYY-MM-DD');

        const attendanceRecords = await commonQuery.findAllRecords(AttendanceDay, {
            employee_id: employeeId,
            attendance_date: { [Op.between]: [ninetyDaysAgo, todayStr] },
            status: { [Op.ne]: 2 }
        }, {
            include: [{ 
                model: AttendancePunch, 
                as: "attendancePunches", 
                required: false,
                attributes: ['punch_time', 'punch_type']
            }],
            order: [[{ model: AttendancePunch, as: "attendancePunches" }, 'punch_time', 'ASC']]
        }, null, isOwnRequest ? { applyHierarchy: false } : true);

        const seenDates = new Set();
        const eligibleDates = [];

        for (const record of attendanceRecords) {
            const dateStr = record.attendance_date;

            // Skip if we have already successfully pushed an eligible entry for this date
            if (seenDates.has(dateStr)) {
                continue;
            }

            // Verify if it is Holiday or Weekly Off
            const { isHoliday, isWeeklyOff, holidayDetails } = await getDayOffInfo(employee, dateStr);
            if (!isHoliday && !isWeeklyOff) {
                continue;
            }

            // Check if they actually worked on this holiday/weekly off day
            let isWorkingStatus = [0, 1, 12, 13].includes(Number(record.status));
            const workedMins = parseFloat(record.worked_minutes || 0);
            const hasPunches = (record.first_in || record.last_out) ? true : false;

            if (!isWorkingStatus && (workedMins > 0 || hasPunches)) {
                isWorkingStatus = true;
            }

            if (!isWorkingStatus) {
                continue;
            }

            // Check if there is already an active CREDIT request for this day
            const existingRequest = await commonQuery.findOneRecord(LeaveRequest, {
                employee_id: employeeId,
                request_type: 'CREDIT',
                start_date: dateStr,
                approval_status: {
                    [Op.notIn]: [
                        constants.LEAVE_APPROVAL_STATUS.REJECTED,
                        constants.LEAVE_APPROVAL_STATUS.CANCELLED,
                        constants.LEAVE_APPROVAL_STATUS.DELETED
                    ]
                },
                status: 0
            }, {}, null, false, isOwnRequest ? { applyHierarchy: false } : true);

            if (existingRequest) {
                continue;
            }

            let creditValue = 0;
            if (workedMins >= maxCompOff) {
                creditValue = 1.0;
            } else if (workedMins >= minCompOff) {
                creditValue = 0.5;
            }

            if (creditValue <= 0) {
                continue;
            }

            seenDates.add(dateStr);
            eligibleDates.push({
                date: dateStr,
                worked_minutes: workedMins,
                type: isHoliday ? (holidayDetails?.name || "Holiday") : "Weekly Off",
                credit_value: creditValue,
                punch_in: record.first_in,
                punch_out: record.last_out,
                punches: record.attendancePunches || []
            });
        }

        // Sort descending by date
        eligibleDates.sort((a, b) => b.date.localeCompare(a.date));

        return res.success("Eligible comp-off dates fetched successfully", eligibleDates);
    } catch (err) {
        return handleError(err, res, req);
    }
};