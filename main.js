// LocalFaves — start your saved local dev sites with one click.
const { app, BrowserWindow, ipcMain, shell, dialog, clipboard, Tray, Menu, nativeImage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn, execFile, execFileSync } = require('child_process');

const IS_WIN = process.platform === 'win32';

app.setName('LocalFaves');
if (process.env.LOCALFAVES_DATA_DIR) app.setPath('userData', process.env.LOCALFAVES_DATA_DIR);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
if (IS_WIN) app.setAppUserModelId('LocalFaves');

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  basePort: 3080,   // first port block starts here
  blockStep: 10,    // each new site gets the next block of 10 (3080, 3090, 3100…)
  blockSize: 5,     // ports reserved per site
  closeToTray: true,
  editor: 'code',
  sort: 'recent',
};
let data = { sites: [], seen: [], ignored: [], settings: { ...DEFAULT_SETTINGS } };

const dataFile = () => path.join(app.getPath('userData'), 'localfaves.json');

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
    data = {
      sites: Array.isArray(raw.sites) ? raw.sites : [],
      seen: Array.isArray(raw.seen) ? raw.seen : [],
      ignored: Array.isArray(raw.ignored) ? raw.ignored : [],
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
    };
    migrateToFivePorts();
  } catch { /* first run */ }
}

// One-time upgrade: sites used to get 3 ports, now they get 5.
function migrateToFivePorts() {
  if (data.settings.fivePorts) return;
  if (Number(data.settings.blockSize) < 5) data.settings.blockSize = 5;
  for (const s of data.sites) {
    const start = Number(s.portStart);
    if ((Number(s.portCount) || 1) >= 5) continue;
    const end = start + 4;
    const clash = data.sites.some((o) => o !== s
      && start <= Number(o.portStart) + (Number(o.portCount) || 1) - 1 && end >= Number(o.portStart));
    if (!clash) s.portCount = 5;
  }
  data.settings.fivePorts = true;
  save();
}
function save() {
  try {
    fs.mkdirSync(path.dirname(dataFile()), { recursive: true });
    const tmp = dataFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, dataFile());
  } catch (e) { console.error('save failed', e); }
}

const siteById = (id) => data.sites.find((s) => s.id === id);
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------
const portsOf = (s) => {
  const start = Number(s.portStart) || 3000;
  const n = Math.min(Math.max(Number(s.portCount) || 1, 1), 10);
  return Array.from({ length: n }, (_, i) => start + i);
};

// {port} = first port, {port2} = second, {port3} = third …
function fillPorts(str, ports) {
  return String(str || '').replace(/\{port(\d*)\}/gi, (_, n) => {
    const i = n ? Number(n) - 1 : 0;
    return String(ports[i] ?? ports[0]);
  });
}

function probe(host, port, timeout = 400) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeout, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}
async function isPortOpen(port) {
  const r = await Promise.all([probe('127.0.0.1', port), probe('::1', port)]);
  return r.some(Boolean);
}

let lastListenerPorts = new Set();

function allocateBlock(extraTaken = []) {
  const { basePort, blockStep, blockSize } = data.settings;
  const taken = data.sites
    .map((s) => [Number(s.portStart), Number(s.portStart) + (Number(s.portCount) || 1) - 1])
    .concat(extraTaken);
  for (let start = Number(basePort); start < 65000; start += Number(blockStep) || 10) {
    const end = start + (Number(blockSize) || 1) - 1;
    if (taken.some(([a, b]) => start <= b && end >= a)) continue;
    let busy = false;
    for (let p = start; p <= end; p++) if (lastListenerPorts.has(p)) busy = true;
    if (!busy) return start;
  }
  return Number(basePort);
}

// ---------------------------------------------------------------------------
// Shell helpers
// ---------------------------------------------------------------------------
function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      resolve(err && !stdout ? '' : String(stdout || ''));
    });
  });
}

function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    if (IS_WIN) {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    } else {
      try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { } }
      resolve();
    }
  });
}

const stripAnsi = (s) => s
  .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  .replace(/\x1b[()][0-9A-Za-z]/g, '');

// ---------------------------------------------------------------------------
// Finding dev servers that are already running (started by you or an agent)
// ---------------------------------------------------------------------------
async function listListeners() {
  const map = new Map();
  if (IS_WIN) {
    const out = await run('netstat', ['-ano']);
    for (const line of out.split(/\r?\n/)) {
      const p = line.trim().split(/\s+/);
      if (p[0] !== 'TCP' || p[3] !== 'LISTENING') continue;
      const idx = p[1].lastIndexOf(':');
      const port = Number(p[1].slice(idx + 1));
      const pid = Number(p[4]);
      if (port >= 1024 && pid > 4 && !map.has(port)) map.set(port, { port, pid });
    }
  } else {
    const out = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']);
    for (const line of out.split('\n').slice(1)) {
      const p = line.trim().split(/\s+/);
      const m = (p[8] || '').match(/:(\d+)$/);
      if (!m) continue;
      const port = Number(m[1]);
      if (port >= 1024 && !map.has(port)) map.set(port, { port, pid: Number(p[1]) });
    }
  }
  lastListenerPorts = new Set(map.keys());
  return [...map.values()];
}

