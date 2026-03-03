const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { archiveAndCleanupLogs } = require('../helpers');
const LeaveBalanceService = require("../services/leaveBalanceService");
const ContractorDeactivationService = require("../services/contractorDeactivationService");

const initCronJobs = () => {
    // ⏰ Daily Log Cleanup Task
    // Runs every day at 00:00 AM
    cron.schedule('0 0 * * *', async () => {
        console.log('⏰ Running daily log cleanup task...');
        try {
            await archiveAndCleanupLogs(90); // Keep 90 days of logs
            console.log('✅ Log cleanup completed.');
        } catch (error) {
            console.error('❌ Log cleanup failed:', error);
        }
    });

    // ⏰ Monthly Leave Accrual Task
    // Runs on the 1st of every month at 00:05 AM
    cron.schedule('5 0 1 * *', async () => {
        console.log('⏰ Running monthly leave accrual task...');
        try {
            await LeaveBalanceService.processMonthlyAccruals();
            console.log('✅ Monthly leave accruals completed.');
        } catch (error) {
            console.error('❌ Monthly leave accrual failed:', error);
        }
    });

    // ⏰ Year-End Leave Reset Task
    // Runs every day at 00:10 AM to check if any employee's cycle has ended
    cron.schedule('10 0 * * *', async () => {
        console.log('⏰ Checking for year-end leave resets...');
        try {
            await LeaveBalanceService.processYearEndReset();
            console.log('✅ Year-end reset check completed.');
        } catch (error) {
            console.error('❌ Year-end reset failed:', error);
        }
    });

    // ⏰ Daily Contractor Deactivation Task
    // Runs every day at 00:15 AM
    cron.schedule('15 0 * * *', async () => {
        console.log('⏰ Running daily contractor deactivation task...');
        try {
            await ContractorDeactivationService.deactivateInactiveContractors();
            console.log('✅ Contractor deactivation completed.');
        } catch (error) {
            console.error('❌ Contractor deactivation failed:', error);
        }
    });

    // ⏰ Hourly Payslip PDF Cleanup Task
    // Runs every hour to delete PDFs older than 24 hours
    cron.schedule('0 * * * *', async () => {
        console.log('⏰ Running hourly payslip PDF cleanup task...');
        try {
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
                if (deleteCount > 0) {
                    console.log(`✅ Deleted ${deleteCount} expired payslip PDFs.`);
                } else {
                    console.log('ℹ️ No expired payslip PDFs found.');
                }
            }
        } catch (error) {
            console.error('❌ Payslip PDF cleanup failed:', error);
        }
    });

    console.log('🚀 Internal Cron Jobs Initialized');

};

module.exports = { initCronJobs };
