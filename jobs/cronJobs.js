const cron = require('node-cron');
const cronParser = require('cron-parser');
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const { archiveAndCleanupLogs, archiveAndDeleteOldRows } = require('../helpers');
const LeaveBalanceService = require("../services/leaveBalanceService");
const ContractorDeactivationService = require("../services/contractorDeactivationService");
const ResignationService = require("../services/resignationService");
const DeviceHealthService = require("../services/deviceHealthService");
const { CronJobRun, Logs, FaceRecognitionError, sequelize } = require("../models");
const { commonQuery, Op } = require("../helpers");
const hrDashboardController = require("../controllers/employee/hrDashboardController");
const { requestContext } = require("../utils/requestContext");

// ─────────────────────────────────────────────────────────────────────────────
// Named job handlers (reusable for both cron schedule & on-demand execution)
// ─────────────────────────────────────────────────────────────────────────────

const jobLogCleanup = async (asOf = null, batch_id = null) => {
    console.log('⏰ Running daily log cleanup task...');
    await archiveAndCleanupLogs();
    console.log('✅ Log cleanup completed.');
};

const jobMonthlyLeaveAccrual = async (asOf = null, batch_id = null, isManual = false) => {
    console.log('⏰ Running monthly leave accrual task...');
    await LeaveBalanceService.processMonthlyAccruals(asOf, batch_id, isManual);
    console.log('✅ Monthly leave accruals completed.');
};

const jobYearEndLeaveReset = async (asOf = null, batch_id = null) => {
    // We moved the logging inside the service to avoid daily terminal noise
    await LeaveBalanceService.processYearEndReset(asOf, batch_id);
};

const jobContractorDeactivation = async (asOf = null, batch_id = null) => {
    console.log('⏰ Running daily contractor deactivation task...');
    await ContractorDeactivationService.deactivateInactiveContractors(asOf, batch_id);
    console.log('✅ Contractor deactivation completed.');
};

const jobResignationProcessing = async (asOf = null, batch_id = null) => {
    console.log('⏰ Running daily resignation/exit processing task...');
    const count = await ResignationService.processDailyExits(asOf, batch_id);
    console.log(`✅ ${count} employee exits processed.`);
};

const jobAttendanceRebuild = async (asOf = null, batch_id = null) => {
    const { requestContext } = require("../utils/requestContext");
    const dayjs = require('dayjs');

    // If asOf is provided, treat asOf as "today" and rebuild for asOf-1 day (yesterday) and asOf day (today)
    // If not provided, rebuild for actual yesterday and actual today
    const refDate = asOf ? dayjs(asOf) : dayjs();
    const yesterdayDate = refDate.subtract(1, 'day').format('YYYY-MM-DD');
    const todayDate = refDate.format('YYYY-MM-DD');
    const targetDates = [yesterdayDate, todayDate];

    await requestContext.run({ userId: 0, companyId: 0, is_super_admin: true, batchId: batch_id }, async () => {
        const { Employee, AttendanceDay } = require("../models");
        const attendanceHelper = require("../helpers/attendanceHelper");
        const { commonQuery, Op } = require("../helpers");

        const employees = await commonQuery.findAllRecords(Employee, { status: 0 }, { attributes: ['id', 'company_id', 'branch_id'] }, null, {});
        const employeeIds = employees.map(emp => emp.id);

        for (const targetDate of targetDates) {
            console.log(`⏰ Running daily attendance rebuild task for date: ${targetDate}...`);

            const existingAttendance = await commonQuery.findAllRecords(AttendanceDay, {
                attendance_date: targetDate,
                status: { [Op.ne]: 2 }
            }, { attributes: ['employee_id'] }, null, {});

            const existingEmpIds = existingAttendance.map(a => a.employee_id);

            console.log(`[Cron] Rebuilding ${existingEmpIds.length} existing attendance records for ${targetDate}...`);
            for (const empId of existingEmpIds) {
                try {
                    const emp = employees.find(e => e.id === empId);
                    await requestContext.run({
                        userId: 0,
                        companyId: emp?.company_id || 0,
                        branchId: emp?.branch_id || 0,
                        is_super_admin: true,
                        batchId: batch_id
                    }, async () => {
                        await attendanceHelper.rebuildAttendanceDay(empId, targetDate, {
                            employee: emp,
                            user_id: 0,
                            company_id: emp?.company_id,
                            branch_id: emp?.branch_id
                        });
                    });
                } catch (err) {
                    console.error(`[Cron] Rebuild failed for emp ${empId} on ${targetDate}:`, err.message);
                }
            }

            console.log(`[Cron] Syncing missing attendance records for ${targetDate}...`);
            await attendanceHelper.bulkSyncAttendanceDays(employeeIds, targetDate, { user_id: 0 });
        }

        console.log('✅ Daily attendance rebuild completed.');
    });
};

