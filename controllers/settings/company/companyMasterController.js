const { sequelize, CompanyMaster, User, BranchMaster, GodownMaster, RolePermission, CompanyAddress, CountryMaster, StateMaster } = require("../../../models");
const { validateRequest, commonQuery, handleError, uploadFile, deleteFile, Op, getCompanySubscription, fileExists, initializeCompanySettings, constants } = require("../../../helpers");
const { updateDocumentUsedLimit } = require("../../../helpers/functions/commonFunctions");

const ensureSingleDefault = async (POST, transaction) => {  
  if (POST.is_default === 1 || POST.is_default === '1') {

    await commonQuery.updateRecordById(
      CompanyMaster,
      { user_id: POST.user_id },
      { is_default: 2 },
      transaction
    );
  }
};

// Helper to parse stringified JSON fields from multipart/form-data
const parseJsonFields = (body) => {
  const fieldsToParse = ["company_addresses"];
  fieldsToParse.forEach(field => {
    if (body[field] && typeof body[field] === 'string') {
      try {
        body[field] = JSON.parse(body[field]);
      } catch (error) {
        console.error(`Error parsing JSON for field ${field}:`, error);
        body[field] = [];
      }
    }
  });
};

const ASSOCIATED_MODELS = [
   {
    model: CompanyAddress, key: "company_addresses", as: "addresses",
    include: [{ model: CountryMaster, as: "country", attributes: ["id", "country_name"] },
    { model: StateMaster, as: "state", attributes: ["id", "state_name"] }
  ]
  },
]

/**
 * Create Company with auto-generated company_code
 */
