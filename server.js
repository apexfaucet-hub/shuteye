#!/usr/bin/env node
'use strict';
// Shuteye: talk to Claude Code from your phone with your eyes shut.
//
// The page listens (the browser's speech recognition), sends your words here, a headless `claude -p` session answers
// in your project folder, and the page reads the answer out loud. Zero dependencies: Node's standard library only.
//
// SAFETY MODEL, read before changing a default:
//   - Default mode is READ-ONLY. Bash, Write, Edit, NotebookEdit, WebFetch and subagents are removed from the session,
//     so no allow-list in your settings can bring them back. It can read your files, search and answer.
//   - --full-powers runs the session with bypassPermissions. The spoken rules make it say what it will change and wait
//     for your "yes", and deny.json keeps secret files away from the file tools. Bash is NOT sandboxed in this mode:
//     `cat ~/.ssh/id_rsa` would still work. Full powers is a trust decision about whoever holds your phone, not a sandbox.
//   - One random key (256 bits), kept in the phone browser's storage and sent as a header on every call, compared in
//     constant time. It is never printed: you pair a phone with a ONE-TIME link (15 minutes, works once) that the page
//     trades for the key. Five wrong tries lock an address out for an hour, and 50 wrong tries an hour lock everyone out.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : (process.env['VOICE_' + n.toUpperCase().replace(/-/g, '_')] || d); };
if (flag('help')) {
  console.log(`shuteye: talk to Claude Code with your eyes shut

  node server.js [--dir <project>] [--port 3411] [--tunnel] [--full-powers] [--claude <path>] [--base /voice] [--trust-proxy]
  node server.js --pair      make a new one-time pairing link for a phone (while the server runs)

  --dir          folder the Claude Code session works in (default: where you run this)
  --port         local port (default 3411; binds 127.0.0.1 only)
  --tunnel       start a Cloudflare quick tunnel (needs cloudflared on PATH) and print an https link for your phone
  --full-powers  let the voice session change things (it asks first). Default is read-only. Read the README first.
  --claude       path to the claude binary (default: claude on PATH)
  --base         URL prefix if you serve it behind your own proxy at a sub-path, e.g. /voice
  --trust-proxy  trust CF-Connecting-IP / X-Real-IP for the lockout (only behind a proxy that sets them)`);
  process.exit(0);
}

const HOME = os.homedir();
const STATE_DIR = path.join(HOME, '.shuteye');
const PORT = Number(opt('port', 3411));
const WORKDIR = path.resolve(opt('dir', process.cwd()));
const CLAUDE = opt('claude', 'claude');
const BASE = String(opt('base', '')).replace(/\/$/, '');
const FULL = flag('full-powers');
const JOB_TIMEOUT_MS = (FULL ? 30 : 10) * 60 * 1000;

fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
const KEY_FILE = path.join(STATE_DIR, 'key');
if (!fs.existsSync(KEY_FILE)) fs.writeFileSync(KEY_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const KEY = fs.readFileSync(KEY_FILE, 'utf8').trim();
const STATE = path.join(STATE_DIR, 'state.json');
const HISTORY = path.join(STATE_DIR, 'history.md');
const DENY = path.join(STATE_DIR, 'deny.json');
if (!fs.existsSync(DENY)) fs.copyFileSync(path.join(__dirname, 'deny.template.json'), DENY);
const PAGE = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8');
const PAIR = path.join(STATE_DIR, 'pair.json');
const TRUST_PROXY = flag('trust-proxy') || flag('tunnel');   // cloudflared sets CF-Connecting-IP itself
function newPairToken() {
  const t = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(PAIR, JSON.stringify({ hash: crypto.createHash('sha256').update(t).digest('hex'), expires: Date.now() + 15 * 60e3, used: null }), { mode: 0o600 });
  return t;
}
function redeemPair(token) {
  let d = {}; try { d = JSON.parse(fs.readFileSync(PAIR, 'utf8')); } catch (e) { return false; }
  const h = crypto.createHash('sha256').update(String(token)).digest('hex');
  const ok = typeof d.hash === 'string' && d.hash.length === h.length && !d.used && Date.now() < d.expires && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(d.hash));
  if (ok) { d.used = new Date().toISOString(); fs.writeFileSync(PAIR, JSON.stringify(d), { mode: 0o600 }); }
  return ok;
}
if (flag('pair')) {
  let origin = 'http://127.0.0.1:' + PORT; try { origin = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'origin.json'), 'utf8')).origin || origin; } catch (e) {}
  console.log('one-time pairing link (15 minutes, works once): ' + origin + (BASE || '') + '/#p=' + newPairToken());
  process.exit(0);
}

