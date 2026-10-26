const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const PASSWORD = process.env.CLINE_WEB_PASSWORD || '';
const HOME = fs.realpathSync(process.env.HOME);

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

// Blocks web pages from other sites that try to reach this server through the
// browser (including "DNS rebinding"). API calls must use a known host name,
// and when the browser sends an Origin it must be this same site.
// Add more host names with ALLOWED_HOSTS=name1,name2 (for a tunnel or domain).
const ALLOWED_HOSTS = new Set(
  ['localhost', '127.0.0.1', '[::1]', HOST]
    .concat(String(process.env.ALLOWED_HOSTS || '').split(','))
    .map(h => h.trim().toLowerCase())
    .filter(Boolean)
);

function hostName(value) {
  // "name:3000" -> "name", "[::1]:3000" -> "[::1]"
  const v = String(value || '').trim().toLowerCase();
  if (v.startsWith('[')) return v.slice(0, v.indexOf(']') + 1);
  return v.split(':')[0];
}

app.use('/api', (req, res, next) => {
  if (!ALLOWED_HOSTS.has(hostName(req.headers.host))) {
    return res.status(403).json({ error: 'This host name is not allowed.' });
  }
  const origin = req.headers.origin;
  if (origin) {
    let originHost = '';
    try { originHost = new URL(origin).host.toLowerCase(); } catch {}
    if (originHost !== String(req.headers.host || '').toLowerCase()) {
      return res.status(403).json({ error: 'Cross-site requests are not allowed.' });
    }
  }
  next();
});

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
    const arr = [...sessions.entries()];
    const kept = arr.slice(Math.max(0, arr.length - 64));
    const tmp = SESSIONS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(kept)));
    fs.renameSync(tmp, SESSIONS_FILE);
    sessions.clear();
    for (const [k,v] of kept) sessions.set(k,v);
  } catch {}
}

const sessions = loadSessions();

