/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const script = require('../.claude/skills/prolibu-scripts/scripts/script');

const D = 'dev99.example.com';
const P = 'my-hook';
const DEV_ID = 'a'.repeat(24);
const PROD_ID = 'b'.repeat(24);
const OTHER_ID = 'c'.repeat(24);
const BUNDLE = '// bundle\n(async function main() {})();\n';

let rootDir;
let out;
let err;
let calls;
let state;

function respond(status, body) {
  return { status, text: async () => JSON.stringify(body) };
}

// Shaped after the verified server: GET /v2/script/<code> answers the record or 404; the run
// answers 200 with { output, eventData, error, errorStack?, timeMs } even when the script
// fails; GET /v2/log ignores any filter on meta and answers { pagination, data } newest first.
async function fakeFetch(url, init) {
  const u = new URL(url);
  calls.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams) });
  if (state.timeout && u.pathname === '/v2/script/run') {
    const e = new Error('timed out');
    e.name = 'TimeoutError';
    throw e;
  }
  const byCode = u.pathname.match(/^\/v2\/script\/([^/]+)$/);
  if (init.method === 'GET' && byCode && byCode[1] !== 'run') {
    const record = state.scripts[decodeURIComponent(byCode[1])];
    return record ? respond(200, record) : respond(404, { error: 'Not found.' });
  }
  if (init.method === 'GET' && u.pathname === '/v2/script/run') {
    state.runs += 1;
    state.logs = [...state.newLogs, ...state.logs];
    return respond(200, state.runResult);
  }
  if (init.method === 'GET' && u.pathname === '/v2/log') {
    return respond(200, { pagination: { count: state.logs.length }, data: state.logs });
  }
  return respond(404, { error: `unexpected ${init.method} ${u.pathname}` });
}

const run = (argv) => script.main(argv, {
  rootDir,
  fetchImpl: fakeFetch,
  sleep: async () => {},
  stdout: { write: (s) => { out += s; } },
  stderr: { write: (s) => { err += s; } },
});

function writeLocal({ config, bundle = BUNDLE } = {}) {
  const dir = path.join(rootDir, 'accounts', D, 'scripts', P);
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config || {
    variables: [{ key: 'apiKey', value: 'LOCAL-SECRET' }], lifecycleHooks: [], readme: '', git: { repositoryUrl: '' },
  }));
  if (bundle !== null) fs.writeFileSync(path.join(dir, 'dist', 'bundle.js'), bundle);
}

const log = (id, scriptId, message, status = 'Info') => ({
  _id: id, createdAt: '2026-10-30T12:00:00.000Z', status, message, meta: { scriptId, scriptCode: 'x', eventName: 'ApiRun' },
});

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-scripts-root-'));
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: 'SECRET123' }));
  out = '';
  err = '';
  calls = [];
  state = {
    runs: 0,
    timeout: false,
    scripts: {
      [`${P}-dev`]: {
        _id: DEV_ID, scriptCode: `${P}-dev`, active: true, timeout: 30000, lifecycleHooks: [],
        variables: [{ key: 'apiKey', value: 'ACCOUNT-SECRET' }], code: BUNDLE, updatedAt: 'T1',
      },
      [P]: { _id: PROD_ID, scriptCode: P, active: true, lifecycleHooks: [] },
    },
    runResult: { output: { ok: true }, eventData: { query: {}, body: {} }, error: null, timeMs: 12 },
    logs: [log('old', DEV_ID, 'before the run')],
    newLogs: [log('n1', DEV_ID, 'from this run'), log('n2', OTHER_ID, 'another script')],
  };
});
afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('status', () => {
  test('in sync: exit 0, compares code with dist/bundle.js and never prints variable values', async () => {
    writeLocal();
    expect(await run(['status', D, P])).toBe(0);
    const res = JSON.parse(out);
    expect(res).toMatchObject({
      scriptCode: `${P}-dev`, _id: DEV_ID, inSync: true, code: { matchesBundle: true },
      variables: { localKeys: ['apiKey'], accountKeys: ['apiKey'], droppedOnNextDeploy: [] },
      otherCopy: { scriptCode: P, _id: PROD_ID },
    });
    expect(out).not.toContain('SECRET');
  });

  test('--env prod checks <prefix>, not <prefix>-prod', async () => {
    state.scripts[P] = { ...state.scripts[`${P}-dev`], _id: PROD_ID, scriptCode: P };
    writeLocal();
    expect(await run(['status', D, P, '--env', 'prod'])).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ scriptCode: P, _id: PROD_ID, otherCopy: { scriptCode: `${P}-dev` } });
    expect(calls[0].path).toBe(`/v2/script/${P}`);
  });

  test('code that differs from the local bundle is a problem (exit 3)', async () => {
    writeLocal({ bundle: '// newer local build\n' });
    expect(await run(['status', D, P])).toBe(3);
    const res = JSON.parse(out);
    expect(res.inSync).toBe(false);
    expect(res.code.matchesBundle).toBe(false);
    expect(res.problems.join(' ')).toContain('Failed to PATCH code');
  });

  test('hooks the account rejected show as a mismatch', async () => {
    writeLocal({ config: { variables: [{ key: 'apiKey', value: 'x' }], lifecycleHooks: ['Deal'] } });
    expect(await run(['status', D, P])).toBe(3);
    expect(JSON.parse(out).problems.join(' ')).toContain('lifecycleHooks differ');
  });

  test('variables saved by setVariable are flagged as dropped on the next deploy', async () => {
    state.scripts[`${P}-dev`].variables.push({ key: 'cursor', value: '42' });
    writeLocal();
    expect(await run(['status', D, P])).toBe(0);
    const res = JSON.parse(out);
    expect(res.variables.droppedOnNextDeploy).toEqual(['cursor']);
    expect(res.warnings.join(' ')).toContain('drops them');
  });

  test('warns when both copies are active with a trigger', async () => {
    state.scripts[`${P}-dev`].lifecycleHooks = ['Contact'];
    state.scripts[P] = { _id: PROD_ID, scriptCode: P, active: true, lifecycleHooks: ['Contact'] };
    writeLocal({ config: { variables: [{ key: 'apiKey', value: 'x' }], lifecycleHooks: ['Contact'] } });
    expect(await run(['status', D, P])).toBe(0);
    expect(JSON.parse(out).warnings.join(' ')).toContain('both run on every event');
  });

  test('an inactive script is a problem', async () => {
    state.scripts[`${P}-dev`].active = false;
    writeLocal();
    expect(await run(['status', D, P])).toBe(3);
    expect(JSON.parse(out).problems.join(' ')).toContain('inactive');
  });

  test('not deployed: blocked, with the deploy command', async () => {
    expect(await run(['status', D, 'new-one'])).toBe(3);
    expect(err).toContain('BLOCKED');
    expect(err).toContain(`./prolibu script dev --domain ${D} --prefix new-one --no-git`);
  });
});

