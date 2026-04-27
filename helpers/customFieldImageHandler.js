const { uploadFile, deleteFile } = require('./fileUpload');
/**
 * Handles image uploads for custom fields
 */
const handleCustomFieldImages = async (
  req, res, customFields = [], allFiles = [], folder, transaction, existingData = null
) => {
  if (!Array.isArray(customFields) || customFields.length === 0) {
    return customFields;
  }

  let existingFieldsArray = [];
  if (existingData && existingData.custom_fields) {
      if (typeof existingData.custom_fields === 'string') {
          try { existingFieldsArray = JSON.parse(existingData.custom_fields); } catch(e) {}
      } else if (Array.isArray(existingData.custom_fields)) {
          existingFieldsArray = existingData.custom_fields;
      }
  }

  const updatedFields = await Promise.all(
    customFields.map(async (field) => {
      const { field_name, type, key } = field;
      const fieldType = (type || field.field_type || "").toLowerCase();
      console.log("onboarding_debug.log", `[handleCustomFieldImages] Processing field: ${field_name}, type: ${fieldType}, key: ${key}`);

      delete field.image_url;
      delete field.image_urls;

      if (fieldType !== "image") return field;

      let oldValueArray = [];
      let wasDefault = false;

      if (existingFieldsArray.length > 0) {
        const oldField = existingFieldsArray.find(f => f.field_name === field_name);
        if (oldField && oldField.value) {
            oldValueArray = Array.isArray(oldField.value) ? oldField.value : [oldField.value];
            wasDefault = oldField.is_default_image === true;
        }
      }

      let keptFiles = Array.isArray(field.value) ? field.value : (field.value ? [field.value] : []);
      let newFiles = [];
      
      // 1. Upload new files if keys exist
      const keysToProcess = Array.isArray(key) ? key : (key ? [key] : []);
      
      for (const k of keysToProcess) {
          const uploadedFile = allFiles.find(f => f.fieldname === k);
          if (uploadedFile) {
              console.log("onboarding_debug.log", `[handleCustomFieldImages] Found file for key ${k}: ${uploadedFile.originalname}`);
              const tempReq = { file: uploadedFile };
              const saved = await uploadFile(tempReq, res, folder, transaction);
              if (saved[k]) {
                  console.log("onboarding_debug.log", `[handleCustomFieldImages] Saved file for key ${k}: ${saved[k]}`);
                  newFiles.push(saved[k]);
              }
          } else {
              console.log("onboarding_debug.log", `[handleCustomFieldImages] NO file found for key ${k}`);
          }
      }
      
      // 2. Delete old files not present in keptFiles
      for (const old of oldValueArray) {
          if (!keptFiles.includes(old) && !wasDefault) {
              await deleteFile(req, res, folder, old);
          }
      }
      
      // 3. Merge files into array
      field.value = [...keptFiles, ...newFiles];
      
      if (newFiles.length > 0) {
          delete field.is_default_image; 
      } else if (wasDefault && field.value.length > 0 && newFiles.length === 0) {
          field.is_default_image = true;
      }
      
      return field;
    })
  );

  return updatedFields;
};

/**
 * Generates image URLs for custom field images in response data
 */
const generateCustomFieldImageUrls = (customFields, folder) => {
  if (!Array.isArray(customFields)) return [];

  return customFields.map(field => {
    const updatedField = { ...field };

    const fieldType = field.type || field.field_type;
    if (fieldType !== "image") {
      return updatedField;
    }

    const actualImageFolder = field.is_default_image ? 'custom_fields/' : folder;
    
    // Always parse as array
    let valArray = Array.isArray(field.value) ? field.value : (field.value ? [field.value] : []);

    updatedField.image_urls = valArray.map(v => {
      // Check if it's already a full URL (including blob URLs)
      if (v && (v.startsWith('http://') || v.startsWith('https://') || v.startsWith('blob:'))) {
        return v;
      }
      return `${process.env.FILE_SERVER_URL}${actualImageFolder}${v}`;
    });

    return updatedField;
  });
};

/**
 * Handles attachment uploads for detail arrays (experience_details, education_details, family_details, professional_reference)
 * Expects attachments array to contain keys like "experience_attachment_0_0" which correspond to uploaded file fieldnames
 */
const handleDetailAttachments = async (req, res, detailArray = [], allFiles = [], folder, transaction) => {
  if (!Array.isArray(detailArray) || detailArray.length === 0) {
    return detailArray;
  }

  console.log("onboarding_debug.log", `[handleDetailAttachments] Processing detail array with ${detailArray.length} items`);
  console.log("onboarding_debug.log", `[handleDetailAttachments] Available files: ${allFiles.map(f => f.fieldname).join(", ")}`);

  const updatedDetails = await Promise.all(
    detailArray.map(async (detail, detailIndex) => {
      const updatedDetail = { ...detail };
      
      if (updatedDetail.attachments && Array.isArray(updatedDetail.attachments)) {
        console.log("onboarding_debug.log", `[handleDetailAttachments] Detail ${detailIndex} has ${updatedDetail.attachments.length} attachments: ${JSON.stringify(updatedDetail.attachments)}`);
        
        const processedAttachments = await Promise.all(
          updatedDetail.attachments.map(async (attachmentKey) => {
            // If attachment is already a string filename (not a key pattern), keep it
            if (typeof attachmentKey === 'string' && !attachmentKey.includes('_attachment_')) {
              console.log("onboarding_debug.log", `[handleDetailAttachments] Keeping existing filename: ${attachmentKey}`);
              return attachmentKey;
            }
            
            // If attachment is a key pattern, try to find and upload the file
            if (typeof attachmentKey === 'string') {
              const uploadedFile = allFiles.find(f => f.fieldname === attachmentKey);
              if (uploadedFile) {
                console.log("onboarding_debug.log", `[handleDetailAttachments] Found file for key ${attachmentKey}: ${uploadedFile.originalname}`);
                const tempReq = { files: { [attachmentKey]: uploadedFile } };
                const saved = await uploadFile(tempReq, res, folder, transaction);
                if (saved[attachmentKey]) {
                  console.log("onboarding_debug.log", `[handleDetailAttachments] Saved file for key ${attachmentKey}: ${saved[attachmentKey]}`);
                  return saved[attachmentKey];
                }
              } else {
                console.log("onboarding_debug.log", `[handleDetailAttachments] NO file found for key ${attachmentKey}`);
              }
            }
            
            // If no file found, return null to remove invalid attachment
            return null;
          })
        );
        
        // Filter out null values
        updatedDetail.attachments = processedAttachments.filter(a => a !== null);
        console.log("onboarding_debug.log", `[handleDetailAttachments] Detail ${detailIndex} after processing: ${updatedDetail.attachments.length} attachments`);
      }
      
      return updatedDetail;
    })
  );

  return updatedDetails;
};

module.exports = {
  handleCustomFieldImages,
  generateCustomFieldImageUrls,
  handleDetailAttachments
};