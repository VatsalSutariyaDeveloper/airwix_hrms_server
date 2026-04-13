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
https://loadly.io/airwix-payroll

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
https://loadly.io/airwix-payroll

Best regards,
HR Team`;

    return await sendWhatsappMessage(mobile_no, message);
};

module.exports = {
    sendWhatsappMessage,
    sendInvitationLink,
    sendOnboardingInvite
};
