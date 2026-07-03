const express = require("express");
const path = require("path");
const cors = require("cors");
const dotenv = require("dotenv");
const http = require("http");
const os = require("os");
const cluster = require("cluster");

dotenv.config({ path: ".env" });

const { initCronJobs } = require("./jobs/cronJobs");
const { handleError } = require("./helpers");

// ==========================================
// 1. CLUSTER MASTER LOGIC (SELF-HEALING)
// ==========================================
if (cluster.isMaster) {
  console.log(`🛡️  Master Process [${process.pid}] is running.`);

  // Fork the first worker
  const worker = cluster.fork();

  // Listen for worker deaths (crashes)
  cluster.on("exit", (worker, code, signal) => {
    console.error(`💀 Worker Process [${worker.process.pid}] died (Code: ${code}, Signal: ${signal})`);
    console.log("♻️  Self-Healing: Spawning new worker process instantly...");
    cluster.fork();
  });

  // Global listeners for the Master process itself
  process.on("unhandledRejection", (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    console.error("💀 [HIGH RISK] MASTER UNHANDLED REJECTION:", error);
    handleError(error, null, null, true);
  });

  process.on("uncaughtException", async (err) => {
    console.error("💀 [HIGH RISK] MASTER UNCAUGHT EXCEPTION:", err);
    await handleError(err, null, null, true);
    setTimeout(() => process.exit(1), 1000);
  });

} else {
  // ==========================================
  // 2. WORKER PROCESS LOGIC (EXPRESS APP)
  // ==========================================
  console.log(`🚀 Worker Process [${process.pid}] started.`);

  const db = require("./models");
  const { tenantMiddleware } = require("./middlewares/tenantMiddleware");
  const responseFormatter = require("./middlewares/responseFormatter");
  const errorHandler = require("./middlewares/errorHandler");
  const settingsRoutes = require("./routes/settingsRoutes");
  const administrationRoutes = require("./routes/administrationRoutes");
  const authRoutes = require("./routes/authRoutes");
  const dashboardRoutes = require("./routes/dashboardRoutes");
  const subscriptionRoutes = require("./routes/subscriptionRoutes");
  const checkPermission = require("./middlewares/checkPermission");
  const { updateCurrencyRates } = require("./services/currencyUpdateService");
  const { normalizeNullValues } = require("./middlewares/normalizeNullValues");
  const attendanceRoutes = require("./routes/attendanceRoutes");
  const employeeRoutes = require("./routes/employeeRoutes");
  const payrollRoutes = require("./routes/payrollRoutes");
  const canteenAttendanceRoutes = require("./routes/canteenAttendanceRoutes");
  const resignationRoutes = require("./routes/resignationRoutes");
  const onboardingRoutes = require("./routes/onboardingRoutes");
  const systemLogRoutes = require("./routes/systemLogRoutes");
  const reportsRoutes = require("./routes/reportsRoutes");
  const announcementRoutes = require("./routes/announcementRoutes");
  const notificationRoutes = require("./routes/notificationRoutes");
  const hrDashboardRoutes = require("./routes/hrDashboardRoutes");
  const masterAdminRoutes = require("./routes/masterAdminRoutes");
  const visitorRoutes = require("./routes/visitorRoutes");

  const app = express();
  const { requestContext } = require("./utils/requestContext.js");
  app.use((req, res, next) => {
    requestContext.run(
      {
        userId: null,
        companyId: null,
        branchId: null,
        ip: req.headers["x-forwarded-for"] || req.connection.remoteAddress || req.ip,
        userAgent: req.headers["user-agent"] || "unknown",
        endpoint: `${req.method} ${req.originalUrl}`,
        access: "public"
      },
      () => next()
    );
  });
  const { authMiddleware } = require("./middlewares/authMiddleware");
  const server = http.createServer(app);

  app.use(responseFormatter);
  app.use(tenantMiddleware);
  app.use(cors());
  app.use(express.json({ limit: "500mb" }));

  app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
      console.error(`🚨 JSON Parsing Error: ${err.message} from IP: ${req.ip}`);
      return res.status(400).json({ success: false, message: "Malformed JSON payload: " + err.message });
    }
    next();
  });

  app.use(express.urlencoded({ extended: true, limit: "500mb" }));
  app.use("/uploads", express.static(path.join(__dirname, "uploads")));
  app.use(normalizeNullValues);

  app.use((req, res, next) => {
    res.setTimeout(1000 * 1000, () => {
      console.warn(`⚠️ Request timed out: ${req.method} ${req.originalUrl}`);
      if (!res.headersSent) {
        res.status(500).json({ status: false, message: "Internal Server Error: Request Timeout", data: null });
      }
    });
    next();
  });

  const apiLogger = require("./middlewares/apiLogger");
  app.use(apiLogger);
  app.use(responseFormatter);
  app.use("/api/auth", authRoutes);
  // Master Admin routes — use their own authentication (X-Master-Admin-Key header)
  app.use("/api/master-admin", masterAdminRoutes);
  app.use(authMiddleware);
  app.use(checkPermission);

  app.use("/api/dashboard", dashboardRoutes);
  app.use("/api/hr-dashboard", hrDashboardRoutes);
  app.use("/api/settings", settingsRoutes);
  app.use("/api/administration", administrationRoutes);
  app.use("/api/subscription", subscriptionRoutes);
  app.use("/api/attendance", attendanceRoutes);
  app.use("/api/canteen-attendance", canteenAttendanceRoutes);
  app.use("/api/employee", employeeRoutes);
  app.use("/api/payroll", payrollRoutes);
  app.use("/api/resignation", resignationRoutes);
  app.use("/api/onboarding", onboardingRoutes);
  app.use("/api/reports", reportsRoutes);
  app.use("/api/system-logs", systemLogRoutes);
  app.use("/api/announcements", announcementRoutes);
  app.use("/api/notifications", notificationRoutes);
  app.use("/api/visitor", visitorRoutes);

  // 🔍 404 JSON Fallback Handler for undefined routes
  app.use((req, res, next) => {
    res.status(404).json({
      success: false,
      code: "NOT_FOUND",
      message: `Cannot ${req.method} ${req.originalUrl}. Route not found.`
    });
  });

  app.use(errorHandler);

  app.get("/force-currency-update", async (req, res) => {
    console.log("Manually triggering currency update...");
    await updateCurrencyRates();
    res.status(200).send("Currency update process triggered successfully.");
  });

  const startServer = () => {
    server.setTimeout(50 * 1000);
    const PORT = process.env.PORT || 5000;
    const HOST = "0.0.0.0";
    server.listen(PORT, HOST, () => {
      const ip = getServerIP();
      console.log(`🚀 Server running on http://${ip}:${PORT}`);
    });
  };

  const DB_SYNC_ENABLED = process.env.DB_SYNC === "true";
  if (DB_SYNC_ENABLED) {
    const { createConnectionByPrefix } = require("./config/database");
    const prefixes = Object.keys(process.env).filter(key => key.endsWith('_DB_NAME')).map(key => key.replace('_DB_NAME', ''));
    if (process.env.DB_NAME && !prefixes.includes('')) prefixes.push('');

    console.log(`🛠️  DB_SYNC is ENABLED. Syncing ${prefixes.length} environments...`);
    Promise.all(prefixes.map(prefix => createConnectionByPrefix(prefix).sync()))
      .then(() => {
        console.log("✅ Database checks complete.");
        startServer();
      })
      .catch((err) => {
        console.error("❌ Database sync failed:", err.message);
        process.exit(1);
      });
  } else {
    console.log("ℹ️  DB_SYNC is DISABLED. Skipping table checks.");
    startServer();
  }

  initCronJobs();

  // WORKER Error Catchers
  process.on("unhandledRejection", (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    console.error("💀 [HIGH RISK] WORKER UNHANDLED REJECTION:", error);
    handleError(error, null, null, true);
  });

  process.on("uncaughtException", async (err) => {
    console.error("💀 [HIGH RISK] WORKER UNCAUGHT EXCEPTION:", err);
    try {
      await handleError(err, null, null, true);
      console.log("✅ Worker crash recorded. Restarting via cluster master...");
    } catch (logErr) {
      console.error("❌ Failed to log worker crash.");
    } finally {
      process.exit(1); // Master will fork a new worker
    }
  });

  function getServerIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const net of interfaces[name]) {
        if (net.family === "IPv4" && !net.internal) return net.address;
      }
    }
    return "localhost";
  }
}
