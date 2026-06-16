'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const tableDefinition = await queryInterface.describeTable('reimbursements');
    if (!tableDefinition.total_amount) {
      await queryInterface.addColumn('reimbursements', 'total_amount', {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: true,
        defaultValue: 0,
        comment: "Authoritative claim total from child items"
      });
    }
  },

  down: async (queryInterface, Sequelize) => {
    const tableDefinition = await queryInterface.describeTable('reimbursements');
    if (tableDefinition.total_amount) {
      await queryInterface.removeColumn('reimbursements', 'total_amount');
    }
  }
};

