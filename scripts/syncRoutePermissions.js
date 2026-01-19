const express = require('express');
require("dotenv").config({ path: ".env.local", override: true });
require("dotenv").config({ path: ".env" });
const { RoutePermission, Permission, ModuleMaster, ModuleEntityMaster, sequelize } = require('../models');
const path = require('path');
const fs = require('fs');

// Mock application to capture routes
const app = express();

// Import all routes
const authRoutes = require("../routes/authRoutes");
const dashboardRoutes = require("../routes/dashboardRoutes");
const settingsRoutes = require("../routes/settingsRoutes");
const administrationRoutes = require("../routes/administrationRoutes");
const subscriptionRoutes = require("../routes/subscriptionRoutes");
const attendanceRoutes = require("../routes/attendanceRoutes");
const employeeRoutes = require("../routes/employeeRoutes");

// Register routes with prefixes (matching app.js)
app.use("/auth", authRoutes);
app.use("/dashboard", dashboardRoutes);
app.use("/settings", settingsRoutes);
app.use("/administration", administrationRoutes);
app.use("/subscription", subscriptionRoutes);
app.use("/attendance", attendanceRoutes);
app.use("/employee", employeeRoutes);

function split(thing) {
    if (typeof thing === 'string') {
        return thing.split('/');
    } else if (thing.fast_slash) {
        return '';
    } else {
        var match = thing.toString()
            .replace('\\/?', '')
            .replace('(?=\\/|$)', '$')
            .match(/^\/\^\\\/([^\$]*)\\\$/);
        return match
            ? match[1].replace(/\\/g, '/')
            : thing.toString();
    }
}

function getRoutes(stack, prefix = '') {
    const routes = [];

    stack.forEach((middleware) => {
        if (middleware.route) {
            // It's a direct route
            const path = prefix + middleware.route.path;
            const methods = Object.keys(middleware.route.methods).map(m => m.toUpperCase());
            methods.forEach(method => {
                routes.push({ method, path });
            });
        } else if (middleware.name === 'router') {
            // It's a sub-router
            const newPrefix = prefix + split(middleware.regexp);
            routes.push(...getRoutes(middleware.handle.stack, newPrefix));
        }
    });

    return routes;
}

async function sync() {
    try {
        console.log("🚀 Starting Route Permission Sync...");

        // 1. Get all routes from Routers directly
        const routeConfigs = [
            { prefix: "/auth", router: authRoutes },
            { prefix: "/dashboard", router: dashboardRoutes },
            { prefix: "/settings", router: settingsRoutes },
            { prefix: "/administration", router: administrationRoutes },
            { prefix: "/subscription", router: subscriptionRoutes },
            { prefix: "/attendance", router: attendanceRoutes },
            { prefix: "/employee", router: employeeRoutes },
        ];

        const allRoutes = [];
        routeConfigs.forEach(config => {
            if (config.router && config.router.stack) {
                allRoutes.push(...getRoutes(config.router.stack, config.prefix));
            }
        });

        console.log(`🔍 Found ${allRoutes.length} routes in the application.`);

        // 2. Fetch all existing permissions, modules, and entities for mapping
        const permissions = await Permission.findAll({
            include: [
                { model: ModuleMaster, as: 'module' },
                { model: ModuleEntityMaster, as: 'entity' }
            ]
        });

        const entities = await ModuleEntityMaster.findAll({
            include: [{ model: ModuleMaster, as: 'moduleMaster' }]
        });

        const existingRoutePerms = await RoutePermission.findAll();
        const existingMap = new Set(existingRoutePerms.map(rp => `${rp.method}:${rp.path_pattern}`));

        let createdCount = 0;
        let skippedCount = 0;

        for (const route of allRoutes) {
            const key = `${route.method}:${route.path}`;
            if (existingMap.has(key)) {
                skippedCount++;
                continue;
            }

            // Attempt to find a matching permission
            let suggestedPermission = null;
            
            // Heuristic mapping
            const actionMap = {
                'GET': 'view',
                'POST': 'create',
                'PUT': 'edit',
                'PATCH': 'edit',
                'DELETE': 'delete'
            };

            const defaultAction = actionMap[route.method] || 'view';
            
            // 1. Try matching by entity_url
            const cleanPath = route.path.startsWith('/') ? route.path.substring(1) : route.path;
            
            // Find entity whose URL is a prefix of this route
            // Sort by length descending to match most specific first
            const matchingEntity = entities
                .filter(e => e.entity_url && (cleanPath === e.entity_url || cleanPath.startsWith(e.entity_url + '/')))
                .sort((a, b) => b.entity_url.length - a.entity_url.length)[0];

            if (matchingEntity) {
                // Now find the permission for this entity and action
                const pathParts = route.path.split('/').filter(p => p && !p.startsWith(':'));
                let actPart = defaultAction;

                // Special case for common patterns in my app
                const lastPart = pathParts[pathParts.length - 1];
                if (lastPart === 'get-transactions' || lastPart === 'get-transaction') actPart = 'view';
                else if (lastPart === 'dropdown-list') actPart = 'view';
                else if (lastPart === 'status' || lastPart === 'update-status') actPart = 'edit';
                else if (lastPart === 'add-permission' || lastPart === 'add' || lastPart === 'create') actPart = 'create';
                
                suggestedPermission = permissions.find(p => 
                    p.entity_id === matchingEntity.id && 
                    p.action.toLowerCase() === actPart.toLowerCase()
                );

                if (!suggestedPermission && actPart !== defaultAction) {
                    // Try default action if specialized didn't work
                    suggestedPermission = permissions.find(p => 
                        p.entity_id === matchingEntity.id && 
                        p.action.toLowerCase() === defaultAction.toLowerCase()
                    );
                }
            }

            // 2. Fallback to slug matching (original logic)
            if (!suggestedPermission) {
                const pathParts = route.path.split('/').filter(p => p && !p.startsWith(':'));
                if (pathParts.length >= 2) {
                    const modPart = pathParts[0].toLowerCase().replace(/[^a-z0-9]/g, '');
                    const entPart = pathParts[1].toLowerCase().replace(/[^a-z0-9]/g, '');
                    let actPart = pathParts.length >= 3 ? pathParts[2].toLowerCase().replace(/[^a-z0-9]/g, '') : defaultAction;
                    
                    if (actPart === 'gettransactions' || actPart === 'gettransaction') actPart = 'view';
                    if (actPart === 'dropdownlist') actPart = 'view';
                    if (actPart === 'status') actPart = 'edit';

                    const possibleSlug = `${modPart}.${entPart}.${actPart}`;
                    suggestedPermission = permissions.find(p => p.slug === possibleSlug);
                }
            }

            if (suggestedPermission) {
                console.log(`➕ Mapping [${route.method}] ${route.path} -> Permission: ${suggestedPermission.slug} (ID: ${suggestedPermission.id})`);
                await RoutePermission.create({
                    method: route.method,
                    path_pattern: route.path,
                    permission_id: suggestedPermission.id,
                    status: 0
                });
                createdCount++;
            } else {
                console.warn(`⚠️ Could not auto-map [${route.method}] ${route.path}. No matching permission found.`);
            }
        }

        console.log("\n✅ Sync Completed!");
        console.log(`- Created: ${createdCount}`);
        console.log(`- Skipped (Exist): ${skippedCount}`);
        console.log(`- Unmapped: ${allRoutes.length - createdCount - skippedCount}`);

    } catch (error) {
        console.error("❌ Sync Failed:", error);
    } finally {
        process.exit();
    }
}

sync();
