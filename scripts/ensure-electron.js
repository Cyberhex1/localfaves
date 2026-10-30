// Runs after `npm install`: downloads Electron's binary if npm skipped it.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.join(__dirname, '..');
const dist = path.join(root, 'node_modules', 'electron', 'dist');
if (!fs.existsSync(dist) && fs.existsSync(path.join(root, 'node_modules', 'electron', 'install.js'))) {
  console.log('Downloading Electron…');
  execFileSync(process.execPath, [path.join(root, 'node_modules', 'electron', 'install.js')], { stdio: 'inherit' });
}
