// Runs every Node server on this Windows PC and keeps them running. The list is servers.json in this folder
// (made from servers.example.json the first time). For each server it:
//   - starts it, and starts it again if it crashes (waiting longer each time it keeps crashing);
//   - keeps its output in logs/<name>.log (the last 5 MB, then logs/<name>.1.log);
//   - if its folder is a git repo, checks for new commits every minute; when there are some it pulls
//     them, installs packages if they changed (or runs the server's own update command), and restarts it.
// Saving servers.json applies it straight away: new servers start, removed ones stop, changed ones restart.
// A dashboard at http://127.0.0.1:3399 (this PC only, behind a key) shows them and can restart, update,
// stop and start each one. open-dashboard.bat opens it.
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
const CONFIG = path.join(here, 'servers.json');
const EXAMPLE = path.join(here, 'servers.example.json');
const LOGS = path.join(here, 'logs');
const PIDS = path.join(LOGS, 'pids.json');
const KEY_FILE = path.join(here, '.dashboard-key');
const URL_FILE = path.join(here, 'dashboard.url');
const RELAUNCH = 75; // asks run.cmd to start this again (it was updated)
const LOG_MAX = 5 * 1024 * 1024;

fs.mkdirSync(LOGS, { recursive: true });

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

// ---- config ----
function readConfig() {
  if (!fs.existsSync(CONFIG)) fs.copyFileSync(EXAMPLE, CONFIG);
  const raw = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const seen = new Set();
  const servers = (raw.servers || []).filter((s) => s && s.enabled !== false).map((s) => {
    const name = String(s.name || '').trim();
    if (!/^[\w.-]{1,40}$/.test(name)) throw new Error(`Server name "${s.name}" can only use letters, numbers, - _ and .`);
    if (seen.has(name)) throw new Error(`Two servers are called "${name}".`);
    seen.add(name);
    if (!s.start) throw new Error(`"${name}" needs a start command, like "node server.js" or "npm start".`);
    return { name, dir: path.resolve(here, s.dir || '.'), start: String(s.start), env: s.env || {}, update: s.update ?? true };
  });
  return { checkEvery: Math.max(15, Number(raw.checkEvery) || 60), dashboardPort: Number(raw.dashboardPort) || 3399, servers };
}

// ---- servers ----
const servers = new Map(); // name → state
const savePids = () => {
  const pids = Object.fromEntries([...servers.values()].filter((s) => s.child).map((s) => [s.cfg.name, s.child.pid]));
  fs.writeFileSync(PIDS, JSON.stringify({ supervisor: process.pid, servers: pids }, null, 2));
};

function startServer(s) {
  clearTimeout(s.retry);
  if (s.child || s.held) return;
  if (!fs.existsSync(s.cfg.dir)) {
    s.status = 'error';
    s.error = `Folder not found: ${s.cfg.dir}`;
    s.log.line(s.error);
    s.retry = setTimeout(() => startServer(s), 60_000);
    return;
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
  if (s.updating || s.cfg.update === false || !isRepo(s.cfg.dir)) return false;
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
        await shell('npm install --omit=dev --no-audit --no-fund', dir, s.log);
      }
    }
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
// servers.json, the logs and the dashboard key aren't in git, so a pull never touches them.
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

// ---- servers.json changes ----
function applyConfig() {
  let next;
  try { next = readConfig(); } catch (err) { say(`servers.json has a problem, so nothing changed: ${err.message}`); return; }
  const names = new Set(next.servers.map((c) => c.name));
  for (const [name, s] of servers) {
    if (!names.has(name)) { say(`${name}: removed from servers.json; stopping it`); stopServer(s); servers.delete(name); }
  }
  for (const cfg of next.servers) {
    const s = servers.get(cfg.name);
    if (!s) { say(`${cfg.name}: added`); addServer(cfg); }
    else if (JSON.stringify(s.cfg) !== JSON.stringify(cfg)) { say(`${cfg.name}: settings changed; restarting it`); s.cfg = cfg; restartServer(s); }
  }
  if (config && next.dashboardPort !== config.dashboardPort) say('The dashboard port changes next time the supervisor starts.');
  config = { ...next, dashboardPort: config?.dashboardPort ?? next.dashboardPort };
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
    name: s.cfg.name, dir: s.cfg.dir, start: s.cfg.start, status: s.held ? 'stopped' : s.status, pid: s.child?.pid || null,
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
    if (req.method === 'GET' && url.pathname === '/api/status') return send(200, { servers: statusJson(), checkEvery: config.checkEvery, since: started, host: process.env.COMPUTERNAME || '' });
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
config = readConfig();
say(`Starting ${config.servers.length} server${config.servers.length === 1 ? '' : 's'}: ${config.servers.map((c) => c.name).join(', ') || 'none yet (add them to servers.json)'}`);
for (const cfg of config.servers) addServer(cfg);
startDashboard(config.dashboardPort, dashboardKey());
fs.watchFile(CONFIG, { interval: 2000 }, () => applyConfig());
setTimeout(checkAll, 5000);
setInterval(checkAll, config.checkEvery * 1000);
