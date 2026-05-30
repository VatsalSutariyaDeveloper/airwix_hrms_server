const { PaymentHistory, Employee, EmployeeAdvance, Payslip, User, sequelize } = require("../../models");
const { sequelize: sequelizeInstance, validateRequest, commonQuery, handleError, formatDateTime, Op } = require("../../helpers");
const { constants } = require("../../helpers/constants");
const { createNotification } = require("../../services/notificationService");
const dayjs = require("dayjs");

const PAYMENT_TYPE = {
    ADVANCE: "Advance",
    SALARY: "Salary"
};

const PAYMENT_MODE = {
    CASH: "Cash",
    BANK: "Bank"
};

// Create a new payment history record
exports.create = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const requiredFields = {
            employee_id: "Employee",
            ref_id: "Reference ID",
            month: "Month",
            year: "Year",
            payment_date: "Payment Date",
            amount: "Amount",
            payment_type: "Payment Type",
            payment_mode: "Payment Mode"
        };

        const errors = await validateRequest(req.body, requiredFields, {}, transaction);
        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        // Validate enum values
        if (req.body.payment_type && !Object.values(PAYMENT_TYPE).includes(req.body.payment_type)) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, { payment_type: "Invalid payment type" });
        }

        if (req.body.payment_mode && !Object.values(PAYMENT_MODE).includes(req.body.payment_mode)) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, { payment_mode: "Invalid payment mode" });
        }

        let isCreated = false;
        let createdPayment = null;

        if (req.body.payment_type === PAYMENT_TYPE.SALARY && req.body.ref_id) {
            const payslip = await commonQuery.findOneRecord(Payslip, req.body.ref_id, {}, transaction);

            if (!payslip) {
                await transaction.rollback();
                return res.error(constants.NOT_FOUND, { ref_id: "Payslip not found" });
            }

            const netPayable = parseFloat(payslip.net_salary || 0);
            const paymentAmount = parseFloat(req.body.amount || 0);

            // Fetch existing payments to check remaining balance
            const existingPaidResult = await PaymentHistory.findAll({
                where: {
                    employee_id: req.body.employee_id,
                    month: req.body.month,
                    year: req.body.year,
                    status: { [Op.ne]: 2 }
                },
                attributes: [[sequelizeInstance.fn('SUM', sequelizeInstance.col('amount')), 'total_paid']],
                raw: true,
                transaction
            });
            const currentTotalPaid = parseFloat(existingPaidResult[0]?.total_paid || 0);

            if ((currentTotalPaid + paymentAmount) > (netPayable + 0.01)) { // Allow 0.01 margin for float
                await transaction.rollback();
                return res.error(constants.VALIDATION_ERROR, {
                    amount: `Total payment (${currentTotalPaid + paymentAmount}) cannot exceed net payable amount (${netPayable})`
                });
            }

            createdPayment = await commonQuery.createRecord(PaymentHistory, req.body, transaction);
            isCreated = true;

            // Update payslip payment_history JSON with salary entry
            const currentPaymentHistory = payslip.payment_history || { advances_adjusted: [] };
            const salaryPayment = {
                id: createdPayment.id,
                amount: req.body.amount,
                payment_mode: req.body.payment_mode,
                payment_date: req.body.payment_date,
                payment_type: req.body.payment_type
            };

            if (!currentPaymentHistory.salary_payments) {
                currentPaymentHistory.salary_payments = [];
            }
            currentPaymentHistory.salary_payments.push(salaryPayment);

            // Calculate total paid and update payslip
            const totalPaidResult = await commonQuery.findAllRecords(PaymentHistory, {
                ref_id: req.body.ref_id,
                payment_type: PAYMENT_TYPE.SALARY
            }, {
                attributes: [[sequelizeInstance.fn('SUM', sequelize.col('amount')), 'total_paid']],
                raw: true
            }, transaction);

            const totalPaid = parseFloat(totalPaidResult[0]?.total_paid || 0) + paymentAmount;

            await commonQuery.updateRecordById(Payslip, req.body.ref_id, {
                payment_history: currentPaymentHistory,
                paid_amount: totalPaid,
                pending_amount: netPayable - totalPaid,
                status: (totalPaid >= netPayable && payslip.status !== 3) ? 3 : payslip.status,
                payment_date: (totalPaid >= netPayable && payslip.status !== 3) ? (req.body.payment_date || dayjs().format('YYYY-MM-DD')) : payslip.payment_date
            }, transaction);
        } else {
            // General or Advance payment history creation
            createdPayment = await commonQuery.createRecord(PaymentHistory, req.body, transaction);
            isCreated = true;
        }

        if (isCreated) {
            // --- Synchronize Payslip Totals ---
            // Find existing Payslip for same employee, month, and year (Finalized or Paid)
            const targetPayslip = await commonQuery.findOneRecord(Payslip, {
                employee_id: req.body.employee_id,
                month: req.body.month,
                year: req.body.year,
                status: { [Op.in]: [1, 3] }
            }, {}, transaction);

            if (targetPayslip) {
                // Recalculate total paid from ALL types (Salary + Advance) for this period
                const totalPaidResult = await PaymentHistory.findAll({
                    where: {
                        employee_id: req.body.employee_id,
                        month: req.body.month,
                        year: req.body.year,
                        status: { [Op.ne]: 2 }
                    },
                    attributes: [[sequelizeInstance.fn('SUM', sequelizeInstance.col('amount')), 'total_paid']],
                    raw: true,
                    transaction
                });

                const totalPaid = parseFloat(totalPaidResult[0]?.total_paid || 0);
                const netSalary = parseFloat(targetPayslip.net_salary || 0);

                await commonQuery.updateRecordById(Payslip, targetPayslip.id, {
                    paid_amount: totalPaid,
                    pending_amount: Math.max(0, netSalary - totalPaid),
                    status: (totalPaid >= (netSalary - 0.01)) ? 3 : 1, // Mark as Paid if threshold met
                    payment_date: (totalPaid >= (netSalary - 0.01)) ? (req.body.payment_date || dayjs().format('YYYY-MM-DD')) : targetPayslip.payment_date
                }, transaction);
            }

            //  Send Notification to Employee
            try {
                const targetUser = await commonQuery.findOneRecord(User, { employee_id: req.body.employee_id }, {}, transaction);
                if (targetUser) {
                    const monthName = formatDateTime(new Date(req.body.year, parseInt(req.body.month) - 1, 1), "MMMM");
                    await createNotification({
                        user_id: targetUser.id,
                        title: "Payment Received",
                        message: `A ${req.body.payment_type} payment of ₹${req.body.amount} has been recorded for ${monthName} ${req.body.year}.`,
                        type: "PAYROLL",
                        reference_id: req.body.ref_id,
                        status_code: 0,
                        company_id: req.user.company_id,
                    }, transaction);
                }
            } catch (notifyErr) {
                console.error("Payment History Notification Error:", notifyErr.message);
            }
        }

        await transaction.commit();
        return res.success(constants.CREATED);

    } catch (err) {
        if (err) {
            await transaction.rollback();
        }
        return handleError(err, res, req);
    }
};

