const express = require('express');
const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const PASSWORD = process.env.CLINE_WEB_PASSWORD || '';
const HOME = process.env.HOME;

// Anything reachable from outside this machine must be protected.
if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !PASSWORD) {
  console.error('CLINE_WEB_PASSWORD must be set when the server listens on a non-local address');
  process.exit(1);
}

// HTTP Basic auth: the browser asks for the password once and remembers it.
// The username is ignored. Use HTTPS in front of this when it is public,
// because Basic auth sends the password with every request.
function requireAuth(req, res, next) {
  if (!PASSWORD) return next();

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  let given = '';
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    given = decoded.slice(decoded.indexOf(':') + 1);
  }

  const a = Buffer.from(given);
  const b = Buffer.from(PASSWORD);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();

  res.set('WWW-Authenticate', 'Basic realm="Cline Chat"');
  return res.status(401).send('Authentication required');
}

app.use(requireAuth);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let busy = false;
// The request currently running, so /api/stop can reach its process.
let currentRun = null;

// Browser-facing session id -> { clineId, cwd }
// clineId is the session id the Cline CLI reports in its run_start event;
// it is passed back with --id so the next message continues the conversation.
// Saved to disk so conversations can continue after the server restarts.
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');

function loadSessions() {
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'))));
  } catch {
    return new Map();
  }
}

function saveSessions() {
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions)));
  } catch {}
}

const sessions = loadSessions();

// Runs the CLI in its own process group, so stopping it also stops anything
// it started. Calls back once with (err, stdout, stderr), like execFile.
function runCline(args, cwd, callback) {
  const child = spawn('cline', args, {
    cwd,
    env: process.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  let finished = false;

  const timer = setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }, 10 * 60 * 1000);

  const finish = (err) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    callback(err, stdout, stderr);
  };

  child.stdout.on('data', d => { if (stdout.length < 10 * 1024 * 1024) stdout += d; });
  child.stderr.on('data', d => { if (stderr.length < 1024 * 1024) stderr += d; });
  child.on('error', err => finish(err));
  child.on('close', (code, signal) => {
    if (code === 0 && !signal) return finish(null);
    const err = new Error(stderr || `Cline exited with code ${code}${signal ? ' (' + signal + ')' : ''}`);
    finish(err);
  });

  return child;
}

app.get('/api/status', (req, res) => {
  res.json({ ready: true, busy, sessionCount: sessions.size });
});

// The CLI has no "list models" command, so ask it over ACP (cline --acp):
// initialize -> session/new, which returns the models available to the account.
let modelCache = null;

function fetchModels() {
  return new Promise((resolve, reject) => {
    const child = spawn('cline', ['--acp'], { cwd: HOME, env: process.env });
    let buf = '';
    let done = false;

    const send = obj => child.stdin.write(JSON.stringify(obj) + '\n');

    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      if (err) reject(err); else resolve(value);
    };

    const timer = setTimeout(() => finish(new Error('Timed out')), 20000);

    child.stdin.on('error', () => {});
    child.on('error', err => finish(err));
    child.on('exit', () => finish(new Error('Cline stopped before responding')));

    child.stdout.on('data', chunk => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;

        let msg;
        try { msg = JSON.parse(line); } catch { continue; }

        if (msg.id === 1) {
          if (msg.error) return finish(new Error(msg.error.message || 'initialize failed'));
          send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: HOME, mcpServers: [] } });
        } else if (msg.id === 2) {
          if (msg.error) return finish(new Error(msg.error.message || 'session/new failed'));
          const m = msg.result?.models || {};
          finish(null, {
            current: m.currentModelId || '',
            models: (m.availableModels || []).map(x => ({
              id: x.modelId,
              name: x.name || x.modelId
            }))
          });
        }
      }
    });

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });
  });
}

// The free models shown in Cline's own picker ("Free" section) come from the
// public recommended-models feed. Same source as the CLI, so the lists match.
const CLINE_API = (process.env.CLINE_API_BASE_URL || 'https://api.cline.bot').replace(/\/+$/, '');

// Bundled copy of the same section, used when the feed cannot be reached.
const BUNDLED_FREE_MODELS = [
  { id: 'cline-free/nemotron-3.5-super-vl', name: 'Nemotron 3.5 Super VL' },
  { id: 'cline-free/mimo-v2.6-flash', name: 'Mimo V2.6 Flash' },
  { id: 'cline-free/muse-spark-1.3-contributor', name: 'Muse Spark 1.3 Contributor' },
  { id: 'cline-free/solar-mini4', name: 'Solar Mini 4' }
];

let freeCache = null;

