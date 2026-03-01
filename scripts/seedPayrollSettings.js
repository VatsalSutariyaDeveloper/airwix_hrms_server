const { CompanySettingsMaster, sequelize } = require("../models");

const payrollSettings = [
  {
    setting_key: "payroll_financial_year",
    setting_label: "Financial Year",
    setting_group: "PAYROLL",
    input_type: "SELECT",
    options: JSON.stringify([{ label: "2024-25", value: "2024-25" }, { label: "2025-26", value: "2025-26" }]),
    default_value: "2024-25",
    description: "Current financial year for payroll processing",
    status: 0,
    entity_visiblity: 1,
    priority: 10
  },
  {
    setting_key: "payroll_cycle",
    setting_label: "Payroll Cycle",
    setting_group: "PAYROLL",
    input_type: "SELECT",
    options: JSON.stringify([{ label: "Monthly", value: "MONTHLY" }, { label: "Weekly", value: "WEEKLY" }]),
    default_value: "MONTHLY",
    description: "Frequency of salary payout",
    status: 0,
    entity_visiblity: 1,
    priority: 20
  },
  {
    setting_key: "payroll_calculation_days",
    setting_label: "Salary Calculation Days",
    setting_group: "PAYROLL",
    input_type: "SELECT",
    options: JSON.stringify([{ label: "30 Days", value: "30" }, { label: "Actual Days in Month", value: "ACTUAL" }, { label: "26 Days (Excl. Sundays)", value: "26" }]),
    default_value: "30",
    description: "Method used to calculate per-day salary",
    status: 0,
    entity_visiblity: 1,
    priority: 30
  },
  {
    setting_key: "payroll_default_tax_regime",
    setting_label: "Default Tax Regime",
    setting_group: "PAYROLL",
    input_type: "SELECT",
    options: JSON.stringify([{ label: "New Regime", value: "NEW" }, { label: "Old Regime", value: "OLD" }]),
    default_value: "NEW",
    description: "Default income tax regime for employees",
    status: 0,
    entity_visiblity: 1,
    priority: 40
  },
  {
    setting_key: "payroll_pt_state",
    setting_label: "PT Registered State",
    setting_group: "PAYROLL",
    input_type: "TEXT",
    default_value: "Maharashtra",
    description: "State for Professional Tax slabs",
    status: 0,
    entity_visiblity: 1,
    priority: 50
  },
  {
    setting_key: "payroll_pf_applicable",
    setting_label: "Enable PF Contribution",
    setting_group: "PAYROLL",
    input_type: "SWITCH",
    default_value: "1",
    description: "Whether Provident Fund is applicable for the company",
    status: 0,
    entity_visiblity: 1,
    priority: 60
  },
  {
    setting_key: "payroll_gratuity_applicable",
    setting_label: "Enable Gratuity Provision",
    setting_group: "PAYROLL",
    input_type: "SWITCH",
    default_value: "1",
    description: "Whether Gratuity provision is enabled",
    status: 0,
    entity_visiblity: 1,
    priority: 70
  },
  {
    setting_key: "payroll_leave_salary_rule",
    setting_label: "Leave Salary Rule",
    setting_group: "PAYROLL",
    input_type: "SELECT",
    options: JSON.stringify([{ label: "Deduct for Unpaid Leave", value: "DEDUCT_UNPAID" }, { label: "No Deduction", value: "NO_DEDUCTION" }]),
    default_value: "DEDUCT_UNPAID",
    description: "Rule for handling unpaid leaves in payroll",
    status: 0,
    entity_visiblity: 1,
    priority: 80
  }
];

async function seed() {
  try {
    for (const setting of payrollSettings) {
      const [record, created] = await CompanySettingsMaster.findOrCreate({
        where: { setting_key: setting.setting_key },
        defaults: setting
      });
      if (!created) {
        await record.update(setting);
        console.log(`Updated setting: ${setting.setting_key}`);
      } else {
        console.log(`Created setting: ${setting.setting_key}`);
      }
    }
    console.log("Payroll settings seeded successfully.");
    process.exit(0);
  } catch (error) {
    console.error("Error seeding payroll settings:", error);
    process.exit(1);
  }
}

seed();