// Runs the CLI in its own process group, so stopping it also stops anything
// it started. Calls back once with (err, stdout, stderr), like execFile.
function runCline(args, cwd, callback) {
  // By default the CLI hands the work to a shared background "hub" that was
  // started from whatever folder was open first, so the chosen folder and the
  // Stop button can be ignored. "local" runs the agent inside this process.
  const env = { ...process.env, CLINE_SESSION_BACKEND_MODE: 'local' };

  const child = spawn('cline', args, {
    cwd,
    env,
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

// Turns what the CLI wrote on stderr into one short, readable sentence.
// A raw exit string or a long stack trace is never sent to the page.
function friendlyError(stderr) {
  const text = String(stderr || '').trim();
  if (!text) return 'Cline did not finish.';
  if (/SIGINT|SIGKILL|SIGTERM/.test(text)) return 'Stopped';

  const jsonLine = text.split(/\r?\n/).find(line => line.trim().startsWith('{'));
  if (jsonLine) {
    try {
      const parsed = JSON.parse(jsonLine);
      const message = parsed.message || (parsed.error && parsed.error.message);
      if (message) return String(message).slice(0, 300);
    } catch {}
  }

  const firstLine = text.split(/\r?\n/).find(line => line.trim()) || '';
  return firstLine.slice(0, 300) || 'Cline did not finish.';
}

app.get('/api/status', (req, res) => {
  res.json({ ready: true, busy, sessionCount: sessions.size });
});

// Lists the folders inside a folder under HOME, for the folder picker.
app.get('/api/folders', (req, res) => {
  const dirReal = (() => {
    try { return fs.realpathSync(path.resolve(HOME, String(req.query.path || ''))); }
    catch { return null; }
  })();
  if (!dirReal) return res.status(404).json({ error: 'Folder not found.' });
  if (dirReal !== HOME && !dirReal.startsWith(HOME + path.sep)) {
    return res.status(400).json({ error: 'The folder must be inside the HOME folder.' });
  }

  let entries;
  try {
    entries = fs.readdirSync(dirReal, { withFileTypes: true });
  } catch {
    return res.status(404).json({ error: 'Folder not found.' });
  }

  const folders = entries
    .filter(e => {
      if (e.name.startsWith('.')) return false;
      if (e.isDirectory()) return true;
      if (e.isSymbolicLink()) {
        try {
          const rp = fs.realpathSync(path.join(dirReal, e.name));
          if (rp !== HOME && !rp.startsWith(HOME + path.sep)) return false;
          return fs.statSync(rp).isDirectory();
        } catch { return false; }
      }
      return false;
    })
    .map(e => e.name)
    .sort((a, b) => a.localeCompare(b));

  res.json({
    path: path.relative(HOME, dirReal),
    parent: dirReal === HOME ? null : path.relative(HOME, path.dirname(dirReal)),
    folders
  });
});

const PROVIDERS_PATH = path.join(process.env.HOME || HOME, '.cline/data/settings/providers.json');
const DEFAULT_PROVIDER_ID = 'cline';
const FREE_MODELS_TTL_MS = 5 * 60 * 1000;
const ACP_ERROR_TTL_MS = 30 * 1000;
const ACP_TIMEOUT_MS = 20 * 1000;
const CLINE_API = (process.env.CLINE_API_BASE_URL || 'https://api.cline.bot').replace(/\/+$/, '');
const FREE_MODELS_URL = `${CLINE_API}/api/v1/ai/cline/recommended-models`;
const MODELS_DEV_URL = process.env.MODELS_DEV_URL || 'https://models.dev/api.json';
const PROVIDER_NAMES = {
  'cline': 'Cline',
  'cline-pass': 'ClinePass',
  'opencode': 'OpenCode',
  'openai-compatible': 'OpenAI Compatible',
  'openai-codex': 'OpenAI ChatGPT Subscription'
};

function readProviderState() {
  try {
    const state = JSON.parse(fs.readFileSync(PROVIDERS_PATH, 'utf8'));
    return {
      providers: state && typeof state.providers === 'object' && state.providers ? state.providers : {},
      lastUsedProvider: state && typeof state.lastUsedProvider === 'string' ? state.lastUsedProvider : ''
    };
  } catch {
    return { providers: {}, lastUsedProvider: '' };
  }
}

function hasConfiguredProvider(configured, id) {
  return !!id && Object.prototype.hasOwnProperty.call(configured, id);
}

function hasProviderCredentials(id, settings, entry) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const apiKey = typeof s.apiKey === 'string' ? s.apiKey.trim() : '';
  if (id === 'openai-compatible') {
    const baseUrl = typeof s.baseUrl === 'string' ? s.baseUrl.trim() : '';
    return !!(apiKey && baseUrl);
  }
  if (apiKey) return true;
  if (s.auth && typeof s.auth === 'object' && Object.keys(s.auth).length) return true;
  if (s.oauth && typeof s.oauth === 'object' && Object.keys(s.oauth).length) return true;
  return typeof entry?.tokenSource === 'string' && entry.tokenSource.trim() !== '';
}

function providerSettings(entry) {
  return entry && typeof entry.settings === 'object' && entry.settings ? entry.settings : {};
}

function providerDisplayName(id) {
  if (PROVIDER_NAMES[id]) return PROVIDER_NAMES[id];
  const known = KNOWN_PROVIDERS.find(p => p.id === id);
  return known ? known.name : id;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function zeroNumber(value) {
  if (value === 0) return true;
  return typeof value === 'string' && value.trim() !== '' && Number(value) === 0;
}

function normalizeFreeModels(list) {
  const seen = new Set();
  const models = [];
  for (const item of Array.isArray(list) ? list : []) {
    let id = '';
    let name = '';
    if (typeof item === 'string') {
      id = item.trim();
    } else if (item && typeof item === 'object') {
      if (typeof item.id === 'string') id = item.id.trim();
      else if (typeof item.modelId === 'string') id = item.modelId.trim();
      if (typeof item.name === 'string') name = item.name.trim();
    }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name: name || id });
  }
  return models;
}

function intersectModels(models, allowed) {
  const allowedIds = new Set(allowed.map(m => m.id));
  return models.filter(m => allowedIds.has(m.id));
}

let freeFeedCache = null;
let freeFeedInFlight = null;

function fetchFreeFeed() {
  if (freeFeedCache && Date.now() - freeFeedCache.at < FREE_MODELS_TTL_MS) {
    return Promise.resolve(freeFeedCache.models);
  }
  if (freeFeedInFlight) return freeFeedInFlight;

  freeFeedInFlight = (async () => {
    try {
      const resp = await fetch(FREE_MODELS_URL, { signal: AbortSignal.timeout(8000) });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const json = await resp.json();
      const models = normalizeFreeModels(json && json.free);
      if (models.length > 0) freeFeedCache = { at: Date.now(), models };
      return models;
    } finally {
      freeFeedInFlight = null;
    }
  })();
  return freeFeedInFlight;
}

let modelsDevCache = null;
let modelsDevInFlight = null;

function fetchModelsDev() {
  if (modelsDevCache && Date.now() - modelsDevCache.at < FREE_MODELS_TTL_MS) {
    return Promise.resolve(modelsDevCache.data);
  }
  if (modelsDevInFlight) return modelsDevInFlight;

  modelsDevInFlight = (async () => {
    try {
      const resp = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(10000) });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      if (!data || typeof data !== 'object') throw new Error('Invalid price catalogue');
      modelsDevCache = { at: Date.now(), data };
      return data;
    } finally {
      modelsDevInFlight = null;
    }
  })();
  return modelsDevInFlight;
}