const pidCache = new Map();
async function processInfo(pids) {
  const result = new Map();
  if (!pids.length) return result;
  if (IS_WIN) {
    const filter = pids.map((p) => `ProcessId=${p}`).join(' OR ');
    const ps = `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress`;
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
    let arr = [];
    try { arr = JSON.parse(out); } catch { }
    if (!Array.isArray(arr)) arr = [arr];
    for (const p of arr) if (p && p.ProcessId) result.set(p.ProcessId, { name: p.Name || '', cmd: p.CommandLine || '' });
  } else {
    const out = await run('ps', ['-o', 'pid=,comm=,args=', '-p', pids.join(',')]);
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
      if (m) result.set(Number(m[1]), { name: path.basename(m[2]), cmd: m[3] });
    }
  }
  return result;
}

const DEV_RUNTIME = /^(node|bun|deno|python\d*(\.\d+)?|pythonw|py|php|ruby|java|dotnet|uvicorn|gunicorn|hugo|caddy|air|wrangler|workerd)(\.exe)?$/i;

function guessFolder(cmd) {
  const m = cmd.match(/([A-Za-z]:\\[^"]*?|\/[^"\s]*?)[\\/]node_modules[\\/]/);
  if (m) {
    const s = m[1];
    const i = s.lastIndexOf(':\\');
    return i > 0 ? s.slice(i - 1) : s;
  }
  const m2 = cmd.match(/([A-Za-z]:\\[^"*?<>|]+?\.(?:js|mjs|cjs|ts|py))(?=["\s]|$)/i);
  if (m2) {
    const s = m2[1];
    const i = s.lastIndexOf(':\\');
    const p = i > 0 ? s.slice(i - 1) : s;
    // skip the runtime's own folder (e.g. C:\Program Files\nodejs\…)
    if (!/\\(Program Files|AppData)\\/i.test(p)) return path.dirname(p);
  }
  return '';
}

const TOOLS = ['next', 'vite', 'astro', 'nuxt', 'remix', 'svelte-kit', 'webpack', 'react-scripts', 'parcel', 'storybook',
  'wrangler', 'http-server', 'serve', 'uvicorn', 'gunicorn', 'flask', 'manage.py', 'http.server', 'electron', 'nodemon', 'tsx'];
function guessTool(cmd) {
  const c = cmd.toLowerCase();
  for (const t of TOOLS) {
    const re = new RegExp(`[\\\\/\\s"]${t.replace('.', '\\.')}([\\\\/\\s".]|$)`);
    if (re.test(c)) return t === 'manage.py' ? 'django' : t;
  }
  return '';
}

async function scanRunning() {
  const listeners = await listListeners();
  const pids = [...new Set(listeners.map((l) => l.pid))];
  for (const k of [...pidCache.keys()]) if (!pids.includes(k)) pidCache.delete(k);
  const unknown = pids.filter((p) => !pidCache.has(p));
  if (unknown.length) {
    const info = await processInfo(unknown);
    for (const p of unknown) pidCache.set(p, info.get(p) || { name: '', cmd: '' });
  }
  const found = [];
  const byPort = new Map();
  for (const l of listeners) {
    const p = pidCache.get(l.pid);
    if (!p || !p.name) continue;
    byPort.set(l.port, { pid: l.pid, proc: p.name, cmd: p.cmd, folder: guessFolder(p.cmd), tool: guessTool(p.cmd) });
    if (!DEV_RUNTIME.test(p.name) && !/node_modules/i.test(p.cmd)) continue;
    found.push({ port: l.port, pid: l.pid, proc: p.name, cmd: p.cmd, folder: guessFolder(p.cmd), tool: guessTool(p.cmd) });
  }
  return { listeners, found, byPort };
}

// ---------------------------------------------------------------------------
// Running the dev servers
// ---------------------------------------------------------------------------
const procs = new Map(); // siteId -> record
const LOG_LIMIT = 200_000;

function pushLog(id, text) {
  const rec = procs.get(id);
  if (!rec) return;
  rec.log += text;
  if (rec.log.length > LOG_LIMIT) rec.log = rec.log.slice(-LOG_LIMIT);
  send('log', { id, text });
}

const isUrlSite = (s) => !!String(s.url || '').trim();
const urlFor = (s, port) => {
  const ports = portsOf(s);
  return fillPorts(s.url || 'http://localhost:{port}', port && port !== ports[0] ? [port, ...ports.slice(1)] : ports);
};

// Address for one port of a site: the main port uses the site's address, spares open the plain root.
function urlForPort(s, port) {
  const ports = portsOf(s);
  if (port === ports[0] && isUrlSite(s)) return urlFor(s);
  return `http://localhost:${port}`;
}

function openInBrowser(url) {
  if (url) shell.openExternal(url).catch(() => { });
}