const RULES_COMMON = [
  'The user is talking to you by VOICE with their eyes closed and hears your answer read aloud; they cannot see a screen.',
  'Answer in two or three short spoken sentences. Plain words only: no markdown, no lists, no headings, no links, no code, no symbols that sound strange read aloud.',
  'Round numbers and say units in words. Speech recognition mishears: if the words are unclear or could mean two things, ask instead of guessing.',
  'Never read out a password, private key, seed phrase or token.',
];
const RULES = (FULL ? RULES_COMMON.concat([
  'Reading, checking and measuring you may do freely. BEFORE ANY CHANGE (editing or writing a file, a command that changes state, a restart, a deploy, sending anything): say in one short sentence exactly what you are about to do and end with "Shall I?". Do it only after their next message says yes.',
]) : RULES_COMMON.concat([
  'This session is read-only: you can read files and search, you cannot run commands or change anything. If they ask for a change, say so and describe in one sentence what they would need to do.',
])).join(' ');

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { return {}; } };
const writeState = (s) => { const t = STATE + '.tmp'; fs.writeFileSync(t, JSON.stringify(s), { mode: 0o600 }); fs.renameSync(t, STATE); };

const fails = new Map();
let globalFails = { n: 0, since: Date.now() };
// Only a header the proxy itself sets: cloudflared sets CF-Connecting-IP; behind your own proxy use X-Real-IP (your proxy
// must set it), because a client could send its own CF-Connecting-IP through a plain proxy.
const clientIp = (req) => String((flag('tunnel') ? req.headers['cf-connecting-ip'] : (TRUST_PROXY ? req.headers['x-real-ip'] : '')) || req.socket.remoteAddress || '?').slice(0, 64);
function noteFail(ip) {
  const now = Date.now(), f = fails.get(ip);
  const g = f && now - f.since < 3600e3 ? f : { n: 0, since: now };
  g.n += 1; if (fails.size > 10000) fails.clear(); fails.set(ip, g);
  if (now - globalFails.since > 3600e3) globalFails = { n: 0, since: now };
  globalFails.n += 1;
  if (g.n === 5) console.error('[shuteye] 5 wrong tries from ' + ip + ' in the last hour; that address is locked out for an hour');
}
const lockedOut = (ip) => { const f = fails.get(ip); return (f && f.n >= 5 && Date.now() - f.since < 3600e3) || (globalFails.n >= 50 && Date.now() - globalFails.since < 3600e3); };
function authorised(req) {
  const ip = clientIp(req);
  // The right key always works, even during a lockout: otherwise a stranger with your link could lock you out.
  const given = Buffer.from(String(req.headers['x-voice-key'] || '')), want = Buffer.from(KEY);
  if (given.length === want.length && crypto.timingSafeEqual(given, want)) { fails.delete(ip); return 'ok'; }
  if (lockedOut(ip)) return 'locked';
  noteFail(ip);
  return 'bad';
}

const jobs = new Map();
let running = null;
// Own process group, so Stop and the timeout end Claude and everything it started; SIGKILL if it ignores SIGTERM.
function killJob(job) {
  const c = job && job.child; if (!c) return;
  try { process.kill(-c.pid, 'SIGTERM'); } catch (e) { try { c.kill('SIGTERM'); } catch (_) {} }
  setTimeout(() => { try { process.kill(-c.pid, 'SIGKILL'); } catch (e) {} if (job.status === 'working') { job.status = 'failed'; running = null; } }, 10000).unref();
}