function modelsDevFreeModels(catalog, providerId) {
  const provider = catalog && catalog[providerId];
  const entries = provider && provider.models && typeof provider.models === 'object'
    ? provider.models
    : {};
  const seen = new Set();
  const models = [];

  for (const [id, model] of Object.entries(entries)) {
    if (!id || seen.has(id) || !model || typeof model !== 'object') continue;
    if (String(model.status || '').toLowerCase() === 'deprecated') continue;
    const cost = model.cost && typeof model.cost === 'object' ? model.cost : null;
    if (!cost || !zeroNumber(cost.input) || !zeroNumber(cost.output)) continue;
    seen.add(id);
    models.push({
      id,
      name: typeof model.name === 'string' && model.name.trim() ? model.name.trim() : id
    });
  }
  return models;
}

let compatibleCache = new Map();
let compatibleInFlight = new Map();

function zeroPricedMetadata(raw) {
  if (!raw || typeof raw !== 'object') return false;
  if (raw.isFree === true || raw.free === true) return true;

  for (const cost of [raw.cost, raw.pricing]) {
    if (!cost || typeof cost !== 'object') continue;
    const input = cost.input ?? cost.prompt ?? cost.inputPrice ?? cost.input_price;
    const output = cost.output ?? cost.completion ?? cost.outputPrice ?? cost.output_price;
    if (zeroNumber(input) && zeroNumber(output)) return true;
  }

  return zeroNumber(raw.inputPrice ?? raw.input_price) &&
    zeroNumber(raw.outputPrice ?? raw.output_price);
}

