const sequelize = require("../config/database");
const masterSequelize = require('../config/master_database');
const { DataTypes } = require("sequelize");

// Administration models
const ModuleMaster = require("./administration/permission/moduleMaster")(sequelize, DataTypes);
const ModuleEntityMaster = require("./administration/permission/moduleEntityMaster")(sequelize, DataTypes);
const ModulePermissionTypeMaster = require("./administration/permission/modulePermissionTypeMaster")(sequelize, DataTypes);
const StateMaster = require("./administration/address/stateMaster")(sequelize, DataTypes);
const CountryMaster = require("./administration/address/countryMaster")(sequelize, DataTypes);
const CompanySettingsMaster = require("./administration/companySettingsMaster")(sequelize, DataTypes);
const CurrencyMaster = require("./administration/currencyMaster")(sequelize, DataTypes);
const BankMaster = require("./administration/bankMaster")(sequelize, DataTypes);

// Settings models
const RolePermission = require("./settings/user/rolePermission")(sequelize, DataTypes);
const Permission = require("./settings/user/permission")(sequelize, DataTypes);
const RoutePermission = require("./settings/user/routePermission")(sequelize, DataTypes);
const UserCompanyRoles = require("./settings/user/userCompanyRoles")(sequelize, DataTypes);
const CompanyMaster = require("./settings/company/companyMaster")(sequelize, DataTypes);
const CompanyConfigration = require("./settings/company/companyConfigration")(sequelize, DataTypes);
const CompanyAddress = require("./settings/company/companyAddress")(sequelize, DataTypes);
const DeviceMaster = require("./settings/deviceMaster")(sequelize, DataTypes);

// Auth models
const User = require("./settings/user/user")(sequelize, DataTypes);
const Login = require("./auth/login")(sequelize, DataTypes);
const LoginHistory = require("./auth/loginHistory")(sequelize, DataTypes);
const OtpVerification = require("./auth/otpVerification")(sequelize, DataTypes);
const ActivityLog = require("./activityLog")(sequelize, DataTypes);
const ActivationRequest = require("./activationRequest")(sequelize, DataTypes);
const Logs = require("./logs")(sequelize, DataTypes);

// Subscription models
const CompanySubscription = require("./subscription/companySubscriptions")(sequelize, DataTypes);
const SubscriptionPlan = require("./subscription/subscriptionPlans")(sequelize, DataTypes);

//Attendance models
const AttendanceTemplate = require("./settings/attendanceTemplate")(sequelize, DataTypes);
const AttendancePunch = require("./attendance/attendancePunch")(sequelize, DataTypes);
const AttendanceDay = require("./attendance/attendanceDay")(sequelize, DataTypes);
const Shift = require("./settings/shift")(sequelize, DataTypes);
// const WeeklyOff = require("./attendance/weeklyOff")(sequelize, DataTypes);
const WeeklyOffTemplate = require("./settings/weeklyOffTemplate")(sequelize, DataTypes);
const WeeklyOffTemplateDay = require("./settings/weeklyOffTemplateDay")(sequelize, DataTypes);

const EmployeeShift = require("./attendance/employeeShift")(sequelize, DataTypes);

// Employee models
const Employee = require("./employee")(sequelize, DataTypes);
const EmployeeFamilyMember = require("./employeeFamilyMember")(sequelize, DataTypes);

// SeriesTypeMaster
const SeriesTypeMaster = require("./settings/seriesTypeMaster")(sequelize, DataTypes);

// APPROVAL ENGINE (Depends on Users, Modules, etc.)
const ApprovalWorkflow = require("./administration/approval/approvalWorkflow")(sequelize, DataTypes);
const ApprovalRule = require("./administration/approval/approvalRule")(sequelize, DataTypes);
const ApprovalLevel = require("./administration/approval/approvalLevel")(sequelize, DataTypes);
const ApprovalRequest = require("./administration/approval/approvalRequest")(sequelize, DataTypes);
const ApprovalLog = require("./administration/approval/approvalLog")(sequelize, DataTypes);

// Holiday models
const Holiday = require("./administration/holiday")(sequelize, DataTypes);
const HolidayTemplate = require("./settings/holidayTemplate")(sequelize, DataTypes);
const HolidayTransaction = require("./settings/holidayTransaction")(sequelize, DataTypes);

// Leave models
const LeaveTemplate = require("./settings/leave/leaveTemplate")(sequelize, DataTypes);
const LeaveTemplateCategory = require("./settings/leave/leaveTemplateCategory")(sequelize, DataTypes);
const LeaveBalance = require("./settings/leave/leaveBalance")(sequelize, DataTypes);
const LeaveRequest = require("./settings/leave/leaveRequest")(sequelize, DataTypes);


// Collect all models in one db object
const db = {
  // Administration
  ModuleMaster,
  ModuleEntityMaster,
  ModulePermissionTypeMaster,
  StateMaster,
  CountryMaster,
  CompanySettingsMaster,
  CurrencyMaster,
  BankMaster,

  // Settings
  RolePermission,
  Permission,
  RoutePermission,
  UserCompanyRoles,
  CompanyMaster,
  CompanyConfigration,
  CompanyAddress,
  DeviceMaster,

  // SeriesTypeMaster
  SeriesTypeMaster,

  // APPROVAL ENGINE (Depends on Users, Modules, etc.)
  ApprovalWorkflow,
  ApprovalRule,
  ApprovalLevel,
  ApprovalRequest,
  ApprovalLog,

  // Auth
  User,
  Login,
  LoginHistory,
  OtpVerification,
  ActivityLog,
  ActivationRequest,
  Logs,

  // Subscription
  CompanySubscription,
  SubscriptionPlan,

  //Attandance
  AttendanceTemplate,
  AttendancePunch,
  AttendanceDay,
  Shift,
  // WeeklyOff,
  WeeklyOffTemplate,
  WeeklyOffTemplateDay,
  EmployeeShift,

  // Employee
  Employee,
  EmployeeFamilyMember,

  // Holiday
  Holiday,
  HolidayTemplate,
  HolidayTransaction,

  // Leave
  LeaveTemplate,
  LeaveTemplateCategory,
  LeaveBalance,
  LeaveRequest,
};

Object.keys(db).forEach(modelName => {
  if (db[modelName].associate) {
    db[modelName].associate(db);
  }
});

// Export Sequelize instance and models
db.sequelize = sequelize;
db.masterSequelize = masterSequelize;
db.Sequelize = require("sequelize");

module.exports = db;