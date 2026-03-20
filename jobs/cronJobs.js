const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { archiveAndCleanupLogs } = require('../helpers');
const LeaveBalanceService = require("../services/leaveBalanceService");
const ContractorDeactivationService = require("../services/contractorDeactivationService");
const ResignationService = require("../services/resignationService");

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

    // ⏰ Daily Resignation/Exit Processing Task
    // Runs every day at 00:20 AM
    cron.schedule('20 0 * * *', async () => {
        console.log('⏰ Running daily resignation/exit processing task...');
        try {
            const count = await ResignationService.processDailyExits();
            console.log(`✅ ${count} employee exits processed.`);
        } catch (error) {
            console.error('❌ Resignation processing failed:', error);
        }
    });

    // ⏰ Daily Attendance Rebuild Task
    // Runs every day at 00:01 AM for Yesterday
    cron.schedule('1 0 * * *', async () => {
        const { requestContext } = require("../utils/requestContext");
        
        // Wrap everything in a System context to satisfy commonQuery/getContext
        await requestContext.run({ userId: 0, companyId: 0, is_super_admin: true }, async () => {
            console.log('⏰ Running daily attendance rebuild task...');
            try {
                const dayjs = require('dayjs');
                const { Employee, AttendanceDay } = require("../models");
                const attendanceHelper = require("../helpers/attendanceHelper");
                const { commonQuery, Op } = require("../helpers");

                const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');

                // 1. Fetch all active employees (Pass {} to skip tenant/context check for global fetch)
                const employees = await commonQuery.findAllRecords(Employee, { status: 0 }, { attributes: ['id', 'company_id', 'branch_id'] }, null, {});
                const employeeIds = employees.map(emp => emp.id);

                // 2. Identify employees who ALREADY have a record for yesterday (usually due to punches)
                const existingAttendance = await commonQuery.findAllRecords(AttendanceDay, {
                    attendance_date: yesterday,
                    status: { [Op.ne]: 2 }
                }, { attributes: ['employee_id'] }, null, {});
                
                const existingEmpIds = existingAttendance.map(a => a.employee_id);

                // 3. Rebuild existing records to finalize calculations
                console.log(`[Cron] Rebuilding ${existingEmpIds.length} existing attendance records for ${yesterday}...`);
                for (const empId of existingEmpIds) {
                    try {
                        const emp = employees.find(e => e.id === empId);
                        // Run each rebuild in its own company context for accurate settings/shift fetching
                        await requestContext.run({ 
                            userId: 0, 
                            companyId: emp?.company_id || 0, 
                            branchId: emp?.branch_id || 0,
                            is_super_admin: true 
                        }, async () => {
                            await attendanceHelper.rebuildAttendanceDay(empId, yesterday, { 
                                employee: emp,
                                user_id: 0,
                                company_id: emp?.company_id,
                                branch_id: emp?.branch_id
                            });
                        });
                    } catch (err) {
                        console.error(`[Cron] Rebuild failed for emp ${empId} on ${yesterday}:`, err.message);
                    }
                }

                // 4. Create missing records (Mark Absent/Holiday/WeeklyOff/Leave)
                console.log(`[Cron] Syncing missing attendance records for ${yesterday}...`);
                // bulkSyncAttendanceDays doesn't currently check context for company_id internally, 
                // but we run it in super-admin context just in case.
                await attendanceHelper.bulkSyncAttendanceDays(employeeIds, yesterday, {
                    user_id: 0,
                });

                console.log('✅ Daily attendance rebuild completed.');
            } catch (error) {
                console.error('❌ Attendance rebuild failed:', error);
            }
        });
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
