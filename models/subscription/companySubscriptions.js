module.exports = (sequelize, DataTypes) => {
  const CompanySubscription = sequelize.define(
    "CompanySubscription",
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      subscription_plan_id: { type: DataTypes.INTEGER, allowNull: false },
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

      // Payment & Period
      amount_paid: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
      payment_id: { type: DataTypes.STRING },
      payment_status: {
        type: DataTypes.ENUM("Paid", "Pending", "Failed"),
        defaultValue: "Pending",
      },
      duration_days: { type: DataTypes.INTEGER, defaultValue: 30 },
      start_date: { type: DataTypes.DATE, allowNull: false },
      end_date: { type: DataTypes.DATE, allowNull: false },

      // ===== LIMIT SNAPSHOT (SAME AS PLAN) =====
      users_limit: { type: DataTypes.INTEGER },
      companies_limit: { type: DataTypes.INTEGER },
      bank_accounts_limit: { type: DataTypes.INTEGER },
      warehouses_limit: { type: DataTypes.INTEGER },
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
      purchase_limit: DataTypes.INTEGER,
      enable_vendor: DataTypes.BOOLEAN,
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
      items_limit: DataTypes.INTEGER,
      enable_manufacturing: DataTypes.BOOLEAN,
      enable_bom: DataTypes.BOOLEAN,

      enable_accounting: DataTypes.BOOLEAN,
      enable_expense_management: DataTypes.BOOLEAN,

      enable_sms: DataTypes.BOOLEAN,
      sms_limit: DataTypes.INTEGER,
      enable_whatsapp: DataTypes.BOOLEAN,
      whatsapp_limit: DataTypes.INTEGER,
      enable_email: DataTypes.BOOLEAN,
      email_limit: DataTypes.INTEGER,

      // ===== USAGE =====
      used_users: { type: DataTypes.INTEGER, defaultValue: 0 },
      used_companies: { type: DataTypes.INTEGER, defaultValue: 0 },
      used_bank_accounts: { type: DataTypes.INTEGER, defaultValue: 0 },
      used_customers: { type: DataTypes.INTEGER, defaultValue: 0 },
      used_sales: { type: DataTypes.INTEGER, defaultValue: 0 },
      used_leads: { type: DataTypes.INTEGER, defaultValue: 0 },
      used_quotations: { type: DataTypes.INTEGER, defaultValue: 0 },
      used_sale_orders: { type: DataTypes.INTEGER, defaultValue: 0 },
      used_proforma_invoices: { type: DataTypes.INTEGER, defaultValue: 0 },
      used_invoices: { type: DataTypes.INTEGER, defaultValue: 0 },
      used_delivery_challans: { type: DataTypes.INTEGER, defaultValue: 0 },
      used_credit_notes: { type: DataTypes.INTEGER, defaultValue: 0 },
      used_debit_notes: { type: DataTypes.INTEGER, defaultValue: 0 },
      used_eway_bills: { type: DataTypes.INTEGER, defaultValue: 0 },
      used_einvoices: { type: DataTypes.INTEGER, defaultValue: 0 },
      used_gst_filings: { type: DataTypes.INTEGER, defaultValue: 0 },
      used_vendors: { type: DataTypes.INTEGER, defaultValue: 0 },
      used_purchase: { type: DataTypes.INTEGER, defaultValue: 0 },
      used_purchase_orders: { type: DataTypes.INTEGER, defaultValue: 0 },
      used_purchase_invoices: { type: DataTypes.INTEGER, defaultValue: 0 },
      used_items: { type: DataTypes.INTEGER, defaultValue: 0 },
      used_warehouses: { type: DataTypes.INTEGER, defaultValue: 0 },
      used_sms: { type: DataTypes.INTEGER, defaultValue: 0 },
      used_whatsapp: { type: DataTypes.INTEGER, defaultValue: 0 },
      used_email: { type: DataTypes.INTEGER, defaultValue: 0 },

      // ===== LIFECYCLE =====
      auto_renew: { type: DataTypes.BOOLEAN, defaultValue: false },
      renewal_attempts: { type: DataTypes.INTEGER, defaultValue: 0 },
      is_trial: { type: DataTypes.BOOLEAN, defaultValue: false },
      is_grace_period: { type: DataTypes.BOOLEAN, defaultValue: false },
      grace_period_days: { type: DataTypes.INTEGER, defaultValue: 0 },
      enable_priority_support: DataTypes.BOOLEAN,
      cancel_reason: DataTypes.STRING,
      cancelled_at: DataTypes.DATE,
      deactivated_at: DataTypes.DATE,
      activated_by: DataTypes.INTEGER,
      last_usage_at: DataTypes.DATE,

      allowed_module_ids: {
        type: DataTypes.TEXT, 
        allowNull: true,
        defaultValue: null,
        comment: "Snapshot of allowed MenuModuleMaster IDs for this subscription period"
      },

      status: {
        type: DataTypes.SMALLINT,
        defaultValue: 0,
        comment: "0: Active, 1: Expired, 2: Cancelled, 3: Suspended",
      },

      user_id: { type: DataTypes.INTEGER, allowNull: false },
      branch_id: { type: DataTypes.INTEGER, allowNull: true, defaultValue: null },
      company_id: { type: DataTypes.INTEGER, allowNull: false },
    },
    {
      tableName: "company_subscriptions",
      timestamps: true,
      underscored: true,
    }
  );

  CompanySubscription.associate = (models) => {
    CompanySubscription.belongsTo(models.SubscriptionPlan, {
      foreignKey: "subscription_plan_id",
    });
  };

  return CompanySubscription;
};