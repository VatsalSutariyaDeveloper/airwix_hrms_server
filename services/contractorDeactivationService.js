const { Employee, AttendancePunch, sequelize } = require('../models');
const { Op } = require('sequelize');
const commonQuery = require('../helpers/commonQuery');
const dayjs = require('dayjs');


class ContractorDeactivationService {
    async deactivateInactiveContractors() {
        console.log('🕒 Starting contractor deactivation check...');
        try {
            const threeMonthsAgo = dayjs().subtract(3, 'month').toDate();

            // 1. Find all active contractors
            const contractors = await commonQuery.findAllRecords(Employee, {
                employee_type: 3,
                status: 0 // Active
            }, {
                attributes: ['id', 'first_name', 'employee_code']
            }, null, false); // requireTenantFields: false for cron

            console.log(`🔍 Found ${contractors.length} active contractors to check.`);

            let deactivatedCount = 0;

            for (const contractor of contractors) {
                // 2. Check for punch_in records in the last 3 months
                const lastPunch = await commonQuery.findOneRecord(AttendancePunch, {
                    employee_id: contractor.id,
                    punch_type: 'IN',
                    punch_time: {
                        [Op.gte]: threeMonthsAgo
                    }
                }, {
                    order: [['punch_time', 'DESC']]
                }, null, false, false); // requireTenantFields: false for cron

                if (!lastPunch) {
                    // 3. Deactivate if no punches found
                    await commonQuery.updateRecordById(Employee, { id: contractor.id }, { status: 1 }, null, false, false);
                    console.log(`✅ Deactivated contractor: ${contractor.first_name} (${contractor.employee_code})`);
                    deactivatedCount++;
                }
            }

            console.log(`📊 Contractor deactivation summary: ${deactivatedCount} deactivated out of ${contractors.length} checked.`);
            return {
                totalChecked: contractors.length,
                deactivatedCount
            };

        } catch (error) {
            console.error('❌ Error in deactivateInactiveContractors service:', error);
            throw error;
        }
    }
}

module.exports = new ContractorDeactivationService();