const jobPayslipCleanup = async (asOf = null, batch_id = null) => {
    console.log('⏰ Running hourly payslip PDF cleanup task...');
    const payslipDir = path.join(process.cwd(), 'uploads', 'payslips');
    if (fs.existsSync(payslipDir)) {
        const files = fs.readdirSync(payslipDir);
        const now = Date.now();
        const twentyFourHoursAgo = now - (24 * 60 * 60 * 1000);

        let deleteCount = 0;
        files.forEach(file => {
            const filePath = path.join(payslipDir, file);
            const stats = fs.statSync(filePath);
            if (stats.isFile() && stats.mtimeMs < twentyFourHoursAgo) {
                fs.unlinkSync(filePath);
                deleteCount++;
            }
        });
        console.log(deleteCount > 0
            ? `✅ Deleted ${deleteCount} expired payslip PDFs.`
            : 'ℹ️ No expired payslip PDFs found.');
    }
};

const jobAnnouncementExpiry = async (asOf = null, batch_id = null) => {
    console.log('⏰ Running daily announcement expiry check task...');
    const dayjs = require('dayjs');
    const { Announcement } = require("../models");
    const { Op, commonQuery } = require("../helpers");

    const currentDate = asOf ? dayjs(asOf) : dayjs();

    const announcements = await Announcement.findAll({
        where: {
            expiry_date: { [Op.lt]: currentDate.format('YYYY-MM-DD') },
            status: 0
        }
    });

    let count = 0;
    for (const ann of announcements) {
        await commonQuery.updateRecordById(Announcement, ann.id, { status: 1 }, null, false, false, batch_id);
        count++;
    }

    console.log(`✅ ${count} expired announcements updated to inactive status.`);
};

const jobDeviceHealthCheck = async (asOf = null, batch_id = null) => {
    console.log('⏰ Running device health check task...');
    await DeviceHealthService.checkDeviceHealth();
};

const jobHolidayAndBirthdayNotifications = async (asOf = null, batch_id = null) => {
    console.log('⏰ Running holiday and birthday notification task...');
    await hrDashboardController.sendHolidayAndBirthdayNotifications(asOf);
};

