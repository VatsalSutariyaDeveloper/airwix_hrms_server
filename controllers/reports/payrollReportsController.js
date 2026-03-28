const { Employee, SalaryComponent, Payslip, EmployeeSalaryTemplate, EmployeeSalaryTemplateTransaction, DesignationMaster, Department, BranchMaster, PaymentHistory } = require("../../models");
const { commonQuery, handleError } = require("../../helpers");
const { Op } = require("sequelize");

exports.getTDSDeductionReport = async (req, res) => {
    return res.ok([]);
    /*
    try {
        const { month, year, branch_id } = req.body;
        if (!month || !year) {
            return res.error("VALIDATION_ERROR", { message: "Month and Year are required" });
        }

        const where = {
            month: parseInt(month),
            year: parseInt(year),
            status: { [Op.in]: [1, 2] } // Finalized or Paid
        };

        if (branch_id) {
            where.branch_id = branch_id;
        }

        const payslips = await commonQuery.findAllRecords(Payslip, where, {
            include: [{
                model: Employee,
                as: "employee",
                attributes: ['id', 'first_name', 'employee_code', 'pan_number'],
                include: [{ model: DesignationMaster, as: 'designation', attributes: ['designation_name'] }]
            }],
            order: [['employee_id', 'ASC']]
        });

        const reportData = [];

        payslips.forEach(payslip => {
            const tdsData = payslip.tds_calculation_data || {};
            const actualTds = parseFloat(payslip.statutory_details?.['Income Tax (TDS)'] || 0);

            reportData.push({
                    id: payslip.id,
                    employee_id: payslip.employee_id,
                    employee_name: payslip.employee?.first_name,
                    employee_code: payslip.employee?.employee_code,
                    pan_number: payslip.employee?.pan_number,
                    designation: payslip.employee?.designation?.designation_name,

                    // Detailed tax data from stored snapshot
                    annual_gross: tdsData.annualGross || 0,
                    standard_deduction: tdsData.standardDeduction || 0,
                    taxable_income: tdsData.taxableIncome || 0,
                    regime: tdsData.regime || 'new_regime',
                    annual_tax: tdsData.annualTax || 0,
                    tax_paid_already: tdsData.taxPaidAlready || 0,
                    monthly_tds: tdsData.monthlyTDS || 0,
                    percentage: tdsData.percentage || 0,
                    exemption_amount: parseFloat(tdsData.exemptions || 0),
                    total_deduction: payslip.total_deduction || 0,

                    // What was actually deducted in the finalized payslip
                    actual_tds_deducted: actualTds,
                    status: payslip.status
                });
        });

        return res.ok(reportData);
    } catch (err) {
        return handleError(err, res, req);
    }
    */
};


