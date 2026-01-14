// // middlewares/rateLimiter.js
// const rateLimit = require("express-rate-limit");

// const apiLimiter = rateLimit({
//   windowMs: 15 * 60 * 1000, // 15 minutes
//   max: 100, // Limit each IP to 100 requests per windowMs
//   // standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
//   // legacyHeaders: false, // Disable the `X-RateLimit-*` headers
//   keyGenerator: (req) => {
//      if (req.body?.user_id || req.user?.user_id) {
//       return `user-${req.body.user_id || req.user.user_id}`;
//     }

//     // Fallback to IP if unauthenticated
//     return req.ip;
//   },
//   message: {
//     status: false,
//     message: "Too many requests, please try again after 15 minutes.",
//   },
// });

// module.exports = apiLimiter;