describe('run', () => {
  test('refuses without --confirmed and sends nothing', async () => {
    expect(await run(['run', D, P])).toBe(2);
    expect(calls).toHaveLength(0);
    expect(err).toContain('--confirmed');
  });

  test('runs by _id with the query, and returns only this run\'s log lines of this script', async () => {
    expect(await run(['run', D, P, '--query', 'dealId=123', '--query', 'note=a b', '--confirmed'])).toBe(0);
    const runCall = calls.find((c) => c.path === '/v2/script/run');
    expect(runCall.query).toEqual({ scriptId: DEV_ID, dealId: '123', note: 'a b' });
    const res = JSON.parse(out);
    expect(res.output).toEqual({ ok: true });
    expect(res.error).toBeNull();
    expect(res.logs.map((l) => l.message)).toEqual(['from this run']);
  });

  test('a failed script answers 200 with error: exit 1 and the stack is shown', async () => {
    state.runResult = { output: null, error: 'boom', errorStack: 'Error: boom\n    at line 12:3', timeMs: 5 };
    state.newLogs = [log('f1', DEV_ID, 'boom', 'Failure')];
    expect(await run(['run', D, P, '--confirmed'])).toBe(1);
    const res = JSON.parse(out);
    expect(res).toMatchObject({ error: 'boom', errorStack: 'Error: boom\n    at line 12:3' });
    expect(res.logs[0]).toMatchObject({ status: 'Failure', message: 'boom' });
  });

  test('an inactive script is not run', async () => {
    state.scripts[`${P}-dev`].active = false;
    expect(await run(['run', D, P, '--confirmed'])).toBe(3);
    expect(state.runs).toBe(0);
  });

  test('scriptId cannot be overridden through --query', async () => {
    expect(await run(['run', D, P, '--query', 'scriptId=other', '--confirmed'])).toBe(2);
    expect(state.runs).toBe(0);
  });

  test('no answer within the client timeout is reported, not hidden', async () => {
    state.timeout = true;
    expect(await run(['run', D, P, '--confirmed'])).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ timedOutLocally: true, ran: 'unknown' });
  });
});

describe('logs', () => {
  test('keeps only this script\'s lines and respects --limit', async () => {
    state.logs = [log('1', DEV_ID, 'a'), log('2', OTHER_ID, 'b'), log('3', DEV_ID, 'c'), log('4', DEV_ID, 'd')];
    expect(await run(['logs', D, P, '--limit', '2'])).toBe(0);
    expect(JSON.parse(out).logs.map((l) => l.message)).toEqual(['a', 'c']);
  });
});

describe('usage', () => {
  test('rejects a bad prefix or env before sending anything', async () => {
    expect(await run(['status', D, '../x'])).toBe(2);
    expect(await run(['status', D, P, '--env', 'staging'])).toBe(2);
    expect(calls).toHaveLength(0);
  });

  test('the API key never reaches the output', async () => {
    state.runResult = { output: { echoed: 'SECRET123' }, error: null, timeMs: 1 };
    expect(await run(['run', D, P, '--confirmed'])).toBe(0);
    expect(out).not.toContain('SECRET123');
  });
});
