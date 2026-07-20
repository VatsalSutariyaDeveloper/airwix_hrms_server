// Watches for repeated DB connection-pool exhaustion (SequelizeConnectionAcquireTimeoutError).
// If it happens too many times within a short window, the worker exits so the cluster
// master (see app.js) can respawn it with a fresh connection pool.

const { sendAlert } = require("./notifyAlert");

const THRESHOLD = 5;              // error count that trips the restart
const WINDOW_MS = 2 * 60 * 1000;  // ...within this rolling time window

let timestamps = [];
let restarting = false;

const reportDbTimeout = (err) => {
  if (!err || err.name !== "SequelizeConnectionAcquireTimeoutError") return;
  if (restarting) return;

  const now = Date.now();
  timestamps.push(now);
  timestamps = timestamps.filter((t) => now - t <= WINDOW_MS);

  console.error(
    `🛡️  [DB Watchdog] Connection pool timeout ${timestamps.length}/${THRESHOLD} in the last ${WINDOW_MS / 1000}s`
  );

  if (timestamps.length >= THRESHOLD) {
    restarting = true;
    console.error(
      `🚨 [DB Watchdog] Threshold reached: ${THRESHOLD} pool timeouts within ${WINDOW_MS / 1000}s. ` +
      `Restarting worker [${process.pid}] to recover the connection pool...`
    );
    sendAlert(
      `DB connection pool exhausted: ${THRESHOLD} timeouts in ${WINDOW_MS / 1000}s.\n` +
      `Worker [${process.pid}] is restarting itself to recover.\n` +
      `If this repeats within minutes, the pool is still under-provisioned or Postgres is I/O-bound - check checkpoint logs.`
    );

    // small delay so the log line above actually flushes before exit
    setTimeout(() => process.exit(1), 500);
  }
};

module.exports = { reportDbTimeout };
