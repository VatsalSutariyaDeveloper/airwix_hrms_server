// const { EmployeeShift, Shift } = require("../models");

// export const createShift = async (data, companyId) => {
//     return await Shift.create({ ...data, company_id: companyId });
// };

// export const assignShiftToEmployee = async (
//     employeeId,
//     shiftId,
//     effectiveFrom
// ) => {
//     // close previous shift
//     await EmployeeShift.update(
//         { effective_to: effectiveFrom },
//         { where: { employee_id: employeeId, effective_to: null } }
//     );

//     return await EmployeeShift.create({
//         employee_id: employeeId,
//         shift_id: shiftId,
//         effective_from: effectiveFrom,
//     });
// };
