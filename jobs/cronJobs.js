const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { archiveAndCleanupLogs } = require('../helpers');
const LeaveBalanceService = require("../services/leaveBalanceService");
const ContractorDeactivationService = require("../services/contractorDeactivationService");
const ResignationService = require("../services/resignationService");

// ─────────────────────────────────────────────────────────────────────────────
// Named job handlers (reusable for both cron schedule & on-demand execution)
// ─────────────────────────────────────────────────────────────────────────────

const jobLogCleanup = async (asOf = null) => {
    console.log('⏰ Running daily log cleanup task...');
    await archiveAndCleanupLogs(90);
    console.log('✅ Log cleanup completed.');
};

const jobMonthlyLeaveAccrual = async (asOf = null) => {
    console.log('⏰ Running monthly leave accrual task...');
    await LeaveBalanceService.processMonthlyAccruals(asOf);
    console.log('✅ Monthly leave accruals completed.');
};

const jobYearEndLeaveReset = async (asOf = null) => {
    // We moved the logging inside the service to avoid daily terminal noise
    await LeaveBalanceService.processYearEndReset(asOf);
};

const jobContractorDeactivation = async (asOf = null) => {
    console.log('⏰ Running daily contractor deactivation task...');
    await ContractorDeactivationService.deactivateInactiveContractors(asOf);
    console.log('✅ Contractor deactivation completed.');
};

const jobResignationProcessing = async (asOf = null) => {
    console.log('⏰ Running daily resignation/exit processing task...');
    const count = await ResignationService.processDailyExits(asOf);
    console.log(`✅ ${count} employee exits processed.`);
};

const jobAttendanceRebuild = async (asOf = null) => {
    const { requestContext } = require("../utils/requestContext");
    const dayjs = require('dayjs');

    // If asOf is provided, treat asOf as "today" and rebuild for asOf-1 day (yesterday)
    // If not provided, rebuild for actual yesterday
    const refDate = asOf ? dayjs(asOf) : dayjs();
    const targetDate = refDate.subtract(1, 'day').format('YYYY-MM-DD');

    await requestContext.run({ userId: 0, companyId: 0, is_super_admin: true }, async () => {
        console.log(`⏰ Running daily attendance rebuild task for date: ${targetDate}...`);
        const { Employee, AttendanceDay } = require("../models");
        const attendanceHelper = require("../helpers/attendanceHelper");
        const { commonQuery, Op } = require("../helpers");

        const employees = await commonQuery.findAllRecords(Employee, { status: 0 }, { attributes: ['id', 'company_id', 'branch_id'] }, null, {});
        const employeeIds = employees.map(emp => emp.id);

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
                    is_super_admin: true
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

        console.log('✅ Daily attendance rebuild completed.');
    });
};

const jobPayslipCleanup = async (asOf = null) => {
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

const jobAnnouncementExpiry = async (asOf = null) => {
    console.log('⏰ Running daily announcement expiry check task...');
    const dayjs = require('dayjs');
    const { Announcement } = require("../models");
    const { Op } = require("../helpers");

    const currentDate = asOf ? dayjs(asOf) : dayjs();

    const expiredAnnouncements = await Announcement.update(
        { status: 1 },
        {
            where: {
                expiry_date: { [Op.lt]: currentDate.format('YYYY-MM-DD') },
                status: 0
            }
        }
    );

    const count = expiredAnnouncements[0];
    console.log(`✅ ${count} expired announcements updated to inactive status.`);
};

// ─────────────────────────────────────────────────────────────────────────────
// All jobs registry (used by runAllNow)
// ─────────────────────────────────────────────────────────────────────────────

const ALL_JOBS = [
    { name: 'Log Cleanup',              fn: jobLogCleanup },
    { name: 'Monthly Leave Accrual',    fn: jobMonthlyLeaveAccrual },
    { name: 'Year-End Leave Reset',     fn: jobYearEndLeaveReset },
    { name: 'Contractor Deactivation',  fn: jobContractorDeactivation },
    { name: 'Resignation Processing',   fn: jobResignationProcessing },
    { name: 'Attendance Rebuild',       fn: jobAttendanceRebuild },
    { name: 'Payslip PDF Cleanup',      fn: jobPayslipCleanup },
    { name: 'Announcement Expiry',      fn: jobAnnouncementExpiry },
];

// ─────────────────────────────────────────────────────────────────────────────
// Run all jobs immediately (for testing / manual trigger)
// ─────────────────────────────────────────────────────────────────────────────

const runAllNow = async (asOf = null) => {
    const label = asOf ? `[AS OF: ${asOf}]` : '[LIVE DATE]';
    console.log(`\n🚀 ===== MANUAL CRON RUN STARTED ${label} =====\n`);
    const results = [];

    for (const job of ALL_JOBS) {
        console.log(`\n▶️  Starting: ${job.name}`);
        const start = Date.now();
        try {
            await job.fn(asOf);
            const duration = ((Date.now() - start) / 1000).toFixed(2);
            results.push({ name: job.name, status: '✅ success', duration: `${duration}s` });
        } catch (err) {
            const duration = ((Date.now() - start) / 1000).toFixed(2);
            console.error(`❌ ${job.name} failed:`, err.message);
            results.push({ name: job.name, status: '❌ failed', error: err.message, duration: `${duration}s` });
        }
    }

    console.log('\n📋 ===== CRON RUN SUMMARY =====');
    console.table(results);
    console.log('===================================\n');

    return results;
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
    console.log(`\n▶️  Manual trigger: ${job.name}${label}`);
    const start = Date.now();
    try {
        await job.fn(asOf);
        const duration = ((Date.now() - start) / 1000).toFixed(2);
        console.log(`✅ ${job.name} completed in ${duration}s`);
        return { name: job.name, status: '✅ success', duration: `${duration}s` };
    } catch (err) {
        const duration = ((Date.now() - start) / 1000).toFixed(2);
        console.error(`❌ ${job.name} failed:`, err.message);
        return { name: job.name, status: '❌ failed', error: err.message, duration: `${duration}s` };
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Register cron schedules — ALL run at 12:00 AM (midnight)
// ─────────────────────────────────────────────────────────────────────────────

const initCronJobs = () => {
    // ⏰ Midnight batch — runs all daily jobs sequentially at 00:00 AM
    // Sequential execution avoids DB contention between jobs
    cron.schedule('0 0 * * *', async () => {
        console.log('⏰ [MIDNIGHT CRON] Starting all daily jobs...');
        await runAllNow(); // uses live date (no asOf)
    });

    // ⏰ Payslip PDF Cleanup — runs every hour (not daily, so kept separate)
    cron.schedule('0 * * * *', async () => {
        await jobPayslipCleanup().catch(e => console.error('❌ Payslip PDF cleanup failed:', e));
    });

    console.log('🚀 Cron Jobs Initialized — All daily jobs scheduled at 12:00 AM midnight');
};

module.exports = {
    initCronJobs,
    runAllNow,
    runJobNow,
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
};

