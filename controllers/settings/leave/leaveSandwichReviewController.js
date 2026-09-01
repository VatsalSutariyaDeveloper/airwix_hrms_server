const { LeaveSandwichReviewFlag, LeaveRequest, Employee, LeaveTemplate, sequelize } = require("../../../models");
const { commonQuery, handleError } = require("../../../helpers");
const { constants } = require("../../../helpers/constants");
const LeaveBalanceService = require("../../../services/leaveBalanceService");
const dayjs = require("dayjs");

// Apply ("apply" — adjusts the earlier request's balance by the recomputed
// delta) or dismiss a sandwich-adjustment flag. Called from the leave approval
// screen when a `sandwich_flag` is surfaced for a pair of leave requests that
// bracket a weekend/holiday — there is no separate review list; the flag is
// acted on immediately or left pending for next time.
// The suggested delta is always recomputed fresh here rather than trusted
// from the stored row, since the underlying leave requests could
// theoretically have changed since the flag was raised.
exports.updateStatus = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.params;
        const { action, remark } = req.body;

        if (action !== "apply" && action !== "dismiss") {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, { action: 'Action must be "apply" or "dismiss".' });
        }

        const flag = await commonQuery.findOneRecord(LeaveSandwichReviewFlag, { id }, {
            include: [
                { model: LeaveRequest, as: "earlierRequest" },
                { model: LeaveRequest, as: "laterRequest" },
            ],
        }, transaction);

        if (!flag || flag.status === 2) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }
        if (flag.review_status !== 0) {
            await transaction.rollback();
            return res.error("INVALID_OPERATION", { message: "This flag has already been reviewed." });
        }

        if (action === "apply") {
            const employee = await commonQuery.findOneRecord(Employee, flag.employee_id, {
                include: [{ model: LeaveTemplate, as: "leaveTemplate" }],
            }, transaction);
            if (!employee || !flag.earlierRequest || !flag.laterRequest) {
                await transaction.rollback();
                return res.error(constants.NOT_FOUND, { message: "Underlying employee/leave requests could not be found." });
            }

            const gapDays = await LeaveBalanceService.computeCrossRequestGapDays(
                employee, flag.leave_category_id, flag.earlierRequest, flag.laterRequest, transaction
            );
            const delta = gapDays.length;

            // Detect excess days on the later request caused by gap days having already
            // been added to the later request's total_days at creation time. Recompute
            // the correct total for the later request using only its own date range.
            const { totalWorkingDays: correctLaterTotal } = await LeaveBalanceService.computeSandwichAdjustedWorkingDays(
                employee, flag.leave_category_id,
                flag.laterRequest.start_date, flag.laterRequest.end_date,
                transaction,
                { startSession: flag.laterRequest.start_session || 0, endSession: flag.laterRequest.end_session || 0 }
            );
            // Apply session reduction to match how total_days was originally computed
            let laterExpected = correctLaterTotal;
            const lrSS = flag.laterRequest.start_session || 0;
            const lrES = flag.laterRequest.end_session || 0;
            if (flag.laterRequest.start_date === flag.laterRequest.end_date && lrSS !== 0) {
                laterExpected = correctLaterTotal > 0 ? 0.5 : 0;
            } else {
                if (lrSS !== 0) laterExpected -= 0.5;
                if (lrES !== 0 && flag.laterRequest.start_date !== flag.laterRequest.end_date) laterExpected -= 0.5;
                laterExpected = Math.max(0, laterExpected);
            }
            laterExpected = Math.round(laterExpected * 10) / 10;

            const storedLaterTotal = Math.round(parseFloat(flag.laterRequest.total_days || 0) * 10) / 10;
            const excessOnLater = Math.max(0, Math.round((storedLaterTotal - laterExpected) * 10) / 10);

            if (excessOnLater > 0) {
                // Correct the later request's total_days and refund the excess from balance
                const correctedLaterTotal = Math.round((storedLaterTotal - excessOnLater) * 10) / 10;
                await commonQuery.updateRecordById(LeaveRequest, flag.laterRequest.id, { total_days: correctedLaterTotal }, transaction);
                await LeaveBalanceService.adjustLeaveBalance(
                    flag.employee_id, flag.leave_category_id, -excessOnLater, transaction,
                    dayjs(flag.laterRequest.start_date), employee
                );
            }

            if (delta > 0) {
                const newTotal = Math.round((parseFloat(flag.earlierRequest.total_days) + delta) * 10) / 10;
                await commonQuery.updateRecordById(LeaveRequest, flag.earlierRequest.id, {
                    total_days: newTotal,
                    sandwich_gap_dates: gapDays.map(d => d.date)
                }, transaction);
                await LeaveBalanceService.adjustLeaveBalance(
                    flag.employee_id, flag.leave_category_id, delta, transaction,
                    dayjs(flag.earlierRequest.start_date), employee
                );
            }

            await commonQuery.updateRecordById(LeaveSandwichReviewFlag, flag.id, {
                review_status: 1,
                reviewed_by: req.user?.id,
                reviewed_at: new Date(),
                remark: remark || null,
                suggested_additional_days: delta,
                gap_dates: gapDays.map(d => d.date),
            }, transaction);
        } else {
            await commonQuery.updateRecordById(LeaveSandwichReviewFlag, flag.id, {
                review_status: 2,
                reviewed_by: req.user?.id,
                reviewed_at: new Date(),
                remark: remark || null,
            }, transaction);
        }

        await transaction.commit();
        return res.success(constants.UPDATED);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};
