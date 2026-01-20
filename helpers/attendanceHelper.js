const { Op } = require("sequelize");
const { AttendanceDay, AttendancePunch } = require("../models");

async function punch(employeeId, meta) {
  const now = new Date();
  const today = now.toISOString().split("T")[0];

  // 1️⃣ Determine punch type (IN / OUT)
  const lastPunch = await AttendancePunch.findOne({
    where: {
      employee_id: employeeId,
      punch_time: {
        [Op.between]: [`${today} 00:00:00`, `${today} 23:59:59`],
      },
      status: 0,
    },
    order: [["punch_time", "DESC"]],
  });

  const punchType = !lastPunch || lastPunch.punch_type === "OUT" ? "IN" : "OUT";

  // 2️⃣ Save raw punch
  await AttendancePunch.create({
    employee_id: employeeId,
    punch_type: punchType,
    punch_time: now,
    ...meta,
  });

  // 3️⃣ Recalculate day attendance
  await rebuildAttendanceDay(employeeId, today, meta);

  return { punchType, punchTime: now };
}

async function rebuildAttendanceDay(employeeId, date, meta = {}) {
  const punches = await AttendancePunch.findAll({
    where: {
      employee_id: employeeId,
      punch_time: {
        [Op.between]: [`${date} 00:00:00`, `${date} 23:59:59`],
      },
      status: 0,
    },
    order: [["punch_time", "ASC"]],
  });

  if (punches.length === 0) return;

  const firstIn = punches.find((p) => p.punch_type === "IN");
  const lastOut = [...punches].reverse().find((p) => p.punch_type === "OUT");

  let workedMinutes = 0;
  for (let i = 0; i < punches.length - 1; i++) {
    if (punches[i].punch_type === "IN" && punches[i + 1].punch_type === "OUT") {
      workedMinutes +=
        (new Date(punches[i + 1].punch_time) -
          new Date(punches[i].punch_time)) /
        60000;
    }
  }

  // Status mapping: 0: PRESENT, 1: HALF_DAY, 2: ABSENT
  let status = 0; // PRESENT
  if (workedMinutes < 240) {
    status = 1; // HALF_DAY (less than 4 hours)
  }

  await AttendanceDay.upsert({
    employee_id: employeeId,
    attendance_date: date,
    first_in: firstIn ? firstIn.punch_time.toISOString().split("T")[1].slice(0, 8) : null,
    last_out: lastOut ? lastOut.punch_time.toISOString().split("T")[1].slice(0, 8) : null,
    worked_minutes: Math.floor(workedMinutes),
    status: status,
    user_id: meta.user_id || 0,
    branch_id: meta.branch_id || 0,
    company_id: meta.company_id || 0,
  });
}

module.exports = {
  punch,
};
