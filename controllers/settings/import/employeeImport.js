const { parentPort, workerData } = require("worker_threads");
const { sequelize, commonQuery, constants } = require("../../../helpers");
const { Employee, Department, DesignationMaster, StateMaster, CustomField, BranchMaster, CompanyMaster } = require("../../../models");
const { transformRows } = require("../../../helpers/functions/excelService");
const { Op } = require("sequelize");
const xlsx = require("xlsx");
const fs = require("fs");
const { fail } = require('../../../helpers/Err');
const { requestContext } = require("../../../utils/requestContext");

const moment = require("moment");


function parseExcelDate(value, rowIndex, fieldName = "Date") {
    if (value === undefined || value === null || value === "") {
        return null;
    }

    // 1️⃣ If value is already a JS Date
    if (value instanceof Date && !isNaN(value)) {
        return value;
    }

    // 2️⃣ If Excel numeric date (e.g. 45567)
    if (typeof value === "number") {
        if (value <= 0) return null; // Handle zero or negative dates gracefully
        const excelEpoch = new Date(Date.UTC(1899, 11, 30));
        const parsed = new Date(excelEpoch.getTime() + value * 86400000);

        if (isNaN(parsed)) {
            return null; // Return null instead of throwing to keep processing
        }
        return parsed;
    }

    // 3️⃣ If string date
    if (typeof value === "string") {
        const formats = [
            "DD-MM-YYYY",
            "DD/MM/YYYY",
            "YYYY-MM-DD",
            "MM/DD/YYYY"
        ];

        const m = moment(value.trim(), formats, true);
        if (!m.isValid()) {
            throw new Error(`Row ${rowIndex}: Invalid ${fieldName}`);
        }

        return m.toDate();
    }

    throw new Error(`Row ${rowIndex}: Invalid ${fieldName}`);
}

const normalizeText = (v) => {
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    return s === "" ? null : s.toLowerCase();
};

const normalizeHeader = (h) => {
    if (h === undefined || h === null) return "";
    return String(h).trim().toLowerCase().replace(/[^a-z0-9]/g, "");
};

const getGenderValue = (v) => {
    const s = String(v || "").trim().toLowerCase();
    if (!s) return null;
    if (s.startsWith("m") || s.includes("male")) return 1;
    if (s.startsWith("f") || s.includes("female")) return 2;
    if (s.startsWith("o") || s.includes("other")) return 3;
    return null;
};

const getMaritalStatusValue = (v) => {
    const s = String(v || "").trim().toLowerCase();
    if (!s) return null;
    if (s.startsWith("m")) return 1; // Married
    if (s.startsWith("u") || s.startsWith("n") || s.startsWith("s")) return 2; // Unmarried / Single / No
    return null;
};

const BLOOD_GROUP_MAP = {
    "a+": 1, "a positive": 1, "a-": 2, "a negative": 2,
    "b+": 3, "b positive": 3, "b-": 4, "b negative": 4,
    "o+": 5, "o positive": 5, "o-": 6, "o negative": 6,
    "ab+": 7, "ab positive": 7, "ab-": 8, "ab negative": 8
};

const getEmployeeTypeDetails = (typeStr, codeStr) => {
    const s = String(typeStr || '').trim().toLowerCase();
    const c = String(codeStr || '').trim().toLowerCase();
    
    let employee_type = 1; // Default to Staff
    let worker_type = null;

    // Check for on-role/off-role first as it implies Worker type
    if (s.includes('on-role') || s.includes('on role')) {
        return { employee_type: 2, worker_type: 1 };
    }
    if (s.includes('off-role') || s.includes('off role')) {
        return { employee_type: 2, worker_type: 2 };
    }

    if (s.includes('staff')) {
        employee_type = 1;
    } else if (s.includes('worker') || c.includes('worker')) {
        employee_type = 2;
        // Check code for on-role/off-role if not in type string
        if (c.includes('on-role') || c.includes('on role')) {
            worker_type = 1; 
        } else if (c.includes('off-role') || c.includes('off role')) {
            worker_type = 2; 
        }
    } else if (s.includes('contractor')) {
        employee_type = 3; // Contractor
    } else if (s === '1' || s === '2' || s === '3') {
        employee_type = parseInt(s);
    }
    
    return { employee_type, worker_type };
};

const getWorkerTypeValue = (v) => {
    const s = String(v || "").trim().toLowerCase();
    if (!s) return null;
    if (s.includes('on-role') || s.includes('on role') || s === '1') return 1;
    if (s.includes('off-role') || s.includes('off role') || s === '2') return 2;
    return null;
};

