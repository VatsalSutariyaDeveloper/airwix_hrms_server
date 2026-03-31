const express = require("express");
const path = require("path");
const cors = require("cors");
const dotenv = require("dotenv");
const http = require("http");
const os = require("os");
dotenv.config({ path: ".env" });
// const { initSocket } = require('./socket');
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
const { updateCurrencyRates } = require("./services/currencyUpdateService"); // Adjust path
const { normalizeNullValues } = require("./middlewares/normalizeNullValues");
const attendanceRoutes = require("./routes/attendanceRoutes");
const employeeRoutes = require("./routes/employeeRoutes");
const payrollRoutes = require("./routes/payrollRoutes");
const canteenAttendanceRoutes = require("./routes/canteenAttendanceRoutes");
const resignationRoutes = require("./routes/resignationRoutes");
const onboardingRoutes = require("./routes/onboardingRoutes");
const systemLogRoutes = require("./routes/systemLogRoutes");
const { initCronJobs } = require("./jobs/cronJobs");
const reportsRoutes = require("./routes/reportsRoutes");
// const decryptRequest = require("./middlewares/decryptRequest");
// const { decryptId } = require('./helpers/cryptoHelper');

const app = express();
const { authMiddleware } = require("./middlewares/authMiddleware");
// Create the HTTP server instance using your Express app
const server = http.createServer(app);

// Initialize Socket.IO and pass it the http server instance
// initSocket(server);

app.use(responseFormatter);
app.use(tenantMiddleware);
app.use(cors());
app.use(express.json());
// Catch and handle JSON parsing errors
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error(`🚨 JSON Parsing Error: ${err.message} from IP: ${req.ip}`);
    return res.status(400).json({
      success: false,
      message: "Malformed JSON payload: " + err.message
    });
  }
  next();
});
app.use(express.urlencoded({ extended: true }));
// app.use(decryptRequest);
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use(normalizeNullValues);
// app.use(decryptMiddleware);
// Set a 30-second timeout for all requests
app.use((req, res, next) => {
  // Set response timeout
  res.setTimeout(1000 * 1000, () => {
    console.warn(`⚠️ Request timed out: ${req.method} ${req.originalUrl}`);
    if (!res.headersSent) {
      res.status(500).json({
        status: false,
        message: "Internal Server Error: Request Timeout",
        data: null,
      });
    }
  });
  next();
});

const apiLogger = require("./middlewares/apiLogger");
app.use(apiLogger);
app.use(responseFormatter);
app.use("/api/auth", authRoutes);

app.use(authMiddleware);
app.use(checkPermission);

// Load master routes
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/hr-dashboard", require("./routes/hrDashboardRoutes"));
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
app.use(errorHandler);

// FOR PRODUCTION DO NOT REMOVE THIS
// cron.schedule('0 0 * * *', () => {
//   console.log('🕒 Running scheduled currency update...');
//   updateCurrencyRates();
// });

// FOR LOCAL TESTING AND WITH MANUAL TRIGGER
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
  
  // Find all prefixes that have a _DB_NAME entry in env
  const prefixes = Object.keys(process.env)
    .filter(key => key.endsWith('_DB_NAME'))
    .map(key => key.replace('_DB_NAME', ''));

  // Always include the default (no prefix) if it exists
  if (process.env.DB_NAME && !prefixes.includes('')) {
    prefixes.push('');
  }

  console.log(`🛠️  DB_SYNC is ENABLED. Syncing ${prefixes.length} database environments: ${prefixes.join(', ') || 'Default'}`);

  Promise.all(prefixes.map(prefix => createConnectionByPrefix(prefix).sync()))
    .then(() => {
      console.log("✅ All database checks complete (new tables created if missing)");
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

// Initialize Cron Jobs
initCronJobs();

function getServerIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      // IPv4, non-internal (not 127.0.0.1)
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return "localhost";
}
