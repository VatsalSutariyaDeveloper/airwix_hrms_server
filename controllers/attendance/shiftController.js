const shiftService = require("../../helpers/shiftHelper");

exports.createShift = async (req, res) => {
    const shift = await shiftService.createShift(req.body, req.user.companyId);
    res.json({ message: "Shift created", data: shift });
};

exports.assignShift = async (req, res) => {
    const { employee_id, shift_id, effective_from } = req.body;

    await shiftService.assignShiftToEmployee(
        employee_id,
        shift_id,
        effective_from
    );

    res.json({ message: "Shift assigned successfully" });
};