const { PaymentHistory, Employee, EmployeeAdvance, Payslip, User, sequelize } = require("../../models");
const { sequelize: sequelizeInstance, validateRequest, commonQuery, handleError } = require("../../helpers");
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

        if (req.body.payment_type === PAYMENT_TYPE.SALARY && req.body.ref_id) {
            const payslip = await commonQuery.findOneRecord(Payslip, req.body.ref_id, {}, transaction);
            
            if (!payslip) {
                await transaction.rollback();
                return res.error(constants.NOT_FOUND, { ref_id: "Payslip not found" });
            }

            const netPayable = parseFloat(payslip.net_salary || 0);
            const paymentAmount = parseFloat(req.body.amount || 0);

            if (paymentAmount > netPayable) {
                await transaction.rollback();
                return res.error(constants.VALIDATION_ERROR, { 
                    amount: `Payment amount (${paymentAmount}) cannot exceed net payable amount (${netPayable})` 
                });
            }
        
            await commonQuery.createRecord(PaymentHistory, req.body, transaction);
            isCreated = true;
        
            const totalPaidResult = await commonQuery.findAllRecords(PaymentHistory, {
                ref_id: req.body.ref_id,
                payment_type: PAYMENT_TYPE.SALARY
            }, {
                attributes: [[sequelizeInstance.fn('SUM', sequelizeInstance.col('amount')), 'total_paid']],
                raw: true
            }, transaction);
            
            const totalPaid = parseFloat(totalPaidResult[0]?.total_paid || 0);
            
            if (totalPaid >= netPayable && payslip.status !== 3) {
                await commonQuery.updateRecordById(Payslip, req.body.ref_id, { status: 3 }, transaction);
            }
        } else {
            // General or Advance payment history creation
            await commonQuery.createRecord(PaymentHistory, req.body, transaction);
            isCreated = true;
        }

        if (isCreated) {
            // 💸 Send Notification to Employee
            try {
                const targetUser = await commonQuery.findOneRecord(User, { employee_id: req.body.employee_id }, {}, transaction);
                if (targetUser) {
                    const monthName = dayjs().month(parseInt(req.body.month) - 1).format('MMMM');
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
        if(err){
            await transaction.rollback();
        }
        return handleError(err, res, req);
    }
};

exports.getAllPaymentHistory = async (req, res) => {
    try {
        const fieldConfig = [
            ["payment_date", true, true],
            ["amount", true, true]
        ];

        const data = await commonQuery.fetchPaginatedData(
            PaymentHistory,
            req.body,
            fieldConfig,
            {
                include: [
                    { model: Employee, as: 'employee', attributes: ['id', 'employee_code', 'first_name', 'mobile_no'] }
                ]
            }
        );
        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.paymentHistoryView = async (req, res) => {
    try{
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
                    }
                ]
            }
        );

        if (!paymentHistory) {
            return res.error(constants.NOT_FOUND);
        }

        return res.ok(paymentHistory);
    }catch(err){
        return handleError(err, res, req);
    }
};