async function startSite(id) {
  const s = siteById(id);
  if (!s) return { ok: false, error: 'That site no longer exists.' };
  const ports = portsOf(s);
  const existing = procs.get(id);

  if (existing && existing.alive) {
    if (isUrlSite(s)) openInBrowser(urlFor(s, existing.actualPort));
    return { ok: true, already: true };
  }
  if (isUrlSite(s) && await isPortOpen(ports[0])) {
    s.lastStarted = Date.now(); save();
    openInBrowser(urlFor(s));
    broadcast();
    return { ok: true, already: true, external: true };
  }
  if (!s.folder || !fs.existsSync(s.folder)) return { ok: false, error: `Can't find the folder ${s.folder || '(none set)'}.` };
  if (!String(s.command || '').trim()) return { ok: false, error: 'This site has no start command yet. Edit it and add one.' };

  const cmd = fillPorts(s.command, ports);
  const env = { ...process.env, PORT: String(ports[0]), BROWSER: 'none' };
  delete env.ELECTRON_RUN_AS_NODE;
  ports.forEach((p, i) => { env[`LOCALFAVES_PORT${i + 1}`] = String(p); });
  for (const line of String(s.env || '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][\w.]*)\s*=\s*(.*)$/);
    if (m) env[m[1]] = fillPorts(m[2].trim(), ports);
  }

  let child;
  try {
    child = spawn(cmd, { cwd: s.folder, env, shell: true, windowsHide: true, detached: !IS_WIN });
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const rec = {
    child, pid: child.pid, alive: true, status: isUrlSite(s) ? 'starting' : 'running',
    log: existing ? existing.log + '\n' : '', startedAt: Date.now(), actualPort: null, logPort: null, stopping: false,
  };
  procs.set(id, rec);
  pushLog(id, `▶ ${cmd}\n  folder: ${s.folder}\n  ports:  ${ports.join(', ')}  (PORT=${ports[0]})\n\n`);

  let tail = '';
  const onData = (buf) => {
    const text = stripAnsi(buf.toString());
    pushLog(id, text);
    tail = (tail + text).slice(-4000);
    if (!rec.actualPort) {
      for (const line of tail.split(/\r?\n/)) {
        if (!/local|listen|running|ready|serving|started|available/i.test(line)) continue;
        const m = line.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})/i);
        if (m) rec.logPort = Number(m[1]);
      }
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (e) => pushLog(id, `\n✖ ${e.message}\n`));
  child.on('exit', (code) => {
    rec.alive = false;
    rec.exitCode = code;
    const ranFine = rec.status === 'running' || rec.status === 'no-port';
    rec.status = rec.stopping ? 'stopped' : (code === 0 && ranFine ? 'stopped' : 'crashed');
    pushLog(id, `\n■ Process ended${code != null ? ` (exit code ${code})` : ''}.\n`);
    if (rec.status === 'crashed') notify(`${s.name} stopped`, 'The dev server quit unexpectedly. Open LocalFaves to read the log.');
    broadcast();
  });

  s.lastStarted = Date.now();
  s.launches = (s.launches || 0) + 1;
  save();
  broadcast();
  if (isUrlSite(s)) waitForReady(s, rec, ports);
  return { ok: true };
}

async function waitForReady(s, rec, ports) {
  const deadline = Date.now() + (Number(s.timeoutSec) || 120) * 1000;
  while (rec.alive && Date.now() < deadline) {
    if (await isPortOpen(ports[0])) { rec.actualPort = ports[0]; break; }
    if (rec.logPort && rec.logPort !== ports[0] && Date.now() - rec.startedAt > 2500 && await isPortOpen(rec.logPort)) {
      rec.actualPort = rec.logPort;
      pushLog(s.id, `\n⚠ LocalFaves: the server picked :${rec.logPort} instead of :${ports[0]}. Add a port flag like --port {port} to the start command so it stays on its own ports.\n`);
      break;
    }
    await sleep(500);
  }
  if (!rec.alive) return;
  if (!rec.actualPort) {
    rec.status = 'no-port';
    pushLog(s.id, `\n⚠ LocalFaves: nothing answered on :${ports[0]} after ${Math.round((Date.now() - rec.startedAt) / 1000)}s. The server may use a different port — check the log above.\n`);
    broadcast();
    return;
  }
  rec.status = 'running';
  broadcast();
  openInBrowser(urlFor(s, rec.actualPort));
}

async function stopSite(id, { external = false } = {}) {
  const rec = procs.get(id);
  if (rec && rec.alive) {
    rec.stopping = true;
    pushLog(id, '\n■ Stopping…\n');
    await killTree(rec.pid);
  } else if (external) {
    const s = siteById(id);
    if (s) {
      const ports = new Set(portsOf(s));
      const { listeners } = await scanRunning();
      for (const l of listeners) if (ports.has(l.port)) await killTree(l.pid);
    }
  }
  setTimeout(broadcast, 700);
  return { ok: true };
}

