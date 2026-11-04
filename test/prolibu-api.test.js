/* global describe, test, expect, beforeEach, afterEach, jest */
const fs = require('fs');
const os = require('os');
const path = require('path');
const api = require('../.claude/skills/_shared/prolibu-api');

let rootDir;
let out;
let err;
let fetchImpl;

const io = () => ({
  fetchImpl, rootDir,
  stdout: { write: (s) => { out += s; } },
  stderr: { write: (s) => { err += s; } },
});
const exec = (argv) => api.run(argv, io());

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-api-'));
  const dir = path.join(rootDir, 'accounts', 'dev99.example.com');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ apiKey: 'SECRET123' }));
  out = '';
  err = '';
  fetchImpl = jest.fn(async () => ({
    status: 200,
    text: async () => '{"ok":true}',
  }));
});
afterEach(() => fs.rmSync(rootDir, { recursive: true, force: true }));

test('GET without --confirmed is sent', async () => {
  const code = await exec(['dev99.example.com', 'GET', '/v2/form?limit=1']);
  expect(code).toBe(0);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const [url, opts] = fetchImpl.mock.calls[0];
  expect(url).toBe('https://dev99.example.com/v2/form?limit=1');
  expect(opts.headers.Authorization).toBe('Bearer SECRET123');
  expect(JSON.parse(out).status).toBe(200);
});

test('POST without --confirmed is refused', async () => {
  const code = await exec(['dev99.example.com', 'POST', '/v2/form', '--data', '{"a":1}']);
  expect(code).toBe(2);
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(err).toContain('Refusing to write without --confirmed');
});

test('POST with --confirmed sends JSON body', async () => {
  const code = await exec(['dev99.example.com', 'POST', '/v2/form', '--data', '{"formName":"x"}', '--confirmed']);
  expect(code).toBe(0);
  const [, opts] = fetchImpl.mock.calls[0];
  expect(opts.body).toBe(JSON.stringify({ formName: 'x' }));
  expect(opts.headers['Content-Type']).toBe('application/json');
});

