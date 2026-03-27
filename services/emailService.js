const sendEmailHelper = require("./mailer");
const { CompanyMaster } = require("../models");

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
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
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
    },

    sendOnboardingApproval: async (email, name, employeeCode, departmentName, designationName, joiningDate, companyId) => {
        try {
            await sendEmailHelper({
                company_id: companyId,
                from: process.env.ADMIN_EMAIL,
                email: email,
                subject: `Welcome aboard! Your Onboarding has been Approved`,
                message: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
                        <h2 style="color: #1e293b;">Congratulations ${name}!</h2>
                        <p style="color: #475569; line-height: 1.6;">
                            We are pleased to inform you that your onboarding process has been successfully approved. Welcome to the team!
                        </p>
                        <div style="background-color: #f8fafc; padding: 15px; border-radius: 6px; margin: 20px 0;">
                            <table style="width: 100%; border-collapse: collapse;">
                                <tr>
                                    <td style="color: #64748b; padding: 5px 0; width: 40%;"><strong>Employee Code:</strong></td>
                                    <td style="color: #1e293b;">${employeeCode}</td>
                                </tr>
                                <tr>
                                    <td style="color: #64748b; padding: 5px 0;"><strong>Department:</strong></td>
                                    <td style="color: #1e293b;">${departmentName}</td>
                                </tr>
                                <tr>
                                    <td style="color: #64748b; padding: 5px 0;"><strong>Designation:</strong></td>
                                    <td style="color: #1e293b;">${designationName}</td>
                                </tr>
                                <tr>
                                    <td style="color: #64748b; padding: 5px 0;"><strong>Joining Date:</strong></td>
                                    <td style="color: #1e293b;">${joiningDate}</td>
                                </tr>
                            </table>
                        </div>
                        <p style="color: #475569; line-height: 1.6;">
                            You are now officially part of our organization. Your HR team will provide you with further information about your orientation schedule, access credentials, and other onboarding activities.
                        </p>
                        <div style="text-align: center; margin: 30px 0;">
                            <div style="background-color: #dcfce7; color: #166534; padding: 15px; border-radius: 6px; border-left: 4px solid #22c55e;">
                                <strong>🎉 Welcome to the Team!</strong>
                            </div>
                        </div>
                        <p style="color: #64748b; font-size: 0.9em; line-height: 1.5;">
                            If you have any questions, please don't hesitate to reach out to the HR department.
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
            console.error("Failed to send onboarding approval email:", error);
            throw error;
        }
    },

    sendOnboardingRejection: async (email, name, rejectNote, onboardingLink, companyId) => {
        try {
            await sendEmailHelper({
                company_id: companyId,
                from: process.env.ADMIN_EMAIL,
                email: email,
                subject: `Action Required: Your Onboarding Submission Needs Review`,
                message: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
                        <h2 style="color: #dc2626;">Onboarding Rejection</h2>
                        <p style="color: #475569; line-height: 1.6;">
                            Dear ${name},
                        </p>
                        <p style="color: #475569; line-height: 1.6;">
                            Thank you for submitting your onboarding details. Our team has reviewed your submission and found some details that need to be addressed before we can proceed with your activation.
                        </p>
                        <div style="padding: 15px; border-radius: 6px; border: 1px solid #dc2626;">
                            <h3 style="color: #dc2626; margin-top: 0;">Review Comments:</h3>
                            <p style="color: #374151; margin-bottom: 0;">${rejectNote}</p>
                        </div>
                        <p style="color: #475569; line-height: 1.6;">
                            Please review the comments above and update your information accordingly. You can access your onboarding form using the link below to make the necessary corrections.
                        </p>
                        <div style="text-align: center; margin: 30px 0;">
                            <a href="${onboardingLink}" style="background-color: #dc2626; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">
                                Update Your Information
                            </a>
                        </div>
                        <p style="color: #64748b; font-size: 0.9em; line-height: 1.5;">
                            If you have any questions about the review comments or need assistance with the update process, please don't hesitate to contact our HR department.
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
            console.error("Failed to send onboarding rejection email:", error);
            throw error;
        }
    },

    /**
     * Send resignation notification to all concerned parties
     */
    sendResignationNotification: async (data) => {
        try {
            const { 
                companyId, 
                employeeName, 
                employeeEmail, 
                resignationDate, 
                preferredLWD, 
                reason, 
                recipients 
            } = data;

            await sendEmailHelper({
                company_id: companyId,
                from: process.env.ADMIN_EMAIL,
                email: employeeEmail, // To the employee
                cc: recipients.join(','), // To supervisor, manager, admins
                subject: `Resignation Submission - ${employeeName}`,
                message: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
                        <h2 style="color: #1e293b;">Resignation Notification</h2>
                        <p style="color: #475569; line-height: 1.6;">
                            This is to inform that a resignation has been submitted by <strong>${employeeName}</strong>.
                        </p>
                        <div style="background-color: #f8fafc; padding: 15px; border-radius: 6px; margin: 20px 0;">
                            <table style="width: 100%; border-collapse: collapse;">
                                <tr>
                                    <td style="color: #64748b; padding: 5px 0; width: 40%;"><strong>Resignation Date:</strong></td>
                                    <td style="color: #1e293b;">${resignationDate}</td>
                                </tr>
                                <tr>
                                    <td style="color: #64748b; padding: 5px 0;"><strong>Preferred Last Working Day:</strong></td>
                                    <td style="color: #1e293b;">${preferredLWD}</td>
                                </tr>
                                <tr>
                                    <td style="color: #64748b; padding: 5px 0;"><strong>Reason:</strong></td>
                                    <td style="color: #1e293b;">${reason || 'N/A'}</td>
                                </tr>
                            </table>
                        </div>
                        <p style="color: #475569; line-height: 1.6;">
                            The request is currently pending approval.
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
            console.error("Failed to send resignation notification email:", error);
            throw error;
        }
    },

    /**
     * Send resignation approval/rejection notification to approvers
     */
    sendResignationActionNotification: async (data) => {
        try {
            const { 
                companyId, 
                employeeName, 
                employeeEmail, 
                resignationDate, 
                action, 
                actionBy, 
                remarks, 
                level, 
                totalLevels, 
                nextLevelApprovers,
                approvedLWD,
                recipients 
            } = data;

            // Get company email from CompanyMaster
            const company = await CompanyMaster.findOne({
                where: { id: companyId, status: 0 },
                attributes: ['email']
            });
            const companyEmail = company?.email || process.env.ADMIN_EMAIL;

            const isApproval = action === 'APPROVED';
            const isFinalApproval = level === totalLevels && isApproval;
            const subject = isFinalApproval 
                ? `Resignation Approved - ${employeeName}`
                : isApproval 
                ? `Resignation Approved (Level ${level}/${totalLevels}) - ${employeeName}`
                : `Resignation Rejected - ${employeeName}`;

            const message = `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
                    <h2 style="color: ${isApproval ? '#059669' : '#dc2626'};">
                        ${isFinalApproval ? 'Resignation Approved' : isApproval ? 'Resignation Partially Approved' : 'Resignation Rejected'}
                    </h2>
                    <p style="color: #475569; line-height: 1.6;">
                        This is to inform that the resignation request for <strong>${employeeName}</strong> has been <strong>${action.toLowerCase()}</strong> by <strong>${actionBy}</strong>.
                    </p>
                    <div style="background-color: #f8fafc; padding: 15px; border-radius: 6px; margin: 20px 0;">
                        <table style="width: 100%; border-collapse: collapse;">
                            <tr>
                                <td style="color: #64748b; padding: 5px 0; width: 40%;"><strong>Employee:</strong></td>
                                <td style="color: #1e293b;">${employeeName}</td>
                            </tr>
                            <tr>
                                <td style="color: #64748b; padding: 5px 0;"><strong>Resignation Date:</strong></td>
                                <td style="color: #1e293b;">${resignationDate}</td>
                            </tr>
                            <tr>
                                <td style="color: #64748b; padding: 5px 0;"><strong>Action:</strong></td>
                                <td style="color: ${isApproval ? '#059669' : '#dc2626'}; font-weight: bold;">${action}</td>
                            </tr>
                            <tr>
                                <td style="color: #64748b; padding: 5px 0;"><strong>Approval Level:</strong></td>
                                <td style="color: #1e293b;">${level} of ${totalLevels}</td>
                            </tr>
                            ${approvedLWD ? `
                            <tr>
                                <td style="color: #64748b; padding: 5px 0;"><strong>Approved LWD:</strong></td>
                                <td style="color: #1e293b;">${approvedLWD}</td>
                            </tr>
                            ` : ''}
                            ${remarks ? `
                            <tr>
                                <td style="color: #64748b; padding: 5px 0;"><strong>Remarks:</strong></td>
                                <td style="color: #1e293b;">${remarks}</td>
                            </tr>
                            ` : ''}
                        </table>
                    </div>
                    ${isApproval && !isFinalApproval ? `
                    <div style="background-color: #fef3c7; padding: 15px; border-radius: 6px; border-left: 4px solid #f59e0b; margin: 20px 0;">
                        <p style="color: #92400e; margin: 0;">
                            <strong>Next Level:</strong> This request has been moved to the next approval level (Level ${level + 1} of ${totalLevels}).
                        </p>
                    </div>
                    ` : ''}
                    ${isFinalApproval ? `
                    <div style="background-color: #dcfce7; padding: 15px; border-radius: 6px; border-left: 4px solid #22c55e; margin: 20px 0;">
                        <p style="color: #166534; margin: 0;">
                            <strong>Final Approval:</strong> The resignation has been fully approved. The employee's last working day is ${approvedLWD}.
                        </p>
                    </div>
                    ` : ''}
                    ${!isApproval ? `
                    <div style="background-color: #fee2e2; padding: 15px; border-radius: 6px; border-left: 4px solid #dc2626; margin: 20px 0;">
                        <p style="color: #991b1b; margin: 0;">
                            <strong>Action Required:</strong> The resignation has been rejected. Please review the remarks and take appropriate action.
                        </p>
                    </div>
                    ` : ''}
                    <hr style="border: 0; border-top: 1px solid #f1f5f9; margin: 20px 0;">
                    <p style="color: #94a3b8; font-size: 0.8em; text-align: center;">
                        This is an automated message from Airwix HRMS.
                    </p>
                </div>
            `;

            await sendEmailHelper({
                company_id: companyId,
                from: employeeEmail, // From the employee
                email: companyEmail, // To the company email
                cc: recipients.join(','), // CC to approvers
                subject: subject,
                message: message,
            });
            return true;
        } catch (error) {
            console.error("Failed to send resignation action notification email:", error);
            throw error;
        }
    }
};

module.exports = emailService;