function stopAllSync() {
  for (const rec of procs.values()) {
    if (!rec.alive) continue;
    rec.stopping = true;
    try {
      if (IS_WIN) execFileSync('taskkill', ['/pid', String(rec.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else process.kill(-rec.pid, 'SIGTERM');
    } catch { }
  }
}

// ---------------------------------------------------------------------------
// Project detection — guesses the start command for a folder
// ---------------------------------------------------------------------------

// Port flags for tools that ignore the PORT variable.
function frameworkFlags(body) {
  if (/electron-vite|electron-forge|\belectron\b|\btauri\b/.test(body)) return { desktop: true, flags: '' };
  if (/\bnext\b/.test(body)) return { flags: '-p {port}' };
  if (/\bvite\b/.test(body) && !/\bvite (build|preview)\b/.test(body)) return { flags: '--port {port} --strictPort' };
  if (/\b(astro|nuxt|nuxi|ng serve|vue-cli-service|webpack serve|webpack-dev-server|parcel)\b/.test(body)) return { flags: '--port {port}' };
  if (/react-scripts/.test(body)) return { flags: '', note: 'Create React App reads the PORT variable, which LocalFaves sets for you.' };
  return null;
}

// For a monorepo script like `pnpm --filter @scope/web dev`, find that package and read its script.
function workspaceScript(folder, body) {
  const m = body.match(/(?:--filter|-F)\s+["']?([^\s"']+)["']?\s+(?:run\s+)?([\w:-]+)/)
    || body.match(/--workspace[= ]["']?([^\s"']+)["']?.*?\brun\s+([\w:-]+)/)
    || body.match(/\bworkspace\s+([^\s]+)\s+(?:run\s+)?([\w:-]+)/);
  if (!m) return null;
  const [, name, script] = m;
  const roots = ['apps', 'packages', 'services', 'sites', '.'];
  for (const r of roots) {
    const dir = path.join(folder, r);
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue;
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, e.name, 'package.json'), 'utf8'));
        if (pkg.name === name || e.name === name) return { dir: path.join(dir, e.name), body: String((pkg.scripts || {})[script] || '') };
      } catch { }
    }
  }
  return null;
}

