// Self-test for Cline Web. Run it while the server is running:
//   node selftest.js
// It checks the main features against the real Cline and writes ONE report file
// (~/selftest-report.txt) that is safe to share: no API keys, no chat history.
// Optional: PROVIDER=cline MODEL=cline-free/xxx node selftest.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.env.BASE || 'http://127.0.0.1:' + (process.env.PORT || 3000);
const HOME = fs.realpathSync(os.homedir());
const REPORT = path.join(HOME, 'selftest-report.txt');
const TMP_NAME = 'selftest-tmp-' + Date.now();
const TMP = path.join(HOME, TMP_NAME);

const lines = [];
let passed = 0;
let failed = 0;

function log(text) {
  lines.push(text);
  console.log(text);
}

function check(name, ok, detail) {
  if (ok) passed++; else failed++;
  log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  -> ' + detail : ''));
}

function skip(name, why) {
  log('SKIP  ' + name + '  -> ' + why);
}

async function api(method, url, body, timeoutMs) {
  const started = Date.now();
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs || 180000)
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data, ms: Date.now() - started };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Short, safe summary of a text (never the whole reply).
function peek(text) {
  return String(text || '').replace(/\s+/g, ' ').slice(0, 80);
}

async function main() {
  log('Cline Web self-test  ' + new Date().toISOString());
  log('node ' + process.version + '  platform ' + process.platform + '\n');

  // 1. Server alive
  let status;
  try {
    status = await api('GET', '/api/status', null, 10000);
  } catch (err) {
    check('server is running', false, 'cannot reach ' + BASE + ' (' + err.message + ')');
    return;
  }
  check('server is running', status.status === 200 && status.data && status.data.ready);

  // 2. Providers
  const prov = await api('GET', '/api/providers', null, 60000);
  const list = prov.data && Array.isArray(prov.data.providers) ? prov.data.providers : [];
  check('providers list loads', prov.status === 200 && list.length > 0,
    list.map(p => p.id + (p.usable ? '(usable)' : '(' + (p.reason || 'no') + ')')).join(', '));

  const wanted = process.env.PROVIDER || '';
  const chosen = list.find(p => p.usable && (wanted ? p.id === wanted : true));
  if (!chosen) {
    check('a usable provider exists', false, 'none usable; run cline auth first');
    return;
  }

  // 3. Models of that provider
  const mod = await api('GET', '/api/models?provider=' + encodeURIComponent(chosen.id), null, 90000);
  const models = mod.data && Array.isArray(mod.data.models) ? mod.data.models : [];
  check('models list loads for ' + chosen.id, mod.status === 200 && models.length > 0,
    models.length + ' models');
  const model = process.env.MODEL || (mod.data && mod.data.current) || (models[0] && models[0].id);
  if (!model) { check('a model is available', false, ''); return; }
  log('using provider=' + chosen.id + ' model=' + model + '\n');

  // 4. Folder picker + folder safety
  const root = await api('GET', '/api/folders?path=', null, 10000);
  check('folder list works', root.status === 200 && Array.isArray(root.data && root.data.folders),
    root.data && root.data.folders ? root.data.folders.length + ' folders' : JSON.stringify(root.data));
  const up = await api('GET', '/api/folders?path=' + encodeURIComponent('../..'), null, 10000);
  check('".." outside HOME is rejected', up.status === 400, 'status ' + up.status);

  fs.mkdirSync(TMP);
  try {
    fs.symlinkSync('/', path.join(TMP, 'escape'));
    const sym = await api('GET', '/api/folders?path=' + encodeURIComponent(TMP_NAME + '/escape'), null, 10000);
    check('symlink pointing outside HOME is rejected (folders)', sym.status === 400, 'status ' + sym.status);
    const symChat = await api('POST', '/api/chat', {
      prompt: 'say hi there', cwd: TMP_NAME + '/escape', provider: chosen.id, model
    }, 20000);
    check('symlink pointing outside HOME is rejected (chat)', symChat.status === 400, 'status ' + symChat.status);
  } catch (err) {
    skip('symlink tests', err.message);
  }

  // 5. Real chat: Cline must work inside the chosen folder
  const first = await api('POST', '/api/chat', {
    prompt: 'Create a file named proof.txt containing exactly the word hello. Then reply with the word done.',
    cwd: TMP_NAME, provider: chosen.id, model
  });
  check('chat replies', first.status === 200 && first.data && first.data.ok && !!first.data.text,
    'status ' + first.status + ', ' + (first.ms / 1000).toFixed(1) + 's, "' + peek(first.data && (first.data.text || first.data.error)) + '"');
  check('Cline worked inside the chosen folder',
    fs.existsSync(path.join(TMP, 'proof.txt')),
    fs.existsSync(path.join(TMP, 'proof.txt')) ? 'proof.txt created in the chosen folder' : 'proof.txt NOT found there');
  const reported = first.data && first.data.stats && first.data.stats.model;
  check('server reports the model that Cline used', !!reported, String(reported || 'none'));
  if (reported) log('      (asked for ' + model + ', Cline reports ' + reported + ')');

  // 6. Follow-up memory
  const sessionId = first.data && first.data.sessionId;
  const history = [
    { role: 'user', text: 'Remember this word: orange.' },
    { role: 'assistant', text: 'OK, I will remember the word orange.' }
  ];
  if (sessionId) {
    const mem = await api('POST', '/api/chat', {
      prompt: 'What word did I ask you to remember? Reply with that word only.',
      cwd: TMP_NAME, sessionId, provider: chosen.id, model, history
    });
    const text = (mem.data && mem.data.text) || '';
    check('follow-up memory works', /orange/i.test(text), '"' + peek(text || (mem.data && mem.data.error)) + '"');
  } else {
    skip('follow-up memory', 'no session id returned');
  }

  // 7. Busy (409) and Stop in the middle of a long answer
  const longRun = api('POST', '/api/chat', {
    prompt: 'Write a very long story about a cat, at least 800 words. Do not use any tools.',
    cwd: TMP_NAME, provider: chosen.id, model
  });
  await sleep(2500);
  const busy = await api('POST', '/api/chat', {
    prompt: 'say hi there', cwd: TMP_NAME, provider: chosen.id, model
  }, 20000);
  check('second request while busy gets 409', busy.status === 409, 'status ' + busy.status);
  await sleep(6000);
  const stop = await api('POST', '/api/stop', null, 20000);
  const stopped = await longRun;
  if (stop.status === 404) {
    skip('stop in the middle of a long answer', 'the reply already finished before Stop (model too fast)');
  } else {
    check('stop returns quickly with stopped flag',
      stopped.data && stopped.data.stopped === true, 'status ' + stopped.status + ', after ' + (stopped.ms / 1000).toFixed(1) + 's');
    const t = (stopped.data && stopped.data.text) || '';
    log('      partial text length: ' + t.length + ' chars' + (t ? ' ("' + peek(t) + '")' : ''));
    check('no raw exit string shown', !/exited with code|SIGKILL|SIGTERM/i.test(JSON.stringify(stopped.data || {})), '');
  }

  // 8. Server still healthy
  const after = await api('GET', '/api/status', null, 10000);
  check('server not stuck busy afterwards', after.data && after.data.busy === false, '');
}

main()
  .catch(err => check('self-test crashed', false, err.message))
  .finally(() => {
    // Only the temp folder created above is removed (a symlink inside it is
    // removed as a link; its target is never touched).
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
    log('\n' + passed + ' passed, ' + failed + ' failed');
    try { fs.writeFileSync(REPORT, lines.join('\n') + '\n'); } catch {}
    console.log('\nReport saved: ' + REPORT);
    process.exit(failed ? 1 : 0);
  });