const jobAnnouncementNotifications = async (asOf = null, batch_id = null) => {
    console.log('⏰ Running daily announcement notification task...');
    const dayjs = require('dayjs');
    const { Announcement, User, RolePermission, UserDevice, CompanyMaster } = require("../models");
    const { Op, commonQuery } = require("../helpers");
    const firebaseService = require("../helpers/firebaseService");
    const constants = require("../helpers/constants");

    const refDate = asOf ? dayjs(asOf) : dayjs();
    const todayStart = refDate.startOf('day').toDate();
    const todayEnd = refDate.endOf('day').toDate();

    const announcements = await Announcement.findAll({
        where: {
            announcement_date: {
                [Op.between]: [todayStart, todayEnd]
            },
            status: 0
        }
    });

    console.log(`[Cron] Found ${announcements.length} announcements scheduled for today.`);

    for (const ann of announcements) {
        try {
            const companyId = ann.company_id;
            if (!companyId) continue;

            const company = await CompanyMaster.findByPk(companyId, { attributes: ["organization_id"] });
            let companyIds = [companyId];
            if (company && company.organization_id) {
                const companies = await CompanyMaster.findAll({
                    where: { organization_id: company.organization_id, status: 0 },
                    attributes: ["id"]
                });
                if (companies.length > 0) {
                    companyIds = companies.map(c => c.id);
                }
            }

            let whereClause = {
                company_id: { [Op.in]: companyIds },
                status: 0
            };

            const targetType = parseInt(ann.target_type);
            const target = ann.target;

            let queryOptions = {
                attributes: ["id", "fcm_token"]
            };

            if (targetType === 3) {
                const userIds = target ? target.split(",").map(id => parseInt(id.trim())).filter(id => !isNaN(id)) : [];
                if (userIds.length > 0) {
                    whereClause.id = { [Op.in]: userIds };
                } else {
                    continue;
                }
            } else if (targetType === 2) {
                const roleIds = target ? target.split(",").map(id => parseInt(id.trim())).filter(id => !isNaN(id)) : [];
                if (roleIds.length > 0) {
                    whereClause.role_id = { [Op.in]: roleIds };
                } else {
                    continue;
                }
            } else if (targetType === 1) {
                queryOptions.include = [
                    {
                        model: RolePermission,
                        as: "RolePermission",
                        where: { role_key: { [Op.notIn]: [constants.ROLE_KEYS.BUSINESS_ADMIN, constants.ROLE_KEYS.ADMIN] } },
                        required: true,
                        attributes: []
                    }
                ];
            }

            const targetUsers = await commonQuery.findAllRecords(User, whereClause, queryOptions);

            const cleanContent = (ann.content || "")
                .replace(/<[^>]*>/g, "")
                .substring(0, 150);

            let allTokens = [];
            for (const user of targetUsers) {
                const devices = await commonQuery.findAllRecords(UserDevice, { user_id: user.id }, { attributes: ["fcm_token"] }, null, false);
                const deviceTokens = devices.map(d => d.fcm_token).filter(Boolean);
                if (deviceTokens.length > 0) {
                    allTokens.push(...deviceTokens);
                } else if (user.fcm_token) {
                    allTokens.push(user.fcm_token);
                }
            }

            allTokens = [...new Set(allTokens)];

            if (allTokens.length > 0) {
                await firebaseService.sendMulticastNotification(allTokens, {
                    title: `New Announcement: ${ann.title}`,
                    body: cleanContent || "A new company announcement has been published.",
                    data: {
                        type: "ANNOUNCEMENT",
                        reference_id: String(ann.id || ""),
                        redirect_url: "/announcements"
                    }
                });
                console.log(`[Cron] Sent notifications to ${allTokens.length} devices for announcement ID ${ann.id}`);
            }
        } catch (err) {
            console.error(`[Cron] Failed to send notifications for announcement ${ann.id}:`, err.message);
        }
    }
};


const jobFaceAuditCleanup = async (asOf = null, batch_id = null) => {
    console.log('⏰ Running daily face recognition audit cleanup task...');

    let deletedFiles = 0;
    const totalArchived = await archiveAndDeleteOldRows(
        FaceRecognitionError,
        "created_at",
        "face_recognition_errors",
        {
            retentionDays: 7,
            // Runs per batch, before that batch's DB rows are deleted - removes the
            // face-error image files from disk so they don't outlive their record.
            onBatch: async (rows) => {
                for (const record of rows) {
                    if (record.image) {
                        const filePath = path.join(process.cwd(), 'uploads', 'employee', 'face_errors', record.image);
                        try {
                            if (fs.existsSync(filePath)) {
                                fs.unlinkSync(filePath);
                                deletedFiles++;
                            }
                        } catch (err) {
                            console.error(`[FaceAuditCleanup] Failed to delete image ${record.image}:`, err.message);
                        }
                    }
                }
            }
        }
    );

    if (totalArchived === 0) {
        console.log('ℹ️ No expired face recognition audit logs found.');
        return;
    }

    console.log(`✅ Face audit cleanup completed. ${totalArchived} records and ${deletedFiles} images removed.`);
};

