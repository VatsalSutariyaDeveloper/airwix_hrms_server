const NodeCache = require("node-cache");
const {
    CompanyConfigration,
    CompanySubscription,
    SubscriptionPlan,
    CompanyMaster,
    RoutePermission,
    CompanySettings
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
        const [configs, settings] = await Promise.all([
            CompanyConfigration.findAll({
                where: { company_id: companyId, status: 0 },
                raw: true
            }),
            CompanySettings.findAll({
                where: { company_id: companyId, status: 0 },
                raw: true
            })
        ]);

        const settingsObj = {};
        
        // Load from CompanyConfigration
        for (const c of configs) {
            let val = c.setting_value;
            if (val === "true") val = true;
            else if (val === "false") val = false;
            settingsObj[c.setting_key] = val;
        }

        // Load from CompanySettings (overwrites if collision, which is expected for merged settings)
        for (const s of settings) {
            let val = s.settings_value;
            if (val === "true") val = true;
            else if (val === "false") val = false;
            settingsObj[s.settings_name] = val;
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

const clearAllCompaniesCache = () => {
    settingsCache.flushAll();
};


// ================= SUBSCRIPTION CACHE =================
const reloadCompanySubscriptionCache = async (company_id) => {
    let companyId = Number(company_id);
    if (isNaN(companyId)) return null;

    try {
        const company = await CompanyMaster.findOne({
            where: { id: companyId },
            attributes: ["id", "company_id", "organization_id"],
            raw: true
        });

        if (!company) return null;
        
        let orgId = company.organization_id;
        let whereClause = {};

        if (orgId) {
            whereClause = { organization_id: orgId, status: 0 };
        } else {
            companyId = company.company_id || company.id;
            whereClause = { company_id: companyId, status: 0 };
        }

        const subs = await CompanySubscription.findAll({
            where: whereClause,
            include: [{ model: SubscriptionPlan, as: "subscriptionPlan", attributes: ["subscription_type"] }],
            raw: true,
            nest: true
        });

        if (!subs.length) {
            subscriptionCache.del(`sub_${companyId}`);
            return null;
        }

        subs.sort((a, b) =>
            a.subscriptionPlan.subscription_type === "plan" ? -1 : 1
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
let reloadPromise = null;
let lastReloadAt = 0;
// Once we've reloaded from DB (even if it came back empty), don't hit the DB
// again for every single request that misses the cache - that's what was
// happening when route_permissions had 0 rows: every request re-queried Postgres.
const MIN_RELOAD_INTERVAL_MS = 60 * 1000;

const reloadRoutePermissions = async () => {
    // 1. If a reload is already running, return that existing promise
    if (reloadPromise) {
        console.log('⏳ Cache reload in progress, joining queue...');
        return reloadPromise;
    }

    // 2. Start the reload
    reloadPromise = (async () => {
        try {
            console.log('🔄 Fetching Route Permissions from DB...');
            const routes = await RoutePermission.findAll({
                raw: true,
                attributes: ["method", "path_pattern", "permission_id"]
            });

            console.log(`[Cache] Found ${routes.length} routes in DB.`);

            // 3. Prepare data for Mass Set (mset)
            const formattedRoutes = routes.map(r => ({
                key: `${r.method.toUpperCase()}:${r.path_pattern}`,
                val: r.permission_id
            }));

            // 4. Use mset (Atomic Update).
            // ⚠️ DO NOT USE flushAll() here. It causes downtime.
            // mset overwrites existing keys safely.
            if (formattedRoutes.length > 0) {
                routeCache.mset(formattedRoutes);
                console.log(`✅ Cache Updated Successfully.`);
            }
        } catch (err) {
            console.error("[Cache] Route reload failed", err);
        } finally {
            // 5. Release the lock
            lastReloadAt = Date.now();
            reloadPromise = null;
        }
    })();

    return reloadPromise;
};

const getRoutePermissionId = async (method, path) => {
    const key = `${method.toUpperCase()}:${path}`;

    // 1. Try Cache
    let cached = routeCache.get(key);
    if (cached !== undefined) return cached;

    // 2. Cache Miss - only hit the DB if we haven't just refreshed.
    // Prevents hammering Postgres on every request when a rule is genuinely
    // missing (or the table is empty) and every miss would otherwise reload.
    if (reloadPromise || Date.now() - lastReloadAt > MIN_RELOAD_INTERVAL_MS) {
        console.log(`⚠️ Cache Miss for [${key}]. Reloading...`);
        await reloadRoutePermissions();
    }

    // 3. Retry Cache
    return routeCache.get(key);
};


// ================= EXPORTS =================
module.exports = {
    getCompanySetting,
    reloadCompanySettingsCache,
    clearCompanyCache,
    clearAllCompaniesCache,

    getCompanySubscription,
    reloadCompanySubscriptionCache,
    clearCompanySubscriptionCache,
    clearAllCompanySubscriptionCache,
    updateSubscriptionCache,

    reloadCompanyCache,

    reloadRoutePermissions,
    getRoutePermissionId
};
