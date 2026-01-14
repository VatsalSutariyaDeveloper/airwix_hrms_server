const sendEmailHelper = require("../../services/mailer"); // Adjust path
const { handleError } = require("../../helpers");
const RESPONSE_CODES = require("../../helpers/responseCodes");
const axios = require("axios");

exports.sendEmail = async (req, res) => {
  try {
    // 1. Safely access req.body
    const body = req.body || {};

    // 2. Extract Recipient Fields (Handling 'to' vs 'to[]')
    const getList = (key) => {
      const value = body[key] || body[`${key}[]`];
      if (!value) return [];
      return Array.isArray(value) ? value : [value];
    };

    const toList = getList("to");
    const ccList = getList("cc");
    const bccList = getList("bcc");

    // 3. Extract Text & Config Fields
    const from = body.from || process.env.EMAIL_USERNAME; 
    const companyId = body.company_id; 
    
    const subject = body.subject || "No Subject";
    const message = body.message || "";

    // 4. Process Attachments
    let formattedAttachments = [];
    if (req.files && req.files.attachments) {
      const fileList = Array.isArray(req.files.attachments)
        ? req.files.attachments
        : [req.files.attachments];

      formattedAttachments = fileList.map((file) => ({
        filename: file.originalname,
        content: file.buffer, 
      }));
    }

    // 5. Validation
    if (toList.length === 0) {
      return res.status(400).json({
        code: 400,
        status: "BAD_REQUEST",
        message: "No recipients defined (To field is empty)",
      });
    }

    // 6. Send Email (Pass new fields)
    await sendEmailHelper({
      from: from, 
      company_id: companyId,
      email: toList, 
      cc: ccList,
      bcc: bccList,
      subject: subject,
      message: message, 
      attachments: formattedAttachments,
    });

    return res.status(200).json({
      code: 200,
      status: "SUCCESS",
      message: "Email sent successfully",
    });

  } catch (err) {
    console.error("Send Email Error:", err);

    if (err.type && RESPONSE_CODES[err.type]) {
      const response = RESPONSE_CODES[err.type];
      
      return res.status(response.code).json({
        code: response.code,
        status: response.status,
        message: `${response.message}`, 
      });
    }

    // Fallback to default error handler
    return handleError(err, res, req);
  }
};

exports.fetchGSTDetails = async (req, res) => {
  try {
    const { gst_number } = req.body;

    // Validation
    if (!gst_number) {
      return res.status(400).json({
        code: 400,
        status: "BAD_REQUEST",
        message: "GST number is required",
      });
    }

    // Get GST API key from environment
    const GST_KEY = process.env.GST_KEY;
    if (!GST_KEY) {
      return res.status(500).json({
        code: 500,
        status: "INTERNAL_SERVER_ERROR",
        message: "GST API key not configured",
      });
    }

    // Call GST verification API
    const apiUrl = `http://sheet.gstincheck.co.in/check/${GST_KEY}/${gst_number}`;
    const response = await axios.get(apiUrl);

    // Extract only required fields
    const gstData = response.data?.data;
    const filteredData = {
      business_name: gstData?.lgnm || gstData?.tradeNam || "",
      state: gstData?.pradr?.addr?.stcd || "",
      district: gstData?.pradr?.addr?.dst || "",
      pincode: gstData?.pradr?.addr?.pncd || "",
      address: gstData?.pradr?.adr || "",
    };

    return res.status(200).json({
      code: response.data?.code,
      status: response.data?.status,
      message: response.data?.message,
      data: filteredData,
    });

  } catch (err) {
    console.error("GST Check Error:", err);
    return handleError(err, res, req);
  }
};

exports.fetchIFSCDetails = async (req, res) => {
  try {
    const { ifsc } = req.body;

    // Validation
    if (!ifsc) {
      return res.status(400).json({
        code: 400,
        status: "BAD_REQUEST",
        message: "IFSC code is required",
      });
    }

    // Call IFSC verification API (Razorpay public API)
    const apiUrl = `https://ifsc.razorpay.com/${ifsc}`;
    const response = await axios.get(apiUrl);
    const data = {
      BRANCH: response.data.BRANCH,
      BANK: response.data.BANK,
    };

    return res.status(200).json({
      code: 200,
      status: "SUCCESS",
      message: "IFSC code verified successfully",
      data: data,
    });

  } catch (err) {
    console.error("IFSC Check Error:", err);

    // Handle specific API errors
    if (err.response) {
      // IFSC not found returns 404
      if (err.response.status === 404) {
        return res.status(404).json({
          code: 404,
          status: "NOT_FOUND",
          message: "IFSC code not found",
        });
      }

      return res.status(err.response.status).json({
        code: err.response.status,
        status: "ERROR",
        message: "IFSC verification failed",
        error: err.response.data,
      });
    }

    return handleError(err, res, req);
  }
};