const getBloodGroupValue = (v) => {
    let s = String(v || "").trim().toLowerCase().replace(/'/g, '').replace(/\s+/g, " ");
    if (!s) return null;
    // Handle variants like "b positive" vs "b+"
    if (s === "b+ positive") s = "b+";
    return BLOOD_GROUP_MAP[s] || null;
};

const getBooleanValue = (v) => {
    if (v === undefined || v === null) return false;
    if (typeof v === "boolean") return v;
    const s = String(v).trim().toLowerCase();
    return ["true", "1", "yes", "y"].includes(s);
};

let isCancelled = false;
let transaction = null;
let errorFileStream = null;

if (parentPort) {
    parentPort.on("message", async (msg) => {
        if (msg.command === "ABORT") {
            isCancelled = true;
            if (transaction && !transaction.finished) {
                try { await transaction.rollback(); } catch (e) { }
            }
            if (errorFileStream) errorFileStream.end();
            parentPort.postMessage({ status: "CANCELLED" });
            process.exit(0);
        }
    });
}

const writeError = (stream, row, errorMessage) => {
    const errorRow = { ...row, Error: errorMessage };
    if (stream.writable) stream.write(JSON.stringify(errorRow) + '\n');
};

const runWorker = async () => {
    try { await sequelize.authenticate(); } catch (error) {
        parentPort.postMessage({ status: "ERROR", error: "Database connection failed." });
        process.exit(1);
    }

    const { filePath, errorLogPath, body, user_id, branch_id, company_id } = workerData;

    let fieldMapping = {};
    
    // Read Excel headers first for auto-mapping
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    
    // 🔍 Find the header row dynamically
    const allRows = xlsx.utils.sheet_to_json(worksheet, { header: 1 });
    let headerRowIndex = 0;
    const HEADER_KEYWORDS = ["employee code", "sr.no", "name", "first name", "doj", "joining date"];

    for (let i = 0; i < Math.min(allRows.length, 20); i++) {
        const rowData = (allRows[i] || []).map(c => String(c || "").trim().toLowerCase());
        const matchCount = HEADER_KEYWORDS.filter(k => rowData.includes(k)).length;
        if (matchCount >= 2) { // Require at least 2 matches
            headerRowIndex = i;
            break;
        }
    }

    const excelHeaders = (allRows[headerRowIndex] || [])
        .map(h => String(h || "").trim())
        .filter(Boolean);
    
    // Auto-match common required fields even if required_fields is not provided
    const COMMON_FIELD_MAPPINGS = [
        { key: "first_name", aliases: ["first name", "name", "full name", "employee", "emp name", "employee name", "emp. name"] },
        { key: "employee_type", aliases: ["employee type", "emp type", "emp. type", "type", "staff type"] },
        { key: "worker_type", aliases: ["worker type", "employment type"] },
        { key: "joining_date", aliases: ["date of joing", "date of joining", "doj", "joining date", "doj."] },
        { key: "dob", aliases: ["date of birth", "dob", "birth date", "dob."] },
        { key: "gender", aliases: ["gender", "sex"] },
        { key: "mobile_no", aliases: ["mobile number", "mobile", "phone", "phone number", "contact", "mobile no",  "mo no", "monumber", "mo.no", "mob.", "mobile no."] },
        { key: "department_id", aliases: ["department", "dept", "dept."] },
        { key: "designation_id", aliases: ["designation", "desig", "desig."] },
        { key: "employee_code", aliases: ["employee code", "emp code", "code", "emp. code", "employee id", "emp id"] },
        { key: "attendance_supervisor", aliases: ["attendance supervisor", "supervisor"] },
        { key: "is_attendance_supervisor", aliases: ["is attendance supervisor", "attendance supervisor flag"] },
        { key: "reporting_manager", aliases: ["reporting manager", "manager"] },
        { key: "is_reporting_manager", aliases: ["is reporting manager", "reporting manager flag"] },
        { key: "email", aliases: ["email", "email address"] },
        { key: "marital_status", aliases: ["marital status", "marital"] },
        { key: "blood_group", aliases: ["blood group", "blood"] },
        { key: "physically_challenged", aliases: ["physically challenged", "disabled"] },
        { key: "emergency_contact_mobile", aliases: ["emergency contact mobile", "emergency mobile", "emergency contact"] },
        { key: "father_name", aliases: ["father name", "father"] },
        { key: "mother_name", aliases: ["mother name", "mother"] },
        { key: "spouse_name", aliases: ["spouse name", "spouse"] },
        { key: "same_as_current", aliases: ["same as current", "same as present"] },
        { key: "permanent_address1", aliases: ["permanent address1", "permanent address 1", "address", "permanent address"] },
        { key: "permanent_address2", aliases: ["permanent address2", "permanent address 2"] },
        { key: "permanent_city", aliases: ["permanent city", "permanent city name"] },
        { key: "permanent_pincode", aliases: ["permanent pincode", "permanent pin", "permanent zipcode"] },
        { key: "permanent_state_id", aliases: ["permanent state", "permanent state name"] },
        { key: "permanent_country_id", aliases: ["permanent country", "permanent country name"] },
        { key: "present_address1", aliases: ["present address1", "present address 1"] },
        { key: "present_address2", aliases: ["present address2", "present address 2"] },
        { key: "present_city", aliases: ["present city", "present city name"] },
        { key: "present_pincode", aliases: ["present pincode", "present pin", "present zipcode"] },
        { key: "present_state_id", aliases: ["present state", "present state name"] },
        { key: "present_country_id", aliases: ["present country", "present country name"] },
        { key: "uan_number", aliases: ["uan number", "uan"] },
        { key: "name_as_per_pan", aliases: ["name as per pan", "pan name"] },
        { key: "pan_number", aliases: ["pan number", "pan", "pan no.", "pan_no.", "pan no", "pan_no"] },
        { key: "name_as_per_aadhaar", aliases: ["name as per aadhaar", "aadhaar name"] },
        { key: "aadhaar_number", aliases: ["aadhaar number", "aadhaar"] },
        { key: "pf_number", aliases: ["pf number", "pf"] },
        { key: "pf_joining_date", aliases: ["pf joining date", "pf doj"] },
        { key: "pf_eligible", aliases: ["pf eligible", "pf eligibility"] },
        { key: "esi_eligible", aliases: ["esi eligible", "esi eligibility", "esi status", "esic status", "esic eligibility", "esic eligible", "esic"] },
        { key: "esi_number", aliases: ["esi number", "esi", "esic number", "esic no", "esic no.", "esic"] },
        { key: "pt_eligible", aliases: ["pt eligible", "pt eligibility"] },
        { key: "lwf_eligible", aliases: ["lwf eligible", "lwf eligibility"] },
        { key: "eps_eligible", aliases: ["eps eligible", "eps eligibility"] },
        { key: "eps_joining_date", aliases: ["eps joining date", "eps doj"] },
        { key: "eps_exit_date", aliases: ["eps exit date", "eps exit"] },
        { key: "hps_eligible", aliases: ["hps eligible", "hps eligibility"] },
        { key: "driving_license_number", aliases: ["driving license number", "driving license", "dl"] },
        { key: "employee_grade", aliases: ["employee grade", "grade", "emp grade"] },
        { key: "voter_id_number", aliases: ["voter id number", "voter id"] },
        { key: "name_as_per_bank", aliases: ["name as per bank", "bank name"] },
        { key: "bank_name", aliases: ["bank name", "bank"] },
        { key: "bank_account_number", aliases: ["bank account number", "account number", "bank account"] },
        { key: "bank_ifsc_code", aliases: ["bank ifsc code", "ifsc code", "ifsc"] },
        { key: "bank_account_holder_name", aliases: ["bank account holder name", "account holder name"] },
        { key: "upi_id", aliases: ["upi id", "upi"] },
        { key: "education_details", aliases: ["education details", "education", "qualification", "degree"] },
        { key: "exit_date", aliases: ["exit date", "doe", "date of exit"] }
    ];
    
    // Always run auto-match for any headers that haven't been mapped yet
    COMMON_FIELD_MAPPINGS.forEach(requiredField => {
        // If this field key isn't already mapped to some header...
        if (!Object.values(fieldMapping).includes(requiredField.key)) {
            const matchedHeader = excelHeaders.find(header => {
                const normalizedHeader = normalizeHeader(header);
                return requiredField.aliases.some(alias => 
                    normalizedHeader === normalizeHeader(alias)
                );
            });
            
            if (matchedHeader && !fieldMapping[matchedHeader]) {
                fieldMapping[matchedHeader] = requiredField.key;
            }
        }
    });
    // Also map user-provided required_fields if available
    if (body.required_fields && Array.isArray(body.required_fields)) {
        body.required_fields.forEach(requiredField => {
            if (requiredField.key && requiredField.aliases && Array.isArray(requiredField.aliases)) {
                const matchedHeader = excelHeaders.find(header => {
                    const normalizedHeader = normalizeHeader(header);
                    return requiredField.aliases.some(alias => 
                        normalizedHeader === normalizeHeader(alias)
                    );
                });
                
                if (matchedHeader) {
                    fieldMapping[matchedHeader] = requiredField.key;
                }
            }
        });
    }

    const normalizeCompanyAccess = (access) => {
        if (Array.isArray(access)) return access.map(String);
        if (typeof access === "string") return access.split(",").map((id) => id.trim()).filter(Boolean);
        return [];
    };
    let companyAccessList = [];
    if (workerData.is_super_admin) {
        let orgId = workerData.organization_id;
        if (!orgId && company_id) {
            const currentCompany = await CompanyMaster.findOne({
                where: { id: company_id },
                attributes: ['organization_id'],
                raw: true
            });
            if (currentCompany) {
                orgId = currentCompany.organization_id;
            }
        }

        if (orgId) {
            const orgCompanies = await CompanyMaster.findAll({
                where: { organization_id: orgId, status: { [Op.ne]: 2 } },
                attributes: ['id'],
                raw: true
            });
            companyAccessList = orgCompanies.map(c => String(c.id));
        }
    } else {
        companyAccessList = normalizeCompanyAccess(workerData.company_access || "");
    }
    if (company_id && !companyAccessList.includes(String(company_id))) {
        companyAccessList.push(String(company_id));
    }

    const activeCustomFields = await commonQuery.findAllRecords(
        CustomField,
        {
            company_id: { [Op.in]: companyAccessList.map(Number) },
            entity_id: constants.EMPLOYEE_ENTITY_ID,
            status: 0
        },
        { attributes: ['id', 'field_name', 'field_label', 'field_type'], raw: true },null,{}
    );

    // Fetch all active branches for allowed companies
    const branchWhere = { status: 0 };
    if (companyAccessList.length > 0) {
        branchWhere.company_id = { [Op.in]: companyAccessList.map(Number) };
    } else {
        branchWhere.company_id = company_id;
    }
    const branches = await commonQuery.findAllRecords(
        BranchMaster,
        branchWhere,
        {attributes: ['id', 'branch_name', 'company_id']},null, { company_id: true }
    );

    // Create branch name to branch object mapping for quick lookup
    const branchNameToBranchMap = {};
    branches.forEach(branch => {
        branchNameToBranchMap[normalizeHeader(branch.branch_name)] = branch;
    });

    activeCustomFields.forEach(cf => {
        const matchedHeader = excelHeaders.find(header => {
            const normalizedHeader = normalizeHeader(header);
            return normalizedHeader === normalizeHeader(cf.field_name) || normalizedHeader === normalizeHeader(cf.field_label);
        });
        if (matchedHeader) {
            fieldMapping[matchedHeader] = `CUSTOM_FIELD_${cf.field_name}`;
        }
    });

    try {
        errorFileStream = fs.createWriteStream(errorLogPath);
        const originalRows = xlsx.utils.sheet_to_json(worksheet, { range: headerRowIndex });
        const headers = (allRows[headerRowIndex] || []).map(h => String(h || "").trim());
        const rows = transformRows(originalRows, headers, fieldMapping);
        
        if (isCancelled) fail("IMPORT_CANCELLED");

        transaction = await sequelize.transaction();

        // Pre-resolve company and branch for each row
        const resolvedRows = rows.map((record, index) => {
            const originalRecord = originalRows[index] || {};
            let rowBranchId = branch_id;
            let rowCompanyId = company_id;

            const workLocationKey = Object.keys(originalRecord).find(k => 
                normalizeHeader(k) === "worklocation" || 
                normalizeHeader(k) === "workrelatedlocation" ||
                normalizeHeader(k) === "location" ||
                normalizeHeader(k) === "branch" ||
                normalizeHeader(k) === "branchname"
            );
            
            if (workLocationKey && originalRecord[workLocationKey]) {
                const workLocation = String(originalRecord[workLocationKey]).trim();
                const normalizedWorkLocation = normalizeHeader(workLocation);
                
                if (branchNameToBranchMap[normalizedWorkLocation]) {
                    rowBranchId = branchNameToBranchMap[normalizedWorkLocation].id;
                    rowCompanyId = branchNameToBranchMap[normalizedWorkLocation].company_id;
                }
            }
            return {
                record,
                originalRecord,
                rowBranchId,
                rowCompanyId
            };
        });

        // Initialize error tracking variables before use
        let errorCount = 0;
        const errorSample = [];
        const MAX_SAMPLE = 10;

        // 1. Collect all unique identifiers to check against DB
        const employeeCodeSet = new Set();
        const mobileNoSet = new Set();
        const emailsSet = new Set();
        const panNumbersSet = new Set();
        const uanNumbersSet = new Set();
        const aadhaarNumbersSet = new Set();
        const drivingLicensesSet = new Set();
        const voterIdsSet = new Set();
        const bankAccountNumbersSet = new Set();

        resolvedRows.forEach((item) => {
            const r = item.record;
            if (r.employee_code) employeeCodeSet.add(String(r.employee_code).trim());
            if (r.mobile_no) mobileNoSet.add(String(r.mobile_no).trim());
            if (r.email) emailsSet.add(String(r.email).trim().toLowerCase());
            if (r.pan_number) panNumbersSet.add(String(r.pan_number).trim().toUpperCase());
            if (r.uan_number) uanNumbersSet.add(String(r.uan_number).trim());
            if (r.aadhaar_number) {
                const cleanAadhaar = String(r.aadhaar_number).replace(/\s/g, '');
                if (cleanAadhaar) aadhaarNumbersSet.add(cleanAadhaar);
            }
            if (r.driving_license_number) drivingLicensesSet.add(String(r.driving_license_number).trim().toUpperCase());
            if (r.voter_id_number) voterIdsSet.add(String(r.voter_id_number).trim().toUpperCase());
            if (r.bank_account_number) bankAccountNumbersSet.add(String(r.bank_account_number).trim());
        });

        // 2. Fetch existing records from database for all unique fields
        // orConditions will store conditions that will be checked in a single query using Op.or
        const orConditions = [];

        // employee_code check is always company specific, queried across all allowed companies
        if (employeeCodeSet.size > 0) {
            orConditions.push({
                company_id: { [Op.in]: companyAccessList.map(Number) },
                employee_code: { [Op.in]: Array.from(employeeCodeSet) }
            });
        }

        // mobile_no check is global across the whole database (per user request)
        if (mobileNoSet.size > 0) {
            orConditions.push({ mobile_no: { [Op.in]: Array.from(mobileNoSet) } });
        }

        // Other identifiers are also checked globally for a robust uniqueness check
        if (emailsSet.size > 0) orConditions.push({ email: { [Op.in]: Array.from(emailsSet) } });
        if (panNumbersSet.size > 0) orConditions.push({ pan_number: { [Op.in]: Array.from(panNumbersSet) } });
        if (aadhaarNumbersSet.size > 0) orConditions.push({ aadhaar_number: { [Op.in]: Array.from(aadhaarNumbersSet) } });
        if (uanNumbersSet.size > 0) orConditions.push({ uan_number: { [Op.in]: Array.from(uanNumbersSet) } });
        if (drivingLicensesSet.size > 0) orConditions.push({ driving_license_number: { [Op.in]: Array.from(drivingLicensesSet) } });
        if (voterIdsSet.size > 0) orConditions.push({ voter_id_number: { [Op.in]: Array.from(voterIdsSet) } });
        if (bankAccountNumbersSet.size > 0) orConditions.push({ bank_account_number: { [Op.in]: Array.from(bankAccountNumbersSet) } });

        const employeeData = {
            dbEmpCodeSet: new Set(),
            dbEmpMobileSet: new Set(),
            dbEmailSet: new Set(),
            dbPanSet: new Set(),
            dbUanSet: new Set(),
            dbAadhaarSet: new Set(),
            dbDrivingLicenseSet: new Set(),
            dbVoterIdSet: new Set(),
            dbBankAccountSet: new Set(),

            fileEmpCodeSet: new Set(),
            fileEmpMobileSet: new Set(),

            fileTrackingEmployeeMap: new Map(),
            
            // Map to track existing employees by employee_code for updates (keyed by `${company_id}_${code}`)
            existingEmployeeMap: new Map()
        };

        if (orConditions.length > 0) {
            const existingInDb = await commonQuery.findAllRecords(
                Employee,
                {
                    status: { [Op.ne]: 2 }, // Not deleted
                    [Op.or]: orConditions
                },
                { 
                    attributes: ['id', 'company_id', 'employee_code', 'mobile_no', 'email', 'pan_number', 'aadhaar_number', 'uan_number', 'driving_license_number', 'voter_id_number', 'bank_account_number'],
                    raw: true 
                },
                transaction,
                {} // Pass empty object to bypass the automatic company_id filter in commonQuery.findAllRecords
            );

            existingInDb.forEach(emp => {
                // employee_code is specifically company-bound; we only record it if it belongs to one of allowed companies
                if (companyAccessList.includes(String(emp.company_id))) {
                    if (emp.employee_code) {
                        const normalizedCode = String(emp.employee_code).trim().toLowerCase();
                        const key = `${emp.company_id}_${normalizedCode}`;
                        employeeData.dbEmpCodeSet.add(key);
                        // Store full employee record for updates
                        employeeData.existingEmployeeMap.set(key, emp);
                    }
                }

                // Other identifiers are tracked globally so we can prevent duplicates across companies
                if (emp.mobile_no) employeeData.dbEmpMobileSet.add(String(emp.mobile_no).trim());
                if (emp.email) employeeData.dbEmailSet.add(String(emp.email).trim().toLowerCase());
                if (emp.pan_number) employeeData.dbPanSet.add(String(emp.pan_number).trim().toUpperCase());
                if (emp.aadhaar_number) employeeData.dbAadhaarSet.add(String(emp.aadhaar_number).replace(/\s/g, ''));
                if (emp.uan_number) employeeData.dbUanSet.add(String(emp.uan_number).trim());
                if (emp.driving_license_number) employeeData.dbDrivingLicenseSet.add(String(emp.driving_license_number).trim().toUpperCase());
                if (emp.voter_id_number) employeeData.dbVoterIdSet.add(String(emp.voter_id_number).trim().toUpperCase());
                if (emp.bank_account_number) employeeData.dbBankAccountSet.add(String(emp.bank_account_number).trim());
            });
        }

        // 3. Check for conflicts (within Excel AND against Database) - Only block actual conflicts
        for (let i = 0; i < resolvedRows.length; i++) {
            const { record, originalRecord, rowBranchId, rowCompanyId } = resolvedRows[i];
            const rowIndex = i + 2;

            const trimmedEmpCode = record.employee_code ? String(record.employee_code).trim() : null;
            const empCode = trimmedEmpCode ? trimmedEmpCode.toLowerCase() : null;
            const mobile = record.mobile_no ? String(record.mobile_no).trim() : null;
            const email = record.email ? String(record.email).trim().toLowerCase() : null;
            const pan = record.pan_number ? String(record.pan_number).trim().toUpperCase() : null;
            const uan = record.uan_number ? String(record.uan_number).trim() : null;
            const aadhaar = record.aadhaar_number ? String(record.aadhaar_number).replace(/\s/g, '') : null;
            const drivingLicense = record.driving_license_number ? String(record.driving_license_number).trim().toUpperCase() : null;
            const voterId = record.voter_id_number ? String(record.voter_id_number).trim().toUpperCase() : null;
            const bankAccount = record.bank_account_number ? String(record.bank_account_number).trim() : null;

            const conflicts = [];
            
            // Check Excel-to-Excel duplicates scoped to company
            if (empCode && resolvedRows.filter((item, idx) => idx !== i && item.record.employee_code && String(item.record.employee_code).trim().toLowerCase() === empCode && item.rowCompanyId === rowCompanyId).length > 0) conflicts.push(`Employee Code '${trimmedEmpCode}' (Excel Duplicate within company)`);
            if (mobile && resolvedRows.filter((item, idx) => idx !== i && item.record.mobile_no && String(item.record.mobile_no).trim() === mobile).length > 0) conflicts.push(`Mobile '${mobile}' (Excel Duplicate)`);
            if (email && resolvedRows.filter((item, idx) => idx !== i && item.record.email && String(item.record.email).trim().toLowerCase() === email).length > 0) conflicts.push(`Email '${email}' (Excel Duplicate)`);
            if (pan && resolvedRows.filter((item, idx) => idx !== i && item.record.pan_number && String(item.record.pan_number).trim().toUpperCase() === pan).length > 0) conflicts.push(`PAN '${pan}' (Excel Duplicate)`);
            if (uan && resolvedRows.filter((item, idx) => idx !== i && item.record.uan_number && String(item.record.uan_number).trim() === uan).length > 0) conflicts.push(`UAN '${uan}' (Excel Duplicate)`);
            if (aadhaar && resolvedRows.filter((item, idx) => idx !== i && item.record.aadhaar_number && String(item.record.aadhaar_number).replace(/\s/g, '') === aadhaar).length > 0) conflicts.push(`Aadhaar '${record.aadhaar_number}' (Excel Duplicate)`);
            if (drivingLicense && resolvedRows.filter((item, idx) => idx !== i && item.record.driving_license_number && String(item.record.driving_license_number).trim().toUpperCase() === drivingLicense).length > 0) conflicts.push(`Driving License '${drivingLicense}' (Excel Duplicate)`);
            if (voterId && resolvedRows.filter((item, idx) => idx !== i && item.record.voter_id_number && String(item.record.voter_id_number).trim().toUpperCase() === voterId).length > 0) conflicts.push(`Voter ID '${voterId}' (Excel Duplicate)`);
            if (bankAccount && resolvedRows.filter((item, idx) => idx !== i && item.record.bank_account_number && String(item.record.bank_account_number).trim() === bankAccount).length > 0) conflicts.push(`Bank Account '${bankAccount}' (Excel Duplicate)`);

            // Check against Database for conflicts with OTHER employees
            // Employee code existing in DB is OK (will trigger update), but check if it belongs to same company
            const empCodeKey = `${rowCompanyId}_${empCode}`;
            if (empCode && employeeData.dbEmpCodeSet.has(empCodeKey)) {
                const existingEmp = employeeData.existingEmployeeMap.get(empCodeKey);
                if (!existingEmp) {
                    // Employee code exists but in different company - this is a conflict
                    conflicts.push(`Employee Code '${trimmedEmpCode}' (Exists in another company)`);
                }
            }
            
            // For mobile and email, check if they exist in OTHER employees (not the one being updated)
            if (mobile && employeeData.dbEmpMobileSet.has(mobile)) {
                // If this is an update, check if the mobile belongs to the same employee
                if (empCode && employeeData.existingEmployeeMap.has(empCodeKey)) {
                    const existingEmp = employeeData.existingEmployeeMap.get(empCodeKey);
                    if (String(existingEmp.mobile_no).trim() !== mobile) {
                        conflicts.push(`Mobile '${mobile}' (Exists in another employee)`);
                    }
                } else {
                    // Creating new employee but mobile exists - error
                    conflicts.push(`Mobile '${mobile}' (Exists in System)`);
                }
            }
            
            if (email && employeeData.dbEmailSet.has(email)) {
                // If this is an update, check if the email belongs to the same employee
                if (empCode && employeeData.existingEmployeeMap.has(empCodeKey)) {
                    const existingEmp = employeeData.existingEmployeeMap.get(empCodeKey);
                    if (String(existingEmp.email).trim().toLowerCase() !== email) {
                        conflicts.push(`Email '${email}' (Exists in another employee)`);
                    }
                } else {
                    // Creating new employee but email exists - error
                    conflicts.push(`Email '${email}' (Exists in System)`);
                }
            }
            
            // Other identifiers are hard conflicts
            if (pan && employeeData.dbPanSet.has(pan)) conflicts.push(`PAN '${pan}' (Exists in System)`);
            if (uan && employeeData.dbUanSet.has(uan)) conflicts.push(`UAN '${uan}' (Exists in System)`);
            if (aadhaar && employeeData.dbAadhaarSet.has(aadhaar)) conflicts.push(`Aadhaar '${record.aadhaar_number}' (Exists in System)`);
            if (drivingLicense && employeeData.dbDrivingLicenseSet.has(drivingLicense)) conflicts.push(`Driving License '${drivingLicense}' (Exists in System)`);
            if (voterId && employeeData.dbVoterIdSet.has(voterId)) conflicts.push(`Voter ID '${voterId}' (Exists in System)`);
            if (bankAccount && employeeData.dbBankAccountSet.has(bankAccount)) conflicts.push(`Bank Account '${bankAccount}' (Exists in System)`);

            if (conflicts.length > 0) {
                errorCount++;
                const empName = record.first_name ? String(record.first_name).trim() : 'Unknown';
                const errorMessage = `Conflict found for ${empName}: ${conflicts.join(', ')}`;
                errorSample.push(`Row ${rowIndex}: ${errorMessage}`);
                writeError(errorFileStream, originalRecord, errorMessage);
            }
        }

        // If ANY conflicts found (Excel or DB), fail the entire import
        if (errorCount > 0) {
            if (errorFileStream) errorFileStream.end();
            await transaction.rollback();
            parentPort.postMessage({
                status: "SUCCESS",
                result: {
                    importErrors: true,
                    errors: errorSample,
                    errorCount: errorCount,
                    message: `${errorCount} conflict errors found. Please fix conflicts before importing.`
                }
            });
            return;
        }


        const deptCompanyKeys = new Set();
        const desigCompanyKeys = new Set();
        resolvedRows.forEach(item => {
            if (item.record.department_id) {
                deptCompanyKeys.add(`${item.rowCompanyId}_${String(item.record.department_id).trim().toLowerCase()}`);
            }
            if (item.record.designation_id) {
                desigCompanyKeys.add(`${item.rowCompanyId}_${String(item.record.designation_id).trim().toLowerCase()}`);
            }
        });

        // Bulk create/find departments scoped to company
        const existingDepartments = await commonQuery.findAllRecords(
            Department,
            {
                status: 0,
                company_id: { [Op.in]: companyAccessList.map(Number) }
            },
            { attributes: ['id', 'name', 'company_id'], raw: true },
            transaction
        );
        const departmentMap = new Map();
        existingDepartments.forEach(dept => {
            departmentMap.set(`${dept.company_id}_${String(dept.name).toLowerCase()}`, dept.id);
        });

        const deptsToCreate = [];
        deptCompanyKeys.forEach(key => {
            if (!departmentMap.has(key)) {
                const parts = key.split('_');
                const compId = Number(parts[0]);
                const deptName = parts.slice(1).join('_');
                const branchObj = branches.find(b => b.company_id === compId) || { id: branch_id };
                deptsToCreate.push({
                    name: deptName,
                    company_id: compId,
                    branch_id: branchObj.id,
                    user_id,
                    status: 0
                });
            }
        });

        if (deptsToCreate.length > 0) {
            const createdDepts = await commonQuery.bulkCreate(Department, deptsToCreate, {}, transaction);
            createdDepts.forEach(dept => {
                departmentMap.set(`${dept.company_id}_${String(dept.name).toLowerCase()}`, dept.id);
            });
        }

        // Bulk create/find designations scoped to company
        const existingDesignations = await commonQuery.findAllRecords(
            DesignationMaster,
            {
                status: 0,
                company_id: { [Op.in]: companyAccessList.map(Number) }
            },
            { attributes: ['id', 'designation_name', 'company_id'], raw: true },
            transaction
        );
        const designationMap = new Map();
        existingDesignations.forEach(desig => {
            designationMap.set(`${desig.company_id}_${String(desig.designation_name).toLowerCase()}`, desig.id);
        });

        const desigsToCreate = [];
        desigCompanyKeys.forEach(key => {
            if (!designationMap.has(key)) {
                const parts = key.split('_');
                const compId = Number(parts[0]);
                const desigName = parts.slice(1).join('_');
                const branchObj = branches.find(b => b.company_id === compId) || { id: branch_id };
                desigsToCreate.push({
                    designation_name: desigName,
                    company_id: compId,
                    branch_id: branchObj.id,
                    user_id,
                    status: 0
                });
            }
        });

        if (desigsToCreate.length > 0) {
            const createdDesigs = await commonQuery.bulkCreate(DesignationMaster, desigsToCreate, {}, transaction);
            createdDesigs.forEach(desig => {
                designationMap.set(`${desig.company_id}_${String(desig.designation_name).toLowerCase()}`, desig.id);
            });
        }

        const stateMap = new Map();
        const uniqueStatesSet = new Set();
        resolvedRows.forEach((item) => {
            const r = item.record;
            if (r.permanent_state_id) uniqueStatesSet.add(String(r.permanent_state_id).trim());
            if (r.present_state_id) uniqueStatesSet.add(String(r.present_state_id).trim());
        });
        const uniqueStates = Array.from(uniqueStatesSet);

        // Find existing states only (don't create new states)
        const existingStates = await commonQuery.findAllRecords(
            StateMaster,
            {
                status: 0,
                state_name: { [Op.in]: uniqueStates.map(state => String(state).trim()) }
            },
            { attributes: ['id', 'state_name'], raw: true },
            transaction
        );
        
        // Map existing states
        existingStates.forEach(state => {
            stateMap.set(String(state.state_name).toLowerCase(), state.id);
        });


        let createdCount = 0;
        let updatedCount = 0;
        const validEmployees = []; // For new employees
        const updateEmployees = []; // For existing employees to update

        // First validate all rows and collect valid employees
        for (let i = 0; i < resolvedRows.length; i++) {
            if (i % 500 === 0 && i > 0) await new Promise(resolve => setImmediate(resolve));
            if (isCancelled) fail("IMPORT_CANCELLED");

            const { record, originalRecord, rowBranchId, rowCompanyId } = resolvedRows[i];
            const rowIndex = i + 2;

            try {
                const firstNameRaw = record.first_name || '';
                const firstName = String(firstNameRaw).trim();
                const email = String(record.email || '').trim().toLowerCase();
                const mobile = record.mobile_no ? String(record.mobile_no).trim() : null;
                const trimmedEmpCode = record.employee_code ? String(record.employee_code).trim() : null;
                const empCode = trimmedEmpCode ? trimmedEmpCode.toLowerCase() : null;
                const pan = record.pan_number ? String(record.pan_number).trim().toUpperCase() : null;
                const uan = record.uan_number ? String(record.uan_number).trim() : null;
                const aadhaar = record.aadhaar_number ? String(record.aadhaar_number).replace(/\s/g, '') : null;
                const drivingLicense = record.driving_license_number ? String(record.driving_license_number).trim().toUpperCase() : null;
                const voterId = record.voter_id_number ? String(record.voter_id_number).trim().toUpperCase() : null;
                const bankAccount = record.bank_account_number ? String(record.bank_account_number).trim() : null;

                const noiseWords = ["management", "account", "admin", "branding", "design", "proposals", "hr", "safety", "it", "planning", "manufacturing", "purchase", "documentation", "qc", "sales", "store", "project", "aepl worker"];
                if ((!firstName && !empCode && !mobile)) {
                    continue; 
                }

                if (firstName && noiseWords.includes(firstName.toLowerCase())) {
                    continue;
                }

                if (!firstName) fail("First Name is required");
                const exitDate = parseExcelDate(record.exit_date, rowIndex, "Exit Date");
                const joiningDate = parseExcelDate(record.joining_date, rowIndex, "Joining Date");
                const dob = parseExcelDate(record.dob, rowIndex, "DOB");
                const gender = getGenderValue(record.gender);

                // Prepare employee data
                const typeDetails = getEmployeeTypeDetails(record.employee_type, trimmedEmpCode);

                const deptKey = record.department_id ? `${rowCompanyId}_${String(record.department_id).trim().toLowerCase()}` : null;
                const desigKey = record.designation_id ? `${rowCompanyId}_${String(record.designation_id).trim().toLowerCase()}` : null;

                const prepareData = {
                    employee_code: trimmedEmpCode,
                    first_name: firstName,
                    mobile_no: mobile,
                    employee_type: typeDetails.employee_type,
                    worker_type: typeDetails.worker_type || getWorkerTypeValue(record.worker_type),
                    department_id: deptKey ? departmentMap.get(deptKey) : null,
                    designation_id: desigKey ? designationMap.get(desigKey) : null,
                    attendance_supervisor: record.attendance_supervisor,
                    is_attendance_supervisor: record.is_attendance_supervisor,
                    reporting_manager: record.reporting_manager,
                    is_reporting_manager: record.is_reporting_manager,

                    gender: gender,
                    dob: dob,
                    email: email || null,
                    marital_status: getMaritalStatusValue(record.marital_status),
                    blood_group: getBloodGroupValue(record.blood_group),
                    physically_challenged: record.physically_challenged,
                    emergency_contact_mobile: record.emergency_contact_mobile,
                    father_name: normalizeText(record.father_name),
                    mother_name: normalizeText(record.mother_name),
                    spouse_name: normalizeText(record.spouse_name),
                    same_as_current: record.same_as_current,
                    
                    joining_date: joiningDate,
                    exit_date: exitDate,

                    permanent_address1: record.permanent_address1,
                    permanent_address2: record.permanent_address2,
                    permanent_city: record.permanent_city,
                    permanent_pincode: record.permanent_pincode,
                    permanent_state_id: record.permanent_state_id ? (() => {
                        const stateId = stateMap.get(String(record.permanent_state_id).trim().toLowerCase());
                        return stateId || null;
                    })() : null,
                    permanent_country_id: record.permanent_country_id,
                    present_address1: record.present_address1,
                    present_address2: record.present_address2,
                    present_city: record.present_city,
                    present_pincode: record.present_pincode,
                    present_state_id: record.present_state_id ? (() => {
                        const stateId = stateMap.get(String(record.present_state_id).trim().toLowerCase());
                        return stateId || null;
                    })() : null,
                    present_country_id: record.present_country_id,

                    uan_number: uan,
                    name_as_per_pan: record.name_as_per_pan,
                    pan_number: pan,
                    name_as_per_aadhaar: record.name_as_per_aadhaar,
                    aadhaar_number: aadhaar,
                    
                    pf_eligible: getBooleanValue(record.pf_eligible),
                    pf_number: getBooleanValue(record.pf_eligible) ? record.pf_number : null,
                    pf_joining_date: getBooleanValue(record.pf_eligible) ? parseExcelDate(record.pf_joining_date, rowIndex, "PF Joining Date") : null,
                    
                    esi_eligible: getBooleanValue(record.esi_eligible),
                    esi_number: getBooleanValue(record.esi_eligible) ? record.esi_number : null,
                    
                    pt_eligible: getBooleanValue(record.pt_eligible),
                    lwf_eligible: getBooleanValue(record.lwf_eligible),
                    
                    eps_eligible: getBooleanValue(record.eps_eligible),
                    eps_joining_date: getBooleanValue(record.eps_eligible) ? parseExcelDate(record.eps_joining_date, rowIndex, "EPS Joining Date") : null,
                    eps_exit_date: getBooleanValue(record.eps_eligible) ? parseExcelDate(record.eps_exit_date, rowIndex, "EPS Exit Date") : null,
                    
                    hps_eligible: getBooleanValue(record.hps_eligible),
                    driving_license_number: drivingLicense,
                    voter_id_number: voterId,
                    name_as_per_bank: record.name_as_per_bank,
                    bank_name: record.bank_name,
                    bank_account_number: bankAccount,
                    bank_ifsc_code: record.bank_ifsc_code,
                    bank_account_holder_name: record.bank_account_holder_name,
                    upi_id: record.upi_id,
                    education_details: record.education_details ? (Array.isArray(record.education_details) ? record.education_details : [{ education: record.education_details }]) : [],
                    custom_fields: (() => {
                        const cfArray = [];
                        activeCustomFields.forEach(cf => {
                            let value = undefined;
                            const prefixedKey = `CUSTOM_FIELD_${cf.field_name}`;
                            if (record[prefixedKey] !== undefined) {
                                value = record[prefixedKey];
                            } else {
                                const matchedKey = Object.keys(originalRecord).find(k => 
                                    normalizeHeader(k) === normalizeHeader(cf.field_name) || 
                                    normalizeHeader(k) === normalizeHeader(cf.field_label)
                                );
                                if (matchedKey) value = originalRecord[matchedKey];
                            }

                            if (value !== undefined) {
                                cfArray.push({
                                    field_name: cf.field_name,
                                    field_label: cf.field_label,
                                    type: cf.field_type,
                                    value: value
                                });
                            }
                        });
                        return cfArray;
                    })(),
                    employee_grade: record.employee_grade || (() => {
                        const gradeKey = Object.keys(originalRecord).find(k => normalizeHeader(k) === "grade" || normalizeHeader(k) === "employeegrade");
                        return gradeKey ? originalRecord[gradeKey] : null;
                    })(),
                    branch_id: rowBranchId,
                    company_id: rowCompanyId,
                    user_id
                };

                // Auto set status to Exited if exit_date has passed
                if (exitDate && moment(exitDate).startOf('day').isSameOrBefore(moment().startOf('day'))) {
                    prepareData.status = 4; // Exited
                }

                // Check if this is an update or create (by employee_code only scoped to company)
                const empCodeKey = `${rowCompanyId}_${empCode}`;
                if (empCode && employeeData.existingEmployeeMap.has(empCodeKey)) {
                    // This is an existing employee - prepare for update
                    const existingEmp = employeeData.existingEmployeeMap.get(empCodeKey);
                    
                    const updateData = {
                        id: existingEmp.id
                    };
                    
                    Object.keys(prepareData).forEach(key => {
                        if (key !== 'id' && prepareData[key] !== null && prepareData[key] !== undefined && prepareData[key] !== '') {
                            updateData[key] = prepareData[key];
                        }
                    });
                    
                    updateEmployees.push(updateData);
                    updatedCount++;
                } else {
                    validEmployees.push(prepareData);
                    createdCount++;
                }
            } catch (rowError) {
                errorCount++;
                errorSample.push(`Row ${rowIndex}: ${rowError.message}`);
                writeError(errorFileStream, originalRecord, rowError.message);
            }
        } // Close for-loop here

        // Bulk create all new employees
        if (validEmployees.length > 0) {
            await commonQuery.bulkCreate(Employee, validEmployees, {}, transaction, false);
        }
        
        // Bulk update existing employees
        if (updateEmployees.length > 0) {
            for (const emp of updateEmployees) {
                const empId = emp.id;
                delete emp.id; // Remove id from the update data
                await commonQuery.updateRecordById(
                    Employee,
                    { id: empId },
                    emp,
                    transaction
                );
            }
        }

        if (errorFileStream) errorFileStream.end();

        if (errorCount > 0) {
            await transaction.rollback();

            parentPort.postMessage({
                status: "SUCCESS",
                result: {
                    importErrors: true,
                    errors: errorSample,
                    errorCount: errorCount,
                    message: `${errorCount} errors found in the file. No employees were imported. Please fix all errors before importing again.`
                }
            });
            return;
        }

        await transaction.commit();
        const message = updatedCount > 0 
            ? `${createdCount} employees created and ${updatedCount} employees updated successfully.`
            : `${createdCount} employees processed successfully.`;
        parentPort.postMessage({
            status: "SUCCESS",
            result: { success: true, message: message, count: createdCount, updated: updatedCount, errorCount, errors: errorSample }
        });

    } catch (err) {
        if (transaction && !transaction.finished) await transaction.rollback();
        if (errorFileStream) errorFileStream.end();
        if (err.message === "IMPORT_CANCELLED") {
            parentPort.postMessage({ status: "CANCELLED" });
        } else {
            parentPort.postMessage({ status: "ERROR", error: err.message });
        }
    }
};

const startWorker = async () => {
    const { user_id, branch_id, company_id } = workerData;
    const mockStore = {
        userId: user_id,
        companyId: company_id,
        branchId: branch_id,
        is_super_admin: workerData.is_super_admin,
        branch_access: workerData.branch_access,
        ip: "127.0.0.1"
    };

    await requestContext.run(mockStore, async () => {
        await runWorker();
    });
};

startWorker();