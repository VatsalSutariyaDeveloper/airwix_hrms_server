const axios = require('axios');

const formatMobile = (mobile) => {
  if (!mobile) return null;
  let m = mobile.toString().trim().replace(/^\+/, "");
  if (m.length === 10) m = `91${m}`;
  return m;
};

const sendTemplateSMS = async (mobile, templateId, variables = {}, shouldSendSms = true) => {
  try {
    if (!shouldSendSms) {
      console.log(`[SMS-SERVICE] Skipped sending SMS to ${mobile} (shouldSendSms=false)`);
      return;
    }

    const authKey = process.env.MSG91_AUTH_KEY;
    if (!authKey || !templateId) {
      console.warn('[SMS-SERVICE] MSG91_AUTH_KEY or templateId not configured');
      return;
    }

    const formattedMobile = formatMobile(mobile);
    if (!formattedMobile) return;

    const payload = {
      template_id: templateId,
      short_url: '0',
      recipients: [
        {
          mobiles: formattedMobile,
          ...variables,
        },
      ],
    };

    const res = await axios.post('https://control.msg91.com/api/v5/flow/', payload, {
      headers: {
        authkey: authKey,
        'Content-Type': 'application/json',
      },
    });

    console.log(`[SMS-SERVICE] SMS sent to ${formattedMobile}`, res.data);
    return res.data;
  } catch (err) {
    console.error('[SMS-SERVICE] MSG91 API Error', err?.response?.data || err.message || err);
    throw err;
  }
};

module.exports = {
  sendTemplateSMS,
};
