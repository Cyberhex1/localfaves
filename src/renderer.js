/* global lf */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let S = { sites: [], spotted: [], seen: [], settings: {} };
let query = '';
let logFor = null;
let importData = null;

const UP = new Set(['running', 'external', 'starting', 'no-port']);
const STATUS = {
  running: ['Running', 'ok'],
  external: ['Running · started elsewhere', 'ok'],
  starting: ['Starting…', 'warn'],
  'no-port': ['Running · no answer on port', 'warn'],
  crashed: ['Stopped with an error', 'bad'],
  stopped: ['Stopped', 'idle'],
};

// ---------------------------------------------------------------- helpers
function ago(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24); if (d < 14) return `${d} day${d > 1 ? 's' : ''} ago`;
  return new Date(ts).toLocaleDateString();
}
const fill = (str, ports) => String(str || '').replace(/\{port(\d*)\}/gi, (_, n) => String(ports[n ? Number(n) - 1 : 0] ?? ports[0]));
const portList = (start, count) => Array.from({ length: Math.max(1, Number(count) || 1) }, (_, i) => Number(start) + i);
const siteById = (id) => S.sites.find((s) => s.id === id);
const basename = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';

function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), kind === 'bad' ? 6000 : 3200);
}

// ---------------------------------------------------------------- rendering
function sorted(list) {
  const mode = $('#sort').value;
  const by = {
    recent: (a, b) => (b.lastStarted || 0) - (a.lastStarted || 0) || (b.created || 0) - (a.created || 0),
    name: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    port: (a, b) => a.portStart - b.portStart,
  }[mode];
  // running sites float to the top in "recent" mode
  if (mode === 'recent') return [...list].sort((a, b) => (UP.has(b.status) - UP.has(a.status)) || by(a, b));
  return [...list].sort(by);
}

function siteCard(s) {
  const [label, tone] = STATUS[s.status] || STATUS.stopped;
  const up = UP.has(s.status);
  const live = new Set(s.openPorts || []);
  const info = s.portInfo || s.ports.map((p) => ({ port: p, live: live.has(p), note: '' }));
  const ports = info.map((pi) => `<button class="port ${pi.live ? 'live' : ''} ${pi.note ? 'noted' : ''}" data-act="port" data-port="${pi.port}">:${pi.port}</button>`).join('');
  const moved = s.actualPort && s.actualPort !== s.ports[0] ? `<span class="warn-port">⚠ actually on :${s.actualPort}</span>` : '';
  const hasUrl = !!s.url;
  const nameTitle = up ? (hasUrl ? `Open ${s.openUrl}` : 'Already running') : 'Start it' + (hasUrl ? ' and open the browser' : '');
  return `
  <article class="site tone-${tone}" data-id="${s.id}">
    <div class="site-top">
      <button class="site-name" data-act="launch" title="${esc(nameTitle)}">${esc(s.name)}<span class="go">${up ? '↗' : '▶'}</span></button>
      <span class="pill ${tone}"><i></i>${label}</span>
    </div>
    <div class="site-meta">
      <span class="path" title="${esc(s.folder)}">${esc(s.folder)}</span>
      ${s.lastStarted ? `<span class="when">· ${ago(s.lastStarted)}</span>` : ''}
    </div>
    <div class="ports">${ports}${moved}</div>
    <div class="site-actions">
      ${up
        ? `${hasUrl ? '<button class="btn" data-act="open">Open</button>' : ''}<button class="btn" data-act="stop">Stop</button><button class="btn" data-act="restart">Restart</button>`
        : '<button class="btn primary" data-act="launch">Start</button>'}
      <button class="btn" data-act="logs" ${s.hasLog ? '' : 'title="No log yet"'}>Log</button>
      <button class="btn" data-act="agent" title="Copy a note for your AI agent about which ports to use">Copy for agent</button>
      <span class="spacer"></span>
      <button class="btn ghost icon" data-act="menu" title="More">⋯</button>
    </div>
  </article>`;
}

function emptyState() {
  if (query) return `<div class="empty"><h3>No match for “${esc(query)}”</h3></div>`;
  return `
  <div class="empty">
    <h3>Save your first local site</h3>
    <p>Point LocalFaves at a project folder. It works out how to start it, gives it its own block of ports, and from then on one click starts the dev server and opens it in your browser.</p>
    <div class="row">
      <button class="btn primary" data-act="new">+ Add a site</button>
      <button class="btn" data-act="import">Import from a folder like C:\\code</button>
    </div>
  </div>`;
}

