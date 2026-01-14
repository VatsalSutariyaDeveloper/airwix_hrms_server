module.exports = (sequelize, DataTypes) => {
  const SubscriptionPlan = sequelize.define(
    "SubscriptionPlan",
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },

      // Identity
      subscription_type: {
        type: DataTypes.ENUM(
          "plan",
          "addon_user",
          "addon_company",
          "addon_bank_accounts",
          "addon_sms",
          "addon_whatsapp",
          "addon_email"
        ),
        defaultValue: "plan",
      },
      name: { type: DataTypes.STRING, allowNull: false },
      description: { type: DataTypes.TEXT },

      // Pricing
      price: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
      duration_days: { type: DataTypes.INTEGER, defaultValue: 30 },
      is_trial: { type: DataTypes.BOOLEAN, defaultValue: false },

      // ===== USER & RESOURCE LIMITS =====
      users_limit: { type: DataTypes.INTEGER, defaultValue: 1 },
      companies_limit: { type: DataTypes.INTEGER, defaultValue: 1 },
      bank_accounts_limit: { type: DataTypes.INTEGER, defaultValue: 1 },
      warehouses_limit: { type: DataTypes.INTEGER, defaultValue: 1 },
      platform_access: {
        type: DataTypes.ENUM("web", "android", "ios", "all"),
        defaultValue: "web",
      },

      // ===== FEATURES SNAPSHOT (SAME AS PLAN) =====
      
      enable_customer: DataTypes.BOOLEAN,
      customers_limit: DataTypes.INTEGER,
      enable_sales: DataTypes.BOOLEAN,
      sales_limit: DataTypes.INTEGER,
      enable_leads: DataTypes.BOOLEAN,
      leads_limit: DataTypes.INTEGER,
      enable_tasks: DataTypes.BOOLEAN,
      enable_followups: DataTypes.BOOLEAN,
      enable_quotations: DataTypes.BOOLEAN,
      quotations_limit: DataTypes.INTEGER,
      enable_sale_orders: DataTypes.BOOLEAN,
      sale_orders_limit: DataTypes.INTEGER,
      enable_proforma_invoices: DataTypes.BOOLEAN,
      proforma_invoices_limit: DataTypes.INTEGER,
      enable_invoicing: DataTypes.BOOLEAN,
      invoices_limit: DataTypes.INTEGER,
      enable_delivery_challans: DataTypes.BOOLEAN,
      delivery_challans_limit: DataTypes.INTEGER,
      enable_credit_debit_notes: DataTypes.BOOLEAN,
      credit_notes_limit: DataTypes.INTEGER,
      debit_notes_limit: DataTypes.INTEGER,
      enable_eway_bills: DataTypes.BOOLEAN,
      eway_bills_limit: DataTypes.INTEGER,
      enable_einvoicing: DataTypes.BOOLEAN,
      einvoices_limit: DataTypes.INTEGER,
      enable_gst_filings: DataTypes.BOOLEAN,
      gst_filings_limit: DataTypes.INTEGER,
      enable_tds: DataTypes.BOOLEAN,
      enable_tcs: DataTypes.BOOLEAN,

      enable_purchase: DataTypes.BOOLEAN,
      enable_vendors: DataTypes.BOOLEAN,
      vendors_limit: DataTypes.INTEGER,
      enable_purchase_orders: DataTypes.BOOLEAN,
      purchase_orders_limit: DataTypes.INTEGER,
      enable_purchase_invoicing: DataTypes.BOOLEAN,
      purchase_invoices_limit: DataTypes.INTEGER,

      enable_inventory: DataTypes.BOOLEAN,
      enable_multi_warehouses: DataTypes.BOOLEAN,
      enable_stock_adjustment: DataTypes.BOOLEAN,
      enable_stock_transfer: DataTypes.BOOLEAN,
      enable_barcode: DataTypes.BOOLEAN,
      enable_serial_batch: DataTypes.BOOLEAN,
      item_limit: DataTypes.INTEGER,
      enable_manufacturing: DataTypes.BOOLEAN,
      enable_bom: DataTypes.BOOLEAN,

      enable_accounting: DataTypes.BOOLEAN,
      enable_expense_management: DataTypes.BOOLEAN,
      bank_account_limit: DataTypes.INTEGER,

      enable_sms: DataTypes.BOOLEAN,
      sms_limit: DataTypes.INTEGER,
      enable_whatsapp: DataTypes.BOOLEAN,
      whatsapp_limit: DataTypes.INTEGER,
      enable_email: DataTypes.BOOLEAN,
      email_limit: DataTypes.INTEGER,
      enable_priority_support: DataTypes.BOOLEAN,

      allowed_module_ids: {
        type: DataTypes.TEXT, 
        allowNull: true,
        defaultValue: null,
        comment: "MenuModuleMaster IDs included in this plan"
      },

      // ===== STATUS =====
      status: {
        type: DataTypes.SMALLINT,
        defaultValue: 0,
        comment: "0: Active, 1: Inactive",
      },
    },
    {
      tableName: "subscription_plans",
      timestamps: true,
      underscored: true,
    }
  );

  SubscriptionPlan.associate = (models) => {
    SubscriptionPlan.hasMany(models.CompanySubscription, {
      foreignKey: "subscription_plan_id",
      as: "companies",
    });
  };

  return SubscriptionPlan;
};