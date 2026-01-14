const NodeCache = require("node-cache");
const {
    CompanyConfigration,
    CompanySubscription,
    SubscriptionPlan,
    CompanyMaster,
    RoutePermission
} = require("../models");

// ================= CACHE INSTANCES =================
const settingsCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });
const subscriptionCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });
const routeCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });


// ================= SETTINGS CACHE =================
const reloadCompanySettingsCache = async (company_id) => {
    const companyId = Number(company_id);
    if (isNaN(companyId)) return null;

    try {
        const settings = await CompanyConfigration.findAll({
            where: { company_id: companyId, status: 0 },
            raw: true
        });

        const settingsObj = {};
        for (const s of settings) {
            let val = s.setting_value;
            if (val === "true") val = true;
            else if (val === "false") val = false;

            settingsObj[s.setting_key] = val;
        }

        settingsCache.set(`settings_${companyId}`, settingsObj);
        return settingsObj;
    } catch (err) {
        console.error(`[Cache] Settings reload failed: ${companyId}`, err);
        return null;
    }
};

const getCompanySetting = async (company_id) => {
    const companyId = Number(company_id);
    if (isNaN(companyId)) return {};

    const key = `settings_${companyId}`;
    const cached = settingsCache.get(key);
    if (cached) return cached;

    await reloadCompanySettingsCache(companyId);
    return settingsCache.get(key) || {};
};

const clearCompanyCache = (company_id) => {
    settingsCache.del(`settings_${Number(company_id)}`);
};


// ================= SUBSCRIPTION CACHE =================
const reloadCompanySubscriptionCache = async (company_id) => {
    let companyId = Number(company_id);
    if (isNaN(companyId)) return null;

    try {
        const company = await CompanyMaster.findOne({
            where: { id: companyId },
            attributes: ["id", "company_id"],
            raw: true
        });

        if (!company) return null;
        companyId = company.company_id || company.id;

        const subs = await CompanySubscription.findAll({
            where: { company_id: companyId, status: 0 },
            include: [{ model: SubscriptionPlan, attributes: ["subscription_type"] }],
            raw: true,
            nest: true
        });

        if (!subs.length) {
            subscriptionCache.del(`sub_${companyId}`);
            return null;
        }

        subs.sort((a, b) =>
            a.SubscriptionPlan.subscription_type === "plan" ? -1 : 1
        );

        let mergedSub = { ...subs[0] };
        const allowedSet = new Set(
            String(mergedSub.allowed_module_ids || "")
                .split(",")
                .map(id => id.trim())
                .filter(Boolean)
        );

        for (let i = 1; i < subs.length; i++) {
            const addon = subs[i];

            mergedSub.users_limit += addon.users_limit || 0;
            mergedSub.used_users += addon.used_users || 0;
            mergedSub.companies_limit += addon.companies_limit || 0;
            mergedSub.used_companies += addon.used_companies || 0;
            mergedSub.sms_limit += addon.sms_limit || 0;
            mergedSub.bank_accounts_limit += addon.bank_accounts_limit || 0;
            mergedSub.whatsapp_limit += addon.whatsapp_limit || 0;
            mergedSub.email_limit += addon.email_limit || 0;

            mergedSub.enable_sms = mergedSub.enable_sms || addon.enable_sms;
            mergedSub.enable_email = mergedSub.enable_email || addon.enable_email;
            mergedSub.enable_whatsapp = mergedSub.enable_whatsapp || addon.enable_whatsapp;

            if (addon.allowed_module_ids) {
                addon.allowed_module_ids
                    .split(",")
                    .map(id => id.trim())
                    .filter(Boolean)
                    .forEach(id => allowedSet.add(id));
            }
        }

        mergedSub.allowed_module_ids = [...allowedSet].join(",");
        subscriptionCache.set(`sub_${companyId}`, mergedSub);
        return mergedSub;

    } catch (err) {
        console.error(`[Cache] Subscription reload failed: ${companyId}`, err);
        return null;
    }
};

const getCompanySubscription = async (company_id) => {
    const companyId = Number(company_id);
    if (isNaN(companyId)) return null;

    const key = `sub_${companyId}`;
    const cached = subscriptionCache.get(key);
    if (cached) return cached;

    await reloadCompanySubscriptionCache(companyId);
    return subscriptionCache.get(key);
};

const clearCompanySubscriptionCache = (company_id) => {
    subscriptionCache.del(`sub_${Number(company_id)}`);
};

const clearAllCompanySubscriptionCache = () => {
    subscriptionCache.flushAll();
};

const updateSubscriptionCache = (company_id, field, by = 1) => {
    const companyId = Number(company_id);
    const cached = subscriptionCache.get(`sub_${companyId}`);
    if (!cached) return;

    const key = `used_${field}`;
    if (cached[key] !== undefined) {
        cached[key] += by;
        subscriptionCache.set(`sub_${companyId}`, cached);
    }
};


// ================= COMPANY MASTER RELOAD =================
const reloadCompanyCache = async (company_id) => {
    await reloadCompanySettingsCache(company_id);
    await reloadCompanySubscriptionCache(company_id);
    return true;
};


// ================= ROUTE PERMISSION CACHE =================
const reloadRoutePermissions = async () => {
    try {
        const routes = await RoutePermission.findAll({
            raw: true,
            attributes: ["method", "path_pattern", "permission_id"]
        });

        routeCache.flushAll();

        routes.forEach(r => {
            routeCache.set(
                `${r.method.toUpperCase()}:${r.path_pattern}`,
                r.permission_id
            );
        });
    } catch (err) {
        console.error("[Cache] Route reload failed", err);
    }
};

const getRoutePermissionId = async (method, path) => {
    const key = `${method.toUpperCase()}:${path}`;
    const cached = routeCache.get(key);
    if (cached !== undefined) return cached;

    await reloadRoutePermissions();
    return routeCache.get(key);
};


// ================= EXPORTS =================
module.exports = {
    getCompanySetting,
    reloadCompanySettingsCache,
    clearCompanyCache,

    getCompanySubscription,
    reloadCompanySubscriptionCache,
    clearCompanySubscriptionCache,
    clearAllCompanySubscriptionCache,
    updateSubscriptionCache,

    reloadCompanyCache,

    reloadRoutePermissions,
    getRoutePermissionId
};
