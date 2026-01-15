const { Op } = require("sequelize");
const { AttendanceDay, AttendancePunch } = require("../models");

async function punch(employeeId, punchType, meta) {
  const now = new Date();
  const today = now.toISOString().split("T")[0];

  // 1️⃣ Save raw punch
  await AttendancePunch.create({
    employee_id: employeeId,
    punch_type: punchType,
    punch_time: now,
    ...meta,
  });

  // 2️⃣ Recalculate day attendance
  await rebuildAttendanceDay(employeeId, today);
}

async function rebuildAttendanceDay(employeeId, date) {
  const punches = await AttendancePunch.findAll({
    where: {
      employee_id: employeeId,
      punch_time: {
        [Op.between]: [`${date} 00:00:00`, `${date} 23:59:59`],
      },
    },
    order: [["punch_time", "ASC"]],
  });

  if (punches.length === 0) return;

  const firstIn = punches.find(p => p.punch_type === "IN");
  const lastOut = [...punches].reverse().find(p => p.punch_type === "OUT");

  let workedMinutes = 0;
  for (let i = 0; i < punches.length - 1; i++) {
    if (punches[i].punch_type === "IN" && punches[i + 1].punch_type === "OUT") {
      workedMinutes +=
        (new Date(punches[i + 1].punch_time) -
          new Date(punches[i].punch_time)) /
        60000;
    }
  }

  await AttendanceDay.upsert({
    employee_id: employeeId,
    attendance_date: date,
    first_in: firstIn?.punch_time,
    last_out: lastOut?.punch_time,
    worked_minutes: Math.floor(workedMinutes),
    status: workedMinutes >= 480 ? "PRESENT" : "HALF_DAY",
  });
}

module.exports = {
  punch,
};