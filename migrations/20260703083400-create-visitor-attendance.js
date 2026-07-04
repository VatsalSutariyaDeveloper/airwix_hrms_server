"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable("visitor_attendance", {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      visitor_pass_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: "visitor_passes",
          key: "id"
        },
        onUpdate: "CASCADE",
        onDelete: "CASCADE"
      },
      visitor_name: {
        type: Sequelize.STRING(255),
        allowNull: false
      },
      visitor_phone: {
        type: Sequelize.STRING(20),
        allowNull: false
      },
      visitor_photo: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      check_in_time: {
        type: Sequelize.DATE,
        allowNull: true
      },
      check_out_time: {
        type: Sequelize.DATE,
        allowNull: true
      },
      security_remarks: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      status: {
        type: Sequelize.INTEGER,
        defaultValue: 0,
        comment: "1: Checked In, 3: Checked Out"
      },
      created_at: {
        allowNull: false,
        type: Sequelize.DATE
      },
      updated_at: {
        allowNull: false,
        type: Sequelize.DATE
      }
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable("visitor_attendance");
  }
};