const MODELS = new Set(['', 'opus', 'sonnet', 'fable', 'haiku']);
const EFFORTS = new Set(['', 'low', 'medium', 'high', 'xhigh', 'max']);
function startJob(text, newTopic, opts) {
  opts = opts || {};
  const id = crypto.randomBytes(8).toString('hex');
  const st = readState();
  if (newTopic) delete st.sessionId;
  // The spoken text goes in on stdin, never as an argument, so a sentence starting with "-" cannot become an option.
  const rules = opts.detail ? RULES.replace('Answer in two or three short spoken sentences.', 'Answer in up to six spoken sentences; the user asked for detailed answers.') : RULES;
  const args = ['-p', '--output-format', 'json', '--append-system-prompt', rules, '--strict-mcp-config', '--settings', DENY];
  if (MODELS.has(opts.model) && opts.model) args.push('--model', opts.model);
  if (EFFORTS.has(opts.effort) && opts.effort) args.push('--effort', opts.effort);
  if (FULL) args.push('--permission-mode', 'bypassPermissions');
  // Read-only: --restricted removes every code-running tool and confines the file tools to the project folder; the
  // positive --tools list means no other tool (Monitor, Skill, worktrees, cron...) is available at all.
  else args.push('--restricted', '--tools', 'Read', 'Glob', 'Grep', 'WebSearch', '--permission-mode', 'dontAsk', '--permission-prompts', 'none');
  if (st.sessionId) args.push('--resume', st.sessionId);
  const job = { status: 'working', reply: null, error: null, at: Date.now(), child: null, question: text };
  jobs.set(id, job);
  let child;
  try { child = spawn(CLAUDE, args, { cwd: WORKDIR, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true }); child.stdin.end(text); }
  catch (e) { job.status = 'failed'; job.error = 'Could not start Claude Code: ' + e.message; return id; }
  job.child = child; running = id;
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('error', (e) => { job.error = 'Could not start Claude Code (' + e.message + '). Is it installed and logged in?'; });
  const timer = setTimeout(() => { job.error = 'That took too long, so I stopped it.'; killJob(job); }, JOB_TIMEOUT_MS);
  child.on('close', (code) => {
    clearTimeout(timer); running = null; job.child = null;
    try {
      const d = JSON.parse(out.slice(out.indexOf('{')));
      if (d.session_id) { const s = readState(); s.sessionId = d.session_id; writeState(s); }
      job.reply = String(d.result || '').trim() || 'I have no answer for that.';
      job.status = 'done';
      try { fs.appendFileSync(HISTORY, '\n[' + new Date().toISOString() + '] You: ' + job.question + '\nClaude: ' + job.reply + '\n', { mode: 0o600 }); } catch (e) {}
    } catch (e) {
      job.status = 'failed';
      job.error = job.error || 'The answer did not come back' + (code === null ? '.' : ' (exit ' + code + ').');
      console.error('[shuteye] job failed: ' + e.message + ' | ' + err.slice(0, 400));
    }
  });
  return id;
}

