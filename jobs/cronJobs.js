const cron = require('node-cron');
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

    console.log('🚀 Internal Cron Jobs Initialized');
};

module.exports = { initCronJobs };