function fetchOpenAiCompatibleModels(entry) {
  const settings = providerSettings(entry);
  const baseUrl = typeof settings.baseUrl === 'string' ? settings.baseUrl.trim().replace(/\/+$/, '') : '';
  const apiKey = typeof settings.apiKey === 'string' ? settings.apiKey.trim() : '';
  if (!baseUrl || !apiKey) {
    throw httpError(400, 'OpenAI Compatible needs an API key and base URL.');
  }

  const key = `${baseUrl}|${entry && entry.updatedAt ? entry.updatedAt : ''}`;
  const cached = compatibleCache.get(key);
  if (cached && Date.now() - cached.at < FREE_MODELS_TTL_MS) {
    return Promise.resolve(cached.result);
  }
  if (compatibleInFlight.has(key)) return compatibleInFlight.get(key);

  const promise = (async () => {
    const url = /\/models$/.test(baseUrl) ? baseUrl : baseUrl + '/models';
    const resp = await fetch(url, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(8000)
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const json = await resp.json();
    const list = Array.isArray(json?.data)
      ? json.data
      : Array.isArray(json?.models)
        ? json.models
        : Array.isArray(json)
          ? json
          : [];

    const seen = new Set();
    const free = [];
    for (const item of list) {
      let id = '';
      let name = '';
      let raw = null;
      if (typeof item === 'string') {
        id = item.trim();
      } else if (item && typeof item === 'object') {
        raw = item;
        if (typeof item.id === 'string') id = item.id.trim();
        if (typeof item.name === 'string') name = item.name.trim();
      }
      if (!id || seen.has(id)) continue;
      if (raw && String(raw.status || '').toLowerCase() === 'deprecated') continue;
      seen.add(id);
      if (raw && zeroPricedMetadata(raw)) free.push({ id, name: name || id });
    }
    return { free };
  })();

  compatibleInFlight.set(key, promise);
  promise
    .then(result => compatibleCache.set(key, { at: Date.now(), result }))
    .catch(() => {})
    .finally(() => compatibleInFlight.delete(key));
  return promise;
}

const acpCache = new Map();
const acpInFlight = new Map();

function probeAcpModels(providerId, entry) {
  const key = `${providerId}|${entry && entry.updatedAt ? entry.updatedAt : ''}`;
  const cached = acpCache.get(key);
  if (cached) {
    const ttl = cached.result.error ? ACP_ERROR_TTL_MS : FREE_MODELS_TTL_MS;
    if (Date.now() - cached.at < ttl) return Promise.resolve(cached.result);
  }
  if (acpInFlight.has(key)) return acpInFlight.get(key);

  const promise = new Promise(resolve => {
    const settings = providerSettings(entry);
    const env = { ...process.env, CLINE_PROVIDER: providerId };
    if (typeof settings.apiKey === 'string' && settings.apiKey.trim()) {
      env.CLINE_API_KEY = settings.apiKey.trim();
    }
    if (typeof settings.model === 'string' && settings.model.trim()) {
      env.CLINE_MODEL = settings.model.trim();
    }

    let child;
    try {
      child = spawn('cline', ['--acp'], {
        cwd: HOME,
        env,
        stdio: ['pipe', 'pipe', 'ignore']
      });
    } catch (err) {
      resolve({ models: [], current: '', error: err.message || 'Could not start Cline.' });
      return;
    }

    let buffer = '';
    let settled = false;
    let timer;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch {}
      resolve(result);
    };

    timer = setTimeout(() => {
      finish({ models: [], current: '', error: 'Model catalogue timed out.' });
    }, ACP_TIMEOUT_MS);

    const send = (message) => {
      try {
        child.stdin.write(JSON.stringify(message) + '\n');
      } catch (err) {
        finish({ models: [], current: '', error: err.message || 'Could not read the model catalogue.' });
      }
    };

    child.on('error', err => {
      finish({ models: [], current: '', error: err.message || 'Could not start Cline.' });
    });

    child.stdin.on('error', () => {});

    child.on('exit', () => {
      finish({ models: [], current: '', error: 'Cline closed the model catalogue.' });
    });

    child.stdout.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        let message;
        try { message = JSON.parse(line); } catch { continue; }

        if (message.id === 1) {
          if (message.error) {
            return finish({
              models: [],
              current: '',
              error: message.error.message || 'Cline could not start.'
            });
          }
          send({
            jsonrpc: '2.0',
            id: 2,
            method: 'session/new',
            params: { cwd: HOME, mcpServers: [] }
          });
        } else if (message.id === 2) {
          if (message.error) {
            return finish({
              models: [],
              current: '',
              error: message.error.message || 'Cline could not list models.'
            });
          }
          const models = normalizeFreeModels(
            message.result && message.result.models && message.result.models.availableModels
          );
          const current = typeof message.result?.models?.currentModelId === 'string'
            ? message.result.models.currentModelId
            : '';
          finish({ models, current, error: '' });
        }
      }
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: {} }
    });
  });

  acpInFlight.set(key, promise);
  promise
    .then(result => acpCache.set(key, { at: Date.now(), result }))
    .catch(() => {})
    .finally(() => acpInFlight.delete(key));
  return promise;
}

