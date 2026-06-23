'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // 21/06/2026 is a Sunday (day_of_week = 0, week_no = 3 because 21 / 7 = 3)
    // Delete attendance_day records on 2026-06-21 with status 3 (WEEKLY_OFF)
    // for employees of employee_type = 2 and company_id != 2 who do NOT have a weekly off.
    await queryInterface.sequelize.query(`
      DELETE FROM attendance_day ad
      USING employees e
      WHERE ad.employee_id = e.id
        AND ad.attendance_date = '2026-06-21'
        AND ad.status = 3
        AND e.employee_type = 2
        AND e.company_id != 2
        AND NOT EXISTS (
            SELECT 1 FROM employee_weekly_offs ewo
            WHERE ewo.employee_id = e.id
              AND ewo.day_of_week = 0
              AND ewo.week_no IN (0, 3)
              AND ewo.is_off = true
              AND ewo.status = 0
        )
        AND (
            e.weekly_off_template IS NULL
            OR NOT EXISTS (
                SELECT 1 FROM weekly_off_template_days wotd
                WHERE wotd.template_id = e.weekly_off_template
                  AND wotd.day_of_week = 0
                  AND wotd.week_no IN (0, 3)
                  AND wotd.is_off = true
                  AND wotd.status = 0
            )
        );
    `);
  },

  down: async (queryInterface, Sequelize) => {
    // Deletions cannot be easily reversed, so this is a no-op.
  }
};
