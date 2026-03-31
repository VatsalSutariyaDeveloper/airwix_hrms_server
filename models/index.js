const { createConnectionByPrefix, sequelize } = require("../config/database");
const masterSequelize = require('../config/master_database');
const { DataTypes, Sequelize } = require("sequelize");
const { storage } = require("../middlewares/tenantMiddleware");

// Cache to store initialized model sets (one per prefix)
const modelSets = {};

function initModels(prefix) {
  if (modelSets[prefix]) {
    return modelSets[prefix];
  }

  // Get the sequelize connection for this prefix
  const seq = createConnectionByPrefix(prefix);
  
  // Administration models
  const ModuleMaster = require("./administration/permission/moduleMaster")(seq, DataTypes);
  const ModuleEntityMaster = require("./administration/permission/moduleEntityMaster")(seq, DataTypes);
  const ModulePermissionTypeMaster = require("./administration/permission/modulePermissionTypeMaster")(seq, DataTypes);
  const StateMaster = require("./administration/address/stateMaster")(seq, DataTypes);
  const CountryMaster = require("./administration/address/countryMaster")(seq, DataTypes);
  const CompanySettingsMaster = require("./administration/companySettingsMaster")(seq, DataTypes);
  const CurrencyMaster = require("./administration/currencyMaster")(seq, DataTypes);
  const BankMaster = require("./administration/bankMaster")(seq, DataTypes);
  const StatutoryLWFRule = require("./administration/statutoryLWFRule")(seq, DataTypes);
  const StatutoryPTRule = require("./administration/statutoryPTRule")(seq, DataTypes);

  // Settings models
  const RolePermission = require("./settings/user/rolePermission")(seq, DataTypes);
  const Permission = require("./settings/user/permission")(seq, DataTypes);
  const RoutePermission = require("./settings/user/routePermission")(seq, DataTypes);
  const UserCompanyRoles = require("./settings/user/userCompanyRoles")(seq, DataTypes);
  const CompanyMaster = require("./settings/company/companyMaster")(seq, DataTypes);
  const Organization = require("./settings/company/organization")(seq, DataTypes);
  const CompanyConfigration = require("./settings/company/companyConfigration")(seq, DataTypes);
  const CompanyAddress = require("./settings/company/companyAddress")(seq, DataTypes);
  const DeviceMaster = require("./settings/deviceMaster")(seq, DataTypes);
  const DesignationMaster = require("./settings/designationMaster")(seq, DataTypes);
  const BranchMaster = require("./settings/branchMaster")(seq, DataTypes);
  const ResignationTemplate = require("./settings/resignationTemplate")(seq, DataTypes);
  const ResignationReason = require("./settings/resignationReason")(seq, DataTypes);
  const OnDutyRequest = require("./settings/onDutyRequest")(seq, DataTypes);

  // Auth models
  const User = require("./settings/user/user")(seq, DataTypes);
  const Login = require("./auth/login")(seq, DataTypes);
  const LoginHistory = require("./auth/loginHistory")(seq, DataTypes);
  const OtpVerification = require("./auth/otpVerification")(seq, DataTypes);
  const ActivityLog = require("./activityLog")(seq, DataTypes);
  const ActivationRequest = require("./activationRequest")(seq, DataTypes);
  const EmployeeResignation = require("./employeeResignation")(seq, DataTypes);
  const ApiLog = require("./apiLog")(seq, DataTypes);
  const Logs = require("./logs")(seq, DataTypes);
  const Notification = require("./notification")(seq, DataTypes);

  // Subscription models
  const CompanySubscription = require("./subscription/companySubscriptions")(seq, DataTypes);
  const SubscriptionPlan = require("./subscription/subscriptionPlans")(seq, DataTypes);

  //Attendance models
  const AttendanceTemplate = require("./settings/attendanceTemplate")(seq, DataTypes);
  const AttendancePunch = require("./attendance/attendancePunch")(seq, DataTypes);
  const AttendanceDay = require("./attendance/attendanceDay")(seq, DataTypes);
  const ShiftTemplate = require("./settings/shiftTemplate")(seq, DataTypes);
  const ShiftBreak = require("./settings/shiftBreak")(seq, DataTypes);
  const WeeklyOffTemplate = require("./settings/weeklyOffTemplate")(seq, DataTypes);
  const WeeklyOffTemplateDay = require("./settings/weeklyOffTemplateDay")(seq, DataTypes);
  const EmployeeShift = require("./attendance/employeeShift")(seq, DataTypes);

  // Employee models
  const Employee = require("./employee")(seq, DataTypes);
  const EmployeeFamilyMember = require("./employeeFamilyMember")(seq, DataTypes);
  const AttendanceRegularization = require("./attendance/attendanceRegularization")(seq, DataTypes);

  // SeriesTypeMaster
  const SeriesTypeMaster = require("./settings/seriesTypeMaster")(seq, DataTypes);

  // APPROVAL ENGINE (Depends on Users, Modules, etc.)
  const ApprovalWorkflow = require("./administration/approval/approvalWorkflow")(seq, DataTypes);
  const ApprovalRule = require("./administration/approval/approvalRule")(seq, DataTypes);
  const ApprovalLevel = require("./administration/approval/approvalLevel")(seq, DataTypes);
  const ApprovalRequest = require("./administration/approval/approvalRequest")(seq, DataTypes);
  const ApprovalLog = require("./administration/approval/approvalLog")(seq, DataTypes);

  // Holiday models
  const Holiday = require("./administration/holiday")(seq, DataTypes);
  const HolidayTemplate = require("./settings/holidayTemplate")(seq, DataTypes);
  const HolidayTransaction = require("./settings/holidayTransaction")(seq, DataTypes);

  // Leave models
  const LeaveTemplate = require("./settings/leave/leaveTemplate")(seq, DataTypes);
  const LeaveTemplateCategory = require("./settings/leave/leaveTemplateCategory")(seq, DataTypes);
  const EmployeeLeaveBalance = require("./employeeData/EmployeeLeaveBalance")(seq, DataTypes);
  const LeaveRequest = require("./settings/leave/leaveRequest")(seq, DataTypes);

  // Salary models
  const SalaryTemplate = require("./settings/salary/salaryTemplate")(seq, DataTypes);
  const SalaryTemplateTransaction = require("./settings/salary/salaryTemplateTransaction")(seq, DataTypes);
  const SalaryComponent = require("./settings/salary/salaryComponent")(seq, DataTypes);

  // Employee Salary Template models
  const EmployeeSalaryTemplate = require("./employeeData/EmployeeSalaryTemplate")(seq, DataTypes);
  const EmployeeSalaryTemplateTransaction = require("./employeeData/EmployeeSalaryTemplateTransaction")(seq, DataTypes);
  const SalaryRevisionHistory = require("./employeeData/SalaryRevisionHistory")(seq, DataTypes);

  //Department models
  const Department = require("./settings/department")(seq, DataTypes);
  const PrintTemplate = require("./settings/printTemplate")(seq, DataTypes);

  // Employee Specific Template Data (User Wise)
  const EmployeeAttendanceTemplate = require("./employeeData/EmployeeAttendanceTemplate")(seq, DataTypes);
  const EmployeeHoliday = require("./employeeData/EmployeeHoliday")(seq, DataTypes);
  const EmployeeWeeklyOff = require("./employeeData/EmployeeWeeklyOff")(seq, DataTypes);
  const EmployeePrintTemplate = require("./employeeData/EmployeePrintTemplate")(seq, DataTypes);
  const EmployeeSettings = require("./settings/employeeSettings")(seq, DataTypes);
  const CustomField = require("./settings/customField")(seq, DataTypes);

  // Payroll models
  const Payslip = require("./payroll/payslip")(seq, DataTypes);
  const IncentiveType = require("./settings/incentiveType")(seq, DataTypes);
  const EmployeeIncentive = require("./payroll/employeeIncentive")(seq, DataTypes);
  const EmployeeAdvance = require("./payroll/employeeAdvance")(seq, DataTypes);
  const PaymentHistory = require("./payroll/paymentHistory")(seq, DataTypes);
  const CashVoucher = require("./payroll/cashVoucher")(seq, DataTypes);

  const CanteenAttendance = require("./canteenAttendance/canteenAttendance")(seq, DataTypes);

  // Collect all models in one db object
  const db = {
    ModuleMaster,
    ModuleEntityMaster,
    ModulePermissionTypeMaster,
    StateMaster,
    CountryMaster,
    CompanySettingsMaster,
    CurrencyMaster,
    BankMaster,
    RolePermission,
    Permission,
    RoutePermission,
    UserCompanyRoles,
    CompanyMaster,
    Organization,
    CompanyConfigration,
    CompanyAddress,
    DeviceMaster,
    DesignationMaster,
    BranchMaster,
    ResignationTemplate,
    ResignationReason,
    OnDutyRequest,
    SeriesTypeMaster,
    ApprovalWorkflow,
    ApprovalRule,
    ApprovalLevel,
    ApprovalRequest,
    ApprovalLog,
    User,
    Login,
    LoginHistory,
    OtpVerification,
    ActivityLog,
    ActivationRequest,
    EmployeeResignation,
    ApiLog,
    Logs,
    Notification,
    CompanySubscription,
    SubscriptionPlan,
    AttendanceTemplate,
    AttendancePunch,
    AttendanceDay,
    ShiftTemplate,
    ShiftBreak,
    WeeklyOffTemplate,
    WeeklyOffTemplateDay,
    EmployeeShift,
    Employee,
    EmployeeFamilyMember,
    Holiday,
    HolidayTemplate,
    HolidayTransaction,
    LeaveTemplate,
    LeaveTemplateCategory,
    LeaveRequest,
    SalaryTemplate,
    SalaryTemplateTransaction,
    SalaryComponent,
    EmployeeSalaryTemplate,
    EmployeeSalaryTemplateTransaction,
    StatutoryLWFRule,
    StatutoryPTRule,
    Department,
    PrintTemplate,
    EmployeeAttendanceTemplate,
    EmployeeLeaveBalance,
    EmployeeHoliday,
    EmployeeWeeklyOff,
    EmployeePrintTemplate,
    EmployeeSettings,
    CustomField,
    Payslip,
    IncentiveType,
    EmployeeIncentive,
    EmployeeAdvance,
    PaymentHistory,
    CashVoucher,
    CanteenAttendance,
    SalaryRevisionHistory,
    AttendanceRegularization
  };

  Object.keys(db).forEach(modelName => {
    if (db[modelName].associate) {
      db[modelName].associate(db);
    }
  });

  db.sequelize = seq;
  db.masterSequelize = masterSequelize;
  db.Sequelize = Sequelize;

  modelSets[prefix] = db;
  return db;
}

// Initial default database setup
const defaultPrefix = process.env.HRMS_DB_NAME ? 'HRMS' : '';
initModels(defaultPrefix);

// Multi-tenant proxy
const dbProxy = new Proxy({}, {
  get(target, prop) {
    const prefix = storage.getStore() || (process.env.HRMS_DB_NAME ? 'HRMS' : '');
    const currentDB = initModels(prefix); // Lazily initialize models for new environments
    return currentDB[prop];
  }
});

module.exports = dbProxy;
