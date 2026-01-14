const sequelize = require("../config/database");
const masterSequelize = require('../config/master_database');
const { DataTypes } = require("sequelize");
const { encrypt,decrypt } = require("../helpers/crypto");

// Administration models
const ModuleMaster = require("./administration/permission/moduleMaster")(sequelize, DataTypes);
const ModuleEntityMaster = require("./administration/permission/moduleEntityMaster")(sequelize, DataTypes);
const ModulePermissionTypeMaster = require("./administration/permission/modulePermissionTypeMaster")(sequelize, DataTypes);
const HSNMaster = require("./administration/hsnMaster")(sequelize, DataTypes);
const CityMaster = require("./administration/address/cityMaster")(masterSequelize, DataTypes);
const StateMaster = require("./administration/address/stateMaster")(sequelize, DataTypes);
const CountryMaster = require("./administration/address/countryMaster")(sequelize, DataTypes);
const ZoneMaster = require("./administration/address/zoneMaster")(sequelize, DataTypes);
const CompanySettingsMaster = require("./administration/companySettingsMaster")(sequelize, DataTypes);
const CurrencyMaster = require("./administration/currencyMaster")(sequelize, DataTypes);
const BankMaster = require("./administration/bankMaster")(sequelize, DataTypes);

// Settings models
const RolePermission = require("./settings/user/rolePermission")(sequelize, DataTypes);
const Permission = require("./settings/user/permission")(sequelize, DataTypes);
const RoutePermission = require("./settings/user/routePermission")(sequelize, DataTypes);
const UserCompanyRoles = require("./settings/user/userCompanyRoles")(sequelize, DataTypes);
const TemplatesMessage = require("./settings/templatesMessage")(sequelize, DataTypes);
const CompanyMaster = require("./settings/company/companyMaster")(sequelize, DataTypes);
const CompanyConfigration = require("./settings/company/companyConfigration")(sequelize, DataTypes);
const CompanyAddress = require("./settings/company/companyAddress")(sequelize, DataTypes);
const TaxTypeMaster = require("./settings/tax/taxTypeMaster")(sequelize, DataTypes);
const Taxes = require("./settings/tax/taxes")(sequelize, DataTypes);
const TaxGroup = require("./settings/tax/taxGroup")(sequelize, DataTypes);
const TaxGroupTransaction = require("./settings/tax/taxGroupTransaction")(sequelize, DataTypes);
const Notification = require("./settings/notification")(sequelize, DataTypes);

// Transaction models
const TaxTransaction = require("./transactions/taxTransaction")(sequelize,DataTypes);

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

// Collect all models in one db object
const db = {
  // Administration
  ModuleMaster,
  ModuleEntityMaster,
  ModulePermissionTypeMaster,
  HSNMaster,
  CityMaster,
  StateMaster,
  CountryMaster,
  ZoneMaster,
  CompanySettingsMaster,
  CurrencyMaster,
  BankMaster,

  // Settings
  RolePermission,
  Permission,
  RoutePermission,
  UserCompanyRoles,
  TemplatesMessage,
  CompanyMaster,
  CompanyConfigration,
  CompanyAddress,
  TaxTypeMaster,
  Taxes,
  TaxGroup,
  TaxGroupTransaction,
  Notification,

  // Transactions
  TaxTransaction,

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