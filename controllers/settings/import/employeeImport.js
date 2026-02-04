const { parentPort, workerData } = require("worker_threads");
const { sequelize, commonQuery } = require("../../../helpers");
const { Employee } = require("../../../models");
const { transformRows } = require("../../../helpers/functions/excelService");
const { Op } = require("sequelize");
const xlsx = require("xlsx");
const fs = require("fs");
const { fixDecimals } = require("../../../helpers/functions/commonFunctions");
const { fail } = require('../../../helpers/Err');

const moment = require("moment");

const employeeCodeCounter = { current: null };

async function generateEmployeeCode(company_id, transaction, counterRef) {
    if (counterRef.current === null) {
        const lastEmp = await Employee.findOne({
            where: { company_id },
            order: [["created_at", "DESC"]],
            attributes: ["employee_code"],
            transaction
        });

        let lastNumber = 0;
        if (lastEmp?.employee_code) {
            const match = lastEmp.employee_code.match(/EM-(\d+)/);
            if (match) lastNumber = parseInt(match[1], 10);
        }

        counterRef.current = lastNumber;
    }

    counterRef.current += 1;
    return `EM-${String(counterRef.current).padStart(2, "0")}`;
}


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

// Static Maps for Enums

const GENDER_MAP = {
    MALE: 1,
    FEMALE: 2,
    OTHER: 3
};

const MARITAL_STATUS_MAP = {
    MARRIED: 1,
    UNMARRIED: 2
};

const BLOOD_GROUP_MAP = {
    "A+": 1, "A-": 2,
    "B+": 3, "B-": 4,
    "O+": 5, "O-": 6,
    "AB+": 7, "AB-": 8
};

const BOOL_MAP = {
    YES: true,
    NO: false,
    TRUE: true,
    FALSE: false,
    1: true,
    0: false
};

