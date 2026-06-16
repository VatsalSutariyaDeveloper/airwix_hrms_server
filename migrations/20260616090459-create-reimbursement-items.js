'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    await queryInterface.createTable('reimbursement_items', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      reimbursement_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'reimbursements',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      expense_type: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'expense_type',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      amount: {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: false
      },
      expense_date: {
        type: Sequelize.DATEONLY,
        allowNull: true
      },
      description: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      bills_docs: {
        type: Sequelize.STRING,
        allowNull: true,
        comment: "Path to the uploaded bill document"
      },
      company_id: {
        type: Sequelize.INTEGER,
        allowNull: true
      },
      branch_id: {
        type: Sequelize.INTEGER,
        allowNull: true
      },
      status: {
        type: Sequelize.SMALLINT,
        defaultValue: 0,
        comment: "0: Active, 1: Inactive, 2: Deleted"
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'users',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
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

    // Add indexes
    await queryInterface.addIndex('reimbursement_items', ['reimbursement_id']);
    await queryInterface.addIndex('reimbursement_items', ['expense_type']);
    await queryInterface.addIndex('reimbursement_items', ['company_id']);
    await queryInterface.addIndex('reimbursement_items', ['branch_id']);
    await queryInterface.addIndex('reimbursement_items', ['status']);
  },

  async down (queryInterface, Sequelize) {
    await queryInterface.dropTable('reimbursement_items');
  }
};
