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

      delete field.image_url;
      delete field.image_urls;

      if (type !== "image") return field;

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
              const tempReq = { file: uploadedFile };
              const saved = await uploadFile(tempReq, res, folder, transaction);
              if (saved[k]) {
                  newFiles.push(saved[k]);
              }
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

    if (field.type !== "image") {
      return updatedField;
    }

    const actualImageFolder = field.is_default_image ? 'custom_fields/' : folder;
    
    // Always parse as array
    let valArray = Array.isArray(field.value) ? field.value : (field.value ? [field.value] : []);

    updatedField.image_urls = valArray.map(v => {
      // Check if it's already a full URL
      if (v && (v.startsWith('http://') || v.startsWith('https://'))) {
        return v;
      }
      return `${process.env.FILE_SERVER_URL}${actualImageFolder}${v}`;
    });

    return updatedField;
  });
};

module.exports = {
  handleCustomFieldImages,
  generateCustomFieldImageUrls
};