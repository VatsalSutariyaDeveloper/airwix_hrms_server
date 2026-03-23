const sendEmailHelper = require("./mailer");

/**
 * Service to handle all email logic
 */
const emailService = {
    /**
     * Send onboarding invitation to a candidate
     * @param {string} email 
     * @param {string} name 
     * @param {string} link 
     * @param {number} companyId 
     */
    sendOnboardingInvite: async (email, name, link, companyId) => {
        try {
            await sendEmailHelper({
                company_id: companyId,
                from: process.env.ADMIN_EMAIL,
                email: email,
                subject: `Welcome to the Team! Complete your Onboarding`,
                message: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e2e8f0; rounded: 8px;">
                        <h2 style="color: #1e293b;">Hello ${name},</h2>
                        <p style="color: #475569; line-height: 1.6;">
                            We are excited to have you join our team! To get started with your joining process, please fill in your details using the link below:
                        </p>
                        <div style="text-align: center; margin: 30px 0;">
                            <a href="${link}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">
                                Complete Onboarding
                            </a>
                        </div>
                        <p style="color: #64748b; font-size: 0.9em; line-height: 1.5;">
                            Note: This link allows you to fill in your personal, bank, and document details securely. If you have any questions, please reach out to the HR department.
                        </p>
                        <hr style="border: 0; border-top: 1px solid #f1f5f9; margin: 20px 0;">
                        <p style="color: #94a3b8; font-size: 0.8em; text-align: center;">
                            This is an automated message from Airwix HRMS.
                        </p>
                    </div>
                `,
            });
            return true;
        } catch (error) {
            console.error("Failed to send onboarding invite email:", error);
            throw error;
        }
    }
};

module.exports = emailService;
