// Fire-and-forget alert to Telegram (and/or WhatsApp via CallMeBot) for events that need
// someone to look at the server RIGHT NOW - DB pool exhaustion restarts, hard crashes.
// Never throws: a broken notifier must not take down the app it's supposed to be warning about.

const axios = require("axios");

const sendAlert = async (message) => {
  const text = `🚨 HRMS SERVER ALERT\n${new Date().toLocaleString()}\n\n${message}`;

  // --- Telegram (recommended: free, official, reliable) ---
  // TELEGRAM_CHAT_ID may be a single chat/group ID, or several comma-separated
  // (e.g. one per person) - every ID listed gets the alert.
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChatIds = (process.env.TELEGRAM_CHAT_ID || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (tgToken && tgChatIds.length > 0) {
    await Promise.all(tgChatIds.map(async (chatId) => {
      try {
        await axios.post(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
          chat_id: chatId,
          text
        }, { timeout: 5000 });
      } catch (err) {
        console.error(`[Alert] Telegram notification to ${chatId} failed:`, err.message);
      }
    }));
  }

  // --- WhatsApp via CallMeBot (free, unofficial) ---
  const cmbPhone = process.env.CALLMEBOT_PHONE;
  const cmbApiKey = process.env.CALLMEBOT_APIKEY;
  if (cmbPhone && cmbApiKey) {
    try {
      await axios.get("https://api.callmebot.com/whatsapp.php", {
        params: { phone: cmbPhone, apikey: cmbApiKey, text },
        timeout: 5000
      });
    } catch (err) {
      console.error("[Alert] WhatsApp (CallMeBot) notification failed:", err.message);
    }
  }
};

module.exports = { sendAlert };
