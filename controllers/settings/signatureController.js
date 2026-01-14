const { Signature } = require("../../models");
const { validateRequest, commonQuery, handleError, sequelize, uploadFile, deleteFile, constants, ENTITIES } = require("../../helpers");
const path = require("path");
const { Op } = require("sequelize");

const ENTITY = ENTITIES.SIGNATURE.NAME;

const ensureSingleDefault = async (POST, currentId, transaction) => {
  if (POST.is_default === 1) {
    const whereCondition = {
      user_id: POST.user_id,
      branch_id: POST.branch_id,
      company_id: POST.company_id,
      ...(currentId && { id: { [sequelize.Sequelize.Op.ne]: currentId } })
    };

    await commonQuery.updateRecordById(
      Signature,
      whereCondition,
      { is_default: 2 },
      transaction
    );
  }
};


// Create a new signature record
exports.create = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const POST = req.body;

    // validate
    const errors = await validateRequest(POST, { name: "Name" }, {}, transaction);
    if (errors) {
      await transaction.rollback();
      return res.error("VALIDATION_ERROR", { errors });
    }

    // detect image from req.files (array or object)
    let uploadedFile = null;

    if (Array.isArray(req.files)) {
      uploadedFile = req.files.find(f => f.fieldname === "image");
    } else if (req.files?.image) {
      uploadedFile = Array.isArray(req.files.image)
        ? req.files.image[0]
        : req.files.image;
    }

    if (!uploadedFile) {
      await transaction.rollback();
      return res.error("VALIDATION_ERROR", {
        errors: ["Signature image is required."]
      });
    }

    // fix upload request structure
    const imageReq = {
      ...req,
      files: {
        image: [uploadedFile]
      }
    };

    const result = await uploadFile(
      imageReq,
      res,
      constants.SIGNATURE_FOLDER,
      transaction
    );

    POST.image = result.image;

    await ensureSingleDefault(POST, null, transaction);

    const created = await commonQuery.createRecord(Signature, POST, transaction);
  
    const record = created.toJSON();
    record.image_url = record.image ? `${process.env.FILE_SERVER_URL}${constants.SIGNATURE_FOLDER}${record.image}` : null;
    
    await transaction.commit();
    return res.success(constants.CREATED, record);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Get signature record by ID
