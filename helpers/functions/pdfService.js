const puppeteer = require('puppeteer');
const ejs = require('ejs');
const path = require('path');
const fs = require('fs');

/**
 * Converts a number to words (Indian Style - Lakhs/Crores)
 */
const numberToWords = (num) => {
    const a = ['', 'One ', 'Two ', 'Three ', 'Four ', 'Five ', 'Six ', 'Seven ', 'Eight ', 'Nine ', 'Ten ', 'Eleven ', 'Twelve ', 'Thirteen ', 'Fourteen ', 'Fifteen ', 'Sixteen ', 'Seventeen ', 'Eighteen ', 'Nineteen '];
    const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

    const n = ('000000000' + num).substr(-9).match(/^(\d{2})(\d{2})(\d{2})(\d{1})(\d{2})$/);
    if (!n) return '';
    let str = '';
    str += n[1] != 0 ? (a[Number(n[1])] || b[n[1][0]] + ' ' + a[n[1][1]]) + 'Crore ' : '';
    str += n[2] != 0 ? (a[Number(n[2])] || b[n[2][0]] + ' ' + a[n[2][1]]) + 'Lakh ' : '';
    str += n[3] != 0 ? (a[Number(n[3])] || b[n[3][0]] + ' ' + a[n[3][1]]) + 'Thousand ' : '';
    str += n[4] != 0 ? (a[Number(n[4])] || b[n[4][0]] + ' ' + a[n[4][1]]) + 'Hundred ' : '';
    str += n[5] != 0 ? ((str != '') ? 'and ' : '') + (a[Number(n[5])] || b[n[5][0]] + ' ' + a[n[5][1]]) : '';
    return str.trim();
};

const formatCurrency = (amount) => {
    return new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR',
        minimumFractionDigits: 2,
    }).format(amount || 0);
};

/**
 * Generates a PDF from an EJS template
 * @param {string} templatePath - Absolute path to the EJS template
 * @param {object} data - Data to pass to the template
 * @param {string} outputPath - Absolute path where the PDF should be saved
 */
exports.generatePdfFromTemplate = async (templatePath, data, outputPath) => {
    let browser;
    try {
        // Render EJS to HTML
        const html = await ejs.renderFile(templatePath, {
            ...data,
            numberToWords,
            formatCurrency,
            totalEarnings: data.totalEarnings || 0,
            totalDeductions: data.totalDeductions || 0
        });

        // Launch puppeteer
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        const page = await browser.newPage();
        
        // Increase navigation timeout to 60 seconds and use 'load'
        await page.setDefaultNavigationTimeout(60000);
        
        // Set content - 'load' is faster and safer for self-contained HTML
        await page.setContent(html, { 
            waitUntil: 'load',
            timeout: 60000 
        });

        // Generate PDF
        await page.pdf({
            path: outputPath,
            format: 'A4',
            printBackground: true,
            margin: {
                top: '20px',
                right: '20px',
                bottom: '20px',
                left: '20px'
            }
        });

        return true;
    } catch (err) {
        console.error('Error in generatePdfFromTemplate:', err);
        throw err;
    } finally {
        if (browser) {
            await browser.close().catch(e => console.error("Error closing browser:", e.message));
        }
    }
};