const OPENCODE_REASON = 'not supported here: it ignores the chosen folder';
let opencodeCache = null;

function commandExists(command) {
  const dirs = String(process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const file = path.join(dir, command);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return true;
    } catch {}
  }
  return false;
}

function checkOpencode() {
  if (opencodeCache && Date.now() - opencodeCache.at < FREE_MODELS_TTL_MS) {
    return Promise.resolve(opencodeCache.available);
  }
  const available = commandExists('opencode');
  opencodeCache = { at: Date.now(), available };
  return Promise.resolve(available);
}

async function discoverProviderModels(providerId, entry) {
  if (!entry) throw httpError(400, 'This provider is not configured.');
  const settings = providerSettings(entry);

  if (providerId === 'cline') {
    if (!hasProviderCredentials(providerId, settings, entry)) {
      throw httpError(400, 'Cline credentials are missing. Sign in to Cline in the terminal.');
    }
    return {
      models: await fetchFreeFeed(),
      source: 'cline-recommended-free'
    };
  }

  if (providerId === 'cline-pass') {
    if (!hasProviderCredentials(providerId, settings, entry)) {
      throw httpError(400, 'ClinePass credentials are missing. Sign in to ClinePass in the terminal.');
    }
    const [feed, acp] = await Promise.all([
      fetchFreeFeed(),
      probeAcpModels(providerId, entry)
    ]);
    if (acp.error) throw httpError(503, 'ClinePass model catalogue is unavailable. Try again later.');
    return {
      models: intersectModels(feed, acp.models),
      source: 'cline-recommended-free + cline-pass-acp'
    };
  }

  if (providerId === 'opencode') {
    if (!await checkOpencode()) {
      throw httpError(400, 'The local OpenCode CLI was not found. Install it in the terminal.');
    }
    const [acp, catalog] = await Promise.all([
      probeAcpModels(providerId, entry),
      fetchModelsDev()
    ]);
    if (acp.error) throw httpError(503, 'OpenCode model catalogue is unavailable. Try again later.');
    return {
      models: intersectModels(modelsDevFreeModels(catalog, 'opencode'), acp.models),
      source: 'opencode-acp + models.dev'
    };
  }

  if (providerId === 'openai-compatible') {
    if (!hasProviderCredentials(providerId, settings, entry)) {
      throw httpError(400, 'OpenAI Compatible needs an API key and base URL.');
    }
    const result = await fetchOpenAiCompatibleModels(entry);
    return { models: result.free, source: 'openai-compatible-models' };
  }

  if (providerId === 'openai-codex') {
    if (!hasProviderCredentials(providerId, settings, entry)) {
      throw httpError(400, 'OpenAI ChatGPT Subscription credentials are missing. Sign in in the terminal.');
    }
    return { models: [], source: 'none' };
  }

  if (!hasProviderCredentials(providerId, settings, entry)) {
    throw httpError(400, 'This provider is not authenticated. Sign in in the terminal.');
  }
  const [acp, catalog] = await Promise.all([
    probeAcpModels(providerId, entry),
    fetchModelsDev()
  ]);
  if (acp.error) throw httpError(503, 'This provider model catalogue is unavailable. Try again later.');
  return {
    models: intersectModels(modelsDevFreeModels(catalog, providerId), acp.models),
    source: 'acp + models.dev'
  };
}