exports.getById = async (req, res) => {
  try {
    const record = await commonQuery.findOneRecord(Signature, req.params.id);

    if (!record || record.status === 2) return res.error(constants.NOT_FOUND);

    const responseData = record.toJSON ? record.toJSON() : record;
    responseData.image_url = responseData.image ? `${process.env.FILE_SERVER_URL}${constants.SIGNATURE_FOLDER}${responseData.image}` : null;

    return res.ok(responseData);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Update signature record by ID
exports.update = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const POST = req.body;

    const errors = await validateRequest(POST, { name: "Name" }, {}, transaction);
    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    const existing = await commonQuery.findOneRecord(Signature, req.params.id, {}, transaction);

    if (!existing || existing.status === 2) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }

    let newImageFile = null;

    if (Array.isArray(req.files)) {
      newImageFile = req.files.find(f => f.fieldname === "image");
    } else if (req.files?.image) {
      newImageFile = Array.isArray(req.files.image)
        ? req.files.image[0]
        : req.files.image;
    }

    // CASE 1: New image upload
    if (newImageFile) {      
      // Step 1: Upload new image first
      const imageReq = {
        ...req,
        files: { image: [newImageFile] }
      };

      const uploadResult = await uploadFile(imageReq, res, constants.SIGNATURE_FOLDER, transaction);

      POST.image = uploadResult.image;

      // Step 2: Delete old image after successful upload
      if (existing.image) {        
        await deleteFile(req, res, constants.SIGNATURE_FOLDER, existing.image);
      }
    }

    // CASE 2: Client wants to remove existing image
    else if (POST.image === "" || POST.image === null) {      
      if (existing.image) {
        await deleteFile(req, res, constants.SIGNATURE_FOLDER, existing.image);
      }
      POST.image = null;
    }

    // CASE 3: Image unchanged
    else if (POST.image === existing.image) {
      delete POST.image;
    }

    await ensureSingleDefault(POST, req.params.id, transaction);

    const updated = await commonQuery.updateRecordById(Signature, req.params.id, POST, transaction);

    await transaction.commit();
    return res.success(constants.UPDATED, updated);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Get all signatures with pagination, searching, and sorting
exports.getAll = async (req, res) => {
  try {
    const fieldConfig = [
      ["name", true, true],
      ["image", true, true],
    ];

    const data = await commonQuery.fetchPaginatedData(
      Signature,
      req.body,
      fieldConfig,
    );

    // Add image_url to each signature record
    if (data.items && Array.isArray(data.items)) {
      data.items = data.items.map(record => {
        const responseData = record.toJSON ? record.toJSON() : record;

        if (responseData.image) {
          responseData.image_url = responseData.image ? `${process.env.FILE_SERVER_URL}${constants.SIGNATURE_FOLDER}${responseData.image}` : null;
        }
        return responseData;
      });
    }

    return res.ok(data);
  } catch (err) {
    console.error(err);
    return handleError(err, res, req);
  }
};

// Get list of all signatures for dropdowns
exports.dropdownList = async (req, res) => {
  try {
    const { signature } = req.body;

    const records = await commonQuery.findAllRecords(
      Signature,
      {
        user_id: req.body.user_id,
        branch_id: req.body.branch_id,
        company_id: req.body.company_id,
        status: 0
      },
      {
        attributes: ["id", "name", "image"],
        order: [["is_default", "ASC"]]
      }
    );

    // If signature parameter is true, add image_url to each record
    if (signature) {
      const recordsWithImageUrl = records.map(record => {
        const responseData = record.toJSON ? record.toJSON() : record;
        responseData.image_url = responseData.image ? `${process.env.FILE_SERVER_URL}${constants.SIGNATURE_FOLDER}${responseData.image}` : null;
        return responseData;
      });

      return res.ok(recordsWithImageUrl);
    }

    return res.success("FETCH", ENTITY, records);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Soft delete by IDs
exports.delete = async (req, res) => {
  const { user_id, branch_id, company_id } = req.body;
  const transaction = await sequelize.transaction();
  try {
    const requiredFields = {
      ids: "Select Data",
    };

    const errors = await validateRequest(req.body, requiredFields, {}, transaction);
    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    const { ids } = req.body;

    // Validate that ids is an array and not empty
    if (!Array.isArray(ids) || ids.length === 0) {
      await transaction.rollback();
      return res.error(constants.INVALID_INPUT);
    }

    // Find all signature records corresponding to the provided ids
    const recordsToDelete = await commonQuery.findAllRecords(
      Signature,
      { id: { [Op.in]: ids }, company_id, user_id, branch_id },
      {},
      transaction
    );

    if (!recordsToDelete || recordsToDelete.length === 0) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }

    // Loop through each record and delete its associated files
    for (const record of recordsToDelete) {
      if (record.image) {
        await deleteFile(req, res, constants.SIGNATURE_FOLDER, record.image);
        await commonQuery.updateRecordById(
          Signature,
          record.id,
          {image: null},
          transaction
        );
        // await record.update({ image: null }, { transaction });
      }
    }

    const deletedCount = await commonQuery.softDeleteById(
      Signature,
      ids,
      { user_id, branch_id, company_id },
      transaction
    );

    if (deletedCount === 0) {
      await transaction.rollback();
      return res.error(constants.ALREADY_DELETED);
    }

    await transaction.commit();
    return res.success(constants.DELETED);
  } catch (err) {
    console.log(err);
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Update Status
exports.updateStatus = async (req, res) => {
  // const transaction = await sequelize.transaction();
  // try {
  //   const { status, ids } = req.body;

  //   const requiredFields = {
  //     ids: "Select Any One Data",
  //     status: "Select Status",
  //   };

  //   const errors = await validateRequest(req.body, requiredFields, {}, transaction);
  //   if (errors) {
  //     await transaction.rollback();
  //     return res.error("VALIDATION_ERROR", { errors });
  //   }

  //   // Validate that ids is an array and not empty
  //   if (!Array.isArray(ids) || ids.length === 0) {
  //     await transaction.rollback();
  //     return res.error("INVALID_idS_ARRAY");
  //   }

  //   // Validate that status is provided and valid (0,1,2 as per your definition)
  //   if (![0, 1, 2].includes(status)) {
  //     await transaction.rollback();
  //     return res.error("VALIDATION_ERROR", {
  //       errors: ["Invalid status value"],
  //     });
  //   }

  //   // Update only the status field by id
  //   const updated = await commonQuery.updateRecordById(
  //     Signature,
  //     ids,
  //     { status },
  //     transaction
  //   );

  //   if (!updated || updated.status === 2) {
  //     if (!transaction.finished) await transaction.rollback();
  //     return res.error("NOT_FOUND");
  //   }

  //   await transaction.commit();
  //   return res.success(constants.SIGNATURE_UPDATED);
  // } catch (err) {
  //   if (!transaction.finished) await transaction.rollback();
  //   return handleError(err, res, req);
  // }
};

// Update Default
exports.updateDefault = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { id } = req.body;

    // Get the first record to retrieve user_id, branch_id, company_id
    const firstRecord = await commonQuery.findOneRecord(Signature, id);
    if (!firstRecord) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }

    // Set all records to is_default = 2 for the same user, branch, and company
    await commonQuery.updateRecordById(
      Signature,
      {
        user_id: firstRecord.user_id,
        branch_id: firstRecord.branch_id,
        company_id: firstRecord.company_id
      },
      { is_default: 2 },
      transaction
    );

    // Set selected record(s) to is_default = 1
    const updated = await commonQuery.updateRecordById(
      Signature,
      id,
      { is_default: 1 },
      transaction
    );

    if (!updated) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }

    await transaction.commit();
    return res.success(constants.SIGNATURE_DEFAULT_UPDATED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};