exports.create = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    parseJsonFields(req.body);

    const { company_id, user_id, branch_id } = req.body;

    const companyPlan = await getCompanySubscription(company_id);
    if(companyPlan.companies_limit <= companyPlan.used_companies){
      await transaction.rollback();
      return res.error(constants.LIMIT_EXCEEDED, constants.COMPANY_LIMIT_REACHED);
    }

    if(req.body.company_name === undefined || req.body.company_name.trim() === ""){
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, { company_name: "Company Name is required" });
    }
    if(req.body.mobile_no === undefined || req.body.mobile_no.trim() === ""){
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, { mobile_no: "Mobile Number is required" });
    }

    const parentCompany = await commonQuery.findOneRecord(
      CompanyMaster,
      company_id,
      { attributes: ['id', 'company_id'] },
      null,
      false,
      false
    );

    if (!parentCompany) {
      await transaction.rollback();
      return res.error("NOT_FOUND", { message: "Invalid or missing company record." });
    }

    const parentCompanycompanyId = parentCompany.company_id || parentCompany.id;

    // Fetch all related companies
    const companies = await commonQuery.findAllRecords(
      CompanyMaster,
      {
        [Op.or]: [{ id: parentCompanycompanyId }, { company_id: parentCompanycompanyId }],
        status: { [Op.ne]: 2 }
      },
      { attributes: ['id'] },
      null,
      false
    );

    const companyIds = companies.map(c => c.id);

    if (req.body.mobile_no) {
      const mobileExistsOutside = await CompanyMaster.findOne({
        where: {
          mobile_no: req.body.mobile_no,
          id: { [Op.notIn]: companyIds },
          status: { [Op.ne]: 2 }
        },
        transaction
      });

      if (mobileExistsOutside) {
        await transaction.rollback();
        return res.error(constants.VALIDATION_ERROR, {
          mobile_no: "Mobile number already used in another company"
        });
      }
    }
    
    // Find the last company to determine the next sequential code.
    const lastCompany = await commonQuery.findOneRecord(CompanyMaster, {}, { order: [["company_code", "DESC"]] }, transaction);

    let nextNumber = 1;
    if (lastCompany && lastCompany.company_code) {

      const match = lastCompany.company_code.match(/\d+$/);
      if (match) {
        nextNumber = parseInt(match[0], 10) + 1;
      }
    }

    req.body.company_code = `CM${String(nextNumber).padStart(3, "0")}`;

    // Handle file uploads if they exist
    if (req.files?.logo_image) {
      const singleLogoReq = {
        file: Array.isArray(req.files.logo_image) ? req.files.logo_image[0] : req.files.logo_image,
      };

      const uploaded = await uploadFile(singleLogoReq, res, constants.COMPANY_LOGO_IMG_FOLDER, transaction);

      if (uploaded && uploaded.logo_image) {
        req.body.logo_image = uploaded.logo_image;
      }
    }

    let record = null;
    if (company_id){
      record = await commonQuery.findOneRecord(
          CompanyMaster, 
          { id : company_id, status: 0 },
          { attributes: ['id', 'company_id'] }
      );
      if (!record) {
          return res.error(404, "Invalid or missing company record.");
      }
    }

    let companyId = record?.company_id || record?.id || 0;
    req.body.company_id = companyId;
    req.body.business_type_id = record?.business_type_id;

    // 1. Create the Company Master record
    const newCompany = await commonQuery.createRecord(
      CompanyMaster,
      req.body,
      transaction
    );
    if(!newCompany){
      await transaction.rollback();
      return res.error(constants.INTERNAL_SERVER_ERROR, { message: "Failed to create company." });
    }
    await updateDocumentUsedLimit(company_id, 'companies', 1, transaction);

    // 4. Create the default Branch ("Main Branch")
    const branchPayload = {
        branch_name: "Main Branch",
        country_id: req.body.country_id,
        state_id: req.body.state_id,
        city: req.body.city,
        pincode: req.body.pincode,
        zone_id: req.body.zone_id || null, 
        user_id: user_id,
        branch_id: 0, // Using 0 as default for first branch
        company_id: newCompany.id,
    };

    const newBranch = await commonQuery.createRecord(
        BranchMaster,
        branchPayload,
        transaction
    );

    // 5. Create the default Godown ("Main Warehouse")
    const godownPayload = {
        name: "Main Warehouse",
        address: req.body.address || newCompany.address || null,
        user_id: user_id,
        branch_id: newBranch.id,
        company_id: newCompany.id,
    };

    await commonQuery.createRecord(
        GodownMaster,
        godownPayload,
        transaction
    );

    const RolePermissions = await commonQuery.findOneRecord(RolePermission, { company_id: -1, status: 0 }, {}, transaction);

    const userPayload = {
      role_id: 1,
      user_name: " Super Admin", 
      role_id: RolePermissions.id,
      permission: RolePermissions.permissions,
      user_id: user_id,
      branch_id: newBranch.id,
      company_id: newCompany.id,
      company_access: JSON.stringify([newCompany.id]),
    };

    await commonQuery.createRecord(
      User,
      userPayload,
      transaction
    );

    // Create associated models (addresses)
    const commonData = {
      company_id: newCompany.id,
      user_id: user_id,
      branch_id: newBranch.id,
    };

    await initializeCompanySettings(newCompany.id, newBranch.id, user_id, transaction);

    for (const { model, key } of ASSOCIATED_MODELS) {
      if (Array.isArray(req.body[key]) && req.body[key].length > 0) {
        await commonQuery.bulkCreate(model, req.body[key], commonData, transaction);
      }
    }

    await transaction.commit();
    return res.success(constants.COMPANY_CREATED, newCompany); 
  } catch (err) {
    console.error("Error in creating company:", err);
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

/**
 * Get All Active Companies
 */
exports.getAll = async (req, res) => {
  try {
    const result = await commonQuery.findAllRecords(CompanyMaster, {status: 0}, { order: [["company_name", "ASC"]] }, null, false);
    return res.ok(result);
  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * Get All Active Companies
 */
exports.getCompanies = async (req, res) => {
  try {
     const record = await commonQuery.findOneRecord(
        CompanyMaster,
        req.body.company_id,
        { attributes: ['id', 'company_id'] }
    );
    if (!record) {
        return res.error(constants.NOT_FOUND);
    }

    let companyId = record.company_id || record.id;

    const includeOptions = [
      ...ASSOCIATED_MODELS.map(({ model, as, include }) => ({
        model,
        as,
        where: { status: { [Op.ne]: 2 } },
        required: false,
        separate: true,
        order: [["createdAt", "ASC"]],
        ...(include && { include }),
      })),
    ];

    const result = await commonQuery.findAllRecords(CompanyMaster, {
      [Op.or]: [
        { id: companyId },
        { company_id: companyId },
      ],
      status: 0,
    }, { include: includeOptions },null, false);

    // Construct full URL for logo_image and admin_signature_img

    const updatedResult = result.map((company) => {
      const companyData = company.get({ plain: true }); // ensure plain object

      const logoExists = fileExists(constants.COMPANY_LOGO_IMG_FOLDER, companyData.logo_image);
      companyData.logo_image_url = logoExists ? `${process.env.FILE_SERVER_URL}${constants.COMPANY_LOGO_IMG_FOLDER}${companyData.logo_image}` : null;

      const signExists = fileExists(constants.COMPANY_SIGN_IMG_FOLDER, companyData.admin_signature_img);
      companyData.admin_signature_img_url = signExists ? `${process.env.FILE_SERVER_URL}${constants.COMPANY_SIGN_IMG_FOLDER}${companyData.admin_signature_img}` : null;

      return companyData;
    });

    return res.ok(updatedResult);
  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * Get Company by ID
 */
exports.getById = async (req, res) => {
  try {
    const includeOptions = [
      ...ASSOCIATED_MODELS.map(({ model, as, include }) => ({
        model,
        as,
        where: { status: { [Op.ne]: 2 } },
        required: false,
        separate: true,
        order: [["createdAt", "ASC"]],
        ...(include && { include }),
      })),
    ];

    // Fetch the company record by ID
    const record = await commonQuery.findOneRecord(
      CompanyMaster,
      req.params.id,
      { include: includeOptions }
    );

    // Ensure the company is active
    if (!record || record.status === 2) {
      return res.error(constants.COMPANY_NOT_FOUND);
    }

    // Convert to plain object
    const companyData = record.get({ plain: true });

    const logoExists = fileExists(constants.COMPANY_LOGO_IMG_FOLDER, companyData.logo_image);
    companyData.logo_image_url = logoExists ? `${process.env.FILE_SERVER_URL}${constants.COMPANY_LOGO_IMG_FOLDER}${companyData.logo_image}` : null;

    const signExists = fileExists(constants.COMPANY_SIGN_IMG_FOLDER, companyData.admin_signature_img);
    companyData.admin_signature_img_url = signExists ? `${process.env.FILE_SERVER_URL}${constants.COMPANY_SIGN_IMG_FOLDER}${companyData.admin_signature_img}` : null;

    return res.ok(companyData);
  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * Update Company
 */
exports.update = async (req, res) => {
  const transaction = await sequelize.transaction();
  const POST = req.body;
  try {
    parseJsonFields(req.body);

    const skipValidations = !POST.company_name && POST.is_default == 1;
    if (!skipValidations) {
      const requiredFields = {
        company_name: "Company Name",
      };

      // Removed uniqueCheck for company_code as it's not being passed in the body
      const errors = await validateRequest(POST, requiredFields, {
        skipDefaultRequired: ["company_id"],
      }, transaction);

      if (errors) {
        await transaction.rollback();
        return res.error(constants.VALIDATION_ERROR, { errors });
      }
    }

    const existing = await commonQuery.findOneRecord(
      CompanyMaster,
      req.params.id,
      {},
      transaction
    );

    if (!existing || existing.status === 2) {
      await transaction.rollback();
      return res.error(constants.COMPANY_NOT_FOUND);
    }

    delete POST.company_id;
    
    if (req.files?.logo_image) {
      const singleLogoReq = {file: Array.isArray(req.files.logo_image) ? req.files.logo_image[0] : req.files.logo_image,};

      const uploaded = await uploadFile(singleLogoReq, res, constants.COMPANY_LOGO_IMG_FOLDER, transaction, existing.logo_image);

      if (uploaded && uploaded.logo_image) {
        POST.logo_image = uploaded.logo_image;
      }
    }

    await ensureSingleDefault(POST, transaction);

    const updated = await commonQuery.updateRecordById(
      CompanyMaster,
      req.params.id,
      POST,
      transaction
    );

    if (!updated || updated.status === 2) {
      await transaction.rollback();
      return res.error(constants.COMPANY_NOT_FOUND);
    }

    // Sync associated models (addresses)
    const commonData = {
      user_id: POST.user_id,
      branch_id: POST.branch_id,
      company_id: POST.company_id,
    };

    for (const { model, key } of ASSOCIATED_MODELS) {
      if (Array.isArray(POST[key])) {
        await syncChildData(model, POST[key], req.params.id, commonData, transaction);
      }
    }

    await transaction.commit();
    return res.success(constants.COMPANY_UPDATED, updated);
  } catch (err) {
    console.log(err);
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

/**
 * Soft Delete Company
 */
exports.delete = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const deleted = await commonQuery.softDeleteById(CompanyMaster, req.params.id,  transaction);
    if (!deleted) {
      await transaction.rollback();
      return res.error(constants.ALREADY_DELETED);
    }

    // Cascade delete associated models
    for (const { model } of ASSOCIATED_MODELS) {
      await commonQuery.softDeleteById(
        model,
        { company_id: req.params.id },
        null,
        transaction
      );
    }

    await transaction.commit();
    return res.success(constants.COMPANY_DELETED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

/**
 * Synchronizes generic child records (addresses)
 */
async function syncChildData(Model, newData, companyId, extraFields, transaction) {
  const incomingIds = newData.map((d) => d.id).filter(Boolean);

  await commonQuery.softDeleteById(Model, {company_id: companyId, id: { [Op.notIn]: incomingIds },}, null, transaction);

  const recordsToCreate = [];
  const recordsToUpdate = [];

  for (const record of newData) {
    if (record.id) {
      recordsToUpdate.push(record);
    } else {
      recordsToCreate.push({ ...record, ...extraFields, company_id: companyId });
    }
  }

  if (recordsToCreate.length > 0) {
    await commonQuery.bulkCreate(Model, recordsToCreate, {}, transaction);
  }

  for (const record of recordsToUpdate) {
    await commonQuery.updateRecordById(Model, record.id, { ...record, ...extraFields }, transaction);
  }
}
