const { parentPort, workerData } = require("worker_threads");
const { sequelize, commonQuery } = require("../../../helpers");
const { Employee, Department, DesignationMaster, StateMaster } = require("../../../models");
const { transformRows } = require("../../../helpers/functions/excelService");
const { Op } = require("sequelize");
const xlsx = require("xlsx");
const fs = require("fs");
const { fail } = require('../../../helpers/Err');

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
        const excelEpoch = new Date(Date.UTC(1899, 11, 30));
        const parsed = new Date(excelEpoch.getTime() + value * 86400000);

        if (isNaN(parsed)) {
            throw new Error(`Row ${rowIndex}: Invalid ${fieldName}`);
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
    const row = xlsx.utils.sheet_to_json(worksheet, { header: 1 });
    const excelHeaders = (row[0] || [])
        .map(h => String(h || "").trim())
        .filter(Boolean);
    
    // Auto-match common required fields even if required_fields is not provided
    const COMMON_FIELD_MAPPINGS = [
        { key: "first_name", aliases: ["first name", "name", "full name", "employee", "emp name", "employee name"] },
        { key: "joining_date", aliases: ["date of joing", "date of joining", "doj", "joining date"] },
        { key: "dob", aliases: ["date of birth", "dob", "birth date"] },
        { key: "gender", aliases: ["gender", "sex"] },
        { key: "mobile_no", aliases: ["mobile number", "mobile", "phone", "phone number", "contact", "mobile no"] },
        { key: "department_id", aliases: ["department", "dept"] },
        { key: "designation_id", aliases: ["designation", "desig"] },
        { key: "employee_code", aliases: ["employee code", "emp code", "code"] },
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
        { key: "permanent_address1", aliases: ["permanent address1", "permanent address 1"] },
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
        { key: "pan_number", aliases: ["pan number", "pan"] },
        { key: "name_as_per_aadhaar", aliases: ["name as per aadhaar", "aadhaar name"] },
        { key: "aadhaar_number", aliases: ["aadhaar number", "aadhaar"] },
        { key: "pf_number", aliases: ["pf number", "pf"] },
        { key: "pf_joining_date", aliases: ["pf joining date", "pf doj"] },
        { key: "pf_eligible", aliases: ["pf eligible", "pf eligibility"] },
        { key: "esi_eligible", aliases: ["esi eligible", "esi eligibility"] },
        { key: "esi_number", aliases: ["esi number", "esi"] },
        { key: "pt_eligible", aliases: ["pt eligible", "pt eligibility"] },
        { key: "lwf_eligible", aliases: ["lwf eligible", "lwf eligibility"] },
        { key: "eps_eligible", aliases: ["eps eligible", "eps eligibility"] },
        { key: "eps_joining_date", aliases: ["eps joining date", "eps doj"] },
        { key: "eps_exit_date", aliases: ["eps exit date", "eps exit"] },
        { key: "hps_eligible", aliases: ["hps eligible", "hps eligibility"] },
        { key: "driving_license_number", aliases: ["driving license number", "driving license", "dl"] },
        { key: "voter_id_number", aliases: ["voter id number", "voter id"] },
        { key: "name_as_per_bank", aliases: ["name as per bank", "bank name"] },
        { key: "bank_name", aliases: ["bank name", "bank"] },
        { key: "bank_account_number", aliases: ["bank account number", "account number", "bank account"] },
        { key: "bank_ifsc_code", aliases: ["bank ifsc code", "ifsc code", "ifsc"] },
        { key: "bank_account_holder_name", aliases: ["bank account holder name", "account holder name"] },
        { key: "upi_id", aliases: ["upi id", "upi"] }
    ];
    
    // Always map common fields
    COMMON_FIELD_MAPPINGS.forEach(field => {
        const matchedHeader = excelHeaders.find(header => 
            field.aliases.some(alias => 
                String(header).trim().toLowerCase() === String(alias).trim().toLowerCase()
            )
        );
        
        if (matchedHeader) {
            fieldMapping[matchedHeader] = field.key;
        }
    });
    
    // Also map user-provided required_fields if available
    if (body.required_fields && Array.isArray(body.required_fields)) {
        body.required_fields.forEach(requiredField => {
            if (requiredField.key && requiredField.aliases && Array.isArray(requiredField.aliases)) {
                const matchedHeader = excelHeaders.find(header => 
                    requiredField.aliases.some(alias => 
                        String(header).trim().toLowerCase() === String(alias).trim().toLowerCase()
                    )
                );
                
                if (matchedHeader) {
                    fieldMapping[matchedHeader] = requiredField.key;
                }
            }
        });
    }
    
    try {
        errorFileStream = fs.createWriteStream(errorLogPath);
        const rawHeaders = (xlsx.utils.sheet_to_json(worksheet, { header: 1 })[0] || []);
        const headers = rawHeaders.map(h => String(h).trim());
        const originalRows = xlsx.utils.sheet_to_json(worksheet);
        const rows = transformRows(originalRows, headers, fieldMapping);
        
        if (isCancelled) fail("IMPORT_CANCELLED");

        transaction = await sequelize.transaction();

        // Initialize error tracking variables before use
        let errorCount = 0;
        const errorSample = [];
        const MAX_SAMPLE = 10;

        const employeeCode = new Set();
        const mobileNo = new Set();
        const emails = new Set();
        const panNumbers = new Set();
        const uanNumbers = new Set();
        const aadhaarNumbers = new Set();
        const drivingLicenses = new Set();
        const voterIds = new Set();
        const bankAccountNumbers = new Set();

        rows.forEach(r => {
            if (r.employee_code) employeeCode.add(String(r.employee_code).trim().toLowerCase());
            if (r.mobile_no) mobileNo.add(String(r.mobile_no).trim());
            if (r.email) emails.add(String(r.email).trim().toLowerCase());
            if (r.pan_number) panNumbers.add(String(r.pan_number).trim().toUpperCase());
            if (r.uan_number) uanNumbers.add(String(r.uan_number).trim());
            if (r.aadhaar_number) {
                const cleanAadhaar = String(r.aadhaar_number).replace(/\s/g, '');
                if (cleanAadhaar) aadhaarNumbers.add(cleanAadhaar);
            }
            if (r.driving_license_number) drivingLicenses.add(String(r.driving_license_number).trim().toUpperCase());
            if (r.voter_id_number) voterIds.add(String(r.voter_id_number).trim().toUpperCase());
            if (r.bank_account_number) bankAccountNumbers.add(String(r.bank_account_number).trim());
        });

        // Check for duplicates within the Excel file
        for (let i = 0; i < rows.length; i++) {
            const record = rows[i];
            const rowIndex = i + 2;
            const originalRecord = originalRows[i];

            const empCode = record.employee_code ? String(record.employee_code).trim().toLowerCase() : null;
            const mobile = record.mobile_no ? String(record.mobile_no).trim() : null;
            const email = record.email ? String(record.email).trim().toLowerCase() : null;
            const pan = record.pan_number ? String(record.pan_number).trim().toUpperCase() : null;
            const uan = record.uan_number ? String(record.uan_number).trim() : null;
            const aadhaar = record.aadhaar_number ? String(record.aadhaar_number).replace(/\s/g, '') : null;
            const drivingLicense = record.driving_license_number ? String(record.driving_license_number).trim().toUpperCase() : null;
            const voterId = record.voter_id_number ? String(record.voter_id_number).trim().toUpperCase() : null;
            const bankAccount = record.bank_account_number ? String(record.bank_account_number).trim() : null;

            // Check duplicates in current row data
            const duplicates = [];
            if (empCode && rows.filter((r, idx) => idx !== i && r.employee_code && String(r.employee_code).trim().toLowerCase() === empCode).length > 0) {
                duplicates.push(`Employee Code '${record.employee_code}'`);
            }
            if (mobile && rows.filter((r, idx) => idx !== i && r.mobile_no && String(r.mobile_no).trim() === mobile).length > 0) {
                duplicates.push(`Mobile '${mobile}'`);
            }
            if (email && rows.filter((r, idx) => idx !== i && r.email && String(r.email).trim().toLowerCase() === email).length > 0) {
                duplicates.push(`Email '${email}'`);
            }
            if (pan && rows.filter((r, idx) => idx !== i && r.pan_number && String(r.pan_number).trim().toUpperCase() === pan).length > 0) {
                duplicates.push(`PAN '${pan}'`);
            }
            if (uan && rows.filter((r, idx) => idx !== i && r.uan_number && String(r.uan_number).trim() === uan).length > 0) {
                duplicates.push(`UAN '${uan}'`);
            }
            if (aadhaar && rows.filter((r, idx) => idx !== i && r.aadhaar_number && String(r.aadhaar_number).replace(/\s/g, '') === aadhaar).length > 0) {
                duplicates.push(`Aadhaar '${record.aadhaar_number}'`);
            }
            if (drivingLicense && rows.filter((r, idx) => idx !== i && r.driving_license_number && String(r.driving_license_number).trim().toUpperCase() === drivingLicense).length > 0) {
                duplicates.push(`Driving License '${drivingLicense}'`);
            }
            if (voterId && rows.filter((r, idx) => idx !== i && r.voter_id_number && String(r.voter_id_number).trim().toUpperCase() === voterId).length > 0) {
                duplicates.push(`Voter ID '${voterId}'`);
            }
            if (bankAccount && rows.filter((r, idx) => idx !== i && r.bank_account_number && String(r.bank_account_number).trim() === bankAccount).length > 0) {
                duplicates.push(`Bank Account '${bankAccount}'`);
            }

            if (duplicates.length > 0) {
                errorCount++;
                const errorMessage = `Duplicate values found in Excel: ${duplicates.join(', ')}`;
                if (errorCount <= MAX_SAMPLE) errorSample.push(`Row ${rowIndex}: ${errorMessage}`);
                writeError(errorFileStream, originalRecord, errorMessage);
            }
        }

        // If duplicates found in Excel, stop processing
        if (errorCount > 0) {
            if (errorFileStream) errorFileStream.end();
            await transaction.rollback();
            parentPort.postMessage({
                status: "SUCCESS",
                result: {
                    importErrors: true,
                    errors: errorSample,
                    errorCount: errorCount,
                    message: `${errorCount} errors found. Please fix duplicates in Excel file before importing.`
                }
            });
            return;
        }

        console.log("No duplicates found in Excel, proceeding with import...");

        // Create/find departments, designations, and states first using bulk operations
        const departmentMap = new Map();
        const designationMap = new Map();
        const stateMap = new Map();
        const uniqueDepartments = [...new Set(rows.map(r => r.department_id).filter(Boolean))];
        const uniqueDesignations = [...new Set(rows.map(r => r.designation_id).filter(Boolean))];
        const uniqueStates = [...new Set([
            ...rows.map(r => r.present_state_id).filter(Boolean),
            ...rows.map(r => r.permanent_state_id).filter(Boolean)
        ])];


        console.log("Bulk creating departments, designations, and states...");

        // Bulk create/find departments
        const existingDepartments = await commonQuery.findAllRecords(
            Department,
            {
                status: 0,
                name: { [Op.in]: uniqueDepartments.map(dept => String(dept).trim()) }
            },
            { attributes: ['id', 'name'], raw: true },
            transaction
        );

        console.log("Existing departments:--------------------------------------------------");
        
        // Map existing departments
        existingDepartments.forEach(dept => {
            departmentMap.set(String(dept.name).toLowerCase(), dept.id);
        });
        
        // Find departments that need to be created
        const departmentsToCreate = uniqueDepartments.filter(dept => 
            !departmentMap.has(String(dept).trim().toLowerCase())
        ).map(deptName => ({
            name: String(deptName).trim(),
            company_id,
            branch_id,
            user_id,
            status: 0
        }));
        
        // Bulk create new departments
        if (departmentsToCreate.length > 0) {
            const createdDepts = await commonQuery.bulkCreate(Department, departmentsToCreate, {}, transaction);
            createdDepts.forEach(dept => {
                departmentMap.set(String(dept.name).toLowerCase(), dept.id);
            });
        }

        // Bulk create/find designations
        const existingDesignations = await commonQuery.findAllRecords(
            DesignationMaster,
            {
                status: 0,
                designation_name: { [Op.in]: uniqueDesignations.map(desig => String(desig).trim()) }
            },
            { attributes: ['id', 'designation_name'], raw: true },
            transaction
        );
        
        // Map existing designations
        existingDesignations.forEach(desig => {
            designationMap.set(String(desig.designation_name).toLowerCase(), desig.id);
        });
        
        // Find designations that need to be created
        const designationsToCreate = uniqueDesignations.filter(desig => 
            !designationMap.has(String(desig).trim().toLowerCase())
        ).map(desigName => ({
            designation_name: String(desigName).trim(),
            company_id,
            branch_id,
            user_id,
            status: 0
        }));
        
        // Bulk create new designations
        if (designationsToCreate.length > 0) {
            const createdDesigs = await commonQuery.bulkCreate(DesignationMaster, designationsToCreate, {}, transaction);
            createdDesigs.forEach(desig => {
                designationMap.set(String(desig.designation_name).toLowerCase(), desig.id);
            });
        }

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

            fileTrackingEmployeeMap: new Map()
        };

        let createdCount = 0;
        const validEmployees = [];

        // First validate all rows and collect valid employees
        for (let i = 0; i < rows.length; i++) {
            if (i % 500 === 0 && i > 0) await new Promise(resolve => setImmediate(resolve));
            if (isCancelled) fail("IMPORT_CANCELLED");

            const record = rows[i];
            const originalRecord = originalRows[i];
            const rowIndex = i + 2;

            try {
                const firstName = String(record.first_name || '').trim().toLowerCase();
                const email = String(record.email || '').trim().toLowerCase();
                const mobile = String(record.mobile_no || '').trim();
                const pan = record.pan_number ? String(record.pan_number).trim().toUpperCase() : null;
                const uan = record.uan_number ? String(record.uan_number).trim() : null;
                const aadhaar = record.aadhaar_number ? String(record.aadhaar_number).replace(/\s/g, '') : null;
                const drivingLicense = record.driving_license_number ? String(record.driving_license_number).trim().toUpperCase() : null;
                const voterId = record.voter_id_number ? String(record.voter_id_number).trim().toUpperCase() : null;
                const bankAccount = record.bank_account_number ? String(record.bank_account_number).trim() : null;

                if (!firstName) fail("First Name is required");
                if (!mobile) fail("Mobile Number is required");
                if(!record.joining_date) fail("Joining Date is required");
                if(!record.dob) fail("Date of Birth is required");
                if(!record.gender) fail("Gender is required");

                // Check for duplicates (only in Excel file for employee code)
                if (record.employee_code && employeeData.fileEmpCodeSet.has(record.employee_code)) fail(`Employee Code '${record.employee_code}' already exists`);
                if (email && employeeData.dbEmailSet.has(email)) fail(`Email '${email}' already exists`);
                if (employeeData.dbEmpMobileSet.has(mobile)) fail(`Mobile '${mobile}' already exists`);
                if (pan && employeeData.dbPanSet.has(pan)) fail(`PAN '${pan}' already exists`);
                if (uan && employeeData.dbUanSet.has(uan)) fail(`UAN '${uan}' already exists`);
                if (aadhaar && employeeData.dbAadhaarSet.has(aadhaar)) fail(`Aadhaar '${record.aadhaar_number}' already exists`);
                if (drivingLicense && employeeData.dbDrivingLicenseSet.has(drivingLicense)) fail(`Driving License '${drivingLicense}' already exists`);
                if (voterId && employeeData.dbVoterIdSet.has(voterId)) fail(`Voter ID '${voterId}' already exists`);
                if (bankAccount && employeeData.dbBankAccountSet.has(bankAccount)) fail(`Bank Account '${bankAccount}' already exists`);
                if (employeeData.fileEmpMobileSet.has(mobile)) fail(`Duplicate Mobile '${mobile}' found in file`);

                
                // Prepare employee data
                const prepareData = {
                    employee_code: record.employee_code,
                    first_name: firstName,
                    mobile_no: mobile,
                    department_id: record.department_id ? departmentMap.get(String(record.department_id).trim().toLowerCase()) : null,
                    designation_id: record.designation_id ? designationMap.get(String(record.designation_id).trim().toLowerCase()) : null,
                    attendance_supervisor: record.attendance_supervisor,
                    is_attendance_supervisor: record.is_attendance_supervisor,
                    reporting_manager: record.reporting_manager,
                    is_reporting_manager: record.is_reporting_manager,

                    gender: record.gender,
                    dob: parseExcelDate(record.dob, rowIndex, "DOB"),
                    email: email || null,
                    marital_status: record.marital_status,
                    blood_group: record.blood_group,
                    physically_challenged: record.physically_challenged,
                    emergency_contact_mobile: record.emergency_contact_mobile,
                    father_name: normalizeText(record.father_name),
                    mother_name: normalizeText(record.mother_name),
                    spouse_name: normalizeText(record.spouse_name),
                    same_as_current: record.same_as_current,

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

                    joining_date: parseExcelDate(record.joining_date, rowIndex, "Joining Date"),
                    uan_number: uan,
                    name_as_per_pan: record.name_as_per_pan,
                    pan_number: pan,
                    name_as_per_aadhaar: record.name_as_per_aadhaar,
                    aadhaar_number: aadhaar,
                    pf_number: record.pf_number,
                    pf_joining_date: parseExcelDate(record.pf_joining_date, rowIndex, "PF Joining Date"),
                    pf_eligible: record.pf_eligible || false,
                    esi_eligible: record.esi_eligible || false,
                    esi_number: record.esi_number,
                    pt_eligible: record.pt_eligible || false,
                    lwf_eligible: record.lwf_eligible || false,
                    eps_eligible: record.eps_eligible || false,
                    eps_joining_date: parseExcelDate(record.eps_joining_date, rowIndex, "EPS Joining Date"),
                    eps_exit_date: parseExcelDate(record.eps_exit_date, rowIndex, "EPS Exit Date"),
                    hps_eligible: record.hps_eligible || false,
                    driving_license_number: drivingLicense,
                    voter_id_number: voterId,
                    name_as_per_bank: record.name_as_per_bank,
                    bank_name: record.bank_name,
                    bank_account_number: bankAccount,
                    bank_ifsc_code: record.bank_ifsc_code,
                    bank_account_holder_name: record.bank_account_holder_name,
                    upi_id: record.upi_id,
                };

                // Add to valid employees array
                validEmployees.push(prepareData);
                employeeData.fileEmpMobileSet.add(mobile);
                createdCount++;

            } catch (rowError) {
                errorCount++;
                if (errorCount <= MAX_SAMPLE) errorSample.push(`Row ${rowIndex}: ${rowError.message}`);
                writeError(errorFileStream, originalRecord, rowError.message);
            }
        }

        // Bulk create all valid employees
        if (validEmployees.length > 0) {
            await commonQuery.bulkCreate(Employee, validEmployees, {}, transaction);
        }

        if (errorFileStream) errorFileStream.end();

        if (createdCount === 0 && errorCount > 0) {
            await transaction.rollback();

            parentPort.postMessage({
                status: "SUCCESS",
                result: {
                    importErrors: true,
                    errors: errorSample,
                    errorCount: errorCount,
                    message: `${errorCount} errors found. No employees were imported.`
                }
            });
            return;
        }

        const tooManyErrors = errorCount > (rows.length * 0.5) && rows.length > 10;
        if (tooManyErrors) {
            await transaction.rollback();
            parentPort.postMessage({
                status: "SUCCESS",
                result: { importErrors: true, errors: errorSample, errorCount, message: "Too many errors. Import rolled back." }
            });
        } else {
            await transaction.commit();
            parentPort.postMessage({
                status: "SUCCESS",
                result: { success: true, message: `${createdCount} employees processed successfully.`, count: createdCount, errorCount, errors: errorSample }
            });
        }

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

runWorker();
runWorker();