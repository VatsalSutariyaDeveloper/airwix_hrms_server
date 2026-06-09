const { parentPort, workerData } = require("worker_threads");
const { sequelize, commonQuery } = require("../../../helpers");
const { Employee, EmployeeSalaryTemplate, EmployeeSalaryTemplateTransaction, SalaryComponent, SalaryRevisionHistory } = require("../../../models");
const { transformRows } = require("../../../helpers/functions/excelService");
const { Op } = require("sequelize");
const xlsx = require("xlsx");
const fs = require("fs");
const { fail } = require('../../../helpers/Err');
const { requestContext } = require("../../../utils/requestContext");
const dayjs = require('dayjs');
const { rebuildAttendanceDay } = require("../../../helpers/attendanceHelper");

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

const normalizeText = (v) => {
    if (v === undefined || v === null) return "";
    return String(v).trim().toLowerCase();
};

const parseExcelDate = (val, rowIndex, fieldName) => {
    if (!val) return null;
    if (val instanceof Date) return val;

    // Excel numeric date
    if (!isNaN(val) && typeof val === 'number') {
        return new Date(Math.round((val - 25569) * 86400 * 1000));
    }

    const d = new Date(val);
    if (!isNaN(d.getTime())) return d;

    // Try DD-MM-YYYY or DD/MM/YYYY
    const parts = String(val).split(/[-/]/);
    if (parts.length === 3) {
        // Assume DD-MM-YYYY
        const d2 = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
        if (!isNaN(d2.getTime())) return d2;
    }

    return null;
};

const parseExcelAmount = (val) => {
    if (val === undefined || val === null || val === "") return 0;
    if (typeof val === 'number') return val;
    // Remove commas and other non-numeric chars except decimal point and minus sign
    const cleaned = String(val).replace(/[^0-9.-]/g, '');
    const parsed = parseFloat(cleaned);
    return isNaN(parsed) ? 0 : parsed;
};

