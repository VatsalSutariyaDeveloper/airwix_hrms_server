'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Change expense_type column to allow NULL
    await queryInterface.changeColumn('reimbursements', 'expense_type', {
      type: Sequelize.INTEGER,
      allowNull: true
    });
  },

  down: async (queryInterface, Sequelize) => {
    // Revert change
    await queryInterface.changeColumn('reimbursements', 'expense_type', {
      type: Sequelize.INTEGER,
      allowNull: false
    });
  }
};
