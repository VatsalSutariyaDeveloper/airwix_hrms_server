"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn("visitor_passes", "visitor_type", {
      type: Sequelize.ENUM("VISITOR", "CONTRACTOR", "TPI"),
      defaultValue: "VISITOR",
      allowNull: false
    });
    await queryInterface.addColumn("visitor_passes", "valid_from", {
      type: Sequelize.DATEONLY,
      allowNull: true
    });
    await queryInterface.addColumn("visitor_passes", "valid_to", {
      type: Sequelize.DATEONLY,
      allowNull: true
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.removeColumn("visitor_passes", "valid_to");
    await queryInterface.removeColumn("visitor_passes", "valid_from");
    await queryInterface.removeColumn("visitor_passes", "visitor_type");
  }
};
