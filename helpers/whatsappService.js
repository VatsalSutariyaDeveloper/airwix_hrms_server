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
    // 1. Check if we are in Dev Mode (Logs to console instead of sending real API requests)
    if (IS_DEV_MODE && !process.env.WHATSAPP_API_URL) {
        console.log(`\n--- [WHATSAPP DEV LOG] ---`);
        console.log(`To: ${mobile_no}`);
        console.log(`Message: ${message}`);
        console.log(`--------------------------\n`);
        return { success: true, message: "Logged message in Dev Mode" };
    }

    try {
        /**
         * Generic Implementation for automated WhatsApp sending.
         * Common providers like UltraMsg, Green-API, or local gateways use this simple POST structure.
         */
        const apiUrl = process.env.WHATSAPP_API_URL; // e.g., https://api.ultramsg.com/instanceXXXX/messages/chat
        const apiKey = process.env.WHATSAPP_API_KEY; // Your secret token/key

        if (!apiUrl || !apiKey) {
            console.warn("WhatsApp Service: No API URL or Key configured in .env.");
            return { success: false, message: "WhatsApp API is not configured." };
        }

        const response = await axios.post(apiUrl, {
            token: apiKey,  // Some providers use 'token'
            to: mobile_no,
            body: message
        });

        // Check for common 'sent' status in third party APIs
        if (response.data && (response.data.sent === "true" || response.data.error === false || response.status === 200)) {
            return { success: true, data: response.data };
        }

        return { success: false, message: "Failed to send message via gateway.", data: response.data };
    } catch (error) {
        console.error("WhatsApp Service Error:", error.response?.data || error.message);
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

Welcome to Airwix Payroll! Your system account has been created.

Please use the link below to set up your secure 4-digit PIN for login:
${setupLink}

Instructions:
1. Click the link above.
2. Enter your new 4-digit numeric PIN.
3. Confirm the PIN.
4. Once set, you can login to the application using your mobile number and this PIN.

This link is valid for 1 hour only.

Download our application:
https://play.google.com/store/apps/details?id=com.app.airwixpayroll

Best regards,
HR Team`;

    return await sendWhatsappMessage(employee.mobile_no, message);
};

const sendOnboardingInvite = async (mobile_no, firstName, onboardingLink) => {
    if (!mobile_no) {
        return { success: false, message: "Missing mobile number." };
    }

    const name = firstName || "Candidate";
    const message = `Hello ${name},

Welcome to Airwix Payroll! Your onboarding process has been initiated.

Please complete your details using this link:
${onboardingLink}

Download our application:
https://play.google.com/store/apps/details?id=com.app.airwixpayroll

Best regards,
HR Team`;

    return await sendWhatsappMessage(mobile_no, message);
};

const sendForgotPinLink = async (user, setupLink) => {
    if (!user || !user.mobile_no) {
        return { success: false, message: "Missing user contact details." };
    }

    const userName = user.user_name || "User";
    const message = `Hello ${userName},

We received a request to reset your secure PIN.

Please use the link below to generate a new 4-digit PIN for your account:
${setupLink}

This link is valid for 1 hour only. If you didn’t request this, please ignore this message.

Best regards,
Airwix Payroll Team`;

    return await sendWhatsappMessage(user.mobile_no, message);
};

module.exports = {
    sendWhatsappMessage,
    sendInvitationLink,
    sendOnboardingInvite,
    sendForgotPinLink
};
