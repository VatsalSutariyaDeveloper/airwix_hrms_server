'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('attendance_approval_requests', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      employee_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'employees',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      attendance_date: {
        type: Sequelize.DATEONLY,
        allowNull: false
      },
      reason: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      approval_status: {
        type: Sequelize.INTEGER,
        defaultValue: 0,
        comment: "0=PENDING, 1=PARTIALLY_APPROVED, 2=DELETED, 3=APPROVED, 4=REJECTED, 5=CANCELLED"
      },
      current_level: {
        type: Sequelize.INTEGER,
        defaultValue: 1,
        comment: "Tracks the current approval stage"
      },
      approval_history: {
        type: Sequelize.JSON,
        allowNull: true,
        comment: "Record of who approved at each level. Example: [{ level: 1, user_id: 45, date: '...' }]"
      },
      approved_by: {
        type: Sequelize.INTEGER,
        allowNull: true
      },
      approval_remark: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      status: {
        type: Sequelize.SMALLINT,
        defaultValue: 0,
        comment: "0: Active, 1: Inactive, 2: Deleted"
      },
      user_id: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },
      company_id: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },
      proposed_attendance_data: {
        type: Sequelize.JSON,
        allowNull: true,
        comment: "Stores the exact JSON payload from the attendance summary update to be applied upon final approval"
      },
      created_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      },
      updated_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      }
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('attendance_approval_requests');
  }
};
