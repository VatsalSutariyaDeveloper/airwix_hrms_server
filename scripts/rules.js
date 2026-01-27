// Adjust this path to point to your actual models folder
const { StateMaster, StatutoryPTRule, StatutoryLWFRule, sequelize } = require("../models");
 
// --- THE MASTER DATA (Indian Govt Rules) ---
const INDIAN_PT_RULES = {
    "Gujarat": [
        { min: 0, max: 5999, amount: 0 },
        { min: 6000, max: 8999, amount: 80 },
        { min: 9000, max: 11999, amount: 150 },
        { min: 12000, max: null, amount: 200 }, 
    ],
    "Maharashtra": [
        { min: 0, max: 7500, amount: 0, gender: 1 }, // Male
        { min: 7501, max: 10000, amount: 175, gender: 1 },
        { min: 10001, max: null, amount: 200, march_amount: 300, gender: 3 }, 
        { min: 0, max: 10000, amount: 0, gender: 2 }, // Female
    ],
    "Karnataka": [
        { min: 0, max: 14999, amount: 0 },
        { min: 15000, max: null, amount: 200 },
    ],
    "Telangana": [
        { min: 0, max: 15000, amount: 0 },
        { min: 15001, max: 20000, amount: 150 },
        { min: 20001, max: null, amount: 200 },
    ],
    "Andhra Pradesh": [
        { min: 0, max: 15000, amount: 0 },
        { min: 15001, max: 20000, amount: 150 },
        { min: 20001, max: null, amount: 200 },
    ],
    "West Bengal": [
        { min: 0, max: 10000, amount: 0 },
        { min: 10001, max: 15000, amount: 110 },
        { min: 15001, max: 25000, amount: 130 },
        { min: 25001, max: 40000, amount: 150 },
        { min: 40001, max: null, amount: 200 },
    ],
    "Madhya Pradesh": [
        { min: 0, max: 18750, amount: 0 }, 
        { min: 18751, max: null, amount: 208, march_amount: 212 }, 
    ]
};
 
const INDIAN_LWF_RULES = {
    "Gujarat": { ee: 6, er: 12, months: [6, 12] },     
    "Maharashtra": { ee: 12, er: 36, months: [6, 12] }, 
    "Karnataka": { ee: 20, er: 40, months: [12] },      
    "Tamil Nadu": { ee: 10, er: 20, months: [12] },     
    "Haryana": { ee: 10, er: 20, months: [1,2,3,4,5,6,7,8,9,10,11,12] }, 
    "Delhi": { ee: 0, er: 0, months: [] }               
};
 
const seedStatutoryData = async () => {
    let transaction;
    try {
        console.log("🚀 Starting Statutory Data Seeding...");
 
        // Ensure DB connection is active
        await sequelize.authenticate();
        console.log("✅ Database Connected.");
 
        transaction = await sequelize.transaction();
 
        // 1. Fetch all States from your DB
        const allStates = await StateMaster.findAll({ raw: true });
 
        if (!allStates.length) {
            console.error("❌ State Master is empty! Please add states first.");
            process.exit(1);
        }
 
        const ptInsertData = [];
        const lwfInsertData = [];
        let matchedStates = 0;
 
        // 2. Loop through rules and match with DB IDs
        allStates.forEach(state => {
            const stateName = state.state_name; // Ensure this matches your DB column name
            const stateId = state.id;
 
            // --- PREPARE PT RULES ---
            if (INDIAN_PT_RULES[stateName]) {
                const rules = INDIAN_PT_RULES[stateName];
                rules.forEach(rule => {
                    ptInsertData.push({
                        state_id: stateId, 
                        min_salary: rule.min,
                        max_salary: rule.max,
                        monthly_amount: rule.amount,
                        march_amount: rule.march_amount || null,
                        gender: rule.gender || 3, 
                        active: true
                    });
                });
                matchedStates++;
            }
 
            // --- PREPARE LWF RULES ---
            if (INDIAN_LWF_RULES[stateName]) {
                const rule = INDIAN_LWF_RULES[stateName];
                lwfInsertData.push({
                    state_id: stateId,
                    employee_contribution: rule.ee,
                    employer_contribution: rule.er,
                    deduction_months: rule.months, 
                    active: true
                });
            }
        });
 
        console.log(`ℹ️ Found rules for ${matchedStates} states in your database.`);
 
        // 3. Optional: Clear old data to prevent duplicates
        console.log("🧹 Clearing old statutory rules...");
        await StatutoryPTRule.destroy({ where: {}, transaction });
        await StatutoryLWFRule.destroy({ where: {}, transaction });
 
        // 4. Bulk Insert
        if (ptInsertData.length > 0) {
            console.log(`INSERTING: ${ptInsertData.length} PT Rules...`);
            await StatutoryPTRule.bulkCreate(ptInsertData, { transaction });
        }
        if (lwfInsertData.length > 0) {
            console.log(`INSERTING: ${lwfInsertData.length} LWF Rules...`);
            await StatutoryLWFRule.bulkCreate(lwfInsertData, { transaction });
        }
 
        await transaction.commit();
        console.log("✅ SUCCESS: Statutory Data Seeded Successfully!");
        process.exit(0);
 
    } catch (err) {
        if (transaction) await transaction.rollback();
        console.error("❌ ERROR:", err.message);
        process.exit(1);
    }
};
 
// Execute the function
seedStatutoryData();