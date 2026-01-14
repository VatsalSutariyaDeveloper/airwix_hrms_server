// controllers/printSettingsController.js
const { commonQuery, uploadFile, deleteFile, constants } = require('../../helpers');
const { PrintSettings } = require('../../models'); 

// POST /api/print-settings/save
exports.savePrintSettings = async (req, res) => {
  try {
    const { file_name, print_name, entity, user_id, branch_id, company_id } = req.body;
    
    let settings = req.body.settings;
    if (typeof settings === 'string') {
        try {
            settings = JSON.parse(settings);
        } catch (e) {
            console.error("Failed to parse settings JSON", e);
            return res.status(400).json({ success: false, message: "Invalid settings format" });
        }
    }

    // 2. Handle File Uploads
    if (req.files) {
        const savedFiles = await uploadFile(
            req, 
            res, 
            constants.PRINT_SETTINGS_IMG_FOLDER, 
            null 
        );

        if (savedFiles.header_image) {
            settings.headerImageUrl = savedFiles.header_image;
        }
        
        if (savedFiles.footer_image) {
            settings.footerImageUrl = savedFiles.footer_image;
        }

        // ✅ New: Handle Logo Image
        if (savedFiles.logo_image) {
            settings.logoImageUrl = savedFiles.logo_image;
        }
    }

    // 3. Upsert Logic
    const existing = await commonQuery.findOneRecord(PrintSettings, { company_id: company_id, entity_id: entity });

    if (existing) {
        existing.company_id = company_id; 
        existing.user_id = user_id; 
        existing.branch_id = branch_id; 
        existing.file_name = file_name; 
        existing.print_name = print_name;
        existing.entity_id = entity;
        
        // Merge existing config
        const newConfig = { ...existing.config, ...settings };
        existing.config = newConfig;
        
        await existing.save();
    } else {
        await commonQuery.createRecord(
            PrintSettings,
            {   
                company_id: company_id, 
                user_id: user_id, 
                branch_id: branch_id, 
                file_name: file_name, 
                print_name: print_name,
                entity_id: entity,
                config: settings
            }
        );
    }

    return res.json({ success: true, message: "Settings saved successfully" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Server Error" });
  }
};

// GET /api/print-settings/:entity
exports.getPrintSettings = async (req, res) => {
  try {
    const { entity_id, company_id } = req.params;

    const data = await commonQuery.findOneRecord(PrintSettings, { company_id: company_id, entity_id: entity_id });

    if (!data) {
      return res.json({ 
        success: true, 
        settings: null 
      });
    }

    // 4. Append Server URL to images for display
    const config = data.config || {};
    const baseUrl = process.env.FILE_SERVER_URL || "";
    const folder = constants.PRINT_SETTINGS_IMG_FOLDER;
    
    const appendUrl = (path) => {
        if (path && !path.startsWith("http") && !path.startsWith("blob")) {
            return `${baseUrl}${folder}${path}`;
        }
        return path;
    };

    config.headerImageUrl = appendUrl(config.headerImageUrl);
    config.footerImageUrl = appendUrl(config.footerImageUrl);
    config.logoImageUrl = appendUrl(config.logoImageUrl); // ✅ Handle Logo URL

    data.config = config;

    return res.json({ success: true, data: data });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Server Error" });
  }
};