const jobAttendanceIrregularityAlert = async (asOf = null, batch_id = null) => {
    console.log('⏰ Running daily attendance irregularity alert task...');
    const notificationService = require("../services/notificationService");
    const { AttendanceDay, User, Notification, ShiftTemplate, EmployeeShift, Employee, AttendanceRegularization, LeaveRequest, OutDutyRequest } = require("../models");

    const refDate = asOf ? dayjs(asOf) : dayjs();
    const yesterday = refDate.subtract(1, 'day').format('YYYY-MM-DD');
    const dayBeforeYesterday = refDate.subtract(2, 'day').format('YYYY-MM-DD');
    const targetDates = [dayBeforeYesterday, yesterday];

    let totalSentCount = 0;

    for (const targetDate of targetDates) {
        console.log(`[Cron] Checking attendance irregularities/absences for ${targetDate}...`);
        //Updated query: Status 5 is Absent
        const irregularities = await AttendanceDay.findAll({
            where: {
                attendance_date: targetDate,
                [Op.or]: [
                    { status: { [Op.in]: [0, 1, 5, 9, 12, 10, 14, 13] } }, // 5 = Absent
                    { [Op.and]: [{ first_in: null }, { last_out: { [Op.ne]: null } }] },
                    { [Op.and]: [{ first_in: { [Op.ne]: null } }, { last_out: null }] }
                ],
                status: { [Op.notIn]: [3, 4, 6] } // 4 is Holiday, 3 is WO, 6 is Leave
            }
        });

        for (const record of irregularities) {
            try {
                if (record.first_in !== null && record.last_out !== null) {
                    continue;
                }

                // Check if this is an active night shift currently running/crossing midnight.
                // If it is active, skip sending notification for this date run (will check/send in a future run when no longer active).
                let isCurrentActiveNightShift = false;
                let shiftId = record.shift_id;

                if (!shiftId) {
                    const dayOfWeek = dayjs(targetDate).day();
                    const empShift = await EmployeeShift.findOne({
                        where: { employee_id: record.employee_id, day_of_week: dayOfWeek, status: 0 }
                    });
                    if (empShift && empShift.shift_id) {
                        shiftId = empShift.shift_id;
                    } else {
                        const emp = await Employee.findByPk(record.employee_id, { attributes: ['shift_template'] });
                        if (emp && emp.shift_template) {
                            shiftId = emp.shift_template;
                        }
                    }
                }

                if (shiftId) {
                    const shift = await ShiftTemplate.findByPk(shiftId);
                    if (shift) {
                        const isNightShift = shift.is_night_shift || shift.end_time < shift.start_time;
                        if (isNightShift) {
                            let shiftEndTime = dayjs(`${targetDate} ${shift.end_time}`).add(1, 'day');
                            // If current time is before shift end + 2 hours buffer, it's an active night shift.
                            if (dayjs().isBefore(shiftEndTime.add(2, 'hour'))) {
                                isCurrentActiveNightShift = true;
                            }
                        }
                    }
                }

                if (isCurrentActiveNightShift) {
                    console.log(`[Cron] Skipping active night shift employee alert for emp ${record.employee_id} on target date ${targetDate}`);
                    continue;
                }

                const user = await User.findOne({ where: { employee_id: record.employee_id, status: 0 } });
                if (!user) continue;

                // Check if they have a pending/approved regularization, leave, or out-duty request for this date to avoid false alarms
                const hasPendingOrApprovedRegularization = await AttendanceRegularization.findOne({
                    where: {
                        employee_id: record.employee_id,
                        attendance_date: targetDate,
                        approval_status: { [Op.in]: [0, 1, 3] },
                        status: 0
                    }
                });
                if (hasPendingOrApprovedRegularization) {
                    console.log(`[Cron] Skipping notification for emp ${record.employee_id} on ${targetDate} due to pending/approved regularization request`);
                    continue;
                }

                const hasPendingOrApprovedLeave = await LeaveRequest.findOne({
                    where: {
                        employee_id: record.employee_id,
                        start_date: { [Op.lte]: targetDate },
                        end_date: { [Op.gte]: targetDate },
                        approval_status: { [Op.in]: [0, 1, 3] },
                        status: 0
                    }
                });
                if (hasPendingOrApprovedLeave) {
                    console.log(`[Cron] Skipping notification for emp ${record.employee_id} on ${targetDate} due to pending/approved leave request`);
                    continue;
                }

                const hasPendingOrApprovedOutDuty = await OutDutyRequest.findOne({
                    where: {
                        employee_id: record.employee_id,
                        start_date: { [Op.lte]: targetDate },
                        end_date: { [Op.gte]: targetDate },
                        approval_status: { [Op.in]: [0, 1, 3] },
                        status: 0
                    }
                });
                if (hasPendingOrApprovedOutDuty) {
                    console.log(`[Cron] Skipping notification for emp ${record.employee_id} on ${targetDate} due to pending/approved out-duty request`);
                    continue;
                }

                const dateStr = dayjs(targetDate).format("DD MMM YYYY");

                //Logic: Differentiate Absent, Missing Punch-In, and Missing Punch-Out
                let title = "Missing Punch Alert";
                let message = "";

                if (record.status === 5) {
                    title = "Attendance Marked Absent";
                    message = `Your attendance for ${dateStr} has been marked as Absent. Please apply for regularization if this is incorrect.`;
                } else if (record.first_in === null && record.last_out !== null) {
                    title = "Missing Punch-In Alert";
                    message = `You have a missing punch-in on ${dateStr}. Please review and regularize.`;
                } else if (record.first_in !== null && record.last_out === null) {
                    title = "Missing Punch-Out Alert";
                    message = `You have a missing punch-out on ${dateStr}. Please review and regularize.`;
                } 

                //Date-based Deduplication
                const existingNotification = await Notification.findOne({
                    where: {
                        user_id: user.id,
                        type: "ATTENDANCE_IRREGULARITY",
                        message: { [Op.like]: `%${dateStr}%` }
                    }
                });
                if (!existingNotification) {
                    await notificationService.createNotification({
                        user_id: user.id,
                        company_id: record.company_id || user.company_id,
                        branch_id: record.branch_id || user.branch_id,
                        title: title,
                        message: message,
                        type: "ATTENDANCE_IRREGULARITY",
                        reference_id: record.id,
                        status_code: 1,
                        redirect_url: "/dashboard"
                    });
                    totalSentCount++;
                }
            } catch (err) {
                console.error(`[Cron] Failed to notify ${record.employee_id} on ${targetDate}:`, err.message);
            }
        }
    }
    console.log(`✅ Sent ${totalSentCount} attendance/absence notifications.`);
};

