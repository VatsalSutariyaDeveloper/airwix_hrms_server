const NodeCache = require("node-cache");
const { LoginHistory } = require("../models");

// Short TTL, process-local cache for session-validity checks. This app runs
// as a cluster (multiple worker processes) with no Redis, so a force-logout
// on one worker becomes visible to the others within this TTL window rather
// than instantly - the same eventual-consistency tradeoff already accepted
// elsewhere in this codebase (see helpers/cache.js's settings cache).
const sessionValidityCache = new NodeCache({ stdTTL: 10, checkperiod: 15 });

const isSessionValid = async (session_id) => {
  if (!session_id) return true; // no session tracked (legacy token / device token) - not our concern

  const key = `session_${session_id}`;
  const cached = sessionValidityCache.get(key);
  if (cached !== undefined) return cached;

  let valid = false;
  try {
    const row = await LoginHistory.findByPk(session_id, { attributes: ["status", "out_time"] });
    valid = !!row && row.status === 0 && row.out_time === null;
  } catch (err) {
    console.error("[SessionCache] Failed to validate session:", err.message);
    valid = true; // fail open - a DB blip must not lock every logged-in user out
  }

  sessionValidityCache.set(key, valid);
  return valid;
};

const clearSessionCache = (session_id) => {
  if (!session_id) return;
  sessionValidityCache.del(`session_${session_id}`);
};

module.exports = { isSessionValid, clearSessionCache };
