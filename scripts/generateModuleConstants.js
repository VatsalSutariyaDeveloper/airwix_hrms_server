// serve/scripts/generateModuleConstants.js

const fs = require('fs');
const path = require('path');
const db = require('../models');

// Access Models
const ModuleMaster = db.ModuleMaster || db.MenuMaster; 
const ModuleEntityMaster = db.ModuleEntityMaster || db.MenuModuleMaster;

const generateModuleConstants = async () => {
  try {
    console.log("🔌 Connecting to database...");
    
    // 1. Fetch Modules with their Entities
    const modules = await ModuleMaster.findAll({
      where: { status: 0 },
      attributes: ['id', 'module_name', 'cust_module_name'],
      include: [
        { 
            model: ModuleEntityMaster, 
            as: 'entities',
            where: { status: 0 },
            required: false,
            attributes: ['id', 'entity_name', 'cust_entity_name'] 
        }
      ],
      order: [['priority', 'ASC']],
      nest: true
    });

    console.log(`✅ Fetched ${modules.length} modules.`);

    // 2. Build the Structures
    const constantTree = {};
    const flatIds = {};
    const flatNames = {};
    
    const formatKey = (str) => str ? str.toUpperCase().replace(/[^A-Z0-9]/g, '_').replace(/_+/g, '_') : 'UNKNOWN';

    modules.forEach((mod) => {
        const modName = mod.cust_module_name || mod.module_name;
        const modKey = formatKey(mod.module_name);

        constantTree[modKey] = {
            ID: mod.id,
            NAME: modName
        };

        if (mod.entities && mod.entities.length > 0) {
            mod.entities.forEach(ent => {
                const entName = ent.cust_entity_name || ent.entity_name;
                const entKey = formatKey(ent.entity_name);

                // Nested Tree
                constantTree[modKey][entKey] = {
                    ID: ent.id,
                    NAME: entName,
                    MODULE_ID: mod.id
                };

                // 🟢 NEW: Separate IDs and Names for the flat object
                flatIds[`${entKey}_ID`] = ent.id;
                flatNames[`${entKey}_NAME`] = entName;
            });
        }
    });

    // 3. Format the Flat Output (Strictly IDs first, then Names)
    const idsLines = Object.entries(flatIds).map(([k, v]) => `  ${k}: ${v}`);
    const namesLines = Object.entries(flatNames).map(([k, v]) => `  ${k}: "${v}"`);
    
    const flatEntitiesString = `{\n  // === ALL IDs ===\n${idsLines.join(',\n')},\n\n  // === ALL NAMES ===\n${namesLines.join(',\n')}\n}`;

    // 4. Format the final File Content
    const fileContent = `/**
 * AUTO-GENERATED MODULE & ENTITY CONSTANTS
 * Generated on: ${new Date().toLocaleString()}
 * Usage: 
 * const { ENTITIES } = require('./moduleEntitiesConstants');
 * console.log(ENTITIES.ITEM_MASTER_ID);
 */

exports.MODULES = ${JSON.stringify(constantTree, null, 2)};

exports.ENTITIES = ${flatEntitiesString};
`;

    // 5. Write to File
    const outputPath = path.resolve(__dirname, '../helpers/moduleEntitiesConstants.js');
    
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)){
        fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(outputPath, fileContent);
    console.log(`🎉 Success! Constants generated at: ${outputPath}`);

  } catch (error) {
    console.error("❌ Error generating constants:", error);
  } finally {
    await db.sequelize.close();
    process.exit();
  }
};

generateModuleConstants();