// ─────────────────────────────────────────────────────────────────────────────
// All jobs registry (used by runAllNow)
// ─────────────────────────────────────────────────────────────────────────────

const ALL_JOBS = [
    { name: 'Log Cleanup', fn: jobLogCleanup },
    { name: 'Monthly Leave Accrual', fn: jobMonthlyLeaveAccrual },
    { name: 'Year-End Leave Reset', fn: jobYearEndLeaveReset },
    { name: 'Contractor Deactivation', fn: jobContractorDeactivation },
    { name: 'Resignation Processing', fn: jobResignationProcessing },
    { name: 'Attendance Rebuild', fn: jobAttendanceRebuild },
    { name: 'Payslip PDF Cleanup', fn: jobPayslipCleanup },
    { name: 'Announcement Expiry', fn: jobAnnouncementExpiry },
    { name: 'Device Health Check', fn: jobDeviceHealthCheck },
    { name: 'Holiday & Birthday Notifications', fn: jobHolidayAndBirthdayNotifications },
    { name: 'Face Audit Cleanup', fn: jobFaceAuditCleanup },
    { name: 'Attendance Irregularity Alert', fn: jobAttendanceIrregularityAlert },
    { name: 'Announcement Notifications', fn: jobAnnouncementNotifications },
];

// ─────────────────────────────────────────────────────────────────────────────
// Job Tracking Wrapper
// ─────────────────────────────────────────────────────────────────────────────

// A job stuck longer than this is treated as failed so its CronJobRun row
// resolves out of RUNNING and, for the scheduled batches below, doesn't
// block the next job in its chain forever.
const JOB_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

const withTimeout = (promise, ms, label) => {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Job "${label}" timed out after ${Math.round(ms / 60000)} minutes`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

/**
 * Wraps a job function with tracking (logging start/end/status to CronJobRun)
 */
const runJobWithTracking = async (job, asOf = null, isManual = false) => {
    console.log(`\n▶️  Starting: ${job.name}`);
    const start = Date.now();

    // Create tracking record
    const run = await CronJobRun.create({
        job_name: job.name,
        start_time: new Date(),
        status: 'RUNNING',
        as_of: asOf ? new Date(asOf) : null
    });

    try {
        // Execute the actual job, passing the batch_id (run.id)
        // Note: Individual services must be updated to accept and use this batch_id for logging.
        // Guarded by a timeout so a hung job fails instead of leaving this row (and,
        // for scheduled batches, every job queued after it) stuck in RUNNING forever.
        await withTimeout(
            requestContext.run({ userId: 0, companyId: 0, is_super_admin: true, batchId: run.id }, async () => {
                await job.fn(asOf, run.id, isManual);
            }),
            JOB_TIMEOUT_MS,
            job.name
        );

        const duration = ((Date.now() - start) / 1000).toFixed(2);

        await run.update({
            end_time: new Date(),
            status: 'SUCCESS',
            summary: { duration: `${duration}s` }
        });

        console.log(`✅ ${job.name} completed in ${duration}s`);
        return { name: job.name, status: '✅ success', duration: `${duration}s`, runId: run.id };
    } catch (err) {
        const duration = ((Date.now() - start) / 1000).toFixed(2);
        console.error(`❌ ${job.name} failed:`, err.message);

        await run.update({
            end_time: new Date(),
            status: 'FAILED',
            error_message: err.message,
            summary: { duration: `${duration}s` }
        });

        return { name: job.name, status: '❌ failed', error: err.message, duration: `${duration}s`, runId: run.id };
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Revert Logic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reverts changes made by a specific cron job run
 */
const revertCronJobRun = async (runId) => {
    console.log(`\n🔙 Starting REVERT for Cron Job Run ID: ${runId}`);

    const run = await CronJobRun.findByPk(runId);
    if (!run) throw new Error(`Cron job run ${runId} not found.`);
    if (run.status === 'REVERTED') throw new Error(`Run ${runId} is already reverted.`);

    const t = await sequelize.transaction();
    try {
        // Fetch all logs associated with this batch
        const logs = await Logs.findAll({
            where: { batch_id: runId },
            order: [['id', 'DESC']], // Revert in reverse order of application
            transaction: t
        });

        console.log(`Found ${logs.length} log entries to revert.`);

        for (const log of logs) {
            if (!log.old_data || !log.record_id) {
                console.warn(`Skipping log ${log.id}: No old_data or record_id found.`);
                continue;
            }

            const Model = require("../models")[log.entity_name];
            if (!Model) {
                console.warn(`Skipping log ${log.id}: Model ${log.entity_name} not found.`);
                continue;
            }

            if (log.action_type === 'UPDATE' || log.action_type === 'STATUS_CHANGE') {
                console.log(`Restoring ${log.entity_name} ID: ${log.record_id}`);
                await Model.update(log.old_data, {
                    where: { id: log.record_id },
                    transaction: t
                });
            } else if (log.action_type === 'CREATE' || log.action_type === 'BULK_CREATE') {
                console.log(`Deleting created record ${log.entity_name} ID: ${log.record_id}`);
                await Model.destroy({
                    where: { id: log.record_id },
                    transaction: t
                });
            } else if (log.action_type === 'DELETE') {
                console.log(`Restoring deleted ${log.entity_name} ID: ${log.record_id}`);
                // Since it's a soft delete usually (status=2), we just restore the old data (which includes status=0/1)
                await Model.update(log.old_data, {
                    where: { id: log.record_id },
                    transaction: t,
                    paranoid: false // In case of hard delete (not common in this app but safe)
                });
            }
        }

        await run.update({
            status: 'REVERTED',
            reverted_at: new Date(),
            summary: { ...run.summary, reverted_records: logs.length }
        }, { transaction: t });

        await t.commit();
        console.log(`✅ Revert of Run ID ${runId} completed successfully.`);
        return { success: true, revertedCount: logs.length };
    } catch (err) {
        await t.rollback();
        console.error(`❌ Revert failed for Run ID ${runId}:`, err.message);
        throw err;
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Run all jobs immediately (for testing / manual trigger)
// ─────────────────────────────────────────────────────────────────────────────

const runAllNow = async (asOf = null, isManual = false) => {
    const label = asOf ? `[AS OF: ${asOf}]` : '[LIVE DATE]';
    console.log(`\n🚀 ===== MANUAL CRON RUN STARTED ${label} =====\n`);
    const results = [];

    for (const job of ALL_JOBS) {
        const result = await runJobWithTracking(job, asOf, isManual);
        results.push(result);
    }

    console.log('\n📋 ===== CRON RUN SUMMARY =====');
    console.table(results);
    console.log('===================================\n');

    return results;
};

// ─────────────────────────────────────────────────────────────────────────────
// Run a named subset of ALL_JOBS sequentially (used to split the old single
// midnight chain into smaller batches spread across the night, so one hung/slow
// job only delays the rest of its own batch instead of every job for the night).
// ─────────────────────────────────────────────────────────────────────────────

const runBatch = async (jobNames, asOf = null) => {
    const jobs = jobNames.map(name => ALL_JOBS.find(j => j.name === name)).filter(Boolean);
    for (const job of jobs) {
        await runJobWithTracking(job, asOf, false);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Run a SINGLE named job immediately (for selective manual trigger)
// jobKey: one of the keys in ALL_JOBS registry (e.g. 'Attendance Rebuild')
// ─────────────────────────────────────────────────────────────────────────────

const runJobNow = async (jobKey, asOf = null) => {
    const job = ALL_JOBS.find(j => j.name.toLowerCase() === jobKey.toLowerCase());
    if (!job) {
        throw new Error(`Unknown job: "${jobKey}". Available: ${ALL_JOBS.map(j => j.name).join(', ')}`);
    }
    const label = asOf ? ` [AS OF: ${asOf}]` : ' [LIVE DATE]';
    return await runJobWithTracking(job, asOf, true);
};

// ─────────────────────────────────────────────────────────────────────────────
// Register cron schedules — staggered across the night instead of one single
// 12:00 AM chain, so the daily jobs don't all hit the DB at the same instant
// (and, combined with the timeout above, one slow/hung job no longer blocks
// every job scheduled after it). Batches keep their previous relative order;
// "Attendance Rebuild" gets its own slot since it's the heaviest job and
// "Attendance Irregularity Alert" depends on its output, so it's scheduled
// with a buffer after it.
// ─────────────────────────────────────────────────────────────────────────────

const CRON_TZ = process.env.TZ || 'Asia/Kolkata';

/**
 * Marks any CronJobRun row still RUNNING as FAILED. Runs once at boot, before any
 * schedule is registered, so every RUNNING row at that point is guaranteed to
 * belong to a previous process lifetime (this process hasn't started a job yet) -
 * e.g. the worker was killed/crashed/restarted mid-job (self-healing cluster
 * restart, deploy, connection death) and never got the chance to update its own
 * row. Without this, such rows stay RUNNING forever with nothing left to ever
 * resolve them, which is exactly the "stuck in RUNNING" pattern this was added
 * to fix.
 */
const reconcileOrphanedRuns = async () => {
    try {
        const [count] = await CronJobRun.update(
            {
                status: 'FAILED',
                end_time: new Date(),
                error_message: 'Orphaned: process restarted/crashed while this job was RUNNING, so it never reported completion.'
            },
            { where: { status: 'RUNNING' } }
        );
        if (count > 0) {
            console.log(`🧹 Reconciled ${count} orphaned RUNNING cron job run(s) left over from a previous process lifetime.`);
        }
    } catch (err) {
        console.error('❌ Failed to reconcile orphaned cron job runs on boot:', err.message);
    }
};

// Single source of truth for both scheduling (below) and catch-up detection
// (catchUpMissedRuns) - each batch's cron expression and the job names it runs.
const BATCHES = [
    // 00:00 — lightweight cleanup jobs, no dependencies
    { time: '0 0 * * *', label: 'Cleanup', jobs: ['Log Cleanup', 'Payslip PDF Cleanup', 'Face Audit Cleanup'] },
    // 00:15 — HR lifecycle jobs, independent of attendance data
    // 'Monthly Leave Accrual' and 'Year-End Leave Reset' are disabled from auto-run per request
    // (still available for manual trigger via runJobNow) - do not re-enable without confirming.
    { time: '15 0 * * *', label: 'HR Lifecycle', jobs: [/* 'Monthly Leave Accrual', */ /* 'Year-End Leave Reset', */ 'Contractor Deactivation', 'Resignation Processing'] },
    // 00:30 — heaviest job, alone in its slot
    { time: '30 0 * * *', label: 'Attendance Rebuild', jobs: ['Attendance Rebuild'] },
    // 00:55 — needs Attendance Rebuild's output; 25 min buffer after it starts
    { time: '55 0 * * *', label: 'Attendance Irregularity Alert', jobs: ['Attendance Irregularity Alert'] },
    // 01:05 — announcement/notification jobs
    { time: '5 1 * * *', label: 'Announcements', jobs: ['Announcement Expiry', 'Announcement Notifications', 'Holiday & Birthday Notifications'] },
];
const DEVICE_HEALTH_SCHEDULE = '*/30 * * * *';

/**
 * Off by default - set CRON_CATCHUP_ENABLED=true to turn on. This runs real
 * jobs (real notifications, real employee-record changes) the moment it finds
 * something missed, and since nodemon restarts this process on every file
 * save, that could otherwise fire the instant a totally unrelated code change
 * is saved. Requiring an explicit opt-in keeps that a deliberate choice.
 */
const CATCHUP_ENABLED = process.env.CRON_CATCHUP_ENABLED === 'true';

/**
 * node-cron has no concept of a missed tick - if this process is down (or
 * mid-restart) at the exact moment a schedule was due, that tick is gone
 * forever; the job simply won't run until its next natural occurrence, which
 * for a once-daily job means silently losing that whole day's run. This
 * checks, for every job, whether a CronJobRun exists since its most recent due
 * time (per its cron expression) and runs it immediately if not - the same
 * "was this cycle covered" check used for airwix_erp_v2's pg-boss-based
 * catch-up, adapted here since node-cron has no queue to re-dispatch through.
 */
const catchUpMissedRuns = async () => {
    if (!CATCHUP_ENABLED) {
        console.log('⏭️  Cron catch-up disabled (set CRON_CATCHUP_ENABLED=true to enable). Skipping missed-run check.');
        return;
    }

    const schedules = [
        ...BATCHES.flatMap(b => b.jobs.map(name => ({ name, expr: b.time }))),
        { name: 'Device Health Check', expr: DEVICE_HEALTH_SCHEDULE },
    ];

    for (const { name, expr } of schedules) {
        try {
            const lastDue = cronParser.parseExpression(expr, { tz: CRON_TZ }).prev().toDate();

            const recentRun = await CronJobRun.findOne({
                where: { job_name: name, start_time: { [Op.gte]: lastDue } },
                order: [['start_time', 'DESC']]
            });
            if (recentRun) continue;

            const job = ALL_JOBS.find(j => j.name === name);
            if (!job) continue;

            console.warn(`⏰ Catch-up: "${name}" missed its scheduled run (server was likely down at ${lastDue.toISOString()}), running now...`);
            await runJobWithTracking(job);
        } catch (err) {
            console.error(`❌ Failed to check/catch-up job "${name}":`, err.message);
        }
    }
};

const initCronJobs = async () => {
    await reconcileOrphanedRuns();

    const schedule = (expr, label, fn) =>
        cron.schedule(expr, async () => {
            console.log(`⏰ [CRON] Starting batch: ${label}`);
            await fn().catch(e => console.error(`❌ Batch "${label}" failed:`, e));
        }, { timezone: CRON_TZ, noOverlap: true });

    for (const batch of BATCHES) {
        schedule(batch.time, batch.label, () => runBatch(batch.jobs));
    }

    // ⏰ Device Health Check — runs every 30 minutes (tracked + guarded like the rest)
    cron.schedule(DEVICE_HEALTH_SCHEDULE, async () => {
        await runJobWithTracking({ name: 'Device Health Check', fn: jobDeviceHealthCheck }).catch(e =>
            console.error('❌ Device health check failed:', e));
    }, { timezone: CRON_TZ, noOverlap: true });

    console.log(`🚀 Cron Jobs Initialized (tz: ${CRON_TZ}) — daily jobs staggered 00:00–01:05, Device Health every 30 mins`);

    await catchUpMissedRuns();
};

module.exports = {
    initCronJobs,
    runAllNow,
    runJobNow,
    catchUpMissedRuns,
    ALL_JOBS,
    // Individual jobs (can be triggered selectively)
    jobLogCleanup,
    jobMonthlyLeaveAccrual,
    jobYearEndLeaveReset,
    jobContractorDeactivation,
    jobResignationProcessing,
    jobAttendanceRebuild,
    jobPayslipCleanup,
    jobAnnouncementExpiry,
    jobDeviceHealthCheck,
    jobHolidayAndBirthdayNotifications,
    jobFaceAuditCleanup,
    jobAttendanceIrregularityAlert,
    jobAnnouncementNotifications,
    revertCronJobRun,
};