async function getProviderStatuses(configured) {
  const entries = Object.entries(configured);
  if (!entries.length) return [];

  let feedPromise = null;
  let modelsDevPromise = null;
  const getFeed = () => feedPromise || (feedPromise = fetchFreeFeed());
  const getModelsDev = () => modelsDevPromise || (modelsDevPromise = fetchModelsDev());

  return Promise.all(entries.map(async ([id, entry]) => {
    const settings = providerSettings(entry);
    const base = { id, name: providerDisplayName(id), configured: true };

    try {
      if (id === 'cline' || id === 'cline-pass') {
        const authenticated = hasProviderCredentials(id, settings, entry);
        let models = [];
        let catalogError = '';
        try { models = await getFeed(); } catch (err) { catalogError = err.message || 'unavailable'; }
        const usable = authenticated && !catalogError && models.length > 0;
        return {
          ...base,
          authenticated,
          usable,
          freeStatus: catalogError ? 'error' : (models.length ? (id === 'cline' ? 'verified' : 'candidate') : 'none'),
          freeCount: id === 'cline' ? models.length : null,
          catalog: catalogError ? 'error' : (models.length ? 'ok' : 'empty'),
          source: 'cline-recommended-free',
          reason: !authenticated
            ? 'credentials missing'
            : catalogError
              ? 'catalogue unavailable'
              : !models.length
                ? 'no free models'
                : ''
        };
      }

      if (id === 'opencode') {
        const available = await checkOpencode();
        let freeCount = 0;
        let catalogError = '';
        try {
          freeCount = modelsDevFreeModels(await getModelsDev(), 'opencode').length;
        } catch (err) {
          catalogError = err.message || 'unavailable';
        }
        // OpenCode runs its own tools in its own folder and ignores --cwd, and
        // it can hang without answering. It cannot work inside the chosen
        // project folder, so it is listed but never selectable.
        const usable = false;
        return {
          ...base,
          authenticated: available,
          usable,
          freeStatus: catalogError ? 'error' : (freeCount ? 'candidate' : 'none'),
          freeCount: null,
          catalog: catalogError ? 'error' : (freeCount ? 'ok' : 'empty'),
          source: 'opencode-acp + models.dev',
          reason: OPENCODE_REASON,
        };
      }

      if (id === 'openai-compatible') {
        const authenticated = hasProviderCredentials(id, settings, entry);
        let freeCount = 0;
        let catalogError = '';
        if (authenticated) {
          try {
            freeCount = (await fetchOpenAiCompatibleModels(entry)).free.length;
          } catch (err) {
            catalogError = err.message || 'unavailable';
          }
        }
        const usable = authenticated && !catalogError && freeCount > 0;
        return {
          ...base,
          authenticated,
          usable,
          freeStatus: !authenticated ? 'unverified' : catalogError ? 'error' : (freeCount ? 'verified' : 'none'),
          freeCount,
          catalog: !authenticated ? 'unknown' : catalogError ? 'error' : (freeCount ? 'ok' : 'empty'),
          source: 'openai-compatible-models',
          reason: !authenticated
            ? 'API key and base URL required'
            : catalogError
              ? 'model list unavailable'
              : !freeCount
                ? 'no verified free models'
                : ''
        };
      }

      if (id === 'openai-codex') {
        const authenticated = hasProviderCredentials(id, settings, entry);
        return {
          ...base,
          authenticated,
          usable: false,
          freeStatus: 'none',
          freeCount: 0,
          catalog: 'empty',
          source: 'none',
          reason: authenticated ? 'subscription, no free models' : 'credentials missing'
        };
      }

      const authenticated = hasProviderCredentials(id, settings, entry);
      if (!authenticated) {
        return {
          ...base,
          authenticated: false,
          usable: false,
          freeStatus: 'unverified',
          freeCount: 0,
          catalog: 'unknown',
          source: 'acp + models.dev',
          reason: 'credentials missing'
        };
      }

      let acp;
      let catalog;
      let catalogError = '';
      try {
        [acp, catalog] = await Promise.all([
          probeAcpModels(id, entry),
          getModelsDev()
        ]);
      } catch (err) {
        catalogError = err.message || 'unavailable';
      }
      if (acp && acp.error) catalogError = acp.error;
      const models = acp && !catalogError
        ? intersectModels(modelsDevFreeModels(catalog, id), acp.models)
        : [];
      return {
        ...base,
        authenticated,
        usable: !catalogError && models.length > 0,
        freeStatus: catalogError ? 'error' : (models.length ? 'verified' : 'none'),
        freeCount: models.length,
        catalog: catalogError ? 'error' : (models.length ? 'ok' : 'empty'),
        source: 'acp + models.dev',
        reason: catalogError
          ? 'catalogue unavailable'
          : !models.length
            ? 'no verified free models'
            : ''
      };
    } catch (err) {
      return {
        ...base,
        authenticated: false,
        usable: false,
        freeStatus: 'error',
        freeCount: 0,
        catalog: 'error',
        source: 'unknown',
        reason: 'catalogue unavailable'
      };
    }
  }));
}

