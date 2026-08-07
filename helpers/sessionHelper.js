const UAParser = require("ua-parser-js");
const geoip = require("geoip-lite");
const { LoginHistory } = require("../models");
const { logError } = require("./functions/logFunctions");

// RFC1918 / loopback / link-local ranges - IP geolocation services can never
// resolve these to a real place, so they must not be reported as a silent
// blank; they get an explicit, honest label instead.
const isPrivateOrLoopbackIp = (ip) => {
  if (!ip) return false;
  return (
    ip === "127.0.0.1" || ip === "::1" ||
    /^10\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip) ||
    /^169\.254\./.test(ip)
  );
};

const isValidIp = (ip) => {
  if (!ip || typeof ip !== "string") return false;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || /^[0-9a-fA-F:]+$/.test(ip);
};

/**
 * Best-effort reverse geocode of real, user-granted GPS coordinates into a
 * city/state/country label. Uses OpenStreetMap Nominatim - free, no API key
 * required, already used as the fallback geocoder elsewhere in this app's
 * frontend (src/components/Map/LocationPicker.tsx). Never throws - a failed
 * lookup just means city/state/country stay null, it must never block login.
 */
const reverseGeocode = async (latitude, longitude) => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(latitude)}&lon=${encodeURIComponent(longitude)}&zoom=10`,
      { headers: { "User-Agent": "AirwixHRMS/1.0 (login-session-tracking)" }, signal: controller.signal }
    );
    clearTimeout(timeout);
    if (!res.ok) return {};
    const data = await res.json();
    const addr = data?.address || {};
    return {
      city: addr.city || addr.town || addr.village || addr.county || null,
      state: addr.state || null,
      country: addr.country || null
    };
  } catch (e) {
    return {};
  }
};

/**
 * Creates a LoginHistory row for a successful user login and returns its id
 * (embedded into the JWT as `session_id` so logout/force-logout/revocation
 * checks can target the exact session instead of guessing).
 *
 * latitude/longitude are the browser/app-granted GPS coordinates - the
 * calling controller has already enforced these are present before a real
 * user login is allowed to proceed. They're the source of truth for
 * location; IP-based geolocation is only used as a fallback if they're ever
 * missing (should not happen for interactive user logins).
 *
 * Device-based logins (attendance/canteen kiosks) don't go through this -
 * they're tracked separately via DeviceMaster.
 */
const createLoginSession = async (user, req, { login_method, company_id, branch_id, access_by, latitude, longitude }) => {
  const hasCoords = latitude !== undefined && latitude !== null && longitude !== undefined && longitude !== null;

  const clientIp = req.body?.client_ip;
  const ip_address =
    (isValidIp(clientIp) ? clientIp : null) ||
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.connection?.remoteAddress ||
    req.ip ||
    "127.0.0.1";

  const parser = new UAParser(req.headers["user-agent"]);
  const uaResult = parser.getResult();

  let locationLabel = { city: null, state: null, country: null };
  if (hasCoords) {
    locationLabel = await reverseGeocode(latitude, longitude);
  } else {
    // Fallback only - real user logins should never reach this branch,
    // the controller-level check requires latitude/longitude up front.
    const isPrivateIp = isPrivateOrLoopbackIp(ip_address);
    if (isPrivateIp) {
      locationLabel = { city: "Private Network", state: null, country: null };
    } else {
      try {
        const geo = geoip.lookup(ip_address) || {};
        locationLabel = { city: geo.city || null, state: geo.region || null, country: geo.country || null };
      } catch (e) {
        locationLabel = {};
      }
    }
  }

  const isApplication = access_by === "application";
  const { device_model, os_version, brand_name } = req.body || {};

  // Only store what's actually applicable to this access type, as real
  // values or null - never a literal "Unknown" filler string. Device
  // model/brand/OS-version are a mobile-app concept (the app sends them
  // explicitly); browser/browser_version/os are a web-browser concept
  // (parsed from the User-Agent). Mixing both onto every row is what was
  // producing "Unknown Unknown Unknown Unknown Unknown" for every login.
  const payload = {
    user_id: user.id,
    in_time: new Date(),
    ip_address,
    browser: isApplication ? null : (uaResult.browser?.name || null),
    browser_version: isApplication ? null : (uaResult.browser?.version || null),
    os: isApplication ? null : (uaResult.os?.name || null),
    city: locationLabel.city || null,
    state: locationLabel.state || null,
    country: locationLabel.country || null,
    latitude: hasCoords ? String(latitude) : null,
    longitude: hasCoords ? String(longitude) : null,
    access_by: access_by || "web login",
    login_method: login_method || null,
    device_type: isApplication ? "mobile" : "web",
    device_model: isApplication ? (device_model || null) : null,
    device_brand: isApplication ? (brand_name || null) : null,
    os_version: isApplication ? (os_version || null) : (uaResult.os?.version || null),
    user_agent: req.headers["user-agent"] || null,
    status: 0,
    branch_id: branch_id || 0,
    company_id: company_id || 0
  };

  try {
    const row = await LoginHistory.create(payload);
    return row.id;
  } catch (err) {
    // Session tracking must never block a real login - but a failure here
    // must not vanish into a console line nobody reads either. Route it
    // through the same audit-log pipeline every other server error uses,
    // so it shows up in System Logs and someone actually finds out.
    console.error("[SessionHelper] Failed to create login session:", err.message);
    try {
      await logError({
        entity_name: "LOGIN_SESSION_TRACKING_FAILED",
        user_id: user.id,
        company_id,
        branch_id,
        error_message: `Failed to record login session for user ${user.id}: ${err.message}`,
        request_body: { attempted: payload },
        stack_trace: { name: err.name, message: err.message, stack: err.stack }
      });
    } catch (logErr) {
      console.error("[SessionHelper] Also failed to write audit log for the failure:", logErr.message);
    }
    return null;
  }
};

module.exports = { createLoginSession };