// Look inside a server file: does it read PORT, or is it hard-wired to one port?
function portHint(folder, file) {
  let src = '';
  try { src = fs.readFileSync(path.join(folder, file), 'utf8'); } catch { return ''; }
  if (/process\.env\.PORT|process\.env\[['"]PORT|Deno\.env\.get\(['"]PORT|os\.environ.*PORT|getenv\(['"]PORT/.test(src)) return '';
  const m = src.match(/\.listen\(\s*(\d{4,5})/) || src.match(/\bPORT\s*=\s*(\d{4,5})/) || src.match(/\bport\s*[:=]\s*(\d{4,5})/i);
  return m ? `${file} looks hard-wired to port ${m[1]} and doesn't read PORT. Either set "First port" to ${m[1]}, or change the code to use process.env.PORT.` : '';
}

function detectProject(folder) {
  const r = { folder, name: path.basename(folder), command: '', url: 'http://localhost:{port}', note: '' };
  const has = (f) => { try { return fs.existsSync(path.join(folder, f)); } catch { return false; } };
  const read = (f) => { try { return fs.readFileSync(path.join(folder, f), 'utf8'); } catch { return ''; } };
  const notes = [];

  if (has('package.json')) {
    let pkg = {};
    try { pkg = JSON.parse(read('package.json')); } catch { }
    const scripts = pkg.scripts || {};
    const pm = has('pnpm-lock.yaml') || has('pnpm-workspace.yaml') ? 'pnpm'
      : has('yarn.lock') ? 'yarn'
        : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
    const key = ['dev', 'start', 'serve', 'develop'].find((k) => scripts[k]);
    if (key) {
      const body = String(scripts[key]);
      const runCmd = pm === 'npm' ? `npm run ${key}` : pm === 'bun' ? `bun run ${key}` : `${pm} ${key}`;
      const sep = pm === 'npm' ? ' --' : '';
      let fw = frameworkFlags(body);
      if (!fw) {
        const ws = workspaceScript(folder, body);
        if (ws && ws.body) {
          fw = frameworkFlags(ws.body);
          if (fw && !fw.desktop) notes.push(`"${key}" starts ${path.relative(folder, ws.dir)} (${ws.body}).`);
        }
      }
      if (!fw && !/--filter|turbo|nx |lerna|concurrently|run-p/.test(body)) {
        const nodeFile = (body.match(/^\s*(?:node|nodemon|tsx|bun)\s+(?:--\S+\s+)*([\w./\\-]+\.[cm]?[jt]s)\b/) || [])[1];
        const hint = nodeFile ? portHint(folder, nodeFile) : '';
        if (hint) notes.push(hint);
        else notes.push(`"${key}" runs: ${body}\nLocalFaves sets PORT to the first port. If the server ignores it, add a port flag to the command.`);
      } else if (!fw) {
        notes.push(`"${key}" runs: ${body}\nLocalFaves sets PORT to the first port. If the server ignores it, add a port flag to the command.`);
      }
      if (fw && fw.desktop) { r.url = ''; notes.push('Looks like a desktop app, so LocalFaves won\'t open a browser for it.'); }
      if (fw && fw.note) notes.push(fw.note);
      r.command = fw && fw.flags ? `${runCmd}${sep} ${fw.flags}` : runCmd;
    } else if (pkg.main && has(pkg.main)) {
      r.command = `node ${pkg.main}`;
      const hint = portHint(folder, pkg.main);
      notes.push(hint || 'No dev script found, so this runs the main file with PORT set to the first port.');
    }
  }

  if (!r.command) {
    const py = has('.venv\\Scripts\\python.exe') ? '.venv\\Scripts\\python.exe'
      : has('venv\\Scripts\\python.exe') ? 'venv\\Scripts\\python.exe'
        : has('.venv/bin/python') ? '.venv/bin/python' : 'python';
    if (has('manage.py')) r.command = `${py} manage.py runserver {port}`;
    else {
      const entry = ['main.py', 'app.py', 'server.py'].find(has);
      if (entry) {
        const src = read(entry);
        const mod = entry.replace(/\.py$/, '');
        if (/FastAPI\(/.test(src)) r.command = `${py} -m uvicorn ${mod}:app --reload --port {port}`;
        else if (/Flask\(/.test(src)) r.command = `${py} -m flask --app ${mod} run --port {port}`;
        else { r.command = `${py} ${entry}`; notes.push(portHint(folder, entry) || 'PORT is set to the first port — make sure the script reads it.'); }
      }
    }
  }

  if (!r.command) {
    const launcher = ['start.cmd', 'start.bat'].find(has);
    const opensOwnBrowser = launcher && /\bstart\s+(""\s+)?https?:/i.test(read(launcher));
    if (launcher && !(opensOwnBrowser && has('server.js'))) {
      r.command = launcher;
      if (opensOwnBrowser) notes.push(`${launcher} opens its own browser tab, so you may get two tabs.`);
    } else if (has('server.js')) {
      r.command = 'node server.js';
      if (opensOwnBrowser) notes.push(`Runs server.js directly — ${launcher} opens a fixed address in the browser, which would skip your own ports.`);
      const hint = portHint(folder, 'server.js');
      if (hint) notes.push(hint);
    } else if (has('index.html')) {
      r.command = 'npx --yes serve -l {port}';
      notes.push('Plain HTML site — served with the "serve" package.');
    }
  }
  if (!r.command) notes.push('Couldn\'t tell how this project starts. Type the command you normally run in a terminal.');
  r.note = notes.filter(Boolean).join('\n');
  return r;
}

// ---------------------------------------------------------------------------
// Agent note
// ---------------------------------------------------------------------------
function agentNote(s, { forFile = false } = {}) {
  const ports = portsOf(s);
  const spare = ports.slice(1);
  const cmd = fillPorts(s.command, ports);
  const lines = [
    `## Local dev ports (managed by LocalFaves)`,
    ``,
    `This project has its own reserved port block: ${ports.join(', ')}.`,
  ];
  if (isUrlSite(s)) lines.push(`- Main dev server: ${urlFor(s)}. Start it with \`${cmd}\` (PORT=${ports[0]} is expected).`);
  else lines.push(`- Main process uses port ${ports[0]} (PORT=${ports[0]}). Start it with \`${cmd}\`.`);
  const orList = (a) => (a.length > 1 ? `${a.slice(0, -1).join(', ')} or ${a[a.length - 1]}` : String(a[0]));
  if (spare.length) lines.push(`- Need another server (API, preview, Storybook, tests)? Use ${orList(spare)}.`);
  lines.push(
    `- Only use these ports. Other projects run on other ports, so don't start servers on them or kill processes there.`,
    `- If port ${ports[0]} is already in use, the dev server is probably already running. Reuse it instead of starting a second one.`,
  );
  const notes = effectiveNotes(s);
  const noted = ports.filter((p) => notes[p]);
  lines.push('', '### What\'s on each port');
  if (noted.length) for (const p of noted) lines.push(`- ${p}: ${notes[p]}`);
  else lines.push('(nothing noted yet)');
  lines.push(forFile
    ? `When you start something on one of these ports, add or update a line in this list, like \`- ${spare[0] || ports[0]}: playtest\`, so the user can see what it is.`
    : `When you start something on one of these ports, tell the user which port and what it is (for example "${spare[0] || ports[0]}: playtest").`);
  return lines.join('\n');
}

// Port notes: lines like "- 3082: playtest" in the project's AGENTS.md / CLAUDE.md.
const notesCache = new Map(); // file -> { mtime, notes }
function readFileNotes(file) {
  let st;
  try { st = fs.statSync(file); } catch { notesCache.delete(file); return {}; }
  const hit = notesCache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit.notes;
  const notes = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*[-*]\s*`?:?(\d{4,5})`?\s*(?:[:=\u2013\u2014-]|\s\()\s*(.+?)\)?\s*$/);
      if (m && !/^https?:/i.test(m[2])) notes[m[1]] = m[2].replace(/^`|`$/g, '').trim();
    }
  } catch { }
  notesCache.set(file, { mtime: st.mtimeMs, notes });
  return notes;
}
function fileNotes(s) {
  if (!s.folder) return {};
  const ports = new Set(portsOf(s).map(String));
  const out = {};
  for (const f of ['AGENTS.md', 'CLAUDE.md']) {
    const n = readFileNotes(path.join(s.folder, f));
    for (const [k, v] of Object.entries(n)) if (ports.has(k) && !out[k]) out[k] = v;
  }
  return out;
}
const userNotes = (s) => (s.portLabels && typeof s.portLabels === 'object' ? s.portLabels : {});
// What each port is for: your own notes win over notes found in the project files.
function effectiveNotes(s) {
  return { ...fileNotes(s), ...Object.fromEntries(Object.entries(userNotes(s)).filter(([, v]) => v)) };
}

const MARK_START = '<!-- localfaves:start -->';
const MARK_END = '<!-- localfaves:end -->';
function writeAgentFiles(s) {
  const block = `${MARK_START}\n${agentNote(s, { forFile: true })}\n${MARK_END}`;
  const targets = ['AGENTS.md', 'CLAUDE.md'].map((f) => path.join(s.folder, f));
  const existing = targets.filter((f) => fs.existsSync(f));
  const files = existing.length ? existing : targets;
  for (const f of files) {
    let txt = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    const re = /<!-- localfaves:start -->[\s\S]*?<!-- localfaves:end -->/;
    txt = re.test(txt) ? txt.replace(re, () => block) : `${txt.trimEnd()}${txt.trim() ? '\n\n' : ''}${block}\n`;
    fs.writeFileSync(f, txt);
  }
  return files.map((f) => path.basename(f));
}

// ---------------------------------------------------------------------------
// State for the window + tray
// ---------------------------------------------------------------------------
let win = null;
let tray = null;
let quitting = false;
let lastState = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function notify(title, body) {
  try { if (Notification.isSupported()) new Notification({ title, body }).show(); } catch { }
}

async function computeState() {
  const { listeners, found, byPort } = await scanRunning();
  const open = new Set(listeners.map((l) => l.port));
  const claimed = new Set();
  const savedFolders = new Set(data.sites.map((s) => (s.folder || '').toLowerCase()));

  const sites = data.sites.map((s) => {
    const ports = portsOf(s);
    const rec = procs.get(s.id);
    const openPorts = ports.filter((p) => open.has(p));
    ports.forEach((p) => claimed.add(p));
    if (rec && rec.actualPort) claimed.add(rec.actualPort);
    let status = 'stopped';
    if (rec && rec.alive) status = rec.status;
    else if (openPorts.includes(ports[0]) || (openPorts.length && !isUrlSite(s))) status = 'external';
    else if (rec && rec.status === 'crashed') status = 'crashed';
    const fNotes = fileNotes(s);
    const uNotes = userNotes(s);
    const portInfo = ports.map((p) => {
      const pr = open.has(p) ? byPort.get(p) : null;
      return {
        port: p,
        live: open.has(p),
        note: uNotes[p] || fNotes[p] || '',
        userNote: uNotes[p] || '',
        fileNote: fNotes[p] || '',
        proc: pr ? pr.proc : '',
        tool: pr ? pr.tool : '',
        folder: pr ? pr.folder : '',
        cmd: pr ? pr.cmd : '',
      };
    });
    return {
      ...s, ports, openPorts, status, portInfo,
      pid: rec && rec.alive ? rec.pid : null,
      actualPort: rec && rec.alive ? rec.actualPort : null,
      hasLog: !!(rec && rec.log),
      openUrl: isUrlSite(s) ? urlFor(s, rec && rec.alive ? rec.actualPort : null) : '',
    };
  });

  const ignored = new Set(data.ignored);
  const spotted = found.filter((d) => !claimed.has(d.port) && !ignored.has(d.cmd));

  // remember what we've spotted so it can be saved later, even after it stops
  let changed = false;
  const now = Date.now();
  for (const d of spotted) {
    const key = (d.folder || d.cmd).toLowerCase();
    if (d.folder && savedFolders.has(d.folder.toLowerCase())) continue;
    const prev = data.seen.find((x) => x.key === key);
    if (prev) {
      if (now - prev.lastSeen > 60_000 || prev.port !== d.port) { Object.assign(prev, { port: d.port, lastSeen: now, tool: d.tool }); changed = true; }
    } else {
      data.seen.unshift({ key, folder: d.folder, cmd: d.cmd, port: d.port, tool: d.tool, lastSeen: now });
      changed = true;
    }
  }
  data.seen = data.seen
    .filter((x) => !(x.folder && savedFolders.has(x.folder.toLowerCase())))
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, 25);
  if (changed) save();

  const liveKeys = new Set(spotted.map((d) => (d.folder || d.cmd).toLowerCase()));
  const seen = data.seen.filter((x) => !liveKeys.has(x.key) && !ignored.has(x.cmd));

  return { sites, spotted, seen, settings: data.settings, platform: process.platform };
}