let KNOWN_PROVIDERS = [];
try {
  KNOWN_PROVIDERS = JSON.parse(fs.readFileSync(path.join(__dirname, 'providers.json'), 'utf8'));
} catch {}

app.get('/api/providers', async (req, res) => {
  try {
    const { providers: configured } = readProviderState();
    const statuses = await getProviderStatuses(configured);
    // Everything else Cline supports, shown as "not set up yet".
    const others = KNOWN_PROVIDERS
      .filter(p => !Object.prototype.hasOwnProperty.call(configured, p.id))
      .map(p => ({ id: p.id, name: p.name }));
    res.json({ providers: statuses, others });
  } catch {
    res.status(500).json({ error: 'Could not read provider settings.' });
  }
});

app.get('/api/models', async (req, res) => {
  const requested = String(req.query.provider || '').trim();
  const { providers: configured, lastUsedProvider } = readProviderState();
  const fallback = hasConfiguredProvider(configured, lastUsedProvider)
    ? lastUsedProvider
    : hasConfiguredProvider(configured, DEFAULT_PROVIDER_ID)
      ? DEFAULT_PROVIDER_ID
      : Object.keys(configured)[0] || '';
  const provider = requested || fallback;

  if (!hasConfiguredProvider(configured, provider)) {
    return res.status(400).json({ error: 'This provider is not configured.' });
  }

  let discovered;
  try {
    discovered = await discoverProviderModels(provider, configured[provider]);
  } catch (err) {
    return res.status(err.status || 503).json({
      error: err.message || 'Model catalogue is unavailable. Try again later.'
    });
  }

  const models = discovered.models;
  if (models.length === 0) {
    return res.json({
      provider,
      current: '',
      models: [],
      catalog: 'empty',
      catalogError: provider === 'openai-codex'
        ? 'OpenAI ChatGPT Subscription does not expose free models.'
        : 'No free models are available for this provider.',
      source: discovered.source
    });
  }

  const settings = providerSettings(configured[provider]);
  const configuredModel = typeof settings.model === 'string' ? settings.model.trim() : '';
  const current = models.some(m => m.id === configuredModel) ? configuredModel : models[0].id;

  res.json({
    provider,
    current,
    models: models.map(m => ({ id: m.id, name: m.name, source: 'free' })),
    catalog: 'ok',
    catalogError: '',
    source: discovered.source
  });
});