exports.getEmployerContributionReport = async (req, res) => {
    try {
        const { month, year, branch_id } = req.body;
        if (!month || !year) {
            return res.error("VALIDATION_ERROR", { message: "Month and Year are required" });
        }

        const where = {
            month,
            year,
            status: { [Op.in]: [1, 3] } // Finalized or Paid
        };

        if (branch_id) {
            where.branch_id = branch_id;
        }

        const payslips = await commonQuery.findAllRecords(Payslip, where, {
            include: [
                {
                    model: Employee,
                    as: 'employee',
                    attributes: ['id', 'first_name', 'employee_code'],
                    include: [
                        {
                            model: DesignationMaster,
                            as: 'designation',
                            attributes: ['designation_name']
                        }
                    ]
                }
            ]
        });

        const report = payslips.map(ps => {
            const employerDetails = ps.employer_details || {};
            let totalContribution = 0;
            const contributionMap = {};

            // Extract values and calculate total
            Object.entries(employerDetails).forEach(([key, value]) => {
                const val = parseFloat(value || 0);
                contributionMap[key] = val;
                totalContribution += val;
            });

            return {
                id: ps.id,
                employee_id: ps.employee?.id,
                employee_name: ps.employee?.first_name,
                employee_code: ps.employee?.employee_code,
                designation: ps.employee?.designation?.designation_name,
                contribution: contributionMap,
                total_contribution: parseFloat(totalContribution.toFixed(2))
            };
        });

        return res.ok({
            report,
            month,
            year
        });

    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getCTCBreakdownReport = async (req, res) => {
    try {
        const { branch_id } = req.body;
        
        let where = { status: 0, company_id: req.user.company_id };
        if (branch_id && branch_id !== 'All' && branch_id !== 0 && branch_id !== '0') {
            where.branch_id = branch_id;
        }

        const employees = await commonQuery.findAllRecords(Employee, where, {
            attributes: ['id', 'first_name', 'employee_code', 'branch_id'],
            include: [
                { model: DesignationMaster, as: 'designation', attributes: ['designation_name'] },
                { model: Department, as: 'department', attributes: ['name'] },
                { 
                    model: EmployeeSalaryTemplate, 
                    as: 'employeeSalaryTemplate',
                    include: [{
                        separate: true,
                        model: EmployeeSalaryTemplateTransaction,
                        as: 'employeeSalaryTemplateTransactions',
                        include: [{ model: SalaryComponent, as: 'component', attributes: ['component_name'] }]
                    }]
                }
            ]
        }, null, { company_id: true });

        const branches = await commonQuery.findAllRecords(BranchMaster, { company_id: req.user.company_id }, {}, null, { company_id: true });
        const branchMap = {};
        branches.forEach(b => branchMap[b.id] = b.branch_name);

        let allComponentNames = new Set();
        let reportData = [];

        employees.forEach(emp => {
            const template = emp.employeeSalaryTemplate;
            if (!template) return;

            let row = {
                employee_name: emp.first_name || '-',
                designation: emp.designation?.designation_name || '-',
                employee_code: emp.employee_code || '-',
                branch: branchMap[emp.branch_id] || '-',
                department: emp.department?.name || '-',
                ctc: parseFloat(template.ctc_monthly || 0),
                salary_type: template.salary_type || 'Monthly',
                components: {}
            };

            const sc = template.statutory_config || {};
            if (sc.employee_pf?.enabled) { row.components['Employee PF Contribution'] = sc.employee_pf.amount; allComponentNames.add('Employee PF Contribution'); }
            if (sc.employee_esi?.enabled) { row.components['Employee ESI Contribution'] = sc.employee_esi.amount; allComponentNames.add('Employee ESI Contribution'); }
            if (sc.pt?.enabled) { row.components['Professional Tax'] = sc.pt.amount; allComponentNames.add('Professional Tax'); }
            if (sc.employee_lwf?.enabled) { row.components['Employee LWF Contribution'] = sc.employee_lwf.amount; allComponentNames.add('Employee LWF Contribution'); }
            if (sc.employer_pf?.enabled) { row.components['Employer PF Contribution'] = sc.employer_pf.amount; allComponentNames.add('Employer PF Contribution'); }
            if (sc.employer_esi?.enabled) { row.components['Employer ESI Contribution'] = sc.employer_esi.amount; allComponentNames.add('Employer ESI Contribution'); }
            if (sc.employer_lwf?.enabled) { row.components['Employer LWF Contribution'] = sc.employer_lwf.amount; allComponentNames.add('Employer LWF Contribution'); }
            if (sc.pf_edli_admin?.enabled) { row.components['PF EDLI & Admin Charges'] = sc.pf_edli_admin.amount; allComponentNames.add('PF EDLI & Admin Charges'); }

            const trans = template.employeeSalaryTemplateTransactions || [];
            trans.forEach(tr => {
                if (tr.component?.component_name) {
                    const name = tr.component.component_name;
                    row.components[name] = parseFloat(tr.monthly_amount || 0);
                    allComponentNames.add(name);
                }
            });

            reportData.push(row);
        });

        // make sure basic salary is always first if it exists
        let cols = Array.from(allComponentNames);
        const basicIndex = cols.findIndex(c => c.toLowerCase() === 'basic salary' || c.toLowerCase() === 'basic');
        if (basicIndex > 0) {
            const b = cols.splice(basicIndex, 1)[0];
            cols.unshift(b);
        }

        return res.ok({
            categories: cols,
            reportData
        });

    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getGeneratedPayslipReport = async (req, res) => {
    try {
        const { month, year, branch_id } = req.body;
        
        if (!month || !year) {
            return res.error("VALIDATION_ERROR", { message: "Month and Year are required" });
        }

        let where = { month, year, company_id: req.user.company_id, status: { [Op.ne]: 2 } }; // not deleted
        if (branch_id && branch_id !== 'All' && branch_id !== 0 && branch_id !== '0') {
            where.branch_id = branch_id;
        }

        const payslips = await commonQuery.findAllRecords(Payslip, where, {
            include: [
                {
                    model: Employee,
                    as: 'employee',
                    attributes: ['first_name', 'employee_code', 'joining_date', 'pan_number', 'uan_number', 'pf_number', 'branch_id'],
                    include: [
                        { model: DesignationMaster, as: 'designation', attributes: ['designation_name'] },
                        { model: Department, as: 'department', attributes: ['name'] }
                    ]
                }
            ]
        }, null, { company_id: true });

        const branches = await commonQuery.findAllRecords(BranchMaster, { company_id: req.user.company_id }, {}, null, { company_id: true });
        const branchMap = {};
        branches.forEach(b => branchMap[b.id] = b.branch_name);

        let dynamicEarnings = new Set();
        let dynamicDeductions = new Set();
        let dynamicStatutory = new Set();

        let reportData = [];

        payslips.forEach(ps => {
            const emp = ps.employee || {};
            const bd = ps.break_down || {};
            const sal = bd.salary || {};

            let row = {
                employee_name: emp.first_name || '-',
                employee_code: emp.employee_code || '-',
                branch_name: branchMap[emp.branch_id] || '-',
                department: emp.department?.name || '-',
                designation: emp.designation?.designation_name || '-',
                joining_date: emp.joining_date || '-',
                pan_number: emp.pan_number || '-',
                uan_number: emp.uan_number || '-',
                pf_number: emp.pf_number || '-',
                
                salary_amount: parseFloat(sal.ctc_monthly || ps.fixed_gross || 0),
                salary_type: 'Monthly',
                
                days_in_month: ps.total_days || 0,
                payable_days: ps.pd_days || 0,
                present_days: ps.present_days || 0,
                half_days: parseFloat(ps.half_days) || 0,
                absent_days: ps.absent_days || 0,
                holidays: ps.ph_days || 0,
                week_offs: ps.wo_days || 0,
                paid_leaves: ps.lp_days || 0,
                unpaid_leaves: ps.ul_days || 0,
                
                total_payable_days: ps.pd_days || 0,
                total_paid_days: ps.pd_days || 0,
                actual_payable_days: ps.pd_days || 0,
                paid_leave_amount: 0, 

                base_salary: 0,
                overtime: 0,
                overtime_amount: 0,
                
                earnings: {},
                deductions: {},
                statutory: {},
                
                net_salary: parseFloat(ps.net_salary || 0)
            };

            let earningsArr = ps.earning_details || (bd.breakdown?.earnings || []);
            if (!Array.isArray(earningsArr)) {
                earningsArr = Object.entries(earningsArr).map(([name, amount]) => ({ name, amount }));
            }
            
            earningsArr.forEach(e => {
                const name = e.name;
                const amt = parseFloat(e.amount || 0);
                if (name.toLowerCase().includes('basic') || name.toLowerCase().includes('base')) {
                    row.base_salary += amt;
                } else if (name.toLowerCase().includes('overtime')) {
                    row.overtime_amount += amt;

                    row.overtime = 0;
                } else {
                    dynamicEarnings.add(name);
                    row.earnings[name] = (row.earnings[name] || 0) + amt;
                }
            });

            let dedArr = ps.deduction_details || (bd.breakdown?.deductions || []);
            if (!Array.isArray(dedArr)) {
                // If it's an object from DB, check against statutory_details keys for is_statutory flag
                const statObj = ps.statutory_details || (bd.breakdown?.statutory || {});
                dedArr = Object.entries(dedArr).map(([name, amount]) => ({ 
                    name, 
                    amount,
                    is_statutory: statObj.hasOwnProperty(name)
                }));
            }

            dedArr.forEach(d => {
                const name = d.name;
                const amt = parseFloat(d.amount || 0);
                // Exclude statutory items duplicated in deductions
                if (!d.is_statutory) {
                     dynamicDeductions.add(name);
                     row.deductions[name] = (row.deductions[name] || 0) + amt;
                }
            });

            // Fallback for statutory if it's stored in statutory_details directly
            const statObj = ps.statutory_details || (bd.breakdown?.statutory || {});
            Object.keys(statObj).forEach(k => {
                const amt = parseFloat(statObj[k] || 0);
                dynamicStatutory.add(k);
                row.statutory[k] = amt;
            });

            // Extract statutory from deductions array if it has is_statutory flag
            dedArr.forEach(d => {
                if (d.is_statutory) {
                    const name = d.name;
                    const amt = parseFloat(d.amount || 0);
                    dynamicStatutory.add(name);
                    row.statutory[name] = amt;
                }
            });

            reportData.push(row);
        });

        // Convert sets to arrays
        const earningColumns = Array.from(dynamicEarnings);
        const deductionColumns = Array.from(dynamicDeductions);
        const statutoryColumns = Array.from(dynamicStatutory);

        return res.ok({
            earningColumns,
            deductionColumns,
            statutoryColumns,
            reportData
        });

    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getPFReport = async (req, res) => {
    try {
        const { month, year, branch_id } = req.body;
        
        if (!month || !year) {
            return res.error("VALIDATION_ERROR", { message: "Month and Year are required" });
        }

        let where = { month, year, company_id: req.user.company_id, status: { [Op.ne]: 2 } }; 
        if (branch_id && branch_id !== 'All' && branch_id !== 0 && branch_id !== '0') {
            where.branch_id = branch_id;
        }

        const payslips = await commonQuery.findAllRecords(Payslip, where, {
            include: [
                {
                    model: Employee,
                    as: 'employee',
                    attributes: ['first_name', 'employee_code', 'uan_number', 'pf_number', 'branch_id', 'employee_type', 'worker_type']
                }
            ]
        }, null, { company_id: true });
        // payslips = payslips.get({ plain: true });
        // Filter out employees without PF
        // We consider someone in PF if they have UAN/PF OR if there's any PF amount in statutory/employer details.
        
        let reportData = [];
        payslips.forEach(ps => {
            const emp = ps.employee || {};
            const bd = ps.break_down || {};
            
            // Extraction helper to handle both Array and Object formats in JSON fields
            // It normalizes key names (trim + case-insensitive) since legacy data sometimes includes extra spaces
            const getValueFromJSON = (data, keys) => {
                // eslint-disable-next-line no-console
                console.log("Extracting PF value from data:", data, "with keys:", keys);
                if (!data) return 0;

                const normalizedKeys = (keys || []).map(k => (typeof k === 'string' ? k.trim().toLowerCase() : k));

                if (Array.isArray(data)) {
                    const found = data.find(item => {
                        const name = typeof item?.name === 'string' ? item.name.trim().toLowerCase() : '';
                        return normalizedKeys.includes(name);
                    });
                    return found ? parseFloat(found.amount || 0) : 0;
                }

                // Normalize object keys to allow matching keys with extra spaces/case differences
                const normalizedData = {};
                Object.entries(data).forEach(([k, v]) => {
                    if (typeof k === 'string') {
                        normalizedData[k.trim().toLowerCase()] = v;
                    }
                });

                for (const nk of normalizedKeys) {
                    if (normalizedData[nk] !== undefined) return parseFloat(normalizedData[nk] || 0);
                }

                return 0;
            };

            // 1. Extract Employee PF (from statutory or deductions)
            const statData = ps.statutory_details || (bd.breakdown?.statutory || {});
            const dedData = ps.deduction_details || (bd.breakdown?.deductions || {});
            const pfKeys = ['Employee PF', 'PF', 'EPF', 'Provident Fund'];
            let employee_pf = getValueFromJSON(statData, pfKeys);
            if (employee_pf === 0) {
                employee_pf = getValueFromJSON(dedData, pfKeys);
            }

            // 2. Extract Employer PF
            const employerData = ps.employer_details || (bd.breakdown?.employer || {});
            const empPfKeys = ['Employer PF', 'EPF Employer', 'Employer Contribution PF'];
            let employer_pf = getValueFromJSON(employerData, empPfKeys);
            
            // 3. Extract Basic Salary (often used as base for PF)
            const earnData = ps.earning_details || (bd.breakdown?.earnings || {});
            const basicKeys = ['Basic Salary', 'Basic', 'BASIC', 'Basic Pay'];
            let basic_salary = getValueFromJSON(earnData, basicKeys);

            let pf_edli_admin = getValueFromJSON(employerData, ['PF EDLI/Admin', 'EDLI', 'Admin Charges']);
            
            // If they have no PF deduction or contribution, skip them (unless they have pf config active)
            // Or just include all for now to let admin see zeroes if unconfigured
            
            // Indian PF logic rough calculation for PF wages if not saved explicitly
            // PF Wages is usually the base (Basic+DA) capped at 15000 or the actual base
            let pf_wages = 0;
            if (employee_pf > 0) {
                pf_wages = Math.round(employee_pf / 0.12);
            } else if (basic_salary > 0 && (emp.pf_number || emp.uan_number)) {
                // If PF is configured but deduction was 0 (maybe skipped or lwp), we might still want to show base
                pf_wages = basic_salary;
            }
            
            // In ECR, EPS (Pension) is 8.33% of PF Wages (Capped at 15000 usually)
            // EPF Diff is 3.67% of PF Wages
            let eps_wages = pf_wages > 15000 ? 15000 : pf_wages;
            let eps_contribution = Math.round(eps_wages * 0.0833);
            let epf_eps_diff = Math.round(employee_pf - eps_contribution);
            
            // If EPS is not enabled or different, rely on whatever data we have, but usually we just calculate ECR standard here
            
            // NCP Days (Non-contributing period) is basically LWP days
            const lwp_days = parseFloat(ps.wp_days || 0) < parseFloat(ps.total_days || 0) 
                             ? parseFloat(ps.total_days || 0) - parseFloat(ps.wp_days || 0) 
                             : 0;

            let row = {
                uan: emp.uan_number || '-',
                member_name: emp.first_name || '-',
                gross_wages: parseFloat((ps.fixed_gross || bd.salary?.ctc_monthly || 0)).toFixed(2),
                epf_wages: pf_wages,
                eps_wages: eps_wages,
                edli_wages: eps_wages, 
                epf_contri_remitted: Math.round(employee_pf), // 12%
                eps_contri_remitted: eps_contribution, // 8.33%
                epf_eps_diff_remitted: epf_eps_diff, // 3.67%
                ncp_days: lwp_days,
                refund_of_advances: 0,
                employee_code: emp.employee_code || '-',
                employee_type_label: { 1: "Staff", 2: "Worker", 3: "Contractor" }[emp.employee_type] || 'N/A',
                worker_type_label: { 1: "On-role", 2: "Off-role" }[emp.worker_type] || 'N/A',
                pf_number: emp.pf_number || '-'
            };

            // Only include employees who actually have PF configured or deducted
            if (row.epf_contri_remitted > 0 || row.uan !== '-') {
                reportData.push(row);
            }
            
        });

        return res.ok({
            reportData
        });

    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getEmployeeSummaryReport = async (req, res) => {
    try {
        const { month, year, ...employeeFilter } = req.body;
        if (!year) {
            return res.error("VALIDATION_ERROR", { message: "Year is required" });
        }

        const payslipWhere = { year };
        if (month) payslipWhere.month = month;

        const paymentHistoryWhere = { year };
        if (month) paymentHistoryWhere.month = month;

        const employees = await commonQuery.findAllRecords(
            Employee,
            { ...employeeFilter, company_id: req.user.company_id },
            {
                include: [
                    {
                        model: Payslip,
                        as: "payslips",
                        where: payslipWhere,
                        required: true
                    },
                    {
                        model: PaymentHistory,
                        as: "paymentHistories",
                        where: paymentHistoryWhere,
                        required: false
                    }
                ]
            }
        );

        const report = employees.map(emp => {
            const netPayable = (emp.payslips || []).reduce((acc, p) => acc + parseFloat(p.net_salary || 0), 0);
            const paidAmount = (emp.paymentHistories || []).reduce((acc, ph) => acc + parseFloat(ph.amount || 0), 0);
            const pendingAmount = netPayable - paidAmount;

            return {
                id: emp.id,
                employee_name: emp.first_name,
                employee_code: emp.employee_code,
                net_payable: Math.round(netPayable * 100) / 100,
                paid_amount: Math.round(paidAmount * 100) / 100,
                pending_amount: Math.round(pendingAmount * 100) / 100
            };
        });

        return res.ok(report);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getESIReport = async (req, res) => {
    try {
        const { month, year, branch_id } = req.body;
        
        if (!month || !year) {
            return res.error("VALIDATION_ERROR", { message: "Month and Year are required" });
        }

        let where = { month, year, company_id: req.user.company_id, status: { [Op.ne]: 2 } }; 
        if (branch_id && branch_id !== 'All' && branch_id !== 0 && branch_id !== '0') {
            where.branch_id = branch_id;
        }

        const payslips = await commonQuery.findAllRecords(Payslip, where, {
            include: [
                {
                    model: Employee,
                    as: 'employee',
                    attributes: ['first_name', 'employee_code', 'esi_number', 'branch_id', 'employee_type', 'worker_type']
                }
            ]
        }, null, { company_id: true });

        let reportData = [];

        payslips.forEach(ps => {
            const emp = ps.employee || {};
            const bd = ps.break_down || {};
            
            // Extraction helper to handle both Array and Object formats in JSON fields
            // It normalizes key names (trim + case-insensitive) since legacy data sometimes includes extra spaces
            const getValueFromJSON = (data, keys) => {
                if (!data) return 0;

                const normalizedKeys = (keys || []).map(k => (typeof k === 'string' ? k.trim().toLowerCase() : k));

                if (Array.isArray(data)) {
                    const found = data.find(item => {
                        const name = typeof item?.name === 'string' ? item.name.trim().toLowerCase() : '';
                        return normalizedKeys.includes(name);
                    });
                    return found ? parseFloat(found.amount || 0) : 0;
                }

                const normalizedData = {};
                Object.entries(data).forEach(([k, v]) => {
                    if (typeof k === 'string') {
                        normalizedData[k.trim().toLowerCase()] = v;
                    }
                });

                for (const nk of normalizedKeys) {
                    if (normalizedData[nk] !== undefined) return parseFloat(normalizedData[nk] || 0);
                }

                return 0;
            };

            // 1. Extract Employee ESI
            const statData = ps.statutory_details || (bd.breakdown?.statutory || {});
            const dedData = ps.deduction_details || (bd.breakdown?.deductions || {});
            const esiKeys = ['Employee ESI', 'ESI', 'ESIC'];

            let employee_esi = getValueFromJSON(statData, esiKeys);
            if (employee_esi === 0) {
                employee_esi = getValueFromJSON(dedData, esiKeys);
            }

            // 2. Extract Employer ESI
            const employerData = ps.employer_details || (bd.breakdown?.employer || {});
            let employer_esi = getValueFromJSON(employerData, ['Employer ESI', 'ESI Employer', 'Employer Contribution ESI']);
            
            // ESI calculation logic rough deduction check
            // Employee pays 0.75%, Employer pays 3.25% of gross wages usually.
            // Let's rely on actual total_earnings to determine ESI wages (which it usually is, capped or not depending on settings but normally ESIC requires actual Gross during return)
            const gross_earnings = parseFloat(ps.paid_gross || bd.salary?.takeHomeEarnings || 0).toFixed(2);
            
            const total_worked_days = parseFloat(ps.present_days || 0);

            let row = {
                ip_number: emp.esi_number || '-',
                ip_name: emp.first_name || '-',
                no_of_days_worked: total_worked_days,
                total_monthly_wages: gross_earnings,
                employee_share: employee_esi,
                employer_share: employer_esi,
                total_contribution: parseFloat((employee_esi + employer_esi).toFixed(2)),
                // reason_code_for_zero_working_days: total_worked_days === 0 ? 'LWD' : '-', // Provide a generic dummy reason e.g., Leave Without Pay if 0 days
                // last_working_day: '-',
                employee_code: emp.employee_code || '-',
                employee_type_label: { 1: "Staff", 2: "Worker", 3: "Contractor" }[emp.employee_type] || 'N/A',
                worker_type_label: { 1: "On-role", 2: "Off-role" }[emp.worker_type] || 'N/A',
            };

            // Only include employees who actually have ESI configured or deducted
            if (row.employee_share > 0 || row.employer_share > 0 || (row.ip_number && row.ip_number !== '-')) {
                reportData.push(row);
            }
            
        });

        return res.ok({
            reportData
        });

    } catch (err) {
        return handleError(err, res, req);
    }
};