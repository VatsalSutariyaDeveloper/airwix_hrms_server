/**
 * Common email template generator
 * @param {Object} options - Template options
 * @param {string} options.title - Email title
 * @param {string} options.subject - Email subject
 * @param {string} options.userName - User name
 * @param {string} options.message - Main message content
 * @param {string} options.buttonText - Button text
 * @param {string} options.actionUrl - Action URL for button
 * @returns {string} HTML email template
 */
function generateEmailTemplate(options) {
  const {
    title,
    subject,
    userName = "User",
    message,
    buttonText,
    actionUrl
  } = options;

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${subject}</title>
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
        body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 0; background-color: #F8FAFC; color: #1E293B; }
        .container { max-width: 600px; margin: 40px auto; background: #FFFFFF; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06); }
        .header { background-color: #1B365D; padding: 40px 20px; text-align: center; }
        .content { padding: 40px; line-height: 1.6; }
        .footer { background-color: #1B365D; padding: 30px; text-align: center; font-size: 13px; color: #FFFFFF; }
        .button { display: inline-block; padding: 14px 28px; background-color: #1B365D; color: #FFFFFF !important; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; margin: 30px 0; }
        .link { color: #1B365D; word-break: break-all; font-size: 14px; }
        h1 { margin: 0 0 20px; font-size: 24px; font-weight: 700; color: #0F172A; }
        p { margin: 0 0 16px; font-size: 16px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <span style="color: #FFFFFF; font-size: 24px; font-weight: 700; letter-spacing: -0.5px;">${process.env.EMAIL_COMPANY_NAME || 'AIRWIX PAYROLL'}</span>
        </div>
        <div class="content">
          <h1>${title}</h1>
          <p>Hello <strong>${userName}</strong>,</p>
          <p>${message}</p>
          <div style="text-align: center;">
            <a href="${actionUrl}" class="button">${buttonText}</a>
          </div>
        </div>
        <div class="footer">
          <p style="margin: 0;">&copy; ${new Date().getFullYear()} ${process.env.EMAIL_COMPANY_NAME || 'AIRWIX PAYROLL'}. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;
}

module.exports = { generateEmailTemplate };
