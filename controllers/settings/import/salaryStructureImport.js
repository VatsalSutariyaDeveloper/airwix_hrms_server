const { parentPort, workerData } = require("worker_threads");
const { sequelize, commonQuery } = require("../../../helpers");
const { Employee, EmployeeSalaryTemplate, EmployeeSalaryTemplateTransaction, SalaryComponent, SalaryRevisionHistory } = require("../../../models");
const { transformRows } = require("../../../helpers/functions/excelService");
const { Op } = require("sequelize");
const xlsx = require("xlsx");
const fs = require("fs");
const { fail } = require('../../../helpers/Err');
const { requestContext } = require("../../../utils/requestContext");

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
        
        if (isCancelled) fail("IMPORT_CANCELLED");

        transaction = await sequelize.transaction();

        // 1. Pre-fetch all active salary components to map names to IDs
        const allComponents = await commonQuery.findAllRecords(SalaryComponent, {
            status: 0
        }, { attributes: ['id', 'component_name', 'component_type', 'component_category'], raw: true }, transaction, false);

        const componentMap = new Map();
        allComponents.forEach(comp => {
            componentMap.set(normalizeText(comp.component_name), comp);
        });

        // Pre-fetch specific component IDs for calculations
        const basicCompId = allComponents.find(c => normalizeText(c.component_name) === 'basic')?.id;
        const employeePFCompId = allComponents.find(c => {
            const n = normalizeText(c.component_name);
            return n.includes('pf') && (n.includes('deduction') || n.includes('employee'));
        })?.id;
        const employerPFCompId = allComponents.find(c => {
            const n = normalizeText(c.component_name);
            return n.includes('pf') && (n.includes('employer') || n.includes('contribution'));
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

        const statHeaderKeys = {
            ePfStat: getStatHeader(["employee", "pf", "status"]),
            ePfLim: getStatHeader(["employee", "pf", "limit"]),
            eEsiStat: getStatHeader(["employee", "esi", "status"]),
            ptStat: getStatHeader(["pt", "status"]),
            eLwfStat: getStatHeader(["employee", "lwf", "status"]),
            rPfStat: getStatHeader(["employer", "pf", "status"]),
            rPfLim: getStatHeader(["employer", "pf", "limit"]),
            edliStat: getStatHeader(["employer", "edli", "status"]),
            rEsiStat: getStatHeader(["employer", "esi", "status"]),
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
                return nh === "ctc" || nh === "monthly ctc" || nh === "grand ctc" || nh === "total ctc" || nh.includes("ctc");
            }),
            effectiveDateKey: headers.find(h => normalizeText(h).includes("effective") || normalizeText(h).includes("revision date")),
            calculationBasisKey: headers.find(h => {
                const nh = normalizeText(h);
                return nh.includes("calculation days") || nh.includes("calculation type") || nh.includes("calculation basis");
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

        const normalizeLimit = (val, side) => {
            const s = cleanStr(val || "");
            if (s === 'yes') {
                return side === 'employee' ? '₹1,800 Fixed' : '₹ 1800 Limit';
            }
            if (s === 'no') {
                return '12% of Basic';
            }
            // Existing fallback logic
            if (s.includes('1800')) {
                return side === 'employee' ? '₹1,800 Fixed' : '₹ 1800 Limit';
            }
            return '12% of Basic';
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
                    
                    const value = parseFloat(rawValue) || 0;

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
                if (statHeaderKeys.ePfStat) statutory_config.employee_pf.enabled = isYes(row[statHeaderKeys.ePfStat]);
                else if (rowTransactions.find(t => t.component_id === employeePFCompId)) statutory_config.employee_pf.enabled = true;

                if (statutory_config.employee_pf.enabled) {
                    let amt = 0;
                    if (statHeaderKeys.ePfLim) {
                        const limVal = row[statHeaderKeys.ePfLim];
                        statutory_config.employee_pf.calculation_type = normalizeLimit(limVal, 'employee');
                        if (isYes(limVal)) {
                            amt = 1800;
                        } else if (normalizeText(limVal) === 'no') {
                            amt = Math.round(basicAmount * 0.12);
                        } else {
                            amt = rowTransactions.find(t => t.component_id === employeePFCompId)?.monthly_amount || 0;
                        }
                    } else {
                        amt = rowTransactions.find(t => t.component_id === employeePFCompId)?.monthly_amount || 0;
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
                if (statHeaderKeys.rPfStat) statutory_config.employer_pf.enabled = isYes(row[statHeaderKeys.rPfStat]);
                else if (rowTransactions.find(t => t.component_id === employerPFCompId)) statutory_config.employer_pf.enabled = true;

                if (statutory_config.employer_pf.enabled) {
                    let amt = 0;
                    if (statHeaderKeys.rPfLim) {
                        const limVal = row[statHeaderKeys.rPfLim];
                        statutory_config.employer_pf.calculation_type = normalizeLimit(limVal, 'employer');
                        if (isYes(limVal)) {
                            amt = 1800;
                        } else if (normalizeText(limVal) === 'no') {
                            amt = Math.round(basicAmount * 0.12);
                        } else {
                            amt = rowTransactions.find(t => t.component_id === employerPFCompId)?.monthly_amount || 0;
                        }
                    } else {
                        amt = rowTransactions.find(t => t.component_id === employerPFCompId)?.monthly_amount || 0;
                    }
                    
                    const t = rowTransactions.find(t => t.component_id === employerPFCompId);
                    const oldAmt = t ? t.monthly_amount : 0;
                    statutory_config.employer_pf.amount = amt;

                    if (t) {
                        ctcMonthly = ctcMonthly - oldAmt + amt;
                        t.monthly_amount = amt;
                        t.yearly_amount = amt * 12;
                    } else if (amt > 0 && employerPFCompId) {
                        rowTransactions.push({
                            employee_id: employee.id,
                            component_id: employerPFCompId,
                            component_category: 'EMPLOYER_CONTRIBUTION',
                            monthly_amount: amt,
                            yearly_amount: amt * 12,
                            included_in_ctc: true,
                            is_employer_contribution: true,
                            company_id,
                            branch_id: employee.branch_id,
                            user_id
                        });
                        ctcMonthly += amt;
                    }
                }

                // --- Other Statutory (ESI, PT, LWF) ---
                const empESIAmt = findCompValue(["employer esi", "esic", "employer share esi"]);
                if (empESIAmt) { statutory_config.employer_esi.enabled = true; statutory_config.employer_esi.amount = empESIAmt.amount; }
                const empLWFAmt = findCompValue(["lwf", "labour welfare"]);
                if (empLWFAmt) { statutory_config.employer_lwf.enabled = true; statutory_config.employer_lwf.amount = empLWFAmt.amount; }
                const dedESIAmt = findCompValue(["esi deduction", "employee esi", "health insurance"]);
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
                const gratuityAmt = findCompValue(["gratuity", "gratuity provision", "gratuity employer", "gratuity contribution"]);
                if (statutory_config.gratuity.enabled) {
                    const amt = (gratuityAmt && gratuityAmt.amount > 0) ? gratuityAmt.amount : Math.round(basicAmount * 0.0481);
                    statutory_config.gratuity.amount = amt;
                    statutory_config.gratuity.calculation_type = (gratuityAmt && gratuityAmt.amount > 0) ? 'Fixed' : 'Attendance';
                    if ((!gratuityAmt || gratuityAmt.amount === 0) && amt > 0) {
                        const compId = allComponents.find(c => normalizeText(c.component_name).includes('gratuity'))?.id;
                        if (compId) {
                            // Clear existing if it was 0
                            const existingIdx = rowTransactions.findIndex(t => t.component_id === compId);
                            if (existingIdx !== -1) rowTransactions.splice(existingIdx, 1);

                            rowTransactions.push({
                                employee_id: employee.id, component_id: compId, component_category: 'STATUTORY',
                                monthly_amount: amt, yearly_amount: amt * 12, included_in_ctc: true, is_employer_contribution: true,
                                company_id, branch_id: employee.branch_id, user_id
                            });
                        }
                    }
                }

                const leAmt = findCompValue(["leave encashments", "leave enchashments", "leave encashment", "leave enchashment", "pl", "privilege leave"]);
                if (statutory_config.leave_encashment.enabled) {
                    const amt = (leAmt && leAmt.amount > 0) ? leAmt.amount : Math.round(basicAmount * 0.0481);
                    statutory_config.leave_encashment.amount = amt;
                    statutory_config.leave_encashment.calculation_type = (leAmt && leAmt.amount > 0) ? 'Fixed' : 'Attendance';
                    if ((!leAmt || leAmt.amount === 0) && amt > 0) {
                        const compId = allComponents.find(c => {
                            const n = normalizeText(c.component_name);
                            return n.includes('leave encashment') || n.includes('leave enchashment') || n === 'pl';
                        })?.id;
                        if (compId) {
                            const existingIdx = rowTransactions.findIndex(t => t.component_id === compId);
                            if (existingIdx !== -1) rowTransactions.splice(existingIdx, 1);

                            rowTransactions.push({
                                employee_id: employee.id, component_id: compId, component_category: 'STATUTORY',
                                monthly_amount: amt, yearly_amount: amt * 12, included_in_ctc: true, is_employer_contribution: true,
                                company_id, branch_id: employee.branch_id, user_id
                            });
                        }
                    }
                }

                const bonusAmtValue = findCompValue(["bonuses", "bonus", "bonus provision", "exgratia", "ex-gratia"]);
                if (statutory_config.bonus.enabled) {
                    const amt = (bonusAmtValue && bonusAmtValue.amount > 0) ? bonusAmtValue.amount : Math.round(basicAmount * 0.0833);
                    statutory_config.bonus.amount = amt;
                    statutory_config.bonus.calculation_type = (bonusAmtValue && bonusAmtValue.amount > 0) ? 'Fixed' : 'Attendance';
                    if ((!bonusAmtValue || bonusAmtValue.amount === 0) && amt > 0) {
                        const compId = allComponents.find(c => normalizeText(c.component_name).includes('bonus'))?.id;
                        if (compId) {
                            const existingIdx = rowTransactions.findIndex(t => t.component_id === compId);
                            if (existingIdx !== -1) rowTransactions.splice(existingIdx, 1);

                            rowTransactions.push({
                                employee_id: employee.id, component_id: compId, component_category: 'STATUTORY',
                                monthly_amount: amt, yearly_amount: amt * 12, included_in_ctc: true, is_employer_contribution: true,
                                company_id, branch_id: employee.branch_id, user_id
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
                
                // We prioritize the calculated sum to ensure UI/Backend consistency
                ctcMonthly = calculatedTotalCtc;

                // However, if Excel specifically provided a HIGHER CTC (e.g. including hidden items), we respect it
                if (statHeaderKeys.ctcKey && row[statHeaderKeys.ctcKey]) {
                    const excelCTC = parseFloat(row[statHeaderKeys.ctcKey]) || 0;
                    if (excelCTC > ctcMonthly) ctcMonthly = excelCTC;
                }

                let calculationBasis = 'WORKING_DAYS';
                if (statHeaderKeys.calculationBasisKey && row[statHeaderKeys.calculationBasisKey]) {
                    const val = String(row[statHeaderKeys.calculationBasisKey]).trim().toUpperCase();
                    if (["DAYS_IN_MONTH", "FIXED_30_DAYS", "WORKING_DAYS"].includes(val)) {
                        calculationBasis = val;
                    }
                }

                const template = templateMap.get(employee.id);
                const oldCTC = template ? parseFloat(template.ctc_monthly) || 0 : 0;

                const templatePayload = {
                    employee_id: employee.id,
                    template_name: `Imported Template - ${employee.first_name}`,
                    staff_type: 'Regular', salary_type: 'Monthly',
                    ctc_monthly: ctcMonthly, ctc_yearly: ctcMonthly * 12,
                    lwp_calculation_basis: calculationBasis,
                    statutory_config, company_id, branch_id: employee.branch_id, user_id, status: 0
                };

                if (template) {
                    templatesToUpdate.push({ id: template.id, ...templatePayload });
                } else {
                    templatesToCreate.push(templatePayload);
                }

                if (template) {
                    const effectiveDate = parseExcelDate(row[statHeaderKeys.effectiveDateKey], rowIndex, "Effective Date") || new Date();
                    revisionsToCreate.push({
                        employee_id: employee.id, 
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

                // Store row transactions temporarily - we'll need template IDs to save them
                employee.rowTransactions = rowTransactions;
                createdCount++;

                if (createdCount % 100 === 0 && parentPort) {
                    parentPort.postMessage({ status: "PROGRESS", progress: Math.round((createdCount / originalRows.length) * 100) });
                }

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
                console.log("transactionsToCreate",transactionsToCreate)
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