function send(res, code, obj, type) {
  const h = { 'Content-Type': type || 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex',
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' };
  if (type) h['Content-Security-Policy'] = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
  res.writeHead(code, h);
  res.end(type ? obj : JSON.stringify(obj));
}

http.createServer((req, res) => {
  const u = new URL('http://x' + (String(req.url || '/').startsWith('/') ? '' : '/') + String(req.url || '/'))   // '//x' must stay a path, not a host;
  let p = u.pathname;
  if (BASE && p.startsWith(BASE)) p = p.slice(BASE.length) || '/';
  if (req.method === 'GET' && p === '/') return send(res, 200, PAGE.replace('__MODE__', FULL ? 'full powers' : 'read-only').replace('__BASE__', BASE), 'text/html; charset=utf-8');
  if (!p.startsWith('/api/')) return send(res, 404, { ok: false });
  if (req.method === 'POST' && p === '/api/pair') {
    const ip = clientIp(req);
    if (lockedOut(ip)) return send(res, 429, { ok: false, error: 'Too many tries. Try again in an hour.' });
    if (redeemPair(req.headers['x-pair-token'] || '')) { console.log('[shuteye] a phone was paired'); return send(res, 200, { ok: true, key: KEY }); }
    noteFail(ip);
    return send(res, 401, { ok: false, error: 'This pairing link is used up or expired. Make a new one with: node server.js --pair' });
  }
  const a = authorised(req);
  if (a === 'locked') return send(res, 429, { ok: false, error: 'Too many wrong keys. Try again in an hour.' });
  if (a !== 'ok') return send(res, 401, { ok: false, error: 'Wrong key.' });
  if (req.method === 'POST' && p === '/api/ask') {
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 20000) req.destroy(); });
    req.on('end', () => {
      let j = {}; try { j = JSON.parse(body || '{}'); } catch (e) {}
      const text = String(j.text || '').trim().slice(0, 4000);
      if (!text) return send(res, 400, { ok: false, error: 'I did not hear anything.' });
      const cur = running && jobs.get(running);
      if (cur && cur.status === 'working') return send(res, 409, { ok: false, error: 'I am still working on the last question.' });
      return send(res, 200, { ok: true, jobId: startJob(text, !!j.newTopic, { model: String(j.model || ''), effort: String(j.effort || ''), detail: !!j.detail }) });
    });
    return;
  }
  const m = p.match(/^\/api\/job\/([0-9a-f]{16})$/);
  if (req.method === 'GET' && m) {
    const job = jobs.get(m[1]);
    if (!job) return send(res, 404, { ok: false, error: 'Unknown job.' });
    return send(res, 200, { ok: true, status: job.status, reply: job.reply, error: job.error, seconds: Math.round((Date.now() - job.at) / 1000) });
  }
  if (req.method === 'POST' && p === '/api/cancel') { const job = running && jobs.get(running); if (job && job.child) { job.error = 'Stopped.'; killJob(job); } return send(res, 200, { ok: true }); }
  if (req.method === 'POST' && p === '/api/new-topic') { const s = readState(); delete s.sessionId; writeState(s); return send(res, 200, { ok: true }); }
  return send(res, 404, { ok: false });
}).listen(PORT, '127.0.0.1', () => {
  console.log('\nshuteye  (' + (FULL ? 'FULL POWERS: it can change things after you say yes' : 'read-only') + ')');
  console.log('  project: ' + WORKDIR);
  try { fs.writeFileSync(path.join(STATE_DIR, 'origin.json'), JSON.stringify({ origin: 'http://127.0.0.1:' + PORT })); } catch (e) {}
  if (!flag('tunnel')) {
    console.log('  on this computer: http://127.0.0.1:' + PORT + (BASE || '') + '/#p=' + newPairToken() + '   (one-time pairing link, 15 minutes)');
    console.log('  for your phone you need https: run with --tunnel (cloudflared) or put it behind your own https proxy.\n');
  } else startTunnel();
});

function startTunnel() {
  let t;
  try { t = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:' + PORT], { stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { console.log('  --tunnel: could not start cloudflared (' + e.message + ')'); return; }
  let shown = false;
  const look = (d) => {
    const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !shown) {
      shown = true;
      try { fs.writeFileSync(path.join(STATE_DIR, 'origin.json'), JSON.stringify({ origin: m[0] })); } catch (e) {}
      console.log('  on your phone: ' + m[0] + (BASE || '') + '/#p=' + newPairToken() + '\n  (one-time pairing link: works once within 15 minutes; make another with: node server.js --pair)\n');
    }
  };
  t.stdout.on('data', look); t.stderr.on('data', look);
  t.on('error', (e) => console.log('  --tunnel: cloudflared is not installed or not on PATH (' + e.message + ')'));
  process.on('exit', () => { try { t.kill(); } catch (e) {} });
  process.on('SIGINT', () => process.exit(0)); process.on('SIGTERM', () => process.exit(0));
}

setInterval(() => { for (const [id, j] of jobs) if (Date.now() - j.at > 3600e3 && j.status !== 'working') jobs.delete(id); }, 600e3).unref();
