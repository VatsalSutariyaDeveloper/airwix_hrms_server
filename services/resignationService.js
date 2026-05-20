const { commonQuery, Op } = require("../helpers");
const { Employee, User, EmployeeResignation, sequelize } = require("../models");
const dayjs = require("dayjs");

class ResignationService {
    /**
     * Nightly job to deactivate employees whose LWD is today or has passed
     */
    static async processDailyExits(asOf = null, batch_id = null) {
        const transaction = await sequelize.transaction();
        try {
            const today = asOf ? dayjs(asOf).format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD');

            // Find employees with exit_date <= today and status is still Active (0)
            const employeesToDeactivate = await Employee.findAll({
                where: {
                    exit_date: { [Op.lte]: today },
                    status: 0,
                    resignation_status: 2 // Exited/Inactive marked
                },
                transaction
            });

            if (employeesToDeactivate.length === 0) {
                await transaction.commit();
                return 0;
            }

            const employeeIds = employeesToDeactivate.map(e => e.id);
            console.log(`[ResignationService] Deactivating ${employeeIds.length} employees...`);

            // 1. Update Employee Status to Inactive (1)
            for (const emp of employeesToDeactivate) {
                await commonQuery.updateRecordById(Employee, { id: emp.id }, { status: 4 }, transaction, false, {}, batch_id);
            }

            // 2. Update linked User Status to Inactive (1)
            const usersToUpdate = await User.findAll({
                where: { employee_id: { [Op.in]: employeeIds } },
                transaction
            });
            for (const user of usersToUpdate) {
                await commonQuery.updateRecordById(User, { id: user.id }, { status: 4 }, transaction, false, {}, batch_id);
            }

            // 3. Mark the Resignation record as Completed (3)
            const resignationsToUpdate = await EmployeeResignation.findAll({
                where: { 
                    employee_id: { [Op.in]: employeeIds },
                    approval_status: 3, // Approved
                    status: 0
                },
                transaction
            });
            for (const resignation of resignationsToUpdate) {
                await commonQuery.updateRecordById(EmployeeResignation, { id: resignation.id }, { ff_status: 2 }, transaction, false, {}, batch_id);
            }

            await transaction.commit();
            return employeeIds.length;
        } catch (error) {
            if (!transaction.finished) await transaction.rollback();
            throw error;
        }
    }
}

module.exports = ResignationService;
