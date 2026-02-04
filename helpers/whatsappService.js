const axios = require('axios');

/**
 * WhatsApp Service helper to handle automated system notifications via WhatsApp.
 */

// Toggle this to false when connecting to a real WhatsApp API Provider (e.g. Twilio, Interakt, etc.)
const IS_DEV_MODE = process.env.NODE_ENV !== 'production';

/**
 * Low-level function to send a message.
 * @param {string} mobile_no - Recipient mobile number (with country code)
 * @param {string} message - Message body
 */
const sendWhatsappMessage = async (mobile_no, message) => {
    if (IS_DEV_MODE) {
        console.log(`\n--- [WHATSAPP DEV LOG] ---`);
        console.log(`To: ${mobile_no}`);
        console.log(`Message: ${message}`);
        console.log(`--------------------------\n`);
        return { success: true, message: "Logged message in Dev Mode" };
    }

    try {
        /**
         * TODO: Integrate with your chosen WhatsApp API Provider.
         * Example (Generic):
         * 
         * const response = await axios.post(process.env.WHATSAPP_API_URL, {
         *     apiKey: process.env.WHATSAPP_API_KEY,
         *     to: mobile_no,
         *     body: message
         * });
         * return { success: true, data: response.data };
         */

        console.warn("WhatsApp Service: Production mode is active but no API provider is configured.");
        return { success: false, message: "No WhatsApp API Provider configured." };
    } catch (error) {
        console.error("WhatsApp Service Error:", error.message);
        return { success: false, message: error.message };
    }
};

/**
 * Specifically sends the invitation/setup link to a new employee.
 * @param {object} employee - Employee database record
 * @param {string} setupLink - Generated setup link (magic link)
 */
const sendInvitationLink = async (employee, setupLink) => {
    if (!employee || !employee.mobile_no) {
        return { success: false, message: "Missing employee contact details." };
    }

    const firstName = employee.first_name || "there";
    const message = `Hello ${firstName},

Welcome to Airwix HRMS! Your account has been created.

Please use this link to set up your password and access the portal:
${setupLink}

Note: This link is valid for 24 hours.

Best regards,
HR Team`;

    return await sendWhatsappMessage(employee.mobile_no, message);
};

module.exports = {
    sendWhatsappMessage,
    sendInvitationLink
};