const runWorker = async () => {
    try { await sequelize.authenticate(); } catch (error) {
        parentPort.postMessage({ status: "ERROR", error: "Database connection failed." });
        process.exit(1);
    }

    const { filePath, errorLogPath, body, user_id, branch_id, company_id } = workerData;

    try {
        errorFileStream = fs.createWriteStream(errorLogPath);
        const workbook = xlsx.readFile(filePath);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];

        // 🔍 Find the header row dynamically
        const allRows = xlsx.utils.sheet_to_json(worksheet, { header: 1 });
        let headerRowIndex = 0;
        const HEADER_KEYWORDS = ["employee code", "name of employee", "basic", "hra", "gross", "ctc"];

        for (let i = 0; i < Math.min(allRows.length, 20); i++) {
            const rowData = (allRows[i] || []).map(c => String(c || "").trim().toLowerCase());
            const matchCount = HEADER_KEYWORDS.filter(k => rowData.includes(k)).length;
            if (matchCount >= 2) {
                headerRowIndex = i;
                break;
            }
        }

        const originalRows = xlsx.utils.sheet_to_json(worksheet, { range: headerRowIndex });
        const headers = (allRows[headerRowIndex] || []).map(h => String(h || "").trim());

        // Check for duplicate column names in Excel
        const headerNameMap = new Map();
        const duplicateHeaders = [];
        headers.forEach((header, idx) => {
            const normHeader = normalizeText(header);
            if (!normHeader) return;
            if (headerNameMap.has(normHeader)) {
                duplicateHeaders.push(header);
            } else {
                headerNameMap.set(normHeader, idx);
            }
        });
        if (duplicateHeaders.length > 0) {
            console.log("Duplicate Excel columns found:", [...new Set(duplicateHeaders)]);
            throw new Error(`Duplicate column names found in Excel: ${[...new Set(duplicateHeaders)].join(', ')}. Please ensure all column names are unique.`);
        }

        if (isCancelled) fail("IMPORT_CANCELLED");

        transaction = await sequelize.transaction();

        // 1. Pre-fetch active salary components to map names to IDs
        const allComponents = await commonQuery.findAllRecords(SalaryComponent, {
            status: 0
        }, { 
            attributes: ['id', 'component_name', 'component_type', 'component_category', 'calculation_type', 'formula', 'percentage_of', 'percentage_value'], 
            raw: true 
        }, transaction, false);

        const componentMap = new Map();
        allComponents.forEach(comp => {
            componentMap.set(normalizeText(comp.component_name), comp);
        });

        // Pre-fetch specific component IDs for calculations
        const basicCompId = allComponents.find(c => normalizeText(c.component_name) === 'basic')?.id;
        const employeePFCompId = allComponents.find(c => {
            const n = normalizeText(c.component_name);
            return n === 'pf' || (n.includes('pf') && (n.includes('deduction') || n.includes('employee') || n.includes('provident')));
        })?.id;
        const employerPFCompId = allComponents.find(c => {
            const n = normalizeText(c.component_name);
            return n.includes('employer') || n.includes('contribution') || (n.includes('pf') && (n.includes('employer') || n.includes('contribution')));
        })?.id;

        // 2. Identify which columns are components
        const headerComponentMap = new Map();

        // Build a normalized component list for matching
        const normalizedComponents = allComponents.map(c => ({
            ...c,
            normName: normalizeText(c.component_name).replace(/[^a-z0-9]/g, '')
        }));

        headers.forEach((header, index) => {
            const normHeader = normalizeText(header).replace(/[^a-z0-9]/g, '');
            if (!normHeader || normHeader === 'total') return;

            // Strict Match: Exact alphanumeric match
            let matchedComp = normalizedComponents.find(c => c.normName === normHeader);

            // Essential Aliases (only if no exact match found)
            if (!matchedComp) {
                const nh = normalizeText(header).replace(/[^a-z0-9]/g, '');
                if (nh === 'pl' || nh === 'leaveencashments' || nh === 'leaveenchashments') {
                    matchedComp = normalizedComponents.find(c => c.normName === 'leaveencashment' || c.normName === 'leaveenchashment');
                } else if (nh === 'bonuses') {
                    matchedComp = normalizedComponents.find(c => c.normName === 'bonus');
                } else if (nh === 'gratuities') {
                    matchedComp = normalizedComponents.find(c => c.normName === 'gratuity');
                } else if (nh === 'employerpfemployee') {
                    matchedComp = normalizedComponents.find(c => c.normName.includes('pf') && (c.normName.includes('deduction') || c.normName.includes('employee')));
                } else if (nh === 'employerpfemployer') {
                    matchedComp = normalizedComponents.find(c => c.normName.includes('pf') && c.normName.includes('employer'));
                } else if (nh === 'esicemployee') {
                    matchedComp = normalizedComponents.find(c => c.normName.includes('esi') && c.normName.includes('deduction'));
                } else if (nh === 'esicemployer') {
                    matchedComp = normalizedComponents.find(c => c.normName.includes('esi') && c.normName.includes('employer'));
                }
            }

            if (matchedComp) {
                headerComponentMap.set(index, matchedComp);
            }
        });

        // 3. Fetch all employees to map code to ID
        const empCodeKey = headers.find(h => normalizeText(h).includes("code"));
        const empNameKey = headers.find(h => normalizeText(h).includes("name of employee") || normalizeText(h).includes("employee name"));

        const employeeCodesInFile = [...new Set(originalRows.map(r => String(r[empCodeKey] || "").trim()).filter(Boolean))];
        const existingEmployees = await commonQuery.findAllRecords(Employee, {
            employee_code: { [Op.in]: employeeCodesInFile },
            company_id,
            status: { [Op.ne]: 2 }
        }, { attributes: ['id', 'employee_code', 'first_name', 'branch_id'], raw: true }, transaction, { company_id: true });

        const employeeMap = new Map();
        existingEmployees.forEach(emp => {
            employeeMap.set(normalizeText(emp.employee_code), emp);
        });

        // 4. Pre-fetch existing templates for these employees
        const existingTemplates = await commonQuery.findAllRecords(EmployeeSalaryTemplate, {
            employee_id: { [Op.in]: existingEmployees.map(e => e.id) }
        }, { raw: true }, transaction);

        const templateMap = new Map();
        existingTemplates.forEach(t => templateMap.set(t.employee_id, t));

        // 5. Pre-fetch statutory header keys
        const cleanStr = (s) => normalizeText(s).replace(/[^a-z0-9]/g, '');
        const getStatHeader = (keywords) => {
            const cleanKeywords = keywords.map(cleanStr);
            return headers.find(h => {
                const cH = cleanStr(h);
                return cleanKeywords.every(k => cH.includes(k));
            });
        };
        const getPfAmountHeader = (type) => {
            const candidates = headers.filter(h => {
                const cH = cleanStr(h);
                if (!cH.includes('pf')) return false;
                if (cH.includes('status') || cH.includes('limit')) return false;

                if (type === 'employee') {
                    return cH.includes('employee') || cH.includes('deduction') || cH.includes('epfemployee') || cH.includes('providentfundemployee');
                }

                return cH.includes('employer') || cH.includes('contribution') || cH.includes('epfemployer') || cH.includes('providentfundemployer');
            });

            if (candidates.length > 0) return candidates[0];

            if (type === 'employee') {
                return headers.find(h => {
                    const cH = cleanStr(h);
                    return cH === 'pf1' || cH === 'epf1';
                }) || headers.find(h => {
                    const cH = cleanStr(h);
                    return cH.includes('pf') && (cH.endsWith('1') || cH.includes('deduction'));
                });
            }

            return headers.find(h => {
                const cH = cleanStr(h);
                return cH === 'pf' || cH === 'employerpf';
            });
        };
        const getEsiAmountHeader = (type) => {
            const candidates = headers.filter(h => {
                const cH = cleanStr(h);
                if (!cH.includes('esi') && !cH.includes('esic')) return false;
                if (cH.includes('status')) return false;

                if (type === 'employee') {
                    return cH.includes('employee') || cH.includes('deduction');
                }

                return cH.includes('employer');
            });

            if (candidates.length > 0) return candidates[0];

            if (type === 'employee') {
                return headers.find(h => {
                    const cH = cleanStr(h);
                    return cH === 'esic1' || cH === 'esi1';
                }) || headers.find(h => {
                    const cH = cleanStr(h);
                    return (cH.includes('esi') || cH.includes('esic')) && (cH.endsWith('1') || cH.includes('deduction'));
                });
            }

            return headers.find(h => {
                const cH = cleanStr(h);
                return cH === 'esic' || cH === 'esi' || cH === 'employeresi' || cH === 'employeresic';
            });
        };

        const statHeaderKeys = {
            ePfStat: getStatHeader(["employee", "pf", "status"]) || getStatHeader(["employer", "pf", "employee"]),
            ePfLim: getStatHeader(["employee", "pf", "limit"]) || getStatHeader(["employer", "pf", "limit", "employee"]),
            ePfAmt: getPfAmountHeader('employee'),
            eEsiStat: getStatHeader(["employee", "esi", "status"]) || getStatHeader(["employee", "esic", "status"]) || getStatHeader(["esic", "employee"]) || getStatHeader(["esi", "employee"]),
            eEsiAmt: getEsiAmountHeader('employee'),
            ptStat: getStatHeader(["pt", "status"]),
            eLwfStat: getStatHeader(["employee", "lwf", "status"]),
            rPfStat: getStatHeader(["employer", "pf", "status"]) || getStatHeader(["employer", "pf", "employer"]),
            rPfLim: getStatHeader(["employer", "pf", "limit"]) || getStatHeader(["employer", "pf", "limit", "employer"]),
            rPfAmt: getPfAmountHeader('employer'),
            edliStat: getStatHeader(["employer", "edli", "status"]),
            rEsiStat: getStatHeader(["employer", "esi", "status"]) || getStatHeader(["employer", "esic", "status"]) || getStatHeader(["esic", "employer"]) || getStatHeader(["esi", "employer"]),
            rEsiAmt: getEsiAmountHeader('employer'),
            rLwfStat: getStatHeader(["employer", "lwf", "status"]),
            gratuityStat: getStatHeader(["gratuity", "status"]),
            leaveEncashmentStat: getStatHeader(["leave", "encashment", "status"]),
            bonusStat: getStatHeader(["bonus", "status"]),
            tdsStat: getStatHeader(["tds", "status"]),
            grossKey: headers.find(h => {
                const nh = normalizeText(h);
                return nh === "gross" || nh === "monthly gross" || nh === "total gross";
            }),
            ctcKey: headers.find(h => {
                const nh = normalizeText(h);
                return nh === "ctc" || nh === "monthly ctc" || nh === "grand ctc" || nh === "total ctc" || nh.includes("ctc") || nh.includes("cost to company");
            }),
            effectiveDateKey: headers.find(h => normalizeText(h).includes("effective date") || normalizeText(h).includes("revision date")),
            calculationBasisKey: headers.find(h => {
                const nh = normalizeText(h);
                return nh.includes("calculation days") || nh.includes("calculation type") || nh.includes("calculation basis") || nh.includes("lwp computation") || nh.includes("lwp calculation");
            }),
            payrollCycleKey: headers.find(h => {
                const nh = normalizeText(h);
                return nh === "payroll cycle" || nh.includes("payroll cycle");
            }),
            netSalaryKey: headers.find(h => {
                const nh = normalizeText(h);
                return nh === "net salary" || nh === "net pay" || nh === "take home" || nh.includes("net salary");
            })
        };

        let createdCount = 0;
        let errorCount = 0;
        const errorSample = [];
        const MAX_SAMPLE = 10;

        const isYes = (val) => {
            if (!val) return false;
            const s = String(val).toLowerCase().trim();
            return s === 'yes' || s === 'enabled' || s === 'active' || s === '1' || s === 'true' || s === 'y' || s === 'selected';
        };

        const getPfImportConfig = (limitValue, excelAmount, defaultAmount) => {
            const s = cleanStr(limitValue || "");
            const hasExcelAmount = excelAmount > 0;

            if (isYes(limitValue)) {
                return {
                    calculation_type: '₹1800 Limit',
                    amount: hasExcelAmount ? excelAmount : 1800
                };
            }

            if (s === 'no') {
                return {
                    calculation_type: '12% of Basic',
                    amount: hasExcelAmount ? excelAmount : defaultAmount
                };
            }

            if (s === 'no1800fixed' || s === 'no1800limit' || s === 'no1800capped' || s === 'no1800cap' || s.includes('1800') || s.includes('fixed') || s.includes('limit')) {
                return {
                    calculation_type: '12% of Basic (₹1800 Limit)',
                    amount: hasExcelAmount ? excelAmount : Math.min(defaultAmount, 1800)
                };
            }

            return {
                calculation_type: '12% of Basic',
                amount: hasExcelAmount ? excelAmount : defaultAmount
            };
        };

        const templatesToUpdate = [];
        const templatesToCreate = [];
        const transactionsToCreate = [];
        const revisionsToCreate = [];
        const employeeUpdates = [];

        for (let i = 0; i < originalRows.length; i++) {
            const row = originalRows[i];
            const rowIndex = i + headerRowIndex + 2;

            const empCodeValue = empCodeKey ? String(row[empCodeKey] || "").trim() : "";
            const empNameValue = empNameKey ? String(row[empNameKey] || "").trim() : "Unknown";

            if (!empCodeValue || normalizeText(empCodeValue) === "total") continue;

            const employee = employeeMap.get(normalizeText(empCodeValue));
            if (!employee) {
                errorCount++;
                const msg = `Employee '${empNameValue}' (Code: ${empCodeValue}) not Exist in system.`;
                errorSample.push(`Row ${rowIndex}: ${msg}`);
                writeError(errorFileStream, row, msg);
                continue;
            }

            try {
                // Prepare Components Data
                let grossMonthly = 0;
                let ctcMonthly = 0;
                const rowTransactions = [];

                headerComponentMap.forEach((comp, colIdx) => {
                    const rawValue = row[headers[colIdx]];
                    if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") return;

                    const value = parseExcelAmount(rawValue);

                    const payload = {
                        employee_id: employee.id,
                        component_id: comp.id,
                        component_category: (comp.component_type === 'EARNING' || comp.component_type === 'DEDUCTION') ? (comp.component_category || 'FIXED') :
                            (comp.component_type === 'ANNUAL_COMPONENT' ? 'ANNUAL_COMPONENT' :
                                (comp.component_type === 'EMPLOYER_CONTRIBUTION' ? 'EMPLOYER_CONTRIBUTION' :
                                    (comp.component_type === 'VARIABLE_EARNING' ? 'VARIABLE_EARNING' :
                                        (comp.component_type === 'BENEFIT' ? 'BENEFIT' : 'STATUTORY')))),
                        monthly_amount: value,
                        yearly_amount: value * 12,
                        included_in_ctc: true,
                        is_employer_contribution: comp.component_type === 'EMPLOYER_CONTRIBUTION' || comp.component_category === 'STATUTORY',

                        // Inherit calculation logic from Master Component
                        calculation_type: comp.calculation_type || 'FIXED',
                        formula: comp.formula,
                        percentage_of: comp.percentage_of,
                        percentage_value: comp.percentage_value,

                        company_id,
                        branch_id: employee.branch_id,
                        user_id
                    };

                    if (comp.component_type === 'EARNING') { grossMonthly += value; ctcMonthly += value; }
                    else if (comp.component_type === 'ANNUAL_COMPONENT') { ctcMonthly += value; }
                    else if (comp.component_type === 'EMPLOYER_CONTRIBUTION') { ctcMonthly += value; }
                    else if (comp.component_type === 'VARIABLE_EARNING') { ctcMonthly += value; }
                    else if (comp.component_type === 'BENEFIT') { ctcMonthly += value; }
                    else if (comp.component_category === 'STATUTORY') { ctcMonthly += value; }

                    rowTransactions.push(payload);
                });

                // Prepare Statutory Config
                const statutory_config = {
                    employer_pf: { enabled: false, calculation_type: '12% of Basic', included_in_ctc: true, amount: 0 },
                    pf_edli_admin: { enabled: false, calculation_type: 'None', included_in_ctc: true, amount: 0 },
                    employer_esi: { enabled: false, calculation_type: '3.25% Variable', included_in_ctc: true, amount: 0 },
                    employer_lwf: { enabled: false, calculation_type: 'None', included_in_ctc: true, amount: 0, state_id: '' },
                    employee_pf: { enabled: false, calculation_type: '12% of Basic', amount: 0 },
                    employee_esi: { enabled: false, calculation_type: '0.75% of Gross', amount: 0 },
                    pt: { enabled: false, calculation_type: 'None', amount: 0, state_id: '' },
                    employee_lwf: { enabled: false, calculation_type: 'None', amount: 0, state_id: '' },
                    gratuity: { enabled: false, included_in_ctc: true, amount: 0 },
                    leave_encashment: { enabled: false, calculation_type: 'Attendance', included_in_ctc: true, amount: 0 },
                    bonus: { enabled: false, calculation_type: 'Attendance', included_in_ctc: true, amount: 0 },
                    tds: { enabled: false, strategy: 'smart', amount: 0 }
                };

                const findCompValue = (keywords) => {
                    const match = rowTransactions.find(item => {
                        const comp = allComponents.find(c => c.id === item.component_id);
                        return keywords.some(k => normalizeText(comp?.component_name || "").includes(k));
                    });
                    return match ? { enabled: true, amount: match.monthly_amount } : null;
                };

                // --- Basic Amount for PF/ESI calculations ---
                const basicTrans = rowTransactions.find(t => t.component_id === basicCompId);
                const basicAmount = basicTrans ? basicTrans.monthly_amount : 0;

                // --- Employee PF Logic ---
                // Enable Employee PF if: PF STATUS is yes, OR PF LIMIT is yes, OR there's a PF transaction
                if (statHeaderKeys.ePfStat && isYes(row[statHeaderKeys.ePfStat])) {
                    statutory_config.employee_pf.enabled = true;
                } else if (statHeaderKeys.ePfLim && isYes(row[statHeaderKeys.ePfLim])) {
                    statutory_config.employee_pf.enabled = true;
                } else if (rowTransactions.find(t => t.component_id === employeePFCompId)) {
                    statutory_config.employee_pf.enabled = true;
                }

                if (statutory_config.employee_pf.enabled) {
                    let amt = 0;
                    const pfTransaction = rowTransactions.find(t => t.component_id === employeePFCompId);
                    const excelPFAmt = parseExcelAmount(
                        statHeaderKeys.ePfAmt ? row[statHeaderKeys.ePfAmt] : 0
                    ) || pfTransaction?.monthly_amount || 0;
                    const defaultPfAmount = Math.round(basicAmount * 0.12);

                    if (statHeaderKeys.ePfLim) {
                        const limVal = row[statHeaderKeys.ePfLim];
                        const pfConfig = getPfImportConfig(limVal, excelPFAmt, defaultPfAmount);
                        statutory_config.employee_pf.calculation_type = pfConfig.calculation_type;
                        amt = pfConfig.amount;
                    } else {
                        // No limit column: if Excel has amount, use it with max 1800 limit
                        if (excelPFAmt > 0) {
                            amt = Math.min(excelPFAmt, 1800);
                            statutory_config.employee_pf.calculation_type = '₹1800 Limit';
                        } else {
                            // No Excel amount: calculate 12% of Basic with max 1800
                            amt = Math.min(defaultPfAmount, 1800);
                            statutory_config.employee_pf.calculation_type = '12% of Basic';
                        }
                    }
                    statutory_config.employee_pf.amount = amt;

                    const t = rowTransactions.find(t => t.component_id === employeePFCompId);
                    if (t) {
                        t.monthly_amount = amt;
                        t.yearly_amount = amt * 12;
                    } else if (amt > 0 && employeePFCompId) {
                        rowTransactions.push({
                            employee_id: employee.id,
                            component_id: employeePFCompId,
                            component_category: 'FIXED',
                            monthly_amount: amt,
                            yearly_amount: amt * 12,
                            included_in_ctc: true,
                            is_employer_contribution: false,
                            company_id,
                            branch_id: employee.branch_id,
                            user_id
                        });
                    }
                }

                // --- Employer PF Logic ---
                // Enable Employer PF if: PF STATUS is yes, OR PF LIMIT is yes, OR there's a PF transaction
                if (statHeaderKeys.rPfStat && isYes(row[statHeaderKeys.rPfStat])) {
                    statutory_config.employer_pf.enabled = true;
                } else if (statHeaderKeys.rPfLim && isYes(row[statHeaderKeys.rPfLim])) {
                    statutory_config.employer_pf.enabled = true;
                } else if (rowTransactions.find(t => t.component_id === employerPFCompId)) {
                    statutory_config.employer_pf.enabled = true;
                }

                if (statutory_config.employer_pf.enabled) {
                    let amt = 0;
                    const pfTransaction = rowTransactions.find(t => t.component_id === employerPFCompId);
                    const excelPFAmt = parseExcelAmount(
                        statHeaderKeys.rPfAmt ? row[statHeaderKeys.rPfAmt] : 0
                    ) || pfTransaction?.monthly_amount || 0;
                    const defaultPfAmount = Math.round(basicAmount * 0.12);

                    if (statHeaderKeys.rPfLim) {
                        const limVal = row[statHeaderKeys.rPfLim];
                        const pfConfig = getPfImportConfig(limVal, excelPFAmt, defaultPfAmount);
                        statutory_config.employer_pf.calculation_type = pfConfig.calculation_type;
                        amt = pfConfig.amount;
                    } else {
                        // No limit column: if Excel has amount, use it with max 1800 limit
                        if (excelPFAmt > 0) {
                            amt = Math.min(excelPFAmt, 1800);
                            statutory_config.employer_pf.calculation_type = '₹1800 Limit';
                        } else {
                            // No Excel amount: calculate 12% of Basic with max 1800
                            amt = Math.min(defaultPfAmount, 1800);
                            statutory_config.employer_pf.calculation_type = '12% of Basic';
                        }
                    }

                    const t = rowTransactions.find(t => t.component_id === employerPFCompId);
                    const oldAmt = t ? t.monthly_amount : 0;
                    statutory_config.employer_pf.amount = amt;

                    if (t) {
                        ctcMonthly = ctcMonthly - oldAmt + amt;
                        t.monthly_amount = amt;
                        t.yearly_amount = amt * 12;
                    } else if (amt > 0 && employerPFCompId) {
                        const pfComp = allComponents.find(c => c.id === employerPFCompId);
                        rowTransactions.push({
                            employee_id: employee.id,
                            component_id: employerPFCompId,
                            component_category: 'EMPLOYER_CONTRIBUTION',
                            monthly_amount: amt,
                            yearly_amount: amt * 12,
                            included_in_ctc: true,
                            is_employer_contribution: true,
                            
                            calculation_type: pfComp?.calculation_type || 'FIXED',
                            formula: pfComp?.formula,
                            percentage_of: pfComp?.percentage_of,
                            percentage_value: pfComp?.percentage_value,

                            company_id,
                            branch_id: employee.branch_id,
                            user_id
                        });
                        ctcMonthly += amt;
                    }
                }

                // --- Other Statutory (ESI, PT, LWF) ---
                const employerEsiTransaction = rowTransactions.find(t => {
                    const comp = allComponents.find(c => c.id === t.component_id);
                    const n = normalizeText(comp?.component_name || "");
                    return n.includes('esi') && n.includes('employer');
                });
                const employeeEsiTransaction = rowTransactions.find(t => {
                    const comp = allComponents.find(c => c.id === t.component_id);
                    const n = normalizeText(comp?.component_name || "");
                    return n.includes('esi') && (n.includes('employee') || n.includes('deduction'));
                });
                const empESIAmt = statHeaderKeys.rEsiAmt
                    ? { enabled: true, amount: parseExcelAmount(row[statHeaderKeys.rEsiAmt]) || employerEsiTransaction?.monthly_amount || 0 }
                    : findCompValue(["employer esi", "esic", "employer share esi"]);
                if (empESIAmt) { statutory_config.employer_esi.enabled = true; statutory_config.employer_esi.amount = empESIAmt.amount; }
                const empLWFAmt = findCompValue(["lwf", "labour welfare"]);
                if (empLWFAmt) { statutory_config.employer_lwf.enabled = true; statutory_config.employer_lwf.amount = empLWFAmt.amount; }
                const dedESIAmt = statHeaderKeys.eEsiAmt
                    ? { enabled: true, amount: parseExcelAmount(row[statHeaderKeys.eEsiAmt]) || employeeEsiTransaction?.monthly_amount || 0 }
                    : findCompValue(["esi deduction", "employee esi", "health insurance"]);
                if (dedESIAmt) { statutory_config.employee_esi.enabled = true; statutory_config.employee_esi.amount = dedESIAmt.amount; }
                const dedPTAmt = findCompValue(["pt", "professional tax", "prof tax"]);
                if (dedPTAmt) { statutory_config.pt.enabled = true; statutory_config.pt.amount = dedPTAmt.amount; }

                if (statHeaderKeys.eEsiStat) statutory_config.employee_esi.enabled = isYes(row[statHeaderKeys.eEsiStat]);
                if (statHeaderKeys.ptStat) statutory_config.pt.enabled = isYes(row[statHeaderKeys.ptStat]);
                if (statHeaderKeys.eLwfStat) statutory_config.employee_lwf.enabled = isYes(row[statHeaderKeys.eLwfStat]);
                if (statHeaderKeys.edliStat) statutory_config.pf_edli_admin.enabled = isYes(row[statHeaderKeys.edliStat]);
                if (statHeaderKeys.rEsiStat) statutory_config.employer_esi.enabled = isYes(row[statHeaderKeys.rEsiStat]);
                if (statHeaderKeys.rLwfStat) statutory_config.employer_lwf.enabled = isYes(row[statHeaderKeys.rLwfStat]);
                if (statHeaderKeys.gratuityStat) statutory_config.gratuity.enabled = isYes(row[statHeaderKeys.gratuityStat]);
                if (statHeaderKeys.leaveEncashmentStat) statutory_config.leave_encashment.enabled = isYes(row[statHeaderKeys.leaveEncashmentStat]);
                if (statHeaderKeys.bonusStat) statutory_config.bonus.enabled = isYes(row[statHeaderKeys.bonusStat]);
                if (statHeaderKeys.tdsStat) statutory_config.tds.enabled = isYes(row[statHeaderKeys.tdsStat]);

                // --- Bonus, Gratuity, Leave Encashment Logic ---
                const excelGratuityAmt = parseExcelAmount(row['Gratuity']);
                if (statutory_config.gratuity.enabled) {
                    const amt = excelGratuityAmt > 0 ? excelGratuityAmt : 0;
                    statutory_config.gratuity.amount = amt;
                    statutory_config.gratuity.calculation_type = 'Attendance';
                    if (amt > 0) {
                        const comp = allComponents.find(c => normalizeText(c.component_name).includes('gratuity'));
                        if (comp) {
                            const existingIdx = rowTransactions.findIndex(t => t.component_id === comp.id);
                            if (existingIdx !== -1) rowTransactions.splice(existingIdx, 1);
                            rowTransactions.push({
                                employee_id: employee.id, 
                                component_id: comp.id, 
                                component_category: 'STATUTORY',
                                monthly_amount: amt, 
                                yearly_amount: amt * 12, 
                                included_in_ctc: true, 
                                is_employer_contribution: true,
                                calculation_type: comp.calculation_type || 'FIXED',
                                formula: comp.formula,
                                percentage_of: comp.percentage_of,
                                percentage_value: comp.percentage_value,
                                company_id, 
                                branch_id: employee.branch_id, 
                                user_id
                            });
                        }
                    }
                }

                const excelLeaveEncashAmt = parseExcelAmount(row['Leave Encashments']) || parseExcelAmount(row['Leave Encashment']);
                if (statutory_config.leave_encashment.enabled) {
                    const amt = excelLeaveEncashAmt > 0 ? excelLeaveEncashAmt : 0;
                    statutory_config.leave_encashment.amount = amt;
                    statutory_config.leave_encashment.calculation_type = 'Attendance';
                    if (amt > 0) {
                        const comp = allComponents.find(c => {
                            const n = normalizeText(c.component_name);
                            return n.includes('leave encashment') || n.includes('leave enchashment') || n === 'pl';
                        });
                        if (comp) {
                            const existingIdx = rowTransactions.findIndex(t => t.component_id === comp.id);
                            if (existingIdx !== -1) rowTransactions.splice(existingIdx, 1);
                            rowTransactions.push({
                                employee_id: employee.id, 
                                component_id: comp.id, 
                                component_category: 'STATUTORY',
                                monthly_amount: amt, 
                                yearly_amount: amt * 12, 
                                included_in_ctc: true, 
                                is_employer_contribution: true,
                                calculation_type: comp.calculation_type || 'FIXED',
                                formula: comp.formula,
                                percentage_of: comp.percentage_of,
                                percentage_value: comp.percentage_value,
                                company_id, 
                                branch_id: employee.branch_id, 
                                user_id
                            });
                        }
                    }
                }

                const excelBonusAmt = parseExcelAmount(row['Bonus']);
                if (statutory_config.bonus.enabled) {
                    const amt = excelBonusAmt > 0 ? excelBonusAmt : 0;
                    statutory_config.bonus.amount = amt;
                    statutory_config.bonus.calculation_type = 'Attendance';
                    if (amt > 0) {
                        const comp = allComponents.find(c => normalizeText(c.component_name).includes('bonus'));
                        if (comp) {
                            const existingIdx = rowTransactions.findIndex(t => t.component_id === comp.id);
                            if (existingIdx !== -1) rowTransactions.splice(existingIdx, 1);
                            rowTransactions.push({
                                employee_id: employee.id, 
                                component_id: comp.id, 
                                component_category: 'STATUTORY',
                                monthly_amount: amt, 
                                yearly_amount: amt * 12, 
                                included_in_ctc: true, 
                                is_employer_contribution: true,
                                calculation_type: comp.calculation_type || 'FIXED',
                                formula: comp.formula,
                                percentage_of: comp.percentage_of,
                                percentage_value: comp.percentage_value,
                                company_id, 
                                branch_id: employee.branch_id, 
                                user_id
                            });
                        }
                    }
                }

                const tdsAmt = findCompValue(["tds", "tds deduction", "income tax", "tds amount"]);
                if (tdsAmt) {
                    statutory_config.tds.enabled = true;
                    statutory_config.tds.amount = tdsAmt.amount;
                }

                // --- EDLI & Admin Charges ---
                if (statutory_config.pf_edli_admin.enabled) {
                    const edliAmtValue = findCompValue(["edli", "admin charges", "pf admin"]);
                    const amt = edliAmtValue ? edliAmtValue.amount : Math.round(basicAmount * 0.005); // 0.5% default
                    statutory_config.pf_edli_admin.amount = amt;
                    if (!edliAmtValue && amt > 0) {
                        const compId = allComponents.find(c => {
                            const n = normalizeText(c.component_name);
                            return n.includes('edli') || n.includes('admin charges');
                        })?.id;
                        if (compId) {
                            rowTransactions.push({
                                employee_id: employee.id, component_id: compId, component_category: 'STATUTORY',
                                monthly_amount: amt, yearly_amount: amt * 12, included_in_ctc: true, is_employer_contribution: true,
                                company_id, branch_id: employee.branch_id, user_id
                            });
                        }
                    }
                }

                // --- Final CTC Reconciliation ---
                // Re-calculate CTC from all components to ensure total consistency
                let calculatedTotalCtc = 0;
                rowTransactions.forEach(t => {
                    const comp = allComponents.find(c => c.id === t.component_id);
                    // Include if explicitly flagged OR if it's an employer contribution/statutory component
                    if (t.included_in_ctc || t.is_employer_contribution || (comp && comp.component_category === 'STATUTORY')) {
                        calculatedTotalCtc += (parseFloat(t.monthly_amount) || 0);
                    }
                });

                // Add statutory amounts that might NOT be in rowTransactions (because component ID was missing)
                // but are enabled and marked as included in CTC
                if (!rowTransactions.find(t => t.component_id === employerPFCompId) && statutory_config.employer_pf.enabled && statutory_config.employer_pf.included_in_ctc) {
                    calculatedTotalCtc += (statutory_config.employer_pf.amount || 0);
                }
                if (!rowTransactions.find(t => {
                    const comp = allComponents.find(c => c.id === t.component_id);
                    return normalizeText(comp?.component_name || "").includes('gratuity');
                }) && statutory_config.gratuity.enabled && statutory_config.gratuity.included_in_ctc) {
                    calculatedTotalCtc += (statutory_config.gratuity.amount || 0);
                }
                if (!rowTransactions.find(t => {
                    const comp = allComponents.find(c => c.id === t.component_id);
                    return normalizeText(comp?.component_name || "").includes('bonus');
                }) && statutory_config.bonus.enabled && statutory_config.bonus.included_in_ctc) {
                    calculatedTotalCtc += (statutory_config.bonus.amount || 0);
                }
                if (!rowTransactions.find(t => {
                    const comp = allComponents.find(c => c.id === t.component_id);
                    const n = normalizeText(comp?.component_name || "");
                    return n.includes('leave encashment') || n.includes('leave enchashment') || n === 'pl';
                }) && statutory_config.leave_encashment.enabled && statutory_config.leave_encashment.included_in_ctc) {
                    calculatedTotalCtc += (statutory_config.leave_encashment.amount || 0);
                }

                // Check for Excel Grand CTC / CTC column
                const excelCTC = parseExcelAmount(row[statHeaderKeys.ctcKey]);
                const excelGrandCTC = parseExcelAmount(row['(A+B+C+D)']) || parseExcelAmount(row['Grand CTC']) || parseExcelAmount(row['CTC']) || excelCTC;

                // --- Final CTC Reconciliation & Rounding ---
                let finalCtcMonthly = excelGrandCTC > 0 ? excelGrandCTC : calculatedTotalCtc;
                
                // If there's a difference between provided CTC and calculated sum, add a Round Off adjustment
                const diff = finalCtcMonthly - calculatedTotalCtc;
                if (Math.abs(diff) > 0.01) {
                    const roundOffComp = allComponents.find(c => normalizeText(c.component_name).includes('round'));
                    if (roundOffComp) {
                        rowTransactions.push({
                            employee_id: employee.id,
                            component_id: roundOffComp.id,
                            component_category: 'FIXED',
                            monthly_amount: diff,
                            yearly_amount: diff * 12,
                            included_in_ctc: true,
                            is_employer_contribution: false,
                            calculation_type: 'FIXED',
                            company_id,
                            branch_id: employee.branch_id,
                            user_id
                        });
                        calculatedTotalCtc += diff;
                    } else {
                        // If no Round Off component, adjust the last earning component if possible
                        const lastEarning = [...rowTransactions].reverse().find(t => {
                            const c = allComponents.find(comp => comp.id === t.component_id);
                            return c && c.component_type === 'EARNING';
                        });
                        if (lastEarning) {
                            lastEarning.monthly_amount += diff;
                            lastEarning.yearly_amount = lastEarning.monthly_amount * 12;
                            calculatedTotalCtc += diff;
                        }
                    }
                }

                ctcMonthly = calculatedTotalCtc;

                let calculationBasis = 'WORKING_DAYS';
                if (statHeaderKeys.calculationBasisKey && row[statHeaderKeys.calculationBasisKey]) {
                    const val = String(row[statHeaderKeys.calculationBasisKey]).trim().toLowerCase();
                    if (val.includes("month") || val.includes("calendar")) calculationBasis = "DAYS_IN_MONTH";
                    else if (val.includes("30") || val.includes("fixed")) calculationBasis = "FIXED_30_DAYS";
                    else if (val.includes("working") || val.includes("26")) calculationBasis = "WORKING_DAYS";
                }

                const template = templateMap.get(employee.id);
                const oldCTC = template ? parseFloat(template.ctc_monthly) || 0 : 0;
                const effectiveDate = parseExcelDate(row[statHeaderKeys.effectiveDateKey], rowIndex, "Effective Date") || new Date();

                let salaryType = 'Monthly';
                if (statHeaderKeys.payrollCycleKey && row[statHeaderKeys.payrollCycleKey]) {
                    const cycleVal = String(row[statHeaderKeys.payrollCycleKey]).trim().toLowerCase();
                    if (cycleVal.includes('daily')) salaryType = 'Daily';
                    else if (cycleVal.includes('hourly')) salaryType = 'Hourly';
                }

                const templatePayload = {
                    employee_id: employee.id,
                    template_name: `Imported Template - ${employee.first_name}`,
                    staff_type: 'Regular', salary_type: salaryType,
                    ctc_monthly: ctcMonthly, ctc_yearly: ctcMonthly * 12,
                    lwp_calculation_basis: calculationBasis,
                    effective_date: effectiveDate,
                    statutory_config, company_id, branch_id: employee.branch_id, user_id, status: 0
                };

                if (template) {
                    templatesToUpdate.push({ id: template.id, ...templatePayload });
                } else {
                    templatesToCreate.push(templatePayload);
                }

                if (template) {
                    revisionsToCreate.push({
                        employee_id: employee.id,
                        previous_template_id: template.id,
                        new_template_id: template.id,
                        previous_ctc: oldCTC,
                        new_ctc: ctcMonthly,
                        effective_date: effectiveDate,
                        increment_amount: ctcMonthly - oldCTC,
                        increment_percentage: oldCTC > 0 ? ((ctcMonthly - oldCTC) / oldCTC) * 100 : 0,
                        remarks: "Salary Revised via Excel Import",
                        status: 1,
                        approved_by: user_id,
                        company_id,
                        branch_id: employee.branch_id
                    });
                }

                employeeUpdates.push({
                    id: employee.id,
                    pf_eligible: statutory_config.employee_pf.enabled || statutory_config.employer_pf.enabled,
                    esi_eligible: statutory_config.employee_esi.enabled || statutory_config.employer_esi.enabled,
                    pt_eligible: statutory_config.pt.enabled,
                    lwf_eligible: statutory_config.employee_lwf.enabled || statutory_config.employer_lwf.enabled
                });

                // Log Input Component Data (from Excel)
                // console.log('\n╔════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════╗');
                // console.log('║                                                          INPUT COMPONENT DATA (From Excel) - Employee: ' + empCodeValue.padEnd(15) + '                                                                                                                                                                                   ║');
                // console.log('╠════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════╣');
                // console.log('├─────────────────────────────────────────────────────────────┬──────────────────────────────┬──────────────────────────────┬──────────────────────────────┤');
                // console.log('│ Excel Header                                                 │ Component Name               │ Component Type               │ Amount                       │');
                // console.log('├─────────────────────────────────────────────────────────────┼──────────────────────────────┼──────────────────────────────┼──────────────────────────────┤');
                // headerComponentMap.forEach((comp, colIdx) => {
                //     const rawValue = row[headers[colIdx]];
                //     if (rawValue !== undefined && rawValue !== null && String(rawValue).trim() !== "") {
                //         const value = parseExcelAmount(rawValue);
                //         console.log(`│ ${(headers[colIdx] || '').toString().padEnd(60)} │ ${(comp.component_name || '').toString().padEnd(28)} │ ${(comp.component_type || '').toString().padEnd(28)} │ ${value.toString().padEnd(28)} │`);
                //     }
                // });
                // console.log('└─────────────────────────────────────────────────────────────┴──────────────────────────────┴──────────────────────────────┴──────────────────────────────┘');
                // console.log(`\n[Total Components from Excel]: ${rowTransactions.length}`);
                // console.log('[Component IDs Mapped]:', rowTransactions.map(t => t.component_id).join(', '));
                 // // Log Updated Component Data (Final State)
                // console.log('\n╔════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════╗');
                // console.log('║                                                          UPDATED COMPONENT DATA (Final) - Employee: ' + empCodeValue.padEnd(15) + '                                                                                                                                                                                       ║');
                // console.log('╠════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════╣');
                // console.log('├──────────────────────────────┬──────────────────────────────┬──────────────────────────────┬──────────────────────────────┬──────────────────────────────┤');
                // console.log('│ Component ID                 │ Component Name               │ Category                     │ Monthly Amount               │ Yearly Amount                │');
                // console.log('├──────────────────────────────┼──────────────────────────────┼──────────────────────────────┼──────────────────────────────┼──────────────────────────────┤');
                // rowTransactions.forEach(t => {
                //     const comp = allComponents.find(c => c.id === t.component_id);
                //     console.log(`│ ${(t.component_id || '').toString().padEnd(28)} │ ${(comp?.component_name || 'N/A').toString().padEnd(28)} │ ${(t.component_category || '').toString().padEnd(28)} │ ${(t.monthly_amount || 0).toString().padEnd(28)} │ ${(t.yearly_amount || 0).toString().padEnd(28)} │`);
                // });
                // console.log('└──────────────────────────────┴──────────────────────────────┴──────────────────────────────┴──────────────────────────────┴──────────────────────────────┘');
                // console.log(`\n[Total Updated Components]: ${rowTransactions.length}`);
                // console.log('[Sum of Monthly Amounts]:', rowTransactions.reduce((sum, t) => sum + (t.monthly_amount || 0), 0));

                // Log both Excel Input and Updated Statutory Config at the end
                // Store row transactions temporarily - we'll need template IDs to save them
                employee.rowTransactions = rowTransactions;
                createdCount++;

                if (createdCount % 100 === 0 && parentPort) {
                    parentPort.postMessage({ status: "PROGRESS", progress: Math.round((createdCount / originalRows.length) * 100) });
                }
                // console.log('\n========================================');
                // console.log('STATUTORY CONFIG COMPARISON - Employee:', empCodeValue);
                // console.log('========================================');
                // console.log('\n--- EXCEL INPUT DATA ---');
                // console.log('Employee Statutory:');
                // console.log('  PF STATUS  :', row[statHeaderKeys.ePfStat] || 'N/A');
                // console.log('  PF LIMIT   :', row[statHeaderKeys.ePfLim] || 'N/A');
                // console.log('  ESIC STATUS:', row[statHeaderKeys.eEsiStat] || 'N/A');
                // console.log('  PT STATUS  :', row[statHeaderKeys.ptStat] || 'N/A');
                // console.log('  LWF STATUS :', row[statHeaderKeys.eLwfStat] || 'N/A');
                // console.log('Employer Statutory:');
                // console.log('  PF STATUS  :', row[statHeaderKeys.rPfStat] || 'N/A');
                // console.log('  PF LIMIT   :', row[statHeaderKeys.rPfLim] || 'N/A');
                // console.log('  EDLI STATUS:', row[statHeaderKeys.edliStat] || 'N/A');
                // console.log('  ESI STATUS :', row[statHeaderKeys.rEsiStat] || 'N/A');
                // console.log('  LWF STATUS :', row[statHeaderKeys.rLwfStat] || 'N/A');
                
                // console.log('\n--- EXCEL SALARY COMPONENTS ---');
                // console.log('(A) Monthly Payable:');
                // console.log('  BASIC     :', parseExcelAmount(row['BASIC']) || 0);
                // console.log('  HRA       :', parseExcelAmount(row['HRA']) || 0);
                // console.log('  TRANSPORT :', parseExcelAmount(row['TRANSPORT']) || 0);
                // console.log('  MEDICAL   :', parseExcelAmount(row['MEDICAL']) || 0);
                // console.log('  FOOD      :', parseExcelAmount(row['FOOD']) || 0);
                // console.log('  SPECIAL   :', parseExcelAmount(row['SPECIAL']) || 0);
                // console.log('  LTA       :', parseExcelAmount(row['LTA']) || 0);
                // console.log('  (A) Total :', parseExcelAmount(row['(A) Total']) || parseExcelAmount(row['GROSS']) || 0);
                // console.log('(B) Annually Payable:');
                // console.log('  Bonus     :', parseExcelAmount(row['Bonus']) || 0);
                // console.log('  (B) Total :', parseExcelAmount(row['(B) Total']) || parseExcelAmount(row['Bonus']) || 0);
                // console.log('(C) Regulatory / Statutory (Employer):');
                // console.log('  PF              :', parseExcelAmount(statHeaderKeys.rPfAmt ? row[statHeaderKeys.rPfAmt] : 0) || 0);
                // console.log('  Leave Encashment:', parseExcelAmount(row['Leave Encashments']) || parseExcelAmount(row['Leave Encashment']) || 0);
                // console.log('  Gratuity        :', parseExcelAmount(row['Gratuity']) || 0);
                // console.log('  ESIC            :', parseExcelAmount(statHeaderKeys.rEsiAmt ? row[statHeaderKeys.rEsiAmt] : 0) || 0);
                // console.log('  (C) Total       :', parseExcelAmount(row['(C) Total']) || 0);
                // console.log('(D) Other Benefits:');
                // console.log('  Mobile         :', parseExcelAmount(row['Mobile']) || 0);
                // console.log('  Child Education:', parseExcelAmount(row['Child Education']) || 0);
                // console.log('  Petrol         :', parseExcelAmount(row['Petrol']) || 0);
                // console.log('  (D) Total      :', parseExcelAmount(row['(D) Total']) || 0);
                // console.log('--- TOTALS ---');
                // console.log('  Grand CTC (A+B+C+D):', parseExcelAmount(row['(A+B+C+D)']) || parseExcelAmount(row['Grand CTC']) || parseExcelAmount(row['CTC']) || 0);
                // console.log('Employee Deduction:');
                // const empPFDeduction = parseExcelAmount(statHeaderKeys.ePfAmt ? row[statHeaderKeys.ePfAmt] : 0) || 0;
                // const empESICDeduction = parseExcelAmount(statHeaderKeys.eEsiAmt ? row[statHeaderKeys.eEsiAmt] : 0) || 0;
                // const empFoodDeduction = parseExcelAmount(row['Food_1']) || parseExcelAmount(row['FOOD_1']) || parseExcelAmount(row['Food Deduction']) || parseExcelAmount(row['Food']) || 0;
                // const totalDeduction = empPFDeduction + empESICDeduction + empFoodDeduction;
                // console.log('  PF   :', empPFDeduction);
                // console.log('  ESIC :', empESICDeduction);
                // console.log('  Food :', empFoodDeduction);
                // console.log('  Total Deduction:', totalDeduction);
                // if (statHeaderKeys.netSalaryKey) {
                //     console.log('  Net Salary:', parseExcelAmount(row[statHeaderKeys.netSalaryKey]) || 0);
                // }
                
                // // Debug: Show all row keys to find Food column name
                // console.log('\n[DEBUG] All row keys:', Object.keys(row).join(', '));
                
                // console.log('\n--- UPDATED STATUTORY_CONFIG ---');
                // console.log('employee_pf     :', JSON.stringify(statutory_config.employee_pf));
                // console.log('employer_pf     :', JSON.stringify(statutory_config.employer_pf));
                // console.log('employee_esi    :', JSON.stringify(statutory_config.employee_esi));
                // console.log('employer_esi    :', JSON.stringify(statutory_config.employer_esi));
                // console.log('pt              :', JSON.stringify(statutory_config.pt));
                // console.log('employee_lwf    :', JSON.stringify(statutory_config.employee_lwf));
                // console.log('employer_lwf    :', JSON.stringify(statutory_config.employer_lwf));
                // console.log('gratuity        :', JSON.stringify(statutory_config.gratuity));
                // console.log('bonus           :', JSON.stringify(statutory_config.bonus));
                // console.log('leave_encashment:', JSON.stringify(statutory_config.leave_encashment));
                // console.log('pf_edli_admin   :', JSON.stringify(statutory_config.pf_edli_admin));
                // console.log('tds             :', JSON.stringify(statutory_config.tds));
                // console.log('========================================\n');

                    } catch (rowError) {
                errorCount++;
                const msg = rowError.message || "Unknown error processing row";
                errorSample.push(`Row ${rowIndex}: ${msg}`);
                writeError(errorFileStream, row, msg);
            }
        }

        // --- PHASE 2: BATCH DATABASE OPERATIONS ---
        if (createdCount > 0) {
            // 1. Bulk Update/Create Templates
            for (const t of templatesToUpdate) {
                await commonQuery.updateRecordById(EmployeeSalaryTemplate, t.id, t, transaction);
            }
            if (templatesToCreate.length > 0) {
                const newTemplates = await commonQuery.bulkCreate(EmployeeSalaryTemplate, templatesToCreate, { returning: true }, transaction);
                // Assign newly created template IDs back to employees
                newTemplates.forEach(nt => {
                    const emp = existingEmployees.find(e => e.id === nt.employee_id);
                    if (emp) {
                        const templateFromMap = templateMap.get(emp.id) || nt;
                        templateMap.set(emp.id, templateFromMap);
                    }
                });
            }

            // 2. Refresh Template Map and Prep Transactions
            const finalTemplates = await commonQuery.findAllRecords(EmployeeSalaryTemplate, {
                employee_id: { [Op.in]: existingEmployees.map(e => e.id) }
            }, { raw: true }, transaction);
            const finalTemplateMap = new Map();
            finalTemplates.forEach(t => finalTemplateMap.set(t.employee_id, t));

            const empIdsWithTransactions = [];
            existingEmployees.forEach(emp => {
                if (emp.rowTransactions) {
                    empIdsWithTransactions.push(emp.id);
                    const tid = finalTemplateMap.get(emp.id)?.id;
                    if (tid) {
                        emp.rowTransactions.forEach(rt => {
                            rt.employee_salary_template_id = tid;
                            transactionsToCreate.push(rt);
                        });
                    }
                }
            });

            // 3. Clear and Mega-Bulk Create Transactions
            await commonQuery.hardDeleteRecords(EmployeeSalaryTemplateTransaction, { employee_id: { [Op.in]: empIdsWithTransactions } }, transaction);
            if (transactionsToCreate.length > 0) {
                const CHUNK_SIZE = 1000;
                for (let i = 0; i < transactionsToCreate.length; i += CHUNK_SIZE) {
                    await commonQuery.bulkCreate(EmployeeSalaryTemplateTransaction, transactionsToCreate.slice(i, i + CHUNK_SIZE), {}, transaction);
                }
            }

            // 4. Bulk Create Revisions
            if (revisionsToCreate.length > 0) {
                await commonQuery.bulkCreate(SalaryRevisionHistory, revisionsToCreate, {}, transaction);
            }

            // 5. Update Employees
            for (const eu of employeeUpdates) {
                await commonQuery.updateRecordById(Employee, eu.id, eu, transaction);
            }

            // 6. Rebuild attendance days for employees affected by salary revisions
            // Apply effective date rules:
            // - If effective_date is in the past, clamp it to today (apply immediately)
            // - If effective_date is in the future, skip now (will take effect later)
            if (revisionsToCreate.length > 0) {
                const today = dayjs().startOf('day');
                const affectedMap = new Map();
                revisionsToCreate.forEach(r => {
                    if (!r.employee_id) return;
                    const eff = r.effective_date ? dayjs(r.effective_date).startOf('day') : today;
                    const applyDate = eff.isBefore(today) ? today : eff;
                    if (!affectedMap.has(r.employee_id) || applyDate.isBefore(affectedMap.get(r.employee_id))) {
                        affectedMap.set(r.employee_id, applyDate);
                    }
                });

                for (const [empId, applyDate] of affectedMap.entries()) {
                    if (applyDate.isAfter(today)) continue; // future revisions - handle later
                    let cur = applyDate.clone();
                    while (cur.isBefore(today) || cur.isSame(today, 'day')) {
                        await rebuildAttendanceDay(empId, cur.format('YYYY-MM-DD'), { user_id, company_id, branch_id }, transaction);
                        cur = cur.add(1, 'day');
                    }
                }
            }
        }

        if (errorCount > 0) {
            await transaction.rollback();
            parentPort.postMessage({
                status: "SUCCESS",
                result: {
                    importErrors: true,
                    errors: errorSample,
                    errorCount: errorCount,
                    message: `${errorCount} errors found. Please fix all errors before importing.`
                }
            });
            return;
        }

        await transaction.commit();
        parentPort.postMessage({
            status: "SUCCESS",
            result: { success: true, message: `${createdCount} salary structures processed successfully.`, count: createdCount, errorCount, errors: errorSample }
        });

    } catch (err) {
        if (transaction && !transaction.finished) await transaction.rollback();
        if (errorFileStream) errorFileStream.end();
        parentPort.postMessage({ status: "ERROR", error: err.message });
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