app.post('/api/chat', async (req, res) => {
  if (busy) {
    return res.status(409).json({
      error: 'Cline is busy right now. Wait for the current request to finish.'
    });
  }

  let prompt = String(req.body.prompt || '').trim();
  // Relative folders are taken from HOME; an empty value means HOME itself.
  let cwd;
  try { cwd = fs.realpathSync(path.resolve(HOME, String(req.body.cwd || ''))); }
  catch { return res.status(400).json({ error: 'Invalid folder.' }); }
  const sessionId = String(req.body.sessionId || '');
  const model = String(req.body.model || '').trim();
  const provider = String(req.body.provider || DEFAULT_PROVIDER_ID).trim();
  // Earlier messages of this chat, sent by the page (the new message is not included).
  const history = Array.isArray(req.body.history)
    ? req.body.history.filter(m => m && (m.role === 'user' || m.role === 'assistant'))
    : [];

  const { providers: configured } = readProviderState();
  if (!hasConfiguredProvider(configured, provider)) {
    return res.status(400).json({ error: 'This provider is not configured.' });
  }
  if (provider === 'opencode') {
    return res.status(400).json({ error: 'OpenCode is ' + OPENCODE_REASON + '. Choose another provider.' });
  }

  if (!model || model.startsWith('-') || !/^[^\s\x00-\x1f]{1,160}$/.test(model)) {
    return res.status(400).json({ error: 'Choose a model from the free model list.' });
  }

  if (Buffer.byteLength(prompt, 'utf8') > 64 * 1024) {
    return res.status(400).json({ error: 'Prompt too long (max 64KB).' });
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

  // In JSON mode the CLI cannot resume a session: "--id" switches it to
  // interactive mode and fails. So for follow-up messages the earlier part of
  // the chat is sent again inside the prompt instead.
  if (previous && history.length) {
    const lines = history.slice(-12).map(m => {
      const who = m.role === 'user' ? 'User' : 'Assistant';
      return who + ': ' + String(m.text || '').slice(0, 2000);
    });
    prompt = 'Earlier in this conversation:\n\n' + lines.join('\n\n') +
      '\n\nNew message from the user:\n' + prompt;
  }

  if (Buffer.byteLength(prompt, 'utf8') > 64 * 1024) {
    return res.status(400).json({ error: 'Prompt too long (max 64KB).' });
  }

  let discovered;
  try {
    discovered = await discoverProviderModels(provider, configured[provider]);
  } catch (err) {
    return res.status(err.status || 503).json({
      error: err.message || 'Free model catalogue is unavailable. Try again later.'
    });
  }
  if (discovered.models.length === 0) {
    return res.status(400).json({ error: 'No free models are available for this provider.' });
  }
  if (!discovered.models.some(m => m.id === model)) {
    return res.status(400).json({ error: 'Choose a model from the free model list.' });
  }

  if (busy) {
    return res.status(409).json({
      error: 'Cline is busy right now. Wait for the current request to finish.'
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
  // --act forces Act mode. Without it, the mode saved in the CLI settings
  // (for example Plan mode set in the terminal UI) is used, and edits fail.
  const args = [
    '--json',
    '--cwd', cwd,
    '--auto-approve', 'true',
    '--act'
  ];

  if (provider) {
    args.push('--provider', provider);
  }
  if (model) {
    args.push('-m', model);
  }

  // "--" stops option parsing, so a prompt starting with "-" is never read as a flag.
  args.push('--', prompt);

  // (prompt not logged)

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

      // Assistant text only. Tool output also arrives as content_end, so the
      // content type is checked, otherwise a tool result could show up as the reply.
      const isText = e => e.type === 'agent_event' &&
        e.event?.contentType === 'text';
      const lastTextEnd = events.findLast(
        e => isText(e) && e.event?.type === 'content_end' && e.event?.text
      );
      const partialText = result?.text ||
        (lastTextEnd?.event?.text) ||
        events
          .filter(e => isText(e) && e.event?.type === 'content_start')
          .map(e => e.event?.text || '')
          .join('');


      // Remember the CLI session so follow-up messages can resume it.
      // Older CLI builds send run_start with a sessionId; newer ones only
      // report a taskId in hook_event lines, so accept either.
      let cliSessionId = '';
      const start = events.findLast(
        event => event.type === 'run_start' && event.sessionId
      );
      if (start) {
        cliSessionId = start.sessionId;
      } else {
        const hook = events.findLast(event => event.type === 'hook_event' && event.taskId);
        if (hook) cliSessionId = hook.taskId;
      }

      let outSessionId = sessionId;
      if (cliSessionId) {
        if (previous) {
          previous.clineId = cliSessionId;
        } else {
          outSessionId = crypto.randomUUID();
          sessions.set(outSessionId, { clineId: cliSessionId, cwd });
        }
        saveSessions();
      }

      if (wasStopped) {
        return res.json({
          ok: false,
          stopped: true,
          error: 'Stopped',
          text: partialText,
          sessionId: outSessionId
        });
      }

      if (err) {
        return res.status(500).json({
          ok: false,
          error: friendlyError(stderr),
          text: partialText,
          sessionId: outSessionId
        });
      }

      res.json({
        ok: true,
        text: partialText,
        events,
        sessionId: outSessionId,
        stats: {
          iterations: result?.iterations ?? null,
          durationMs: result?.durationMs ?? null,
          model: result?.model?.id ?? null,
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
