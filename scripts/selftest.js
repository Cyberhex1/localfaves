// Quick checks of LocalFaves' detection logic outside Electron: node scripts/selftest.js [projectsFolder]
const Module = require('module');
const path = require('path');
const noop = () => {};
const orig = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'electron') {
    return {
      app: { setName: noop, setPath: noop, setAppUserModelId: noop, on: noop, requestSingleInstanceLock: () => true, whenReady: () => new Promise(noop), getPath: () => require('os').tmpdir() },
      ipcMain: { handle: noop }, shell: {}, dialog: {}, clipboard: {}, Tray: class {}, Menu: {}, nativeImage: {}, Notification: {},
    };
  }
  return orig.call(this, req, ...rest);
};
const lf = require(path.join(__dirname, '..', 'main.js'));
const fs = require('fs');

(async () => {
  const parent = process.argv[2] || 'C:\\code';
  console.log(`== Detected start commands in ${parent}`);
  for (const ent of fs.readdirSync(parent, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
    const d = lf.detectProject(path.join(parent, ent.name));
    console.log(`- ${ent.name}: ${d.command || '(none)'}${d.url ? '' : '  [no browser]'}${d.note ? `\n    note: ${d.note.replace(/\n/g, '\n          ')}` : ''}`);
  }
  console.log('\n== Dev servers running right now');
  const { listeners, found } = await lf.scanRunning();
  console.log(`(${listeners.length} listening ports total)`);
  for (const f of found) console.log(`- :${f.port} ${f.proc} ${f.tool || ''} folder=${f.folder || '?'}`);
  process.exit(0);
})();