function render() {
  const q = query.toLowerCase();
  const sites = sorted(S.sites.filter((s) => !q || s.name.toLowerCase().includes(q) || (s.folder || '').toLowerCase().includes(q) || s.ports.some((p) => String(p).includes(q))));
  $('#sites').innerHTML = sites.length ? sites.map(siteCard).join('') : emptyState();
  const running = S.sites.filter((s) => UP.has(s.status)).length;
  $('#site-count').textContent = S.sites.length ? `${S.sites.length} saved${running ? ` · ${running} running` : ''}` : '';

  $('#spotted-wrap').hidden = !S.spotted.length;
  $('#spotted').innerHTML = S.spotted.map((d, i) => `
    <div class="rowitem" data-i="${i}">
      <span class="p live">:${d.port}</span>
      <div class="what">
        <div class="t">${esc(d.folder ? basename(d.folder) : d.proc)}${d.tool ? `<span class="tag">${esc(d.tool)}</span>` : ''}</div>
        <div class="c" title="${esc(d.cmd)}">${esc(d.folder || d.cmd)}</div>
      </div>
      <div class="acts">
        <button class="btn" data-act="sp-open">Open</button>
        <button class="btn primary" data-act="sp-save">Save as site</button>
        <button class="btn" data-act="sp-stop">Stop</button>
        <button class="btn ghost" data-act="sp-hide" title="Don't show this one again">Hide</button>
      </div>
    </div>`).join('');

  $('#seen-wrap').hidden = !S.seen.length;
  $('#seen').innerHTML = S.seen.map((d, i) => `
    <div class="rowitem" data-i="${i}">
      <span class="p">:${d.port}</span>
      <div class="what">
        <div class="t">${esc(d.folder ? basename(d.folder) : 'Unknown folder')}${d.tool ? `<span class="tag">${esc(d.tool)}</span>` : ''}<span class="tag">${esc(ago(d.lastSeen))}</span></div>
        <div class="c" title="${esc(d.cmd)}">${esc(d.folder || d.cmd)}</div>
      </div>
      <div class="acts">
        <button class="btn primary" data-act="seen-save">Save as site</button>
        <button class="btn ghost" data-act="seen-dismiss">Dismiss</button>
      </div>
    </div>`).join('');

  // keep the hover card attached after the list refreshes
  if (tipFor && !document.body.contains(tipFor)) {
    const chip = $(`.site[data-id="${tipFor.dataset.siteId}"] .port[data-port="${tipFor.dataset.port}"]`);
    if (chip && chip.matches(':hover')) showTip(chip); else hideTip();
  }

  if (logFor) {
    const s = siteById(logFor);
    if (s) $('#drawer-sub').textContent = `${(STATUS[s.status] || STATUS.stopped)[0]} · ports ${s.ports.join(', ')}`;
  }
}

// ---------------------------------------------------------------- actions
async function launch(s) {
  if (UP.has(s.status)) {
    if (s.url) { await lf.invoke('site:open', s.id); toast(`Opening ${s.name}`); }
    else toast(`${s.name} is already running`);
    return;
  }
  const r = await lf.invoke('site:start', s.id);
  if (!r.ok) { toast(r.error, 'bad'); if (s.hasLog) openLog(s.id); return; }
  if (r.external) toast(`${s.name} was already running on :${s.ports[0]} — opening it`);
  else toast(s.url ? `Starting ${s.name}… the browser opens when it's ready` : `Starting ${s.name}…`);
}

async function stop(s) {
  if (s.status === 'external') {
    if (!confirm(`${s.name} on :${s.ports[0]} was started outside LocalFaves (maybe by an agent or a terminal).\n\nStop it anyway?`)) return;
    await lf.invoke('site:stop', s.id, true);
  } else {
    await lf.invoke('site:stop', s.id, false);
  }
  toast(`Stopping ${s.name}`);
}

async function openLog(id) {
  logFor = id;
  const s = siteById(id);
  $('#drawer-title').textContent = s ? `${s.name} — log` : 'Log';
  const text = await lf.invoke('site:log', id);
  $('#log').textContent = text || 'Nothing here yet. Start the site and its output will show up here.';
  $('#drawer').hidden = false;
  render();
  const pre = $('#log');
  pre.scrollTop = pre.scrollHeight;
}

lf.on('log', ({ id, text }) => {
  if (id !== logFor || $('#drawer').hidden) return;
  const pre = $('#log');
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  if (pre.textContent.startsWith('Nothing here yet')) pre.textContent = '';
  pre.textContent += text;
  if (pre.textContent.length > 250000) pre.textContent = pre.textContent.slice(-200000);
  if (atBottom) pre.scrollTop = pre.scrollHeight;
});

function showMenu(s, anchor) {
  const m = $('#menu');
  m.innerHTML = `
    <button data-mact="edit">Edit…</button>
    <button data-mact="agent-write">Write port note into AGENTS.md / CLAUDE.md</button>
    <button data-mact="agent-copy">Copy port note for agent</button>
    <hr>
    <button data-mact="folder">Open folder</button>
    <button data-mact="editor">Open in editor</button>
    ${s.url ? '<button data-mact="copy-url">Copy address</button>' : ''}
    <hr>
    <button data-mact="delete" class="danger">Remove from LocalFaves</button>`;
  m.dataset.id = s.id;
  m.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
  m.style.top = `${r.bottom + 6 + h > innerHeight ? r.top - h - 6 : r.bottom + 6}px`;
}
const hideMenu = () => { $('#menu').hidden = true; };

async function menuAction(act, s) {
  hideMenu();
  switch (act) {
    case 'edit': return openEdit(s);
    case 'agent-copy': await lf.invoke('site:agent-copy', s.id); return toast('Port note copied — paste it to your agent');
    case 'agent-write': {
      const r = await lf.invoke('site:agent-write', s.id);
      return r.ok ? toast(`Port note written to ${r.files.join(' and ')}`) : toast(r.error, 'bad');
    }
    case 'folder': return lf.invoke('site:folder', s.id);
    case 'editor': return lf.invoke('site:editor', s.id);
    case 'copy-url': await navigator.clipboard.writeText(s.openUrl); return toast(`Copied ${s.openUrl}`);
    case 'delete':
      if (confirm(`Remove ${s.name} from LocalFaves?\n\nYour project files aren't touched.`)) { await lf.invoke('site:delete', s.id); toast(`Removed ${s.name}`); }
  }
}

// ---------------------------------------------------------------- ports
const portInfo = (s, port) => (s.portInfo || []).find((x) => x.port === port) || { port, live: (s.openPorts || []).includes(port), note: '' };

async function clickPort(s, port) {
  const pi = portInfo(s, port);
  hideTip();
  if (pi.live) {
    await lf.invoke('site:open-port', s.id, port);
    toast(`Opening :${port}${pi.note ? ` (${pi.note})` : ''}`);
  } else if (port === s.ports[0] && !UP.has(s.status)) {
    launch(s);
  } else {
    toast(`Nothing is running on :${port} yet${pi.note ? ` (${pi.note})` : ''}`);
  }
}

function showPortMenu(s, port, x, y) {
  const pi = portInfo(s, port);
  const main = port === s.ports[0];
  const m = $('#menu');
  m.innerHTML = `
    ${pi.live ? `<button data-pact="open">Open :${port} in browser</button>` : ''}
    ${main && !UP.has(s.status) ? `<button data-pact="start">Start ${esc(s.name)}</button>` : ''}
    <button data-pact="copy">Copy port number</button>
    <button data-pact="copy-url">Copy address</button>
    <hr>
    <button data-pact="note">${pi.userNote ? 'Edit note…' : 'Add a note…'}</button>
    ${pi.userNote ? '<button data-pact="clear" class="danger">Remove note</button>' : ''}`;
  m.dataset.id = s.id;
  m.dataset.port = String(port);
  m.hidden = false;
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`;
  m.style.top = `${y + h + 8 > innerHeight ? y - h : y}px`;
}

async function portMenuAction(act, s, port) {
  hideMenu();
  const pi = portInfo(s, port);
  const url = port === s.ports[0] && s.openUrl ? s.openUrl : `http://localhost:${port}`;
  switch (act) {
    case 'open': return clickPort(s, port);
    case 'start': return launch(s);
    case 'copy': await navigator.clipboard.writeText(String(port)); return toast(`Copied ${port}`);
    case 'copy-url': await navigator.clipboard.writeText(url); return toast(`Copied ${url}`);
    case 'note': return openNote(s, port);
    case 'clear': await lf.invoke('site:port-note', s.id, port, ''); return toast(`Removed the note on :${port}`);
  }
  return pi;
}

function openNote(s, port) {
  const pi = portInfo(s, port);
  const f = $('#note-form').elements;
  $('#note-title').textContent = `Note for :${port}`;
  f.site.value = s.id;
  f.port.value = String(port);
  f.note.value = pi.userNote || '';
  f.note.placeholder = pi.fileNote || (port === s.ports[0] ? 'main dev server' : 'playtest');
  $('#note-file').textContent = pi.fileNote ? `The project's AGENTS.md/CLAUDE.md says: "${pi.fileNote}". Your note will show instead.` : '';
  $('#note-clear').hidden = !pi.userNote;
  $('#note').showModal();
  f.note.focus();
}
$('#note-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  await lf.invoke('site:port-note', f.site.value, Number(f.port.value), f.note.value);
  $('#note').close();
  toast(f.note.value.trim() ? `Noted :${f.port.value} as "${f.note.value.trim()}"` : `Removed the note on :${f.port.value}`);
});

// hover card
let tipFor = null;
function showTip(chip) {
  const card = chip.closest('.site');
  const s = card && siteById(card.dataset.id);
  if (!s) return;
  const port = Number(chip.dataset.port);
  const pi = portInfo(s, port);
  const main = port === s.ports[0];
  const where = pi.folder ? basename(pi.folder) : '';
  const what = [pi.tool, where].filter(Boolean).join(' · ') || pi.proc || 'a server';
  const tip = $('#porttip');
  tip.innerHTML = `
    <div class="h"><b>:${port}</b><span class="muted">${main ? 'main port' : 'spare port'}</span></div>
    ${pi.note ? `<div class="note">${esc(pi.note)}</div><div class="src">${pi.userNote ? 'your note' : 'from AGENTS.md / CLAUDE.md'}</div>` : ''}
    <div class="run ${pi.live ? 'on' : ''}">${pi.live ? `● Running: ${esc(what)}` : '○ Nothing running'}</div>
    ${pi.live && pi.cmd ? `<div class="cmd" title="">${esc(pi.cmd)}</div>` : ''}
    <div class="foot">${pi.live ? 'Click to open' : main && !UP.has(s.status) ? 'Click to start the site' : 'Free for an agent to use'} · right-click for more</div>`;
  tip.hidden = false;
  tipFor = chip;
  chip.dataset.siteId = s.id;
  const r = chip.getBoundingClientRect();
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  tip.style.top = `${r.bottom + 8 + h > innerHeight ? r.top - h - 8 : r.bottom + 8}px`;
}
function hideTip() { $('#porttip').hidden = true; tipFor = null; }
document.addEventListener('mouseover', (e) => {
  const chip = e.target.closest('.port');
  if (chip && chip !== tipFor) showTip(chip);
  else if (!chip && tipFor) hideTip();
});
document.addEventListener('contextmenu', (e) => {
  const chip = e.target.closest('.port');
  if (!chip) return;
  e.preventDefault();
  hideTip();
  const s = siteById(chip.closest('.site').dataset.id);
  if (s) showPortMenu(s, Number(chip.dataset.port), e.clientX, e.clientY);
});

// ---------------------------------------------------------------- edit dialog
const editForm = $('#edit-form');
let detectedNote = '';

async function openEdit(site, prefill = {}) {
  editForm.reset();
  editForm.querySelectorAll('.invalid').forEach((el) => el.classList.remove('invalid'));
  $('#detect-note').textContent = '';
  const isNew = !site;
  $('#edit-title').textContent = isNew ? 'Add a site' : `Edit ${site.name}`;
  $('#delete-btn').hidden = isNew;
  const v = isNew
    ? { name: '', folder: '', command: '', portStart: await lf.invoke('suggest-port'), portCount: S.settings.blockSize || 5, url: 'http://localhost:{port}', env: '', timeoutSec: 120, ...prefill }
    : site;
  for (const k of ['id', 'name', 'folder', 'command', 'portStart', 'url', 'env', 'timeoutSec']) {
    if (editForm.elements[k]) editForm.elements[k].value = v[k] ?? '';
  }
  editForm.elements.portCount.value = String(v.portCount || 5);
  noteDraft = { ...(v.portLabels || {}) };
  fileNoteHints = {};
  for (const pi of (site && site.portInfo) || []) if (pi.fileNote) fileNoteHints[pi.port] = pi.fileNote;
  renderPortNoteInputs();
  if (prefill.note) $('#detect-note').textContent = prefill.note;
  updatePreview();
  $('#edit').showModal();
  (isNew && !v.folder ? editForm.elements.folder : editForm.elements.name).focus();
}

async function detectInto(folder, { overwrite = true } = {}) {
  const d = await lf.invoke('detect', folder);
  if (!d) { $('#detect-note').textContent = "That folder doesn't exist."; return; }
  const f = editForm.elements;
  if (overwrite || !f.command.value) f.command.value = d.command;
  if (!f.name.value) f.name.value = d.name;
  if (overwrite) f.url.value = d.url;
  $('#detect-note').textContent = d.note || '';
  updatePreview();
}

let noteDraft = {};
let fileNoteHints = {};
function renderPortNoteInputs() {
  const f = editForm.elements;
  const ports = Number(f.portStart.value) >= 1024 ? portList(f.portStart.value, f.portCount.value) : [];
  $('#port-notes').innerHTML = ports.map((p, i) => `
    <span class="pn-port">:${p}</span>
    <input data-note-port="${p}" maxlength="80" value="${esc(noteDraft[p] || '')}"
      placeholder="${esc(fileNoteHints[p] ? `AGENTS.md says: ${fileNoteHints[p]}` : i === 0 ? 'main dev server' : i === 1 ? 'for example: playtest' : '')}">`).join('');
}
$('#port-notes').addEventListener('input', (e) => {
  const p = e.target.dataset.notePort;
  if (p) noteDraft[p] = e.target.value;
});
editForm.elements.portStart.addEventListener('input', renderPortNoteInputs);
editForm.elements.portCount.addEventListener('change', renderPortNoteInputs);

function updatePreview() {
  const f = editForm.elements;
  const ports = portList(f.portStart.value || 0, f.portCount.value);
  const valid = Number(f.portStart.value) >= 1024;
  const cmd = fill(f.command.value, ports);
  const url = fill(f.url.value, ports);
  $('#edit-preview').innerHTML = valid
    ? `Clicking the name runs <code>${esc(cmd || '…')}</code> in <b>${esc(basename(f.folder.value) || 'the folder')}</b> with <code>PORT=${ports[0]}</code>${url ? `, then opens <b>${esc(url)}</b>` : ''}.<br>Your agent gets ports <b>${ports.join(', ')}</b>.`
    : 'Pick a first port of 1024 or higher.';
  const clash = S.sites.find((s) => s.id !== f.id.value && ports.some((p) => s.ports.includes(p)));
  if (clash && valid) $('#edit-preview').innerHTML += `<br><span style="color:var(--warn)">⚠ Overlaps with ${esc(clash.name)} (${clash.ports.join(', ')}).</span>`;
}

editForm.addEventListener('input', updatePreview);
editForm.elements.folder.addEventListener('change', (e) => {
  if (e.target.value.trim()) detectInto(e.target.value.trim(), { overwrite: !editForm.elements.command.value });
});

editForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = editForm.elements;
  let bad = false;
  for (const k of ['folder', 'name', 'command', 'portStart']) {
    const empty = !String(f[k].value).trim() || (k === 'portStart' && Number(f[k].value) < 1024);
    f[k].classList.toggle('invalid', empty);
    bad = bad || empty;
  }
  if (bad) { toast('Fill in the highlighted fields', 'bad'); return; }
  const site = Object.fromEntries(['id', 'name', 'folder', 'command', 'portStart', 'portCount', 'url', 'env', 'timeoutSec'].map((k) => [k, f[k].value]));
  site.portLabels = {};
  for (const p of portList(f.portStart.value, f.portCount.value)) if ((noteDraft[p] || '').trim()) site.portLabels[p] = noteDraft[p].trim();
  const saved = await lf.invoke('site:save', site);
  $('#edit').close();
  toast(`Saved ${saved.name} — ports ${portList(saved.portStart, saved.portCount).join(', ')}`);
});

// ---------------------------------------------------------------- import dialog
async function openImport() {
  const r = await lf.invoke('import:scan');
  if (!r) return;
  importData = r;
  $('#import-parent').textContent = `Projects found in ${r.parent}`;
  $('#import-list').innerHTML = r.projects.length ? r.projects.map((p, i) => `
    <label class="import-item ${p.alreadySaved ? 'disabled' : ''}">
      <input type="checkbox" data-i="${i}" ${p.alreadySaved ? 'disabled' : p.command ? 'checked' : ''}>
      <div>
        <div class="n">${esc(p.name)}${p.alreadySaved ? '<span class="tag">already saved</span>' : ''}${!p.url && p.command ? '<span class="tag">desktop app</span>' : ''}</div>
        <div class="c ${p.command ? '' : 'none'}">${esc(p.command || "Couldn't detect a start command — you can add it after importing")}</div>
      </div>
    </label>`).join('') : '<p class="muted">No folders in there.</p>';
  $('#import-all').checked = false;
  $('#import').showModal();
}
$('#import-all').addEventListener('change', (e) => {
  $$('#import-list input[type=checkbox]:not(:disabled)').forEach((c) => { c.checked = e.target.checked; });
});
async function importAdd() {
  const picks = $$('#import-list input:checked').map((c) => importData.projects[Number(c.dataset.i)]);
  if (!picks.length) { toast('Nothing selected'); return; }
  await lf.invoke('import:add', picks);
  $('#import').close();
  toast(`Added ${picks.length} site${picks.length > 1 ? 's' : ''}`);
}

// ---------------------------------------------------------------- settings
const setForm = $('#settings-form');
function openSettings() {
  const st = S.settings;
  setForm.elements.basePort.value = st.basePort;
  setForm.elements.blockStep.value = st.blockStep;
  setForm.elements.blockSize.value = st.blockSize;
  setForm.elements.editor.value = st.editor || 'code';
  setForm.elements.closeToTray.checked = !!st.closeToTray;
  setForm.elements.clearIgnored.checked = false;
  settingsExample();
  $('#settings').showModal();
}
function settingsExample() {
  const b = Number(setForm.elements.basePort.value) || 3080;
  const g = Number(setForm.elements.blockStep.value) || 10;
  const n = Number(setForm.elements.blockSize.value) || 5;
  const blk = (s) => portList(s, n).map((p) => `:${p}`).join(' ');
  $('#settings-example').textContent = `New sites get: ${blk(b)}  →  ${blk(b + g)}  →  ${blk(b + 2 * g)} … Existing sites keep their ports.`;
}
setForm.addEventListener('input', settingsExample);
setForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = setForm.elements;
  await lf.invoke('settings:save', {
    basePort: f.basePort.value, blockStep: f.blockStep.value, blockSize: f.blockSize.value,
    editor: f.editor.value, closeToTray: f.closeToTray.checked, clearIgnored: f.clearIgnored.checked,
    sort: $('#sort').value,
  });
  $('#settings').close();
  toast('Settings saved');
});

