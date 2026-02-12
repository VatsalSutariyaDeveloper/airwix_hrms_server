const fs = require('fs');
const os = require('os');
const path = require('path');

const targetFile = path.join(__dirname, 'controllers', 'employee', 'payrollController.js');

try {
    const content = fs.readFileSync(targetFile, 'utf8');
    const lines = content.split(/\r?\n/);

    // Pattern: start of the duplicate block
    const pattern = "}; if (!employee_id) {";
    const index = lines.findIndex(l => l.includes(pattern));

    if (index !== -1) {
        console.log(`Duplicate found at line ${index + 1}. Truncating...`);
        // Replace the glitch line with just the closing brace
        lines[index] = "};";
        // Keep lines [0 ... index]
        const newLines = lines.slice(0, index + 1);
        fs.writeFileSync(targetFile, newLines.join(os.EOL), 'utf8');
        console.log("File fixed successfully.");
    } else {
        console.log("No duplicate pattern found.");
    }

    // Cleanup
    try {
        fs.unlinkSync(__filename);
    } catch (e) { }

} catch (err) {
    console.error(err);
}