const EXCEL_EMPLOYEE_CODE_KEYS = [
    "employee_code",
    "Employee Code",
    "employee code"
];

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
    const { fixNum } = await fixDecimals(company_id);

    const commonData = { user_id, branch_id, company_id };
    const masterCommonData = { company_id };

    let fieldMapping = {};
    try {
        fieldMapping = JSON.parse(body.field_mapping || "{}");
    } catch (e) {
        parentPort.postMessage({
            status: "ERROR",
            error: "Invalid field_mapping JSON"
        });
        return;
    }

    try {
        errorFileStream = fs.createWriteStream(errorLogPath);
        const workbook = xlsx.readFile(filePath);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const rawHeaders = (xlsx.utils.sheet_to_json(worksheet, { header: 1 })[0] || []);
        const headers = rawHeaders.map(h => String(h).trim());
        const originalRows = xlsx.utils.sheet_to_json(worksheet);
        const rows = transformRows(originalRows, headers, fieldMapping);

        if (isCancelled) fail("IMPORT_CANCELLED");

        // Extract headers
        const row = xlsx.utils.sheet_to_json(worksheet, { header: 1 });
        // const EMPLOYEE_CODE_KEY_SET = new Set(
        //     EXCEL_EMPLOYEE_CODE_KEYS.map(k => k.toLowerCase())
        // );

        const excelHeaders = (row[0] || [])
            .map(h => String(h || "").trim())
            .filter(Boolean);
        const EMPLOYEE_CODE_KEY_SET = new Set(
            ["employee_code", "employee code"]
        );

        // const ExcelHasEmployeeCode = excelHeaders.some(h =>
        //     h && EMPLOYEE_CODE_KEY_SET.has(h.toString().trim().toLowerCase())
        // );
        const ExcelHasEmployeeCode = excelHeaders.some(h =>
            EMPLOYEE_CODE_KEY_SET.has(
                String(h).trim().toLowerCase()
            )
        );

        const MappingHasEmployeeCode = Object.values(fieldMapping)
            .some(v => String(v).trim().toLowerCase() === "employee_code");

        if (!ExcelHasEmployeeCode && MappingHasEmployeeCode) {
            parentPort.postMessage({
                status: "SUCCESS",
                result: {
                    importErrors: true,
                    errorCount: 1,
                    errors: [
                        "Employee Code mapping provided but Excel file does not contain Employee Code column"
                    ]
                }
            });
            return;
        }

        if (ExcelHasEmployeeCode && !MappingHasEmployeeCode) {
            parentPort.postMessage({
                status: "SUCCESS",
                result: {
                    importErrors: true,
                    errorCount: 1,
                    errors: [
                        "Employee Code column exists in Excel but field_mapping is missing employee_code"
                    ]
                }
            });
            return;
        }


        transaction = await sequelize.transaction();


        // --- 2. PRE-SCAN ---
        const employeeCode = new Set();
        const mobileNo = new Set();

        rows.forEach(r => {
            if (r.employee_code) employeeCode.add(String(r.employee_code).trim().toLowerCase());
            if (r.mobile_no) mobileNo.add(String(r.mobile_no).trim().toLowerCase());
        });

        // --- 3. FETCH MASTERS ---
        const employeeWhere = { company_id, branch_id, status: 0 };

        const existingByCode = await Employee.findAll({
            where: {
                ...employeeWhere,
                employee_code: { [Op.in]: Array.from(employeeCode) }
            },
            attributes: ['employee_code'],
            raw: true,
            transaction
        });

        const existingByMobile = await Employee.findAll({
            where: {
                ...employeeWhere,
                mobile_no: { [Op.in]: Array.from(mobileNo) }
            },
            attributes: ['mobile_no'],
            raw: true,
            transaction
        });


        // --- 4. BUILD MAPS ---
        const employeeData = {
            dbEmpCodeSet: new Set(existingByCode.map(e => String(e.employee_code).toLowerCase())),
            dbEmpMobileSet: new Set(existingByMobile.map(e => String(e.mobile_no))),

            fileEmpCodeSet: new Set(),
            fileEmpMobileSet: new Set(),

            fileTrackingEmployeeMap: new Map()
        };

        // --- 5. PROCESSING LOOP ---
        let createdCount = 0;
        let errorCount = 0;
        const errorSample = [];
        const MAX_SAMPLE = 100;

        for (let i = 0; i < rows.length; i++) {
            if (i % 500 === 0 && i > 0) await new Promise(resolve => setImmediate(resolve));
            if (isCancelled) fail("IMPORT_CANCELLED");

            const record = rows[i];
            const originalRecord = originalRows[i];
            const rowIndex = i + 2;

            try {
                // --- A. VALIDATION & NORMALIZATION ---
                // const shouldGenerateEmployeeCode = !ExcelHasEmployeeCode && !MappingHasEmployeeCode;
                const shouldGenerateEmployeeCode =
                    (!ExcelHasEmployeeCode && !MappingHasEmployeeCode) ||
                    (ExcelHasEmployeeCode && MappingHasEmployeeCode && !record.employee_code);

                console.log("shouldGenerateEmployeeCode:", shouldGenerateEmployeeCode);

                let employeeCode = record.employee_code
                    ? String(record.employee_code).trim()
                    : null;

                if (shouldGenerateEmployeeCode) {
                    employeeCode = await generateEmployeeCode(
                        company_id,
                        transaction,
                        employeeCodeCounter
                    );
                }
                const firstName = String(record.first_name || '').trim().toLowerCase();
                const email = String(record.email || '').trim().toLowerCase();
                const mobile = String(record.mobile_no || '').trim();
                const father_name = normalizeText(record.father_name);
                const mother_name = normalizeText(record.mother_name);
                const spouse_name = normalizeText(record.spouse_name);
                // REQUIRED FIELDS

                if (!employeeCode) {
                    fail("Employee Code is missing or empty");
                }
                // if (employeeCode && !MappingHasEmployeeCode) { fail("Employee Code is missing in field_mapping"); }
                // if (!employeeCode && !ExcelHasEmployeeCode) fail("Employee Code is required in excel file");
                
                // if (employeeCode && !shouldGenerateEmployeeCode){
                //     fail("Employee Code is required in both field_mapping and excel file");
                // }
                if (!firstName) fail("First Name is required");
                if (!mobile) fail("Mobile Number is required");

                const rowKey = String(employeeCode).toLowerCase();

                // --- B. CHECK IF EMPLOYEE EXISTS (FILE / DB) ---
                let employeeId = employeeData.fileTrackingEmployeeMap.get(rowKey);

                let isNewEmployee = false;

                if (!employeeId) {

                    // DB DUPLICATE CHECKS
                    if (employeeData.dbEmpCodeSet.has(rowKey)) {
                        fail(`Employee Code '${employeeCode}' already exists`);
                    }

                    // if (email && employeeData.dbEmailSet.has(email)) {
                    //     fail(`Email '${email}' already exists`);
                    // }

                    if (employeeData.dbEmpMobileSet.has(mobile)) {
                        fail(`Mobile '${mobile}' already exists`);
                    }

                    // FILE DUPLICATE CHECKS
                    if (employeeData.fileEmpCodeSet.has(rowKey)) {
                        fail(`Duplicate Employee Code '${employeeCode}' found in file`);
                    }

                    if (employeeData.fileEmpMobileSet.has(mobile)) {
                        fail(`Duplicate Mobile '${mobile}' found in file`);
                    }

                    // --- C. ENUM / TYPE MAPPING ---
                    const gender = GENDER_MAP[String(record.gender || '').toUpperCase()] || null;
                    const maritalStatus =
                        record.marital_status
                            ? MARITAL_STATUS_MAP[String(record.marital_status).trim().toUpperCase()] ?? null
                            : null;
                    const bloodGroup = BLOOD_GROUP_MAP[String(record.blood_group || '').toUpperCase()] || null;

                    const isPhysicallyChallenged =
                        BOOL_MAP[String(record.physically_challenged || "NO").toUpperCase()] || false;


                    // --- D. CREATE EMPLOYEE ---
                    const newEmployee = await Employee.create({
                        // profile_image: record.profile_image || null,
                        employee_code: employeeCode,
                        first_name: firstName,
                        mobile_no: mobile,
                        designation: record.designation,

                        // PERSONAL INFO
                        gender: gender,
                        dob: parseExcelDate(record.dob, rowIndex, "DOB"),
                        email: email || null,
                        marital_status: maritalStatus,
                        blood_group: bloodGroup,
                        physically_challenged: isPhysicallyChallenged,
                        emergency_contact_mobile: record.emergency_contact_mobile,
                        father_name: father_name,
                        mother_name: mother_name,
                        spouse_name: spouse_name,

                        status: 0,
                        ...commonData
                    }, { transaction });

                    employeeId = newEmployee.id;


                    // --- E. TRACK CREATED EMPLOYEE ---
                    employeeData.fileTrackingEmployeeMap.set(rowKey, employeeId);
                    employeeData.fileEmpCodeSet.add(rowKey);
                    // if (email) employeeData.fileEmailSet.add(email);
                    employeeData.fileEmpMobileSet.add(mobile);

                    isNewEmployee = true;
                    createdCount++;
                }

            } catch (rowError) {
                errorCount++;
                if (errorCount <= MAX_SAMPLE) errorSample.push(`Row ${rowIndex}: ${rowError.message}`);
                writeError(errorFileStream, originalRecord, rowError.message);
            }
        }

        // --- 6. FINALIZE ---
        if (errorFileStream) errorFileStream.end();

        // 🔴 IMPORTANT FIX: If no records created AND there are errors, ensure we return FAILURE structure
        if (createdCount === 0 && errorCount > 0) {
            await transaction.rollback();

            // This format mimics what your `responseFormatter` or controller expects for a validation error
            parentPort.postMessage({
                status: "SUCCESS", // We send 'SUCCESS' to the controller, but the payload has the error flag
                result: {
                    importErrors: true, // This flag tells the controller to return 400 or treat as error
                    errors: errorSample,
                    errorCount: errorCount,
                    message: `${errorCount} errors found. No employees were imported.`
                }
            });
            return;
        }

        // Normal logic for partial success or full success
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