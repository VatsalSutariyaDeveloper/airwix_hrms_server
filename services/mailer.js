const nodemailer = require('nodemailer');
const CryptoJS = require("crypto-js");
const { getCompanySetting } = require('../helpers'); 

// Helper to map Nodemailer Error Codes to Human Readable Text
const mapNodemailerError = (err) => {
  console.error("Raw Nodemailer Error:", err); 

  // Common Nodemailer Error Codes
  switch (err.code) {
    case 'EAUTH':
    case 'EAUTHSYS':
      return { type: 'EMAIL_AUTH_FAILED', original: err.message };
    
    case 'ESOCKET':
    case 'ECONNREFUSED':
    case 'ECONNRESET':
      return { type: 'EMAIL_CONNECTION_FAILED', original: err.message };
      
    case 'ETIMEDOUT':
      return { type: 'EMAIL_TIMEOUT', original: err.message };

    case 'EENVELOPE':
    case 'EMESSAGE':
      return { type: 'EMAIL_REJECTED', original: err.message };

    default:
      return { type: 'EMAIL_UNKNOWN_ERROR', original: err.message };
  }
};

const sendEmailHelper = async (options) => {
  let transporterConfig = {};

  console.log(`Using Custom Credentials for Company: ${options.company_id}`);
  
  if (!options.company_id) {
    throw new Error("Company ID is required to fetch custom SMTP settings.");
  }

  // Fetch settings 
  let { smtp_host, smtp_port, smtp_user, smtp_password } = await getCompanySetting(options.company_id);

  if(!smtp_host){
    smtp_host = process.env.EMAIL_HOST;
  }
  if(!smtp_port){
    smtp_port = process.env.EMAIL_PORT;
  } 
  if(!smtp_user){
    smtp_user = process.env.EMAIL_USERNAME;
  }
  if(!smtp_password){
    smtp_password = process.env.EMAIL_PASSWORD;
  }

  console.log("Fetched SMTP Settings:", { smtp_host, smtp_port, smtp_user, smtp_password: smtp_password ? '******' : null });
  if (!smtp_host || !smtp_user || !smtp_password) {
    throw new Error("Custom SMTP settings (Host, User, or Password) not found.");
  }

  let decryptedPassword = smtp_password;
  try {
      const bytes = CryptoJS.AES.decrypt(decodeURIComponent(smtp_password), process.env.SECRET_KEY);
      const originalText = bytes.toString(CryptoJS.enc.Utf8);
      if (originalText) decryptedPassword = originalText;
  } catch (error) {
      console.error("Decryption failed, using plain text.");
  }

  transporterConfig = {
    host: smtp_host,
    port: Number(smtp_port) || 587,
    secure: Number(smtp_port) === 465, 
    auth: {
      user: smtp_user,
      pass: decryptedPassword,
    },

    connectionTimeout: 10000, // 10 seconds to connect
    greetingTimeout: 10000,   // 10 seconds to say hello
    socketTimeout: 15000,     // 15 seconds for data transmission
  };

  try {
    // 2. Create Transporter
    const transporter = nodemailer.createTransport(transporterConfig);

    // 4. Send Mail
    await transporter.sendMail({
      from: options.from, 
      to: options.email,
      cc: options.cc,
      bcc: options.bcc,
      subject: options.subject,
      html: options.message,
      attachments: options.attachments
    });

  } catch (err) {
    const mappedError = mapNodemailerError(err);
    const customError = new Error(mappedError.original);
    customError.type = mappedError.type; // Attach the type (e.g., EMAIL_AUTH_FAILED)
    throw customError;
  }
};

module.exports = sendEmailHelper;