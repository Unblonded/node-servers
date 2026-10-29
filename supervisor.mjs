// Runs every Node server on this Windows PC and keeps them running. The servers live next to this project:
//   C:\Servers\               (any folder)
//     node-servers\           this project
//     deployment\             one folder per server (folders starting with _ or . are skipped)
//       capri\
// (settings.json's "deployment" can point somewhere else.) For each server it:
//   - works out how to start it: package.json's "start" script (npm start), else server.js, index.js,
//     app.js or main.js, else package.json's "main";
//   - runs npm install first if it has a package.json but no node_modules yet;
//   - starts it, and starts it again if it crashes (waiting longer each time it keeps crashing);
//   - keeps its output in logs\<name>.log (the last 5 MB, then logs\<name>.1.log);
//   - if it's a git repo, checks for new commits every minute; when there are some it runs its "update"
//     script if package.json has one (Capri's does), or else pulls them and runs npm install if packages
//     changed; then restarts it.
// New folders start within a few seconds, and removed ones stop. settings.json (optional) can change the
// check interval and dashboard port, and override any server's start command, update, env or turn it off.
// A dashboard at http://127.0.0.1:3399 (this PC only, behind a key) shows them, can restart, update, stop
// and start each one, and can deploy a new one from GitHub. open-dashboard.bat opens it.
// It updates itself the same way from its own repo, then restarts (run.cmd starts it again).
// install.bat registers run.cmd with Windows to start this when the PC turns on.
//   node supervisor.mjs            run everything
//   node supervisor.mjs stop-all   stop servers a previous run left behind (uninstall.bat uses it)
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const here = path.dirname(self);
const SETTINGS = path.join(here, 'settings.json');
// Next to this project, or wherever settings.json's "deployment" says.
const DEPLOY = (() => {
  try { const d = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')).deployment; if (d) return path.resolve(here, d); } catch { /* none or broken: the default */ }
  return path.resolve(here, '..', 'deployment');
})();
const LOGS = path.join(here, 'logs');
const PIDS = path.join(LOGS, 'pids.json');
const KEY_FILE = path.join(here, '.dashboard-key');
const URL_FILE = path.join(here, 'dashboard.url');
const RELAUNCH = 75; // asks run.cmd to start this again (it was updated)
const LOG_MAX = 5 * 1024 * 1024;

fs.mkdirSync(LOGS, { recursive: true });
fs.mkdirSync(DEPLOY, { recursive: true });

// ---- logs ----
// Appends lines with a time in front, and starts a new file past 5 MB (keeping the previous one).
function logFile(name) {
  const file = path.join(LOGS, `${name}.log`);
  let size = 0;
  try { size = fs.statSync(file).size; } catch { /* new */ }
  let partial = '';
  const write = (text) => {
    if (size > LOG_MAX) {
      try { fs.renameSync(file, path.join(LOGS, `${name}.1.log`)); } catch { /* in use: try next time */ }
      size = 0;
    }
    fs.appendFileSync(file, text);
    size += Buffer.byteLength(text);
  };
  return {
    file,
    line(msg) { write(`[${stamp()}] ${msg}\n`); },
    // Output from a server, which arrives in pieces: stamp each complete line.
    chunk(buf) {
      const lines = (partial + buf.toString()).split(/\r?\n/);
      partial = lines.pop();
      if (lines.length) write(lines.map((l) => `[${stamp()}] ${l}\n`).join(''));
    },
  };
}
const stamp = () => new Date().toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const main = logFile('supervisor');
const say = (msg) => { console.log(`[${stamp()}] ${msg}`); main.line(msg); };

// ---- running commands ----
function run(cmd, args, cwd, { timeout = 10 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout, windowsHide: true, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => (err ? reject(Object.assign(err, { output: `${stdout}${stderr}`.trim() })) : resolve(`${stdout}${stderr}`.trim())));
  });
}
const git = (dir, ...args) => run('git', args, dir, { timeout: 2 * 60_000 }).then((out) => out.trim());
function shell(command, cwd, log) {
  return new Promise((resolve, reject) => {
    const p = spawn(command, { cwd, shell: true, windowsHide: true, env: process.env });
    p.stdout.on('data', (b) => log.chunk(b));
    p.stderr.on('data', (b) => log.chunk(b));
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`"${command}" exited with code ${code}`))));
  });
}

// Ends a process and everything it started (a server started through npm or cmd is a few processes deep).
function killTree(pid) {
  return new Promise((resolve) => execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
}

// ---- finding the servers ----
const NAME = /^[\w.-]{1,60}$/;
const ENTRY_FILES = ['server.js', 'index.js', 'app.js', 'main.js', 'server.mjs', 'index.mjs', 'app.mjs', 'server.cjs', 'index.cjs'];
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

// settings.json, or the last good version of it while it has a mistake (said once in the log).
let goodSettings = {};
let settingsProblem = '';
function readSettings() {
  try {
    goodSettings = fs.existsSync(SETTINGS) ? JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) : {};
    settingsProblem = '';
  } catch (err) {
    const msg = `settings.json has a mistake, so the last good settings stay in use: ${err.message}`;
    if (msg !== settingsProblem) say(msg);
    settingsProblem = msg;
  }
  return goodSettings;
}

// How to run one folder, from settings.json's override for it, else what's in the folder.
function detect(name, dir, over = {}) {
  const pkg = readJson(path.join(dir, 'package.json'));
  let start = over.start;
  let how = 'from settings.json';
  if (!start && pkg?.scripts?.start) { start = 'npm start'; how = `npm start → ${pkg.scripts.start}`; }
  if (!start) {
    const file = ENTRY_FILES.find((f) => fs.existsSync(path.join(dir, f)));
    if (file) { start = `node ${file}`; how = `found ${file}`; }
  }
  if (!start && pkg?.main && fs.existsSync(path.join(dir, pkg.main))) { start = `node ${pkg.main}`; how = 'package.json "main"'; }
  const update = over.update ?? (pkg?.scripts?.update ? 'npm run update' : true);
  return {
    name, dir, start: start || '', how: start ? how : '', env: over.env || {}, update,
    packages: Boolean(pkg && Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length), // anything to npm install
    error: start ? '' : 'Can’t tell how to start it: add a "start" script to its package.json, a server.js / index.js, or a start command in settings.json.',
  };
}

const warned = new Set(); // folder names already reported as unusable
function scan() {
  const settings = readSettings();
  const over = settings.servers || {};
  const servers = [];
  for (const entry of fs.readdirSync(DEPLOY, { withFileTypes: true })) {
    if (!entry.isDirectory() || /^[._]/.test(entry.name)) continue;
    if (!NAME.test(entry.name)) {
      if (!warned.has(entry.name)) say(`Skipping deployment\\${entry.name}: folder names can only use letters, numbers, - _ and .`);
      warned.add(entry.name);
      continue;
    }
    if (over[entry.name]?.enabled === false) continue;
    servers.push(detect(entry.name, path.join(DEPLOY, entry.name), over[entry.name]));
  }
  return { checkEvery: Math.max(15, Number(settings.checkEvery) || 60), dashboardPort: Number(settings.dashboardPort) || 3399, servers };
}

// ---- servers ----
const servers = new Map(); // name → state
const savePids = () => {
  const pids = Object.fromEntries([...servers.values()].filter((s) => s.child).map((s) => [s.cfg.name, s.child.pid]));
  fs.writeFileSync(PIDS, JSON.stringify({ supervisor: process.pid, servers: pids }, null, 2));
};

async function startServer(s) {
  clearTimeout(s.retry);
  if (s.child || s.held || s.installing) return;
  if (s.cfg.error) { s.status = 'error'; s.error = s.cfg.error; return; } // tried again when the folder changes
  // Just deployed: its packages aren't installed yet.
  if (s.cfg.packages && !fs.existsSync(path.join(s.cfg.dir, 'node_modules'))) {
    s.installing = true;
    s.status = 'installing';
    s.log.line('── installing packages: npm install');
    say(`${s.cfg.name}: installing packages`);
    try { await shell('npm install --no-audit --no-fund', s.cfg.dir, s.log); }
    catch (err) {
      s.installing = false;
      s.status = 'error';
      s.error = `npm install failed: ${err.message}. Trying again in 5 minutes.`;
      s.log.line(`── ${s.error}`);
      s.retry = setTimeout(() => startServer(s), 5 * 60_000);
      return;
    }
    s.installing = false;
    if (s.held || s.child || !servers.has(s.cfg.name)) return;
  }
  s.status = 'running';
  s.error = '';
  s.startedAt = Date.now();
  s.log.line(`── starting: ${s.cfg.start} (in ${s.cfg.dir})`);
  const child = spawn(s.cfg.start, { cwd: s.cfg.dir, shell: true, windowsHide: true, env: { ...process.env, ...s.cfg.env } });
  s.child = child;
  savePids();
  child.stdout.on('data', (b) => s.log.chunk(b));
  child.stderr.on('data', (b) => s.log.chunk(b));
  child.on('error', (err) => s.log.line(`couldn't start: ${err.message}`));
  child.on('exit', (code, signal) => {
    if (s.child !== child) return;
    s.child = null;
    savePids();
    const ranFor = Date.now() - s.startedAt;
    if (s.stopping) { s.stopping = false; s.status = s.held ? 'stopped' : s.status; return; }
    // It ran a good while: it crashed rather than failing to start, so try again quickly.
    s.backoff = ranFor > 60_000 ? 2000 : Math.min(60_000, (s.backoff || 1000) * 2);
    s.restarts++;
    s.status = 'crashed';
    s.error = `Stopped (${signal || `code ${code}`}) after ${Math.round(ranFor / 1000)}s`;
    s.log.line(`── ${s.error}; starting again in ${s.backoff / 1000}s`);
    say(`${s.cfg.name}: ${s.error}; starting again in ${s.backoff / 1000}s`);
    s.retry = setTimeout(() => startServer(s), s.backoff);
  });
}

function stopServer(s) {
  clearTimeout(s.retry);
  const child = s.child;
  if (!child) return Promise.resolve();
  s.stopping = true;
  return new Promise((resolve) => {
    const done = setTimeout(resolve, 10_000);
    child.once('exit', () => { clearTimeout(done); resolve(); });
    killTree(child.pid);
  });
}
const restartServer = async (s) => { await stopServer(s); s.backoff = 0; startServer(s); };

function addServer(cfg) {
  const s = { cfg, log: logFile(cfg.name), child: null, status: 'starting', restarts: 0, backoff: 0, held: false, error: '', lastCheck: 0, lastUpdate: null, updating: false };
  servers.set(cfg.name, s);
  startServer(s);
}

// ---- updates ----
const isRepo = (dir) => fs.existsSync(path.join(dir, '.git'));

// Pulls new commits for one server and restarts it; the old version keeps serving while packages install.
async function updateServer(s, { force = false } = {}) {
  if (s.updating || s.installing || s.cfg.update === false || !isRepo(s.cfg.dir)) return false;
  s.updating = true;
  try {
    const dir = s.cfg.dir;
    await git(dir, 'fetch', '--quiet');
    s.lastCheck = Date.now();
    const behind = Number(await git(dir, 'rev-list', '--count', 'HEAD..@{u}'));
    if (!behind && !force) return false;
    if (!behind) { s.log.line('── up to date'); return false; }
    const subject = await git(dir, 'log', '-1', '--format=%s', '@{u}');
    s.log.line(`── ${behind} new commit${behind > 1 ? 's' : ''}: ${subject}`);
    say(`${s.cfg.name}: updating (${behind} new commit${behind > 1 ? 's' : ''}: ${subject.slice(0, 80)})`);
    s.status = 'updating';
    if (typeof s.cfg.update === 'string') {
      await shell(s.cfg.update, dir, s.log); // the server's own update (Capri's builds its desktop app too)
    } else {
      const before = await git(dir, 'rev-parse', 'HEAD');
      // npm install rewrites package-lock.json, and any edited tracked file blocks the pull: drop the
      // lockfile rewrite, set anything else aside (git stash list / git stash pop to get it back).
      let changed = await git(dir, 'status', '--porcelain', '--untracked-files=no');
      if (/^\s?M{1,2}\s+package-lock\.json$/.test(changed)) { await git(dir, 'checkout', '--', 'package-lock.json'); changed = ''; }
      if (changed) { s.log.line(`setting aside local changes:\n${changed}`); await git(dir, 'stash', 'push', '-m', 'node-servers: local changes before update'); }
      await git(dir, 'pull', '--ff-only');
      const files = await git(dir, 'diff', '--name-only', before, 'HEAD');
      if (/(^|\n)package(-lock)?\.json$/m.test(files) && fs.existsSync(path.join(dir, 'package.json'))) {
        s.log.line('── packages changed: npm install');
        await shell('npm install --no-audit --no-fund', dir, s.log);
      }
    }
    // The pull may have changed how it starts (a new start script, say).
    const fresh = detect(s.cfg.name, dir, (readSettings().servers || {})[s.cfg.name]);
    s.cfg = fresh;
    s.lastUpdate = { at: Date.now(), subject };
    s.status = 'running';
    if (!s.held) await restartServer(s);
    return true;
  } catch (err) {
    s.error = `Update failed: ${(err.output || err.message).split('\n').slice(-3).join(' ').slice(0, 300)}`;
    s.log.line(`── ${s.error}`);
    say(`${s.cfg.name}: ${s.error}`);
    if (s.status === 'updating') s.status = s.child ? 'running' : 'crashed';
    return false;
  } finally {
    s.updating = false;
  }
}

let config;
let checking = false;
async function checkAll() {
  if (checking || stopping) return;
  checking = true;
  try {
    for (const s of servers.values()) await updateServer(s);
    await updateSelf();
  } finally {
    checking = false;
  }
}

// This kit's own repo: pull new commits, and restart if the supervisor or its dashboard changed.
// settings.json, the logs and the dashboard key aren't in git (and the servers live outside this folder),
// so a pull never touches them.
async function updateSelf() {
  if (!isRepo(here)) return;
  try {
    await git(here, 'fetch', '--quiet');
    if (!Number(await git(here, 'rev-list', '--count', 'HEAD..@{u}'))) return;
    const before = await git(here, 'rev-parse', 'HEAD');
    await git(here, 'pull', '--ff-only');
    const files = (await git(here, 'diff', '--name-only', before, 'HEAD')).split('\n');
    say(`Updated node-servers: ${await git(here, 'log', '-1', '--format=%s')}`);
    if (files.some((f) => /^(supervisor\.mjs|dashboard\.html|run\.cmd)$/.test(f))) {
      say('The supervisor changed; restarting it and its servers.');
      await shutdown(RELAUNCH);
    }
  } catch (err) {
    say(`Couldn't update node-servers itself: ${(err.output || err.message).split('\n')[0]}`);
  }
}

// ---- deployment\ and settings.json changes ----
// Every few seconds: start servers in new folders, stop ones whose folder went, restart ones whose
// settings or start command changed.
function applyConfig() {
  let next;
  try { next = scan(); } catch (err) { say(`Couldn't look in the deployment folder: ${err.message}`); return; }
  const names = new Set(next.servers.map((c) => c.name));
  for (const [name, s] of servers) {
    if (!names.has(name)) { say(`${name}: its folder is gone (or it was turned off); stopping it`); s.held = true; stopServer(s); servers.delete(name); }
  }
  for (const cfg of next.servers) {
    const s = servers.get(cfg.name);
    if (!s) { say(`${cfg.name}: found in deployment\\${cfg.error ? ` (${cfg.error})` : `; ${cfg.how}`}`); addServer(cfg); }
    else if (!s.updating && !s.installing && JSON.stringify(s.cfg) !== JSON.stringify(cfg)) {
      s.cfg = cfg;
      if (cfg.error) { stopServer(s); s.status = 'error'; s.error = cfg.error; continue; }
      say(`${cfg.name}: how it runs changed (${cfg.how}); restarting it`);
      restartServer(s);
    }
  }
  if (config && next.dashboardPort !== config.dashboardPort) say('The dashboard port changes next time the supervisor starts.');
  config = { ...next, dashboardPort: config?.dashboardPort ?? next.dashboardPort };
}

// Clones a repo into deployment\; the next scan finds it, installs its packages and starts it.
async function deploy(url, name) {
  url = String(url || '').trim();
  if (!/^(https:\/\/[\w.-]+\/[\w./-]+?|git@[\w.-]+:[\w./-]+?)(\.git)?\/?$/.test(url)) throw new Error('That doesn’t look like a git address (https://github.com/you/repo).');
  name = String(name || '').trim() || url.replace(/\/$/, '').split(/[/:]/).pop().replace(/\.git$/, '');
  if (!NAME.test(name) || /^[._]/.test(name)) throw new Error('The folder name can only use letters, numbers, - _ and . (and can’t start with . or _).');
  const dir = path.join(DEPLOY, name);
  if (fs.existsSync(dir)) throw new Error(`deployment\\${name} already exists.`);
  say(`Deploying ${url} into deployment\\${name}`);
  const tmp = path.join(DEPLOY, `_cloning-${name}`); // skipped by scans until it's complete
  try {
    await run('git', ['clone', '--quiet', url, tmp], here, { timeout: 10 * 60_000 });
    fs.renameSync(tmp, dir);
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(`git clone failed: ${(err.output || err.message).split('\n').filter(Boolean).pop()}`);
  }
  applyConfig();
  return name;
}

// ---- the dashboard ----
function dashboardKey() {
  try { return fs.readFileSync(KEY_FILE, 'utf8').trim(); } catch { /* first run */ }
  const key = crypto.randomBytes(18).toString('base64url');
  fs.writeFileSync(KEY_FILE, key);
  return key;
}

function statusJson() {
  return [...servers.values()].map((s) => ({
    name: s.cfg.name, dir: s.cfg.dir, start: s.cfg.start, how: s.cfg.how, status: s.held ? 'stopped' : s.status, pid: s.child?.pid || null,
    upSince: s.child ? s.startedAt : null, restarts: s.restarts, error: s.error, git: isRepo(s.cfg.dir) && s.cfg.update !== false,
    lastCheck: s.lastCheck || null, lastUpdate: s.lastUpdate, updating: s.updating,
  }));
}

function tail(file, bytes = 64 * 1024) {
  try {
    const { size } = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(bytes, size));
    fs.readSync(fd, buf, 0, buf.length, size - buf.length);
    fs.closeSync(fd);
    return buf.toString().replace(/^[^\n]*\n/, size > bytes ? '' : '$&');
  } catch { return ''; }
}

function startDashboard(port, key) {
  const page = fs.readFileSync(path.join(here, 'dashboard.html'), 'utf8');
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    // Only from this PC, by its own address (no other site's page can reach it under another name), and with the key.
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host || '')) return send(403, { error: 'This PC only' });
    const given = req.headers['x-key'] || url.searchParams.get('key') || '';
    const ok = given.length === key.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key));
    if (!ok) return send(401, url.pathname === '/' ? '<p style="font:15px system-ui;padding:2em">Open the dashboard with <b>open-dashboard.bat</b> (it has the key).</p>' : { error: 'Missing key' }, url.pathname === '/' ? 'text/html' : 'application/json');
    if (req.method === 'GET' && url.pathname === '/') return send(200, page, 'text/html');
    if (req.method === 'GET' && url.pathname === '/api/status') return send(200, { servers: statusJson(), checkEvery: config.checkEvery, since: started, host: process.env.COMPUTERNAME || '', deployDir: DEPLOY });
    const log = /^\/api\/log\/([\w.-]+)$/.exec(url.pathname);
    if (req.method === 'GET' && log) return send(200, tail(path.join(LOGS, `${log[1]}.log`)), 'text/plain');
    const act = /^\/api\/(restart|update|stop|start)\/([\w.-]+)$/.exec(url.pathname);
    if (req.method === 'POST' && act) {
      const s = servers.get(act[2]);
      if (!s) return send(404, { error: 'No such server' });
      say(`${s.cfg.name}: ${act[1]} (from the dashboard)`);
      if (act[1] === 'stop') { s.held = true; await stopServer(s); s.status = 'stopped'; }
      if (act[1] === 'start') { s.held = false; s.backoff = 0; startServer(s); }
      if (act[1] === 'restart') { s.held = false; await restartServer(s); }
      if (act[1] === 'update') { const updated = await updateServer(s, { force: true }); return send(200, { ok: true, updated, error: s.error }); }
      return send(200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/check') { checkAll(); return send(200, { ok: true }); }
    if (req.method === 'POST' && url.pathname === '/api/reload') { applyConfig(); return send(200, { ok: true }); }
    if (req.method === 'POST' && url.pathname === '/api/deploy') {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 4096) return send(413, { error: 'Too long' }); }
      try {
        const { url: repo, name } = JSON.parse(body || '{}');
        return send(200, { ok: true, name: await deploy(repo, name) });
      } catch (err) { return send(400, { error: err.message }); }
    }
    send(404, { error: 'Not found' });
  });
  server.on('error', (err) => say(`The dashboard couldn't start on port ${port}: ${err.message}`));
  server.listen(port, '127.0.0.1', () => {
    const link = `http://127.0.0.1:${port}/?key=${key}`;
    fs.writeFileSync(URL_FILE, link);
    say(`Dashboard: http://127.0.0.1:${port} (open-dashboard.bat opens it with its key)`);
  });
  return server;
}

// ---- leftovers, start and stop ----
// A previous run that was ended hard (Task Scheduler's End, a crash) can leave its servers running and
// holding their ports. Stop them, but only processes that still look like ours.
async function stopLeftovers() {
  let old;
  try { old = JSON.parse(fs.readFileSync(PIDS, 'utf8')); } catch { return; }
  // Only one supervisor at a time: an old one still running would hold the dashboard and restart servers.
  if (old.supervisor && old.supervisor !== process.pid && (await looksLikeOurs(old.supervisor, /^node$/i))) {
    say(`Stopping the previous supervisor (pid ${old.supervisor})`);
    await killTree(old.supervisor);
  }
  for (const [name, pid] of Object.entries(old.servers || {})) {
    if (!(await looksLikeOurs(pid))) continue;
    say(`${name}: stopping the copy a previous run left behind (pid ${pid})`);
    await killTree(pid);
  }
}
async function looksLikeOurs(pid, kind = /^(cmd|node|npm)$/i) {
  try {
    const out = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], here);
    const image = /^"([^"]+)"/.exec(out)?.[1] || '';
    return kind.test(image.replace(/\.exe$/i, ''));
  } catch { return false; }
}

let stopping = false;
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  say('Stopping every server…');
  await Promise.all([...servers.values()].map((s) => { s.held = true; return stopServer(s); }));
  fs.writeFileSync(PIDS, JSON.stringify({ servers: {} }));
  process.exit(code);
}
for (const sig of ['SIGINT', 'SIGBREAK', 'SIGTERM']) process.on(sig, () => shutdown(0)); // Ctrl+C, closing the window

const started = Date.now();
if (process.platform !== 'win32') {
  console.error('node-servers is for Windows: it uses Task Scheduler, taskkill and cmd.');
  process.exit(1);
}
if (process.argv[2] === 'stop-all') {
  await stopLeftovers();
  fs.writeFileSync(PIDS, JSON.stringify({ servers: {} }));
  process.exit(0);
}

await stopLeftovers();
savePids(); // claims the spot for this run
config = scan();
say(`Found ${config.servers.length} server${config.servers.length === 1 ? '' : 's'} in deployment\\: ${config.servers.map((c) => c.name).join(', ') || 'none yet (put their folders in deployment\\)'}`);
for (const cfg of config.servers) addServer(cfg);
startDashboard(config.dashboardPort, dashboardKey());
setInterval(applyConfig, 4000);
setTimeout(checkAll, 5000);
setInterval(checkAll, config.checkEvery * 1000);