let computing = null;
let pending = false;
async function broadcast() {
  if (computing) { pending = true; return computing; }
  computing = (async () => {
    try {
      lastState = await computeState();
      send('state', lastState);
      updateTray();
    } catch (e) { console.error(e); }
  })();
  await computing;
  computing = null;
  if (pending) { pending = false; broadcast(); }
  return lastState;
}

// ---------------------------------------------------------------------------
// Window + tray
// ---------------------------------------------------------------------------
const asset = (f) => path.join(__dirname, 'assets', f);

function createWindow({ show = true } = {}) {
  win = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 640,
    minHeight: 480,
    title: 'LocalFaves',
    icon: asset('icon.png'),
    backgroundColor: '#15131b',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  if (show) win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { openInBrowser(url); return { action: 'deny' }; });
  win.on('close', (e) => {
    if (!quitting && data.settings.closeToTray && tray) {
      e.preventDefault();
      win.hide();
      if (!data.settings.trayHintShown) {
        data.settings.trayHintShown = true; save();
        if (IS_WIN && tray.displayBalloon) {
          tray.displayBalloon({ iconType: 'info', title: 'LocalFaves is still running', content: 'Your sites keep running. Click the tray icon to reopen, or right-click to quit.' });
        }
      }
    }
  });
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function updateTray() {
  if (!tray || !lastState) return;
  const sites = [...lastState.sites].sort((a, b) => (b.lastStarted || 0) - (a.lastStarted || 0)).slice(0, 15);
  const up = (s) => ['running', 'external', 'starting', 'no-port'].includes(s.status);
  const items = sites.map((s) => ({
    label: `${up(s) ? '●' : '○'}  ${s.name}   :${s.ports[0]}`,
    click: () => startSite(s.id).then((r) => { if (!r.ok) { notify(s.name, r.error); showWindow(); } }),
  }));
  const anyRunning = [...procs.values()].some((r) => r.alive);
  const menu = Menu.buildFromTemplate([
    { label: 'Open LocalFaves', click: showWindow },
    { type: 'separator' },
    ...(items.length ? items : [{ label: 'No saved sites yet', enabled: false }]),
    { type: 'separator' },
    { label: 'Stop all sites started here', enabled: anyRunning, click: () => { for (const id of procs.keys()) stopSite(id); } },
    { label: 'Quit (stops those sites)', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  const n = lastState.sites.filter(up).length;
  tray.setToolTip(n ? `LocalFaves — ${n} running` : 'LocalFaves');
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(asset('tray.png'));
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
    tray.setToolTip('LocalFaves');
    tray.on('click', showWindow);
    tray.on('double-click', showWindow);
  } catch (e) { console.error('tray failed', e); tray = null; }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function cleanLabels(obj) {
  const out = {};
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      const t = String(v || '').trim().slice(0, 80);
      if (/^\d{2,5}$/.test(k) && t) out[k] = t;
    }
  }
  return out;
}

function cleanSite(input) {
  const s = {
    id: input.id || newId(),
    name: String(input.name || '').trim() || path.basename(String(input.folder || 'Untitled')),
    folder: String(input.folder || '').trim(),
    command: String(input.command || '').trim(),
    portStart: Math.min(Math.max(Number(input.portStart) || allocateBlock(), 1024), 65000),
    portCount: Math.min(Math.max(Number(input.portCount) || data.settings.blockSize, 1), 10),
    url: String(input.url ?? 'http://localhost:{port}').trim(),
    env: String(input.env || ''),
    timeoutSec: Math.min(Math.max(Number(input.timeoutSec) || 120, 10), 600),
    portLabels: cleanLabels(input.portLabels),
  };
  return s;
}

function registerIpc() {
  ipcMain.handle('state:get', () => broadcast());

  ipcMain.handle('site:save', (_e, input) => {
    const clean = cleanSite(input);
    const prev = siteById(clean.id);
    if (prev) Object.assign(prev, clean);
    else data.sites.push({ ...clean, created: Date.now(), lastStarted: 0, launches: 0 });
    data.seen = data.seen.filter((x) => !(x.folder && clean.folder && x.folder.toLowerCase() === clean.folder.toLowerCase()));
    save();
    broadcast();
    return siteById(clean.id);
  });

  ipcMain.handle('site:delete', async (_e, id) => {
    const rec = procs.get(id);
    if (rec && rec.alive) await stopSite(id);
    procs.delete(id);
    data.sites = data.sites.filter((s) => s.id !== id);
    save();
    broadcast();
    return true;
  });

  ipcMain.handle('site:start', (_e, id) => startSite(id));
  ipcMain.handle('site:stop', (_e, id, external) => stopSite(id, { external }));
  ipcMain.handle('site:restart', async (_e, id) => {
    await stopSite(id, { external: true });
    for (let i = 0; i < 20; i++) {
      const rec = procs.get(id);
      if (!rec || !rec.alive) break;
      await sleep(250);
    }
    await sleep(400);
    return startSite(id);
  });
  ipcMain.handle('site:open', (_e, id) => {
    const s = siteById(id);
    if (!s) return false;
    const rec = procs.get(id);
    openInBrowser(urlFor(s, rec && rec.alive ? rec.actualPort : null));
    return true;
  });
  ipcMain.handle('site:open-port', (_e, id, port) => {
    const s = siteById(id);
    if (!s) return false;
    openInBrowser(urlForPort(s, Number(port)));
    return true;
  });
  ipcMain.handle('site:port-note', (_e, id, port, note) => {
    const s = siteById(id);
    if (!s) return false;
    s.portLabels = cleanLabels({ ...userNotes(s), [port]: note });
    save();
    broadcast();
    return true;
  });
  ipcMain.handle('site:log', (_e, id) => (procs.get(id) || {}).log || '');
  ipcMain.handle('site:clear-log', (_e, id) => { const r = procs.get(id); if (r) r.log = ''; return true; });
  ipcMain.handle('site:agent-copy', (_e, id) => {
    const s = siteById(id);
    if (!s) return false;
    clipboard.writeText(agentNote(s));
    return true;
  });
  ipcMain.handle('site:agent-text', (_e, id) => { const s = siteById(id); return s ? agentNote(s) : ''; });
  ipcMain.handle('site:agent-write', (_e, id) => {
    const s = siteById(id);
    if (!s) return { ok: false, error: 'Site not found' };
    try { return { ok: true, files: writeAgentFiles(s) }; } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('site:folder', (_e, id) => { const s = siteById(id); if (s) shell.openPath(s.folder); return true; });
  ipcMain.handle('site:editor', (_e, id) => {
    const s = siteById(id);
    if (!s) return false;
    try {
      const c = spawn(`${data.settings.editor || 'code'} "${s.folder}"`, { shell: true, detached: true, stdio: 'ignore', windowsHide: true });
      c.on('error', () => { });
      c.unref();
    } catch { }
    return true;
  });

  ipcMain.handle('pick-folder', async (_e, startIn) => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      defaultPath: startIn || (IS_WIN ? 'C:\\code' : app.getPath('home')),
    });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('detect', (_e, folder) => (folder && fs.existsSync(folder) ? detectProject(folder) : null));
  ipcMain.handle('suggest-port', () => allocateBlock());

  ipcMain.handle('import:scan', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Pick the folder that holds your projects (for example C:\\code)',
      properties: ['openDirectory'],
      defaultPath: IS_WIN && fs.existsSync('C:\\code') ? 'C:\\code' : app.getPath('home'),
    });
    if (r.canceled) return null;
    const parent = r.filePaths[0];
    const saved = new Set(data.sites.map((s) => (s.folder || '').toLowerCase()));
    const projects = [];
    for (const ent of fs.readdirSync(parent, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name.startsWith('.') || ent.name === 'node_modules') continue;
      const folder = path.join(parent, ent.name);
      const d = detectProject(folder);
      projects.push({ ...d, alreadySaved: saved.has(folder.toLowerCase()) });
    }
    return { parent, projects };
  });
  ipcMain.handle('import:add', (_e, list) => {
    const taken = [];
    for (const p of list || []) {
      const start = allocateBlock(taken);
      taken.push([start, start + data.settings.blockSize - 1]);
      data.sites.push({ ...cleanSite({ ...p, portStart: start, portCount: data.settings.blockSize }), created: Date.now(), lastStarted: 0, launches: 0 });
    }
    save();
    broadcast();
    return true;
  });

  ipcMain.handle('kill-pid', async (_e, pid) => { await killTree(Number(pid)); setTimeout(broadcast, 700); return true; });
  ipcMain.handle('open-url', (_e, url) => { if (/^https?:\/\//i.test(url)) openInBrowser(url); return true; });
  ipcMain.handle('ignore', (_e, cmd) => { if (cmd && !data.ignored.includes(cmd)) data.ignored.push(cmd); save(); broadcast(); return true; });
  ipcMain.handle('seen:dismiss', (_e, key) => { data.seen = data.seen.filter((x) => x.key !== key); save(); broadcast(); return true; });
  ipcMain.handle('settings:save', (_e, patch) => {
    const n = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
    data.settings = {
      ...data.settings,
      basePort: Math.min(Math.max(n(patch.basePort, 3080), 1024), 64000),
      blockStep: Math.min(n(patch.blockStep, 10), 1000),
      blockSize: Math.min(n(patch.blockSize, 5), 10),
      closeToTray: !!patch.closeToTray,
      editor: String(patch.editor || 'code').trim() || 'code',
      sort: patch.sort || data.settings.sort,
    };
    if (patch.clearIgnored) data.ignored = [];
    save();
    broadcast();
    return data.settings;
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
// `LocalFaves --start="Site name"` starts a saved site (and opens it) without touching the window.
function handleArgs(argv) {
  const arg = argv.find((x) => x.startsWith('--start='));
  if (!arg) return false;
  const q = arg.slice('--start='.length).replace(/^"|"$/g, '').trim().toLowerCase();
  const s = data.sites.find((x) => x.id === q || x.name.toLowerCase() === q)
    || data.sites.find((x) => x.name.toLowerCase().includes(q));
  if (!s) { notify('LocalFaves', `No saved site called "${q}".`); return true; }
  startSite(s.id).then((r) => { if (!r.ok) notify(s.name, r.error); });
  return true;
}

app.on('second-instance', (_e, argv) => { if (!handleArgs(argv)) showWindow(); });

app.whenReady().then(() => {
  load();
  registerIpc();
  const background = process.argv.includes('--hidden') || process.argv.some((x) => x.startsWith('--start='));
  createWindow({ show: !background });
  handleArgs(process.argv);
  createTray();
  broadcast();
  // refresh status: often while the window is visible, slowly in the tray
  let tick = 0;
  setInterval(() => {
    tick++;
    const visible = win && !win.isDestroyed() && win.isVisible();
    if (visible || tick % 4 === 0) broadcast();
  }, 4000);
});

app.on('before-quit', () => { quitting = true; });
app.on('will-quit', stopAllSync);
app.on('window-all-closed', () => {
  if (!tray || !data.settings.closeToTray) app.quit();
});

// exported for scripts/selftest.js
module.exports = { detectProject, scanRunning, agentNote, writeAgentFiles, guessFolder, fillPorts, portsOf, fileNotes, effectiveNotes };