exports.getAllPaymentHistory = async (req, res) => {
    try {
        const fieldConfig = [
            ["employee.first_name", true, false],
            ["employee.employee_code", true, false],
            ["payment_date", true, true],
            ["amount", true, true]
        ];

        const data = await commonQuery.fetchPaginatedData(
            PaymentHistory,
            { ...req.body },
            fieldConfig,
            {
                include: [
                    { model: Employee, as: 'employee', attributes: ['id', 'employee_code', 'first_name', 'mobile_no'] }
                ]
            }
        );

        const whereCondition = { ...(req.body?.filter || {}) };
        if (req.body?.employee_id) whereCondition.employee_id = req.body.employee_id;
        if (req.body?.month) whereCondition.month = req.body.month;
        if (req.body?.year) whereCondition.year = req.body.year;
        if (req.body?.payment_type) whereCondition.payment_type = req.body.payment_type;

        const total_amount = await commonQuery.sumRecords(PaymentHistory, 'amount', whereCondition);

        return res.ok({ ...data, total_amount });
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.paymentHistoryView = async (req, res) => {
    try {
        const { payment_history_id } = req.body;

        if (!payment_history_id) {
            return res.error(constants.INVALID_ID);
        }

        const paymentHistory = await commonQuery.findOneRecord(
            PaymentHistory,
            { id: payment_history_id },
            {
                include: [
                    {
                        model: EmployeeAdvance,
                        as: 'advance',
                        attributes: ['id', 'amount', 'payment_date', 'payment_mode', 'status', 'adjusted_in_payroll']
                    },
                    {
                        model: Payslip,
                        as: 'payslip',
                        attributes: ['id', 'month', 'year', 'net_salary', 'status']
                    },
                    {
                        model: Employee,
                        as: 'employee',
                        attributes: ['id', 'employee_code', 'first_name', 'mobile_no']
                    },
                    {
                        model: User,
                        as: 'user',
                        attributes: ['id', 'user_name', 'email', 'mobile_no']
                    }
                ]
            }
        );

        if (!paymentHistory) {
            return res.error(constants.NOT_FOUND);
        }

        const month = paymentHistory.month;
        const year = paymentHistory.year;
        const month_name = (month && year)
            ? formatDateTime(new Date(year, parseInt(month) - 1, 1), "MMMM")
            : null;

        if (paymentHistory.dataValues) {
            paymentHistory.dataValues.month_name = month_name;
            paymentHistory.dataValues.year = year;
        }

        return res.ok(paymentHistory);
    } catch (err) {
        return handleError(err, res, req);
    }
};

