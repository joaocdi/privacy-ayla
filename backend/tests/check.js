const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const files = ['tips.js','app.js','image-tools.js','pending-checkouts.js','vip.js','frame.js','carousel.js','admin-mode.js','admin-loader.js','login.js','buyer-account.js'].map(file=>path.join(root,'..',file));
files.push(path.join(root,'..','api','index.js'));
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.test-runs'].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (file.endsWith('.js')) files.push(file);
  }
}
walk(root);
for (const file of files) execFileSync(process.execPath, ['--check', file]);
console.log(`Syntax OK: ${files.length} JavaScript files`);
