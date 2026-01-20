const express = require("express");
const path = require("path");
const cors = require("cors");
const dotenv = require("dotenv");
const http = require("http");
const os = require("os");

dotenv.config({ path: ".env.local", override: true });
dotenv.config({ path: ".env" });
// const { initSocket } = require('./socket');
const db = require("./models");
const cron = require('node-cron');
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
const { archiveAndCleanupLogs } = require('./helpers');
const attendanceRoutes = require("./routes/attendanceRoutes");
const employeeRoutes = require("./routes/employeeRoutes");
const holidayRoutes = require("./routes/holidayRoutes");
// const decryptRequest = require("./middlewares/decryptRequest");
// const { decryptId } = require('./helpers/cryptoHelper');

const app = express();
const connectMongoDB = require('./config/mongo');
const decryptMiddleware = require("./middlewares/decryptMiddleware");
const { decrypt } = require("./helpers/crypto");
const { authMiddleware } = require("./middlewares/authMiddleware");
// Create the HTTP server instance using your Express app
const server = http.createServer(app);

// Initialize Socket.IO and pass it the http server instance
// initSocket(server);

app.use(cors());
app.use(express.json());
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

app.use(responseFormatter);
app.use("/auth", authRoutes);

app.use(authMiddleware);
app.use(checkPermission);

// Load master routes
app.use("/dashboard", dashboardRoutes);
app.use("/settings", settingsRoutes);
app.use("/administration", administrationRoutes);
app.use("/subscription", subscriptionRoutes);
app.use("/attendance", attendanceRoutes);
app.use("/employee", employeeRoutes);
app.use("/holiday", holidayRoutes);
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

// Promise.all([
//   db.sequelize.sync({ alter: false, force: false }),
// ])
//   .then(async () => {
    console.log("✅ Both databases synced");

    // Load entity constants from database

    server.setTimeout(50 * 1000);

    const PORT = process.env.PORT || 5000;
    const HOST = "0.0.0.0";

    server.listen(PORT, HOST, () => {
      const ip = getServerIP();
      console.log(`🚀 Server running on http://${ip}:${PORT}`);
    });
  // })
  // .catch((err) => {
  //   console.error("❌ Failed to sync databases:", err);
  // });

cron.schedule('0 0 * * *', async () => {
  console.log('⏰ Running daily log cleanup task...');
  try {
    await archiveAndCleanupLogs(90); // Keep 90 days of logs
    console.log('✅ Log cleanup completed.');
  } catch (error) {
    console.error('❌ Log cleanup failed:', error);
  }
});

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
