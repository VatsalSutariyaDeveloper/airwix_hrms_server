// const Redis = require("ioredis");

// const redis = new Redis({
//   host: process.env.REDIS_HOST || "127.0.0.1",
//   port: process.env.REDIS_PORT || 6379,
//   retryStrategy: (times) => {
//     const delay = Math.min(times * 50, 2000);
//     return delay;
//   },
//   maxRetriesPerRequest: 3,
// });

// redis.on("connect", () => {
//   console.log("✅ Redis connected successfully");
// });

// redis.on("error", (err) => {
//   console.error("❌ Redis connection error:", err.message);
// });

// redis.on("ready", () => {
//   console.log("✅ Redis is ready to accept commands");
// });

// module.exports = redis;