test('rejects host injection', async () => {
  for (const p of ['//evil.com/x', 'https://evil.com/v2/x', '/v2/../x', 'v2/form']) {
    expect(await exec(['dev99.example.com', 'GET', p])).toBe(2);
  }
  for (const d of ['evil.com/x', 'a@b.com', '']) {
    expect(await exec([d, 'GET', '/v2/form'])).toBe(2);
  }
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('rejects invalid JSON', async () => {
  const code = await exec(['dev99.example.com', 'POST', '/v2/form', '--data', '{bad', '--confirmed']);
  expect(code).toBe(2);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('missing profile', async () => {
  const code = await exec(['dev98.example.com', 'GET', '/v2/form']);
  expect(code).toBe(2);
  expect(err).toContain('No profile for dev98.example.com');
  expect(err).not.toContain('SECRET123');
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('redacts key echoed by server', async () => {
  fetchImpl = jest.fn(async () => ({
    status: 401,
    text: async () => '{"error":"bad token SECRET123"}',
  }));
  const code = await exec(['dev99.example.com', 'GET', '/v2/form']);
  expect(code).toBe(1);
  expect(out).toContain('***');
  expect(out).not.toContain('SECRET123');
});

test('production warning', async () => {
  const dir = path.join(rootDir, 'accounts', 'acme.example.com');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ apiKey: 'SECRET123' }));
  const code = await exec(['acme.example.com', 'POST', '/v2/form', '--data', '{}', '--confirmed']);
  expect(code).toBe(0);
  expect(err).toContain('WARNING: acme.example.com looks like a production account.');
  expect(api.isLikelyProduction('dev42.example.com')).toBe(false);
  expect(api.isLikelyProduction('stg.example.com')).toBe(false);
});

describe('hardening', () => {
  const D = 'dev99.example.com';

  test('--data-file refuses profile*.json basenames', async () => {
    const f = path.join(rootDir, 'profile.other.json');
    fs.writeFileSync(f, '{"apiKey":"OTHER"}');
    const g = path.join(rootDir, 'PROFILE.json');
    fs.writeFileSync(g, '{}');
    for (const file of [f, g]) {
      expect(await exec([D, 'POST', '/v2/form', '--data-file', file, '--confirmed'])).toBe(2);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(err).toContain('--data-file');
  });

  test('--data-file refuses anything under accounts/, including via ..', async () => {
    const inside = path.join(rootDir, 'accounts', D, 'notes.json');
    fs.writeFileSync(inside, '{}');
    const viaDots = path.join(rootDir, 'x', '..', 'accounts', D, 'notes.json');
    expect(await exec([D, 'POST', '/v2/form', '--data-file', inside, '--confirmed'])).toBe(2);
    expect(await exec([D, 'POST', '/v2/form', '--data-file', viaDots, '--confirmed'])).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('--data-file outside accounts/ still works', async () => {
    const f = path.join(rootDir, 'body.json');
    fs.writeFileSync(f, '{"a":1}');
    expect(await exec([D, 'POST', '/v2/form', '--data-file', f, '--confirmed'])).toBe(0);
    expect(fetchImpl.mock.calls[0][1].body).toBe('{"a":1}');
  });

  test('--data-file accepts /tmp, where the Claude Code scratchpad lives', async () => {
    if (process.platform === 'win32') return;
    const dir = fs.mkdtempSync('/tmp/prolibu-api-scratch-');
    const file = path.join(dir, 'body.json');
    fs.writeFileSync(file, '{"a":1}');
    try {
      expect(await exec(['dev99.example.com', 'POST', '/v2/form', '--data-file', file, '--confirmed'])).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--data-file refuses files outside temp folders', async () => {
    const repoFile = path.resolve(__dirname, '..', 'package.json');
    expect(await exec([D, 'POST', '/v2/form', '--data-file', repoFile, '--confirmed'])).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(err).toContain('must be in a temp folder');
  });

  test('--data-file follows symlinks out of temp folders', async () => {
    const link = path.join(rootDir, 'link.json');
    fs.symlinkSync(path.resolve(__dirname, '..', 'package.json'), link);
    expect(await exec([D, 'POST', '/v2/form', '--data-file', link, '--confirmed'])).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('redacts secret fields at any depth in the printed body only', async () => {
    fetchImpl = jest.fn(async () => ({
      status: 200,
      text: async () => JSON.stringify({
        apiKey: 'K1',
        data: [{ Token: 'T1', nested: { accessToken: 'A1', refreshToken: 'R1' } }],
        user: { password: 'P1', SECRET: 'S1', clientSecret: 'C1', name: 'kept' },
      }),
    }));
    const body = '{"token":"SENT"}';
    expect(await exec([D, 'POST', '/v2/form', '--data', body, '--confirmed'])).toBe(0);
    expect(fetchImpl.mock.calls[0][1].body).toBe(body);
    for (const v of ['K1', 'T1', 'A1', 'R1', 'P1', 'S1', 'C1']) expect(out).not.toContain(`"${v}"`);
    const printed = JSON.parse(out).body;
    expect(printed.data[0].nested.accessToken).toBe('***');
    expect(printed.user.name).toBe('kept');
  });

  test('masks header values, as webhooks store shared secrets there', () => {
    const body = { data: [{ endpoint: 'https://x.example.com', headers: [{ name: 'X-Secret', value: 's3cr3t' }] }] };
    expect(api.redactFields(body)).toEqual({ data: [{ endpoint: 'https://x.example.com', headers: [{ name: 'X-Secret', value: '***' }] }] });
  });

  test('does not redact unrelated keys such as tokenCount', () => {
    const value = { tokenCount: 5, tokens: ['a'], secretName: 'x', token: 'y' };
    expect(api.redactFields(value)).toEqual({ tokenCount: 5, tokens: ['a'], secretName: 'x', token: '***' });
  });

  test('redirects fail loudly', async () => {
    fetchImpl = jest.fn(async () => { throw new TypeError('fetch failed'); });
    expect(await exec([D, 'GET', '/v2/form'])).toBe(1);
    expect(fetchImpl.mock.calls[0][1].redirect).toBe('error');
    expect(err).toContain('Request failed');
  });

  test('requests carry a 30s timeout signal and report timeouts', async () => {
    const spy = jest.spyOn(AbortSignal, 'timeout');
    fetchImpl = jest.fn(async () => {
      const e = new Error('The operation was aborted due to timeout');
      e.name = 'TimeoutError';
      throw e;
    });
    expect(await exec([D, 'GET', '/v2/form'])).toBe(1);
    expect(spy).toHaveBeenCalledWith(30000);
    expect(fetchImpl.mock.calls[0][1].signal).toBeDefined();
    expect(err).toContain('timed out after 30 seconds');
    spy.mockRestore();
  });

  test('--data and --data-file are usage errors with GET and DELETE', async () => {
    const f = path.join(rootDir, 'body.json');
    fs.writeFileSync(f, '{}');
    expect(await exec([D, 'GET', '/v2/form', '--data', '{}'])).toBe(2);
    expect(await exec([D, 'GET', '/v2/form', '--data-file', f])).toBe(2);
    expect(await exec([D, 'DELETE', '/v2/form/1', '--data', '{}', '--confirmed'])).toBe(2);
    expect(await exec([D, 'delete', '/v2/form/1', '--data-file', f, '--confirmed'])).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('PATCH, PUT and DELETE are refused without --confirmed', async () => {
    for (const m of ['PATCH', 'PUT', 'DELETE']) {
      expect(await exec([D, m, '/v2/form/1'])).toBe(2);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('lowercase method is treated as a write', async () => {
    expect(await exec([D, 'post', '/v2/form', '--data', '{}'])).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await exec([D, 'post', '/v2/form', '--data', '{}', '--confirmed'])).toBe(0);
    expect(fetchImpl.mock.calls[0][1].method).toBe('POST');
  });

  test('redact covers URL-encoded and JSON-escaped keys', () => {
    const secret = 'a+b/c"d\\e';
    const text = [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)].join(' | ');
    const result = api.redact(text, secret);
    expect(result).toBe('*** | *** | ***');
  });

  test('no production warning for a confirmed POST to dev99', async () => {
    expect(await exec([D, 'POST', '/v2/form', '--data', '{}', '--confirmed'])).toBe(0);
    expect(err).not.toContain('WARNING');
  });
});

describe('--profile', () => {
  const D = 'dev99.example.com';
  const writeProfile = (name, key) => fs.writeFileSync(
    path.join(rootDir, 'accounts', D, name), JSON.stringify({ apiKey: key }),
  );

  test('--profile nonadmin reads profile.nonadmin.json', async () => {
    writeProfile('profile.nonadmin.json', 'NONADMIN456');
    expect(await exec([D, 'GET', '/v2/form', '--profile', 'nonadmin'])).toBe(0);
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer NONADMIN456');
  });

  test('default profile is unchanged', async () => {
    writeProfile('profile.nonadmin.json', 'NONADMIN456');
    expect(await exec([D, 'GET', '/v2/form'])).toBe(0);
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer SECRET123');
  });

  test('invalid profile names are usage errors', async () => {
    for (const name of ['../profile', 'Admin', 'a.b', 'x/y', '']) {
      expect(await exec([D, 'GET', '/v2/form', '--profile', name])).toBe(2);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('missing alternate profile names the file and does not fall back', async () => {
    expect(await exec([D, 'GET', '/v2/form', '--profile', 'nonadmin'])).toBe(2);
    expect(err).toContain('profile.nonadmin.json');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('query strings and non-mutating writes', () => {
  const D = 'dev99.example.com';

  test('encoded separators are allowed in the query, not in the path', async () => {
    expect(await exec([D, 'GET', '/v2/quote/productSearch?term=A%2FB'])).toBe(0);
    expect(await exec([D, 'GET', '/v2/quote%2F..%2Fuser'])).toBe(2);
    expect(await exec([D, 'GET', '/v2/quote/productSearch?term=a b'])).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('PUT /v2/quote/calculate runs without --confirmed and without a production warning', async () => {
    fs.mkdirSync(path.join(rootDir, 'accounts', 'acme.example.com'), { recursive: true });
    fs.writeFileSync(path.join(rootDir, 'accounts', 'acme.example.com', 'profile.json'), JSON.stringify({ apiKey: 'K' }));
    expect(await exec(['acme.example.com', 'PUT', '/v2/quote/calculate', '--data', '{"lineItems":[]}'])).toBe(0);
    expect(err).not.toContain('production');
  });

  test('other PUTs still need --confirmed', async () => {
    expect(await exec([D, 'PUT', '/v2/quote/abc', '--data', '{}'])).toBe(2);
    expect(await exec([D, 'PUT', '/v2/quote/calculateX', '--data', '{}'])).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('createClient', () => {
  const D = 'dev99.example.com';
  const client = () => api.createClient({ domain: D, rootDir, fetchImpl, stderr: { write: (s) => { err += s; } } });

  test('returns status, ok and the parsed body', async () => {
    const res = await client().request('GET', '/v2/deal/1');
    expect(res).toEqual({ status: 200, ok: true, body: { ok: true } });
  });

  test('refuses writes without confirmed and sends them with it', async () => {
    const c = client();
    await expect(c.request('PATCH', '/v2/deal/1', { data: {} })).rejects.toThrow('Refusing to write');
    expect(fetchImpl).not.toHaveBeenCalled();
    await c.request('PATCH', '/v2/deal/1', { data: { a: 1 }, confirmed: true });
    expect(fetchImpl.mock.calls[0][1].body).toBe('{"a":1}');
  });

  test('redact hides the key', () => {
    expect(client().redact('Bearer SECRET123')).toBe('Bearer ***');
  });

  test('a missing profile fails before any request', () => {
    expect(() => api.createClient({ domain: 'dev98.example.com', rootDir, fetchImpl })).toThrow('No profile');
  });
});

describe('requests that reach people', () => {
  const D = 'dev99.example.com';

  test('sending routes need --reaches-people on top of --confirmed', async () => {
    for (const [m, p] of [['POST', '/v2/email'], ['PUT', '/v2/email/send'], ['PUT', '/v2/emailcampaign/sendCampaign'],
      ['POST', '/v2/message/send'], ['POST', '/v2/message/retry'], ['POST', '/v2/notification/send']]) {
      expect(await exec([D, m, p, '--data', '{}', '--confirmed'])).toBe(2);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(err).toContain('--reaches-people');
    expect(await exec([D, 'PUT', '/v2/emailcampaign/sendCampaign', '--data', '{}', '--confirmed', '--reaches-people'])).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('reads and other writes are not affected', async () => {
    expect(await exec([D, 'GET', '/v2/email?limit=1'])).toBe(0);
    expect(await exec([D, 'POST', '/v2/emailcampaign', '--data', '{}', '--confirmed'])).toBe(0);
    expect(await exec([D, 'PATCH', '/v2/messagetemplate/abc', '--data', '{}', '--confirmed'])).toBe(0);
  });

  test('createClient enforces it too', async () => {
    const c = api.createClient({ domain: D, rootDir, fetchImpl, stderr: { write: () => {} } });
    await expect(c.request('PUT', '/v2/email/send', { data: {}, confirmed: true })).rejects.toThrow('reaches-people');
    await c.request('PUT', '/v2/email/send', { data: {}, confirmed: true, reachesPeople: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('authorizationHeader values are masked', () => {
    expect(api.redactFields({ authorizationHeader: 'Basic abc' })).toEqual({ authorizationHeader: '***' });
  });
});

describe('reachesPeopleRoute', () => {
  const R = api.reachesPeopleRoute;

  test('matching ignores letter case, like the server', () => {
    expect(R('PUT', '/v2/emailcampaign/sendcampaign')).toBe(true);
    expect(R('PUT', '/v2/EmailCampaign/SENDCAMPAIGN')).toBe(true);
    expect(R('POST', '/v2/Message/Send')).toBe(true);
    expect(R('POST', '/v2/EMAIL')).toBe(true);
  });

  test('message retry by id reaches people', () => {
    expect(R('POST', `/v2/message/${'a'.repeat(24)}/retry`)).toBe(true);
  });

  test('routes found in the second batch reach people', () => {
    const id = 'b'.repeat(24);
    for (const [m, p] of [
      ['POST', '/v2/aichat/resume'],
      ['POST', '/v2/calendar/scheduleEvent'],
      ['POST', '/v2/calendarevent/reschedule'],
      ['PATCH', '/v2/calendarevent/changestatus'],
      ['PATCH', '/v2/attendee/changeStatus'],
      ['POST', `/v2/contract/resendEmail/${id}/${id}/single`],
      ['POST', '/v2/contract/sendcode'],
      ['POST', '/v2/commercialexception'],
      ['PUT', '/v2/commercialexception/editRequest'],
      ['PUT', '/v2/commercialexception/cancel'],
      ['PATCH', `/v2/commercialexception/${id}`],
    ]) expect([m, p, R(m, p)]).toEqual([m, p, true]);
  });

  test('routes found in the third batch reach people', () => {
    for (const [m, p] of [
      ['POST', '/v2/scoring/recompute'],
      ['POST', '/v2/proposalwizard/generate'],
      ['POST', '/v2/ProposalWizard/pairSubmit'],
      ['PUT', '/v2/contactprotocol/enroll'],
      ['PUT', '/v2/notification/push'],
    ]) expect([m, p, R(m, p)]).toEqual([m, p, true]);
    expect(R('GET', '/v2/scoring/preview')).toBe(false);
    expect(R('PUT', '/v2/contactprotocol/pause')).toBe(false);
  });

  test('a contract write that sets status Ready reaches people', () => {
    const id = 'c'.repeat(24);
    expect(R('POST', '/v2/contract', { status: 'Ready' })).toBe(true);
    expect(R('PATCH', `/v2/contract/${id}`, { status: 'ready' })).toBe(true);
    expect(R('PATCH', `/v2/contract/${id}`, { status: 'Draft' })).toBe(false);
    expect(R('POST', '/v2/contract', { status: 'Draft' })).toBe(false);
  });

  test('a contract created without a status is born Ready, so it reaches people', () => {
    expect(R('POST', '/v2/contract', { contractName: 'x' })).toBe(true);
    expect(R('POST', '/v2/contract/', {})).toBe(true);
    expect(R('POST', '/v2/contract')).toBe(true);
    expect(R('PATCH', `/v2/contract/${'f'.repeat(24)}`, { contractName: 'x' })).toBe(false);
  });

  test('reads and unrelated writes do not', () => {
    expect(R('GET', '/v2/message/send')).toBe(false);
    expect(R('GET', '/v2/commercialexception')).toBe(false);
    expect(R('POST', '/v2/invoice/registerpayment')).toBe(false);
    expect(R('PATCH', `/v2/deal/${'d'.repeat(24)}`, { status: 'Ready' })).toBe(false);
  });

});

describe('the body rule on both entry points', () => {
  const D = 'dev99.example.com';
  const id = 'e'.repeat(24);

  test('the command line refuses a Ready contract without --reaches-people', async () => {
    expect(await exec([D, 'PATCH', `/v2/contract/${id}`, '--data', '{"status":"Ready"}', '--confirmed'])).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await exec([D, 'PATCH', `/v2/contract/${id}`, '--data', '{"status":"Draft"}', '--confirmed'])).toBe(0);
  });

  test('createClient refuses it too', async () => {
    const c = api.createClient({ domain: D, rootDir, fetchImpl, stderr: { write: () => {} } });
    await expect(c.request('POST', '/v2/contract', { data: { status: 'Ready' }, confirmed: true })).rejects.toThrow('reaches-people');
    await c.request('POST', '/v2/contract', { data: { status: 'Ready' }, confirmed: true, reachesPeople: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('blocked routes', () => {
  const B = api.blockedRoute;
  const D = 'dev99.example.com';

  test('routes that delete in bulk or change data on read are blocked for every method', () => {
    expect(B('DELETE', '/v2/log/clear')).toBe(true);
    expect(B('DELETE', '/v2/Log/Clear?x=1')).toBe(true);
    expect(B('DELETE', '/v2/notification/clean')).toBe(true);
    expect(B('GET', '/v2/eventsubscription/getMine')).toBe(true);
    expect(B('PUT', '/v2/eventsubscription/updatemine')).toBe(true);
    expect(B('GET', `/v2/email/view/${'a'.repeat(24)}`)).toBe(true);
    expect(B('GET', '/v2/email/click?u=x')).toBe(true);
    expect(B('POST', '/v2/email/unsubscribe')).toBe(true);
    expect(B('GET', '/v2/EMAIL/Consent/abc')).toBe(true);
  });

  test('audit log exports are blocked, the plain read is not', () => {
    expect(B('GET', '/v2/auditlog/getlogs?format=csv')).toBe(true);
    expect(B('GET', '/v2/auditlog/getLogs?limit=5&format=XLSX')).toBe(true);
    expect(B('GET', '/v2/auditlog/getlogs?limit=5')).toBe(false);
    expect(B('GET', '/v2/auditlog/getlogs?format=json')).toBe(false);
  });

  test('neighbour routes stay allowed', () => {
    expect(B('GET', '/v2/log')).toBe(false);
    expect(B('GET', '/v2/notification')).toBe(false);
    expect(B('GET', '/v2/eventsubscription')).toBe(false);
    expect(B('GET', '/v2/email')).toBe(false);
    expect(B('GET', `/v2/email/${'a'.repeat(24)}`)).toBe(false);
    expect(B('GET', '/v2/emailcampaign/view')).toBe(false);
  });

  test('the command line refuses them even with --confirmed, before any request', async () => {
    expect(await exec([D, 'DELETE', '/v2/log/clear', '--confirmed'])).toBe(2);
    expect(await exec([D, 'GET', '/v2/eventsubscription/getmine'])).toBe(2);
    expect(await exec([D, 'GET', '/v2/auditlog/getlogs?format=csv'])).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('createClient refuses them too, even with every flag', async () => {
    const c = api.createClient({ domain: D, rootDir, fetchImpl, stderr: { write: () => {} } });
    await expect(c.request('DELETE', '/v2/notification/clean', { confirmed: true, reachesPeople: true })).rejects.toThrow('blocked');
    await expect(c.request('GET', '/v2/email/click/x')).rejects.toThrow('blocked');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('blocked routes added by the fourth batch', () => {
  const B = api.blockedRoute;
  const id = 'f'.repeat(24);

  test('ad service callbacks, Meta test events and form discovery are blocked', () => {
    expect(B('PATCH', '/v2/adhub/connect/ADH-1700000000000-123')).toBe(true);
    expect(B('POST', '/v2/AdHub/connect/ADH-1/conversion/test')).toBe(true);
    expect(B('POST', '/v2/adhub/connect/ADH-1/forms/discover')).toBe(true);
    expect(B('GET', '/v2/adhub')).toBe(false);
  });

  test('public lead submission is blocked', () => {
    expect(B('POST', '/v2/contact/submit')).toBe(true);
    expect(B('POST', '/v2/contact')).toBe(false);
  });

  test('raw group moves and work orders built from a request body are blocked', () => {
    expect(B('POST', '/v2/group/move')).toBe(true);
    expect(B('POST', '/v2/workorder/createFromDeal')).toBe(true);
    expect(B('POST', `/v2/workorder/clone/${id}`)).toBe(true);
    expect(B('GET', '/v2/group')).toBe(false);
    expect(B('POST', '/v2/workorder')).toBe(false);
  });
});

describe('template view is blocked', () => {
  test('rendering a system template by name or path is blocked', () => {
    expect(api.blockedRoute('GET', '/v2/template/view/welcome')).toBe(true);
    expect(api.blockedRoute('GET', '/v2/Template/View/x')).toBe(true);
    expect(api.blockedRoute('GET', '/v2/template')).toBe(false);
    expect(api.blockedRoute('GET', '/v2/contenttemplate/view/x')).toBe(false);
  });
});

describe('script variables are masked', () => {
  test('variables[].value is hidden, names stay', () => {
    const body = { scriptCode: 'x', variables: [{ key: 'API_TOKEN', value: 'shh' }, { key: 'LIMIT', value: 5 }] };
    expect(api.redactFields(body)).toEqual({ scriptCode: 'x', variables: [{ key: 'API_TOKEN', value: '***' }, { key: 'LIMIT', value: '***' }] });
  });

  test('a variables field that is not a list is left alone', () => {
    expect(api.redactFields({ variables: 'none' })).toEqual({ variables: 'none' });
  });
});
