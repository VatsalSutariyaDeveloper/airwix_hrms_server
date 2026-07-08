const sendEmailHelper = require("./mailer");
const { CompanyMaster } = require("../models");
const { generateEmailTemplate } = require("../helpers/emailTemplate");

/**
 * Service to handle all email logic
 */
const emailService = {
    /**
     * Send OTP to email
     * @param {string} email
     * @param {string} otp
     */
    sendOtpToEmail: async (email, otp, userName = "User") => {
        try {
            const message = `
                <p style="color: #475569; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
                    Your One-Time Password (OTP) for secure login is provided below. Please use this code to complete your verification process.
                </p>
                
                <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 32px; text-align: center; margin: 24px 0;">
                    <div style="font-size: 36px; font-weight: 700; color: #1e293b; letter-spacing: 8px; font-family: 'Courier New', Courier, monospace;">
                        ${otp}
                    </div>
                </div>
                
                <p style="color: #64748b; font-size: 14px; line-height: 1.5; margin-top: 24px;">
                    <strong>Note:</strong> This OTP is valid for 10 minutes and should not be shared with anyone. If you did not request this code, please ignore this email.
                </p>
                
                <hr style="border: 0; border-top: 1px solid #f1f5f9; margin: 32px 0;">
                <p style="color: #94a3b8; font-size: 12px; text-align: center; margin-bottom: 0;">
                    This is an automated security message from Airwix HRMS.
                </p>
            `;

            await sendEmailHelper({
                from: `${process.env.EMAIL_COMPANY_NAME} <${process.env.ADMIN_EMAIL}>`,
                email: [email],
                subject: "Your Verification OTP",
                message: generateEmailTemplate({
                    title: "Security Verification",
                    subject: "Your Verification OTP",
                    userName: userName,
                    message: message,
                    buttonText: '',
                    actionUrl: ''
                }),
            });
            return true;
        } catch (error) {
            console.error("Failed to send OTP email:", error);
            throw error;
        }
    },
    /**
     * Send onboarding invitation to a candidate
     * @param {string} email 
     * @param {string} name 
     * @param {string} link 
     * @param {number} companyId 
     */
    sendOnboardingInvite: async (email, name, link, companyId) => {
        try {
            const company = await CompanyMaster.findByPk(companyId);
            const companyName = company?.company_name || 'Our Company';

            const message = `
                We are excited to have you join our team! To get started with your joining process, please fill in your details using the button below.
                
                <div style="text-align: center; margin: 30px 0;">
                    <a href="${link}" style="background-color: #1B365D; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; display: inline-block;">
                        Complete Onboarding
                    </a>
                </div>
                
                <p style="color: #64748b; font-size: 0.9em; line-height: 1.5;">
                    Note: This link allows you to fill in your personal, bank, and document details securely. If you have any questions, please reach out to the HR department.
                </p>
                
                <hr style="border: 0; border-top: 1px solid #f1f5f9; margin: 20px 0;">
                <p style="color: #94a3b8; font-size: 0.8em; text-align: center;">
                    This is an automated message from Airwix Payroll.
                </p>
            `;

            await sendEmailHelper({
                company_id: companyId,
                from: `${process.env.EMAIL_COMPANY_NAME} <${process.env.ADMIN_EMAIL}>`,
                email: email,
                subject: `Welcome to ${companyName}! Complete your Onboarding`,
                message: generateEmailTemplate({
                    title: `Welcome to ${companyName}!`,
                    subject: `Welcome to ${companyName}! Complete your Onboarding`,
                    userName: name,
                    message: message,
                    buttonText: '', // No button from template
                    actionUrl: ''  // No action URL from template
                }),
            });
            return true;
        } catch (error) {
            console.error("Failed to send onboarding invite email:", error);
            throw error;
        }
    },

    sendOnboardingApproval: async (email, name, employeeCode, departmentName, designationName, joiningDate, companyId) => {
        try {
            const company = await CompanyMaster.findByPk(companyId);
            const companyName = company ? company.company_name : 'Airwix Payroll';

            const message = `
                We are pleased to inform you that your onboarding process has been successfully approved. Welcome to the ${companyName} team!
                
                <div style="background-color: #f8fafc; padding: 15px; border-radius: 6px; margin: 20px 0;">
                    <table style="width: 100%; border-collapse: collapse;">
                        <tr>
                            <td style="color: #64748b; padding: 5px 0; width: 40%;"><strong>Employee Code:</strong></td>
                            <td style="color: #1e293b;">${employeeCode}</td>
                        </tr>
                        ${departmentName ? `
                        <tr>
                            <td style="color: #64748b; padding: 5px 0;"><strong>Department:</strong></td>
                            <td style="color: #1e293b;">${departmentName}</td>
                        </tr>` : ''}
                        ${designationName ? `
                        <tr>
                            <td style="color: #64748b; padding: 5px 0;"><strong>Designation:</strong></td>
                            <td style="color: #1e293b;">${designationName}</td>
                        </tr>` : ''}
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
                        <strong>🎉 Welcome to the ${companyName} Team!</strong>
                    </div>
                </div>
                
                <p style="color: #64748b; font-size: 0.9em; line-height: 1.5;">
                    If you have any questions, please don't hesitate to reach out to the HR department.
                </p>
                
                <hr style="border: 0; border-top: 1px solid #f1f5f9; margin: 20px 0;">
                <p style="color: #94a3b8; font-size: 0.8em; text-align: center;">
                    This is an automated message from Airwix HRMS.
                </p>
            `;

            await sendEmailHelper({
                company_id: companyId,
                from: `${process.env.EMAIL_COMPANY_NAME} <${process.env.ADMIN_EMAIL}>`,
                email: email,
                subject: `Welcome aboard! Your Onboarding has been Approved`,
                message: generateEmailTemplate({
                    title: `Congratulations ${name}!`,
                    subject: `Welcome aboard! Your Onboarding has been Approved`,
                    userName: name,
                    message: message,
                    buttonText: 'View Employee Portal',
                    actionUrl: `${process.env.FRONTEND_URL || '#'}/employee/dashboard`
                }),
            });
            return true;
        } catch (error) {
            console.error("Failed to send onboarding approval email:", error);
            throw error;
        }
    },

    sendOnboardingRejection: async (email, name, rejectNote, onboardingLink, companyId) => {
        try {
            const message = `
                Thank you for submitting your onboarding details. Our team has reviewed your submission and found some details that need to be addressed before we can proceed with your activation.
                
                <div style="padding: 15px; border-radius: 6px; border: 1px solid #dc2626;">
                    <h3 style="color: #dc2626; margin-top: 0;">Review Comments:</h3>
                    <p style="color: #374151; margin-bottom: 0;">${rejectNote}</p>
                </div>
                
                <p style="color: #475569; line-height: 1.6;">
                    Please review the comments above and update your information accordingly. You can access your onboarding form using the link below to make the necessary corrections.
                </p>
                
                <p style="color: #64748b; font-size: 0.9em; line-height: 1.5;">
                    If you have any questions about the review comments or need assistance with the update process, please don't hesitate to contact our HR department.
                </p>
                
                <hr style="border: 0; border-top: 1px solid #f1f5f9; margin: 20px 0;">
                <p style="color: #94a3b8; font-size: 0.8em; text-align: center;">
                    This is an automated message from Airwix HRMS.
                </p>
            `;

            await sendEmailHelper({
                company_id: companyId,
                from: `${process.env.EMAIL_COMPANY_NAME} <${process.env.ADMIN_EMAIL}>`,
                email: email,
                subject: `Action Required: Your Onboarding Submission Needs Review`,
                message: generateEmailTemplate({
                    title: 'Onboarding Rejection',
                    subject: `Action Required: Your Onboarding Submission Needs Review`,
                    userName: name,
                    message: message,
                    buttonText: 'Update Your Information',
                    actionUrl: onboardingLink
                }),
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

            const message = `
                This is to inform that a resignation has been submitted by <strong>${employeeName}</strong>.
                
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
            `;

            await sendEmailHelper({
                company_id: companyId,
                from: process.env.ADMIN_EMAIL,
                email: employeeEmail, // To the employee
                cc: recipients.join(','), // To supervisor, manager, admins
                subject: `Resignation Submission - ${employeeName}`,
                message: generateEmailTemplate({
                    title: 'Resignation Notification',
                    subject: `Resignation Submission - ${employeeName}`,
                    userName: employeeName,
                    message: message,
                    buttonText: 'View Resignation Details',
                    actionUrl: `${process.env.FRONTEND_URL || '#'}/resignation/view`
                }),
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
                remarks,
                level,
                totalLevels,
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
            const subject = `Resignation Approved - ${employeeName}`;

            const message = `
                This is to inform that the resignation request for <strong>${employeeName}</strong> has been <strong>${action.toLowerCase()}</strong>.
                
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
            `;

            await sendEmailHelper({
                company_id: companyId,
                // from: employeeEmail,
                from: process.env.ADMIN_EMAIL,
                replyTo: employeeEmail,
                email: companyEmail,
                cc: recipients.join(','),
                subject: subject,
                message: generateEmailTemplate({
                    title: `${isFinalApproval ? 'Resignation Approved' : isApproval ? 'Resignation Partially Approved' : 'Resignation Rejected'}`,
                    subject: subject,
                    userName: employeeName,
                    message: message,
                    buttonText: 'View Resignation Details',
                    actionUrl: `${process.env.FRONTEND_URL || '#'}/resignation/view`
                }),
            });
            return true;
        } catch (error) {
            console.error("Failed to send resignation action notification email:", error);
            throw error;
        }
    },

    /**
     * Send email notification to manager for Comp-Off Leave leave credit approval
     */
    sendCompOffCreditApprovalEmail: async (data) => {
        try {
            const {
                companyId,
                employeeName,
                employeeEmail,
                approverEmail,
                approverName,
                date,
                totalDays,
                level,
                totalLevels
            } = data;

            const message = `
                A Comp-Off Leave credit request has been submitted by <strong>${employeeName}</strong> and is pending your approval.
                
                <div style="background-color: #f8fafc; padding: 15px; border-radius: 6px; margin: 20px 0;">
                    <table style="width: 100%; border-collapse: collapse;">
                        <tr>
                            <td style="color: #64748b; padding: 5px 0; width: 40%;"><strong>Employee Name:</strong></td>
                            <td style="color: #1e293b;">${employeeName}</td>
                        </tr>
                        <tr>
                            <td style="color: #64748b; padding: 5px 0;"><strong>Working Date:</strong></td>
                            <td style="color: #1e293b;">${date}</td>
                        </tr>
                        <tr>
                            <td style="color: #64748b; padding: 5px 0;"><strong>Comp-Off Leave Credit Days:</strong></td>
                            <td style="color: #1e293b;">${totalDays} ${totalDays === 1 ? 'day' : 'days'}</td>
                        </tr>
                    </table>
                </div>
                
                <p style="color: #475569; line-height: 1.6;">
                    Please log in to the HRMS portal to review and take action on this request.
                </p>
                
                <hr style="border: 0; border-top: 1px solid #f1f5f9; margin: 20px 0;">
                <p style="color: #94a3b8; font-size: 0.8em; text-align: center;">
                    This is an automated message from Airwix HRMS.
                </p>
            `;

            await sendEmailHelper({
                company_id: companyId,
                from: `${process.env.EMAIL_COMPANY_NAME || 'Airwix Payroll'} <${process.env.ADMIN_EMAIL}>`,
                replyTo: employeeEmail ? `"${employeeName}" <${employeeEmail}>` : undefined,
                email: approverEmail,
                subject: `Comp-Off Leave Credit Approval Request - ${employeeName}`,
                message: generateEmailTemplate({
                    title: 'Comp-Off Leave Credit Pending Approval',
                    subject: `Comp-Off Leave Credit Approval Request - ${employeeName}`,
                    userName: approverName,
                    message: message,
                    buttonText: 'View Pending Requests',
                    actionUrl: `${process.env.FRONTEND_URL || '#'}/pending-request`
                }),
            });
            return true;
        } catch (error) {
            console.error("Failed to send Comp-Off Leave credit approval email:", error);
            throw error;
        }
    }
};

module.exports = emailService;

