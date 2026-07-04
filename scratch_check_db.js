const { sequelize, AttendancePunch, AttendanceDay, Employee } = require("./models");
const dayjs = require("dayjs");

async function check() {
  try {
    const employeeId = 4013;
    const emp = await Employee.findByPk(employeeId);
    if (!emp) {
      console.log("Employee 4013 not found");
      return;
    }
    console.log("Employee:", { id: emp.id, name: emp.full_name || emp.first_name, company_id: emp.company_id, branch_id: emp.branch_id });

    const punches = await AttendancePunch.findAll({
      where: { employee_id: employeeId },
      order: [["punch_time", "ASC"]]
    });

    console.log("\nPunches found:", punches.length);
    punches.forEach(p => {
      console.log({
        id: p.id,
        day_id: p.day_id,
        punch_time: p.punch_time,
        punch_time_formatted: dayjs(p.punch_time).format("YYYY-MM-DD HH:mm:ss"),
        punch_type: p.punch_type,
        status: p.status,
        company_id: p.company_id,
        branch_id: p.branch_id
      });
    });

    const days = await AttendanceDay.findAll({
      where: { employee_id: employeeId },
      order: [["attendance_date", "ASC"]]
    });
    console.log("\nDays found:", days.length);
    days.forEach(d => {
      console.log({
        id: d.id,
        attendance_date: d.attendance_date,
        first_in: d.first_in,
        last_out: d.last_out,
        status: d.status,
        shift_id: d.shift_id
      });
    });
  } catch (err) {
    console.error(err);
  } finally {
    await sequelize.close();
  }
}

check();
