const jwt = require("jsonwebtoken");
const { ClientLog } = require("../../models");

// One-time table sync per process (same pattern as apiLogger middleware).
let clientLogSynced = false;
async function ensureSynced() {
  if (clientLogSynced) return;
  try {
    await ClientLog.sync();
    clientLogSynced = true;
  } catch (err) {
    console.error("[CLIENT-LOG] Failed to sync client_logs table:", err.message);
  }
}

/**
 * POST /api/auth/client-log  (auth-skipped)
 *
 * Receives session/diagnostic events from the mobile app (SessionLogger):
 * auto-logouts with their reason, repeated 401s, base-URL switches, errors.
 * The Bearer token — if any — is only DECODED, never required to be valid:
 * the whole point is that the app calls this when its session is dying.
 *
 * Always answers 200 so a logging failure can never disturb the app.
 */
exports.store = async (req, res) => {
  try {
    await ensureSynced();

    const body = req.body || {};

    // Attribute the log to a user/device from the token when present.
    let decoded = null;
    let tokenValid = null;
    const authHeader = req.headers.authorization;
    if (authHeader) {
      const token = authHeader.split(" ")[1];
      if (token) {
        decoded = jwt.decode(token);
        try {
          jwt.verify(token, process.env.JWT_SECRET);
          tokenValid = true;
        } catch (verifyErr) {
          tokenValid = false;
        }
      }
    }

    const toInt = (v) => {
      const n = parseInt(v, 10);
      return Number.isNaN(n) ? null : n;
    };

    const row = {
      company_id: decoded?.company_id ?? null,
      branch_id: decoded?.branch_id ?? null,
      user_id: toInt(body.user_id) ?? decoded?.id ?? null,
      employee_id: toInt(body.employee_id) ?? decoded?.employee_id ?? null,
      event: String(body.event || "unknown").slice(0, 50),
      reason: body.reason ?? null,
      endpoint: body.endpoint ?? null,
      status_code: toInt(body.status_code),
      server_message: body.server_message ?? null,
      base_url: body.base_url ?? null,
      is_erp: typeof body.is_erp === "boolean" ? body.is_erp : null,
      access: body.access ?? decoded?.access ?? null,
      device_id: decoded?.device_id ?? null,
      token_valid: tokenValid,
      app_version: body.app_version ?? null,
      device_os: body.device_os ?? null,
      device_brand: body.device_brand ?? null,
      device_model: body.device_model ?? null,
      ip_address:
        req.headers["x-forwarded-for"]?.split(",")[0] ||
        req.connection?.remoteAddress ||
        req.ip ||
        null,
      client_time: body.client_time ? new Date(body.client_time) : null,
      payload: body,
    };

    try {
      await ClientLog.create(row);
    } catch (err) {
      // A table created by an older build may still carry foreign keys on
      // user_id/company_id. Those ids come from a token that can reference a
      // user/company absent from THIS server (the wrong-backend case), so the
      // insert would be rejected exactly when the log matters most. Retry
      // without them — `payload` still holds the original values verbatim.
      if (err?.name === "SequelizeForeignKeyConstraintError") {
        console.warn("[CLIENT-LOG] FK constraint hit; retrying with ids detached (values preserved in payload).");
        await ClientLog.create({ ...row, user_id: null, employee_id: null, company_id: null, branch_id: null });
      } else {
        throw err;
      }
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("[CLIENT-LOG] Failed to store client log:", err.message);
    // Still 200: the app fires-and-forgets; an error here must not matter.
    return res.status(200).json({ success: false });
  }
};