async function fetchFreeModels() {
  if (freeCache && Date.now() - freeCache.at < 5 * 60 * 1000) {
    return freeCache.models;
  }
  const resp = await fetch(`${CLINE_API}/api/v1/ai/cline/recommended-models`, {
    signal: AbortSignal.timeout(8000)
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const json = await resp.json();
  const models = (Array.isArray(json.free) ? json.free : [])
    .filter(m => m && typeof m.id === 'string' && m.id)
    .map(m => ({ id: m.id, name: m.name || m.id }));
  if (models.length === 0) throw new Error('Free model list is empty');
  freeCache = { at: Date.now(), models };
  return models;
}

app.get('/api/models', async (req, res) => {
  // Current model comes from the CLI (needs login). Free list does not.
  let current = '';
  try {
    if (!modelCache) modelCache = await fetchModels();
    current = modelCache.current;
  } catch (err) {
    current = '';
  }

  let models;
  try {
    models = await fetchFreeModels();
  } catch (err) {
    models = BUNDLED_FREE_MODELS;
  }

  res.json({ current, models });
});

app.post('/api/chat', (req, res) => {
  if (busy) {
    return res.status(409).json({
      error: 'Cline is busy right now. Wait for the current request to finish.'
    });
  }

  let prompt = String(req.body.prompt || '').trim();
  // Relative folders are taken from HOME; an empty value means HOME itself.
  const cwd = path.resolve(HOME, String(req.body.cwd || ''));
  const sessionId = String(req.body.sessionId || '');
  const model = String(req.body.model || '').trim();

  if (model && !/^[\w./:@-]{1,120}$/.test(model)) {
    return res.status(400).json({ error: 'Invalid model name.' });
  }

  if (!prompt) {
    return res.status(400).json({ error: 'Write your message first.' });
  }

  if (!cwd.startsWith(HOME + path.sep) && cwd !== HOME) {
    return res.status(400).json({
      error: 'The folder must be inside the HOME folder.'
    });
  }

  const previous = sessionId ? sessions.get(sessionId) : undefined;

  if (sessionId && !previous) {
    return res.status(400).json({
      error: 'Session not found. Start a new chat.'
    });
  }

  if (previous && previous.cwd !== cwd) {
    return res.status(400).json({
      error: 'The project folder cannot change within the same session.'
    });
  }

  // The Cline CLI rejects a prompt that has no whitespace in it
  // ("Unknown command or unquoted prompt"), e.g. "hi". A trailing newline
  // satisfies that check without changing the meaning of the message.
  if (!/\s/.test(prompt)) {
    prompt += '\n';
  }

  // Without a terminal the CLI cannot ask for approval, so tools are only
  // allowed to run when auto-approve is on. Every change is still limited to
  // the working directory inside HOME (checked above).
  const args = [
    '--json',
    '--cwd', cwd,
    '--auto-approve', 'true'
  ];

  if (previous) {
    args.push('--id', previous.clineId);
  }

  if (model) {
    args.push('-m', model);
  }

  // "--" stops option parsing, so a prompt starting with "-" is never read as a flag.
  args.push('--', prompt);

  busy = true;
  currentRun = { child: null, stopped: false };

  try {
    currentRun.child = runCline(args, cwd, (err, stdout, stderr) => {
      busy = false;
      const wasStopped = currentRun ? currentRun.stopped : false;
      currentRun = null;

      const events = String(stdout || '')
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap(line => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });

      const result = events.findLast(
        event => event.type === 'run_result'
      );

      // Remember the CLI session so follow-up messages can resume it.
      const start = events.findLast(
        event => event.type === 'run_start' && event.sessionId
      );

      let outSessionId = sessionId;
      if (start) {
        if (previous) {
          previous.clineId = start.sessionId;
        } else {
          outSessionId = crypto.randomUUID();
          sessions.set(outSessionId, { clineId: start.sessionId, cwd });
        }
        saveSessions();
      }

      if (wasStopped) {
        return res.json({
          ok: false,
          stopped: true,
          error: 'Stopped',
          text: result?.text || '',
          sessionId: outSessionId
        });
      }

      if (err) {
        return res.status(500).json({
          ok: false,
          error: String(stderr || err.message || 'Failed to run Cline'),
          text: result?.text || '',
          sessionId: outSessionId
        });
      }

      res.json({
        ok: true,
        text: result?.text || '',
        events,
        sessionId: outSessionId,
        stats: {
          iterations: result?.iterations ?? null,
          durationMs: result?.durationMs ?? null,
          inputTokens: result?.usage?.inputTokens ?? null,
          outputTokens: result?.usage?.outputTokens ?? null
        }
      });
    });
  } catch (err) {
    busy = false;
    currentRun = null;
    res.status(500).json({
      ok: false,
      error: 'Could not start Cline: ' + err.message
    });
  }
});

// Stop the running request. SIGINT lets the CLI abort cleanly.
app.post('/api/stop', (req, res) => {
  if (!currentRun || !currentRun.child) {
    return res.status(404).json({ error: 'Nothing is running right now.' });
  }
  const run = currentRun;
  const pid = run.child.pid;
  run.stopped = true;
  // Signal the whole process group. SIGINT lets the CLI abort cleanly;
  // if it is still alive after 5 seconds, force-kill the group.
  try { process.kill(-pid, 'SIGINT'); } catch {}
  setTimeout(() => {
    if (currentRun === run && run.child && run.child.pid === pid) {
      try { process.kill(-pid, 'SIGKILL'); } catch {}
    }
  }, 5000);
  res.json({ ok: true });
});

app.listen(PORT, HOST, () => {
  console.log(`Cline Web: http://${HOST}:${PORT}${PASSWORD ? ' (password protected)' : ''}`);
});
