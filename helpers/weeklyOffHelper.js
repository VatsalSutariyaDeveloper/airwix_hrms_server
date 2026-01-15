import { WeeklyOff } from "../models";

export const setWeeklyOff = async (employeeId, weekDays) => {
    await WeeklyOff.destroy({ where: { employee_id: employeeId } });

    const rows = weekDays.map(day => ({
        employee_id: employeeId,
        week_day: day,
    }));

    return await WeeklyOff.bulkCreate(rows);
};