// ---------------------------------------------------------------- events
document.addEventListener('click', async (e) => {
  const pm = e.target.closest('[data-pact]');
  if (pm) { const s = siteById($('#menu').dataset.id); if (s) portMenuAction(pm.dataset.pact, s, Number($('#menu').dataset.port)); return; }
  const m = e.target.closest('[data-mact]');
  if (m) { const s = siteById($('#menu').dataset.id); if (s) menuAction(m.dataset.mact, s); return; }
  if (!e.target.closest('#menu')) hideMenu();

  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const card = el.closest('.site');
  const s = card ? siteById(card.dataset.id) : null;
  const row = el.closest('.rowitem');

  switch (act) {
    case 'new': return openEdit(null);
    case 'import': return openImport();
    case 'import-add': return importAdd();
    case 'settings': return openSettings();
    case 'close-dialog': return el.closest('dialog').close();
    case 'close-drawer': logFor = null; $('#drawer').hidden = true; return;
    case 'copy-log': await navigator.clipboard.writeText($('#log').textContent); return toast('Log copied');
    case 'clear-log': if (logFor) { await lf.invoke('site:clear-log', logFor); $('#log').textContent = ''; } return;

    case 'browse': {
      const cur = editForm.elements.folder.value.trim();
      const p = await lf.invoke('pick-folder', cur || undefined);
      if (p) { editForm.elements.folder.value = p; await detectInto(p, { overwrite: !editForm.elements.command.value || !cur || cur !== p }); }
      return;
    }
    case 'detect': {
      const p = editForm.elements.folder.value.trim();
      if (!p) { toast('Pick the project folder first'); return; }
      return detectInto(p);
    }
    case 'delete-site': {
      const id = editForm.elements.id.value;
      const site = siteById(id);
      if (site && confirm(`Remove ${site.name} from LocalFaves?\n\nYour project files aren't touched.`)) {
        await lf.invoke('site:delete', id);
        $('#edit').close();
      }
      return;
    }

    // site card
    case 'launch': return s && launch(s);
    case 'open': return s && lf.invoke('site:open', s.id);
    case 'stop': return s && stop(s);
    case 'restart': if (s) { toast(`Restarting ${s.name}…`); const r = await lf.invoke('site:restart', s.id); if (!r.ok) toast(r.error, 'bad'); } return;
    case 'logs': return s && openLog(s.id);
    case 'agent': if (s) { await lf.invoke('site:agent-copy', s.id); toast('Port note copied — paste it to your agent'); } return;
    case 'menu': e.stopPropagation(); return s && showMenu(s, el);
    case 'port': return s && clickPort(s, Number(el.dataset.port));
    case 'note-clear': {
      const f = $('#note-form').elements;
      await lf.invoke('site:port-note', f.site.value, Number(f.port.value), '');
      $('#note').close();
      return toast(`Removed the note on :${f.port.value}`);
    }

    // spotted
    case 'sp-open': { const d = S.spotted[row.dataset.i]; return lf.invoke('open-url', `http://localhost:${d.port}`); }
    case 'sp-stop': {
      const d = S.spotted[row.dataset.i];
      if (confirm(`Stop the server on :${d.port}?\n\n${d.cmd}`)) { await lf.invoke('kill-pid', d.pid); toast(`Stopped :${d.port}`); }
      return;
    }
    case 'sp-hide': { const d = S.spotted[row.dataset.i]; return lf.invoke('ignore', d.cmd); }
    case 'sp-save': case 'seen-save': {
      const d = (act === 'sp-save' ? S.spotted : S.seen)[row.dataset.i];
      const det = d.folder ? await lf.invoke('detect', d.folder) : null;
      const note = [
        det && det.note,
        act === 'sp-save' ? `It's running on :${d.port} right now. After saving, stop it and start it from here so it moves onto its own ports.` : '',
      ].filter(Boolean).join('\n');
      return openEdit(null, { folder: d.folder || '', name: det ? det.name : '', command: det ? det.command : '', url: det ? det.url : 'http://localhost:{port}', note });
    }
    case 'seen-dismiss': { const d = S.seen[row.dataset.i]; return lf.invoke('seen:dismiss', d.key); }
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { hideMenu(); if (!$('#drawer').hidden && !document.querySelector('dialog[open]')) { logFor = null; $('#drawer').hidden = true; } }
  if (e.ctrlKey && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#search').focus(); }
  if (e.ctrlKey && e.key.toLowerCase() === 'n' && !document.querySelector('dialog[open]')) { e.preventDefault(); openEdit(null); }
});

$('#search').addEventListener('input', (e) => { query = e.target.value.trim(); render(); });
$('#sort').addEventListener('change', () => { lf.invoke('settings:save', { ...S.settings, sort: $('#sort').value }); render(); });
window.addEventListener('resize', () => { hideMenu(); hideTip(); });
$('#main').addEventListener('scroll', () => { hideMenu(); hideTip(); });

lf.on('state', (st) => {
  const first = !S.settings.sort;
  S = st;
  if (first && st.settings.sort) $('#sort').value = st.settings.sort;
  render();
});
lf.invoke('state:get').then((st) => { if (st) { S = st; $('#sort').value = st.settings.sort || 'recent'; render(); } });
setInterval(render, 30000); // keep "x min ago" fresh
