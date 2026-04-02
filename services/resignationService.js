const { Employee, User, EmployeeResignation, sequelize, Op } = require("../models");
const dayjs = require("dayjs");

class ResignationService {
    /**
     * Nightly job to deactivate employees whose LWD is today or has passed
     */
    static async processDailyExits(asOf = null) {
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
            await Employee.update({ status: 1 }, {
                where: { id: { [Op.in]: employeeIds } },
                transaction
            });

            // 2. Update linked User Status to Inactive (1)
            await User.update({ status: 1 }, {
                where: { employee_id: { [Op.in]: employeeIds } },
                transaction
            });

            // 3. Mark the Resignation record as Completed (3)
            await EmployeeResignation.update({ ff_status: 2 }, { // FF Settled or just record closed
                where: { 
                    employee_id: { [Op.in]: employeeIds },
                    approval_status: 3, // Approved
                    status: 0
                },
                transaction
            });

            await transaction.commit();
            return employeeIds.length;
        } catch (error) {
            if (!transaction.finished) await transaction.rollback();
            throw error;
        }
    }
}

module.exports = ResignationService;
