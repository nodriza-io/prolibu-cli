/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const contract = require('../.claude/skills/prolibu-contracts/scripts/contract');

const D = 'dev99.example.com';
const KEY = 'SECRET123';
const CID = 'a'.repeat(24);
const DEAL = 'b'.repeat(24);
const S1 = 'c'.repeat(24);
const S2 = 'd'.repeat(24);
const STRANGER = 'e'.repeat(24);
const USER = 'f'.repeat(24);
const STAGE = '1'.repeat(24);
const FILE_URL = 'https://bucket.s3.us-east-1.amazonaws.com/doc.pdf?X-Amz-Signature=abc';
const PDF = Buffer.from('%PDF-1.4 fake');

let rootDir;
let outDir;
let out;
let err;
let calls;
let emails;
let state;

function respond(status, body) {
  return { status, text: async () => JSON.stringify(body), arrayBuffer: async () => new ArrayBuffer(0) };
}

function evidence(id, role, status, extra = {}) {
  return {
    _id: id, fullName: `Person ${id.slice(0, 1)}`, email: `${id.slice(0, 1)}@example.com`, role, status, ...extra,
  };
}

// A fake of the endpoints the script uses, shaped after the verified server behavior: a save
// that leaves the contract Ready e-mails every signer (or only the first one when they go one
// at a time), and resendEmail "single" e-mails the contact it is given.
async function fakeFetch(url, init) {
  const u = new URL(url);
  if (u.hostname !== D) {
    calls.push({ method: 'GET', path: 'FILE', host: u.hostname });
    if (state.fileStatus) return { status: state.fileStatus, arrayBuffer: async () => new ArrayBuffer(0) };
    const bytes = state.notPdf ? Buffer.from('<html>') : PDF;
    return { status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
  }
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body });
  const c = state.contract;
  if (init.method === 'GET' && u.pathname === `/v2/contract/${CID}`) {
    if (state.missing) return respond(404, { error: 'No encontrado' });
    if (u.searchParams.get('outputFormat') === 'signedUrl') {
      const file = (id) => ({ _id: id, fileName: 'x.pdf', url: FILE_URL, signedUrl: state.fileUrl || FILE_URL });
      return respond(200, {
        _id: CID, contractName: c.contractName, status: c.status, contractDocuments: c.contractDocuments.map(file), signedDocuments: c.signedDocuments.map(file),
      });
    }
    return respond(200, c);
  }
  if (init.method === 'GET' && u.pathname === '/v2/contact') {
    const ids = JSON.parse(u.searchParams.get('xquery'))._id.$in;
    return respond(200, { data: state.contacts.filter((x) => ids.includes(x._id)) });
  }
  if (init.method === 'GET' && u.pathname === `/v2/deal/${DEAL}`) return respond(200, { _id: DEAL, dealName: 'Acme', stage: STAGE });
  if (init.method === 'GET' && u.pathname.startsWith('/v2/stage/')) return respond(200, { stageName: u.pathname.endsWith(STAGE) ? 'Proposal' : 'Approved' });
  if (init.method === 'GET' && u.pathname === `/v2/user/${USER}`) return respond(200, { firstName: 'Ana', lastName: 'Owner' });
  if (init.method === 'GET' && u.pathname === '/v2/contract') return respond(200, { pagination: { count: 1 }, data: [{ ...c, _id: CID }] });
  if (init.method === 'PATCH' && u.pathname === `/v2/contract/${CID}`) {
    if (state.patchError) return respond(400, { error: `bad ${KEY}` });
    state.contract = { ...c, ...body, updatedAt: 'T2' };
    if (state.contract.status === 'Ready') {
      const to = c.options.sendEmailsInOrder ? c.signers.slice(0, 1) : c.signers;
      emails.push(...to.map((id) => state.contacts.find((x) => x._id === id).email));
    }
    return respond(200, state.contract);
  }
  const resend = u.pathname.match(/^\/v2\/contract\/resendEmail\/([a-f0-9]{24})\/([a-f0-9]{24})\/(single|all)$/);
  if (init.method === 'POST' && resend) {
    if (resend[3] === 'all') emails.push(...c.signers.map((id) => state.contacts.find((x) => x._id === id).email));
    else emails.push(state.contacts.find((x) => x._id === resend[2]).email);
    return respond(200, { success: true });
  }
  return respond(404, { error: `unexpected ${init.method} ${u.pathname}` });
}

const run = (argv) => contract.main(argv, {
  rootDir, fetchImpl: fakeFetch,
  stdout: { write: (s) => { out += s; } },
  stderr: { write: (s) => { err += s; } },
});
const json = () => JSON.parse(out);
const writes = () => calls.filter((c) => c.method !== 'GET');

async function preview(cmd, extra = []) {
  out = '';
  const code = await run([cmd, D, CID, ...extra]);
  const result = json();
  out = '';
  return { code, result };
}

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-contracts-root-'));
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-contracts-out-'));
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: KEY }));
  out = '';
  err = '';
  calls = [];
  emails = [];
  state = {
    contacts: [
      { _id: S1, firstName: 'Rita', lastName: 'Reviewer', email: 'rita@example.com' },
      { _id: S2, firstName: 'Sam', lastName: 'Signer', email: 'sam@example.com' },
      { _id: STRANGER, firstName: 'Out', lastName: 'Sider', email: 'out@example.com' },
    ],
    contract: {
      _id: CID,
      contractName: 'Acme - Contract',
      status: 'Draft',
      signers: [S1, S2],
      signerEvidences: {
        [S1]: evidence(S1, 'reviewer', 'Pending', { email: 'rita@example.com' }),
        [S2]: evidence(S2, 'signer', 'Pending', { email: 'sam@example.com' }),
      },
      options: { sendEmailsInOrder: true, deadlineDate: '2999-01-01T00:00:00.000Z', reject: { allow: true } },
      origin: { modelName: 'Deal', docId: DEAL },
      contractDocuments: ['9'.repeat(24)],
      signedDocuments: [],
      createdBy: USER,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: 'T1',
    },
  };
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
});

describe('send', () => {
  test('the preview names only the first person when they go one at a time, and writes nothing', async () => {
    const { code, result } = await preview('send-preview');
    expect(code).toBe(0);
    expect(result.recipients).toEqual(['rita@example.com']);
    expect(result.emailedLaterOneByOne.map((p) => p.email)).toEqual(['sam@example.com']);
    expect(result.dealEffect).toContain('"Approved"');
    expect(result.nextStep).toContain('STOP HERE');
    expect(result.warnings.join(' ')).toContain('Ana Owner');
    expect(writes()).toHaveLength(0);
  });

  test('everyone at once: every participant is a recipient', async () => {
    state.contract.options.sendEmailsInOrder = false;
    const { result } = await preview('send-preview');
    expect(result.recipients).toEqual(['rita@example.com', 'sam@example.com']);
  });

  test('sends only status Ready, with the exact recipients, and reads back', async () => {
    const { result } = await preview('send-preview');
    const code = await run(['send', D, CID, '--version', result.version, '--recipients', ' RITA@example.com ', '--confirmed', '--reaches-people']);
    expect(code).toBe(0);
    const patch = writes();
    expect(patch).toHaveLength(1);
    expect(patch[0]).toMatchObject({ method: 'PATCH', path: `/v2/contract/${CID}`, body: { status: 'Ready' } });
    expect(Object.keys(patch[0].body)).toEqual(['status']);
    expect(emails).toEqual(['rita@example.com']);
    expect(json()).toMatchObject({ sent: true, status: 'Ready' });
  });

  test('refuses without --reaches-people or --confirmed (nothing sent)', async () => {
    const { result } = await preview('send-preview');
    expect(await run(['send', D, CID, '--version', result.version, '--recipients', 'rita@example.com', '--confirmed'])).toBe(2);
    expect(await run(['send', D, CID, '--version', result.version, '--recipients', 'rita@example.com', '--reaches-people'])).toBe(2);
    expect(writes()).toHaveLength(0);
  });

  test('refuses recipients that differ from the computed ones, even a superset', async () => {
    const { result } = await preview('send-preview');
    expect(await run(['send', D, CID, '--version', result.version, '--recipients', 'rita@example.com,sam@example.com', '--confirmed', '--reaches-people'])).toBe(3);
    expect(await run(['send', D, CID, '--version', result.version, '--recipients', 'sam@example.com', '--confirmed', '--reaches-people'])).toBe(3);
    expect(writes()).toHaveLength(0);
    expect(emails).toHaveLength(0);
  });

  test('refuses a stale version (a contact e-mail changed after the preview)', async () => {
    const { result } = await preview('send-preview');
    state.contacts[0].email = 'new@example.com';
    expect(await run(['send', D, CID, '--version', result.version, '--recipients', 'new@example.com', '--confirmed', '--reaches-people'])).toBe(3);
    expect(writes()).toHaveLength(0);
  });

  test('the e-mail goes to the contact, not to the copy on the contract', async () => {
    state.contacts[0].email = 'current@example.com';
    const { result } = await preview('send-preview');
    expect(result.recipients).toEqual(['current@example.com']);
    expect(result.warnings.join(' ')).toContain('current@example.com');
  });

  test.each([
    ['an already sent contract', (c) => { c.status = 'Ready'; }, 'already sent'],
    ['a signed contract', (c) => { c.status = 'Signed'; }, 'cannot be sent'],
    ['a contract not generated from a deal', (c) => { delete c.origin; }, 'not generated from a deal'],
    ['no document', (c) => { c.contractDocuments = []; }, 'no document'],
    ['only reviewers', (c) => { c.signerEvidences[S2].role = 'reviewer'; }, 'reviewer'],
    ['an expired deadline', (c) => { c.options.deadlineDate = '2000-01-01T00:00:00.000Z'; }, 'has passed'],
    ['a participant without a role', (c) => { delete c.signerEvidences[S2]; }, 'no role'],
  ])('blocks %s', async (_name, mutate, text) => {
    mutate(state.contract);
    const { code, result } = await preview('send-preview');
    expect(code).toBe(3);
    expect(result.version).toBeNull();
    expect(result.blockers.join(' ')).toContain(text);
    expect(await run(['send', D, CID, '--version', 'x', '--recipients', 'rita@example.com', '--confirmed', '--reaches-people'])).toBe(3);
    expect(writes()).toHaveLength(0);
  });

  test('blocks a participant whose contact has no e-mail', async () => {
    state.contacts[1].email = '';
    const { code, result } = await preview('send-preview');
    expect(code).toBe(3);
    expect(result.blockers.join(' ')).toContain('no valid e-mail');
  });
});

describe('remind', () => {
  beforeEach(() => { state.contract.status = 'Ready'; });

  test('one at a time: only the person whose turn it is, by the platform order', async () => {
    state.contract.status = 'Pending';
    state.contract.signerEvidences[S1].status = 'Signed';
    const { code, result } = await preview('remind-preview');
    expect(code).toBe(0);
    expect(result.recipients).toEqual(['sam@example.com']);
  });

  test('everyone at once: all pending people, never the ones who signed', async () => {
    state.contract.status = 'Pending';
    state.contract.options.sendEmailsInOrder = false;
    state.contract.signerEvidences[S1].status = 'Signed';
    const { result } = await preview('remind-preview');
    expect(result.recipients).toEqual(['sam@example.com']);
  });

  test('sends resendEmail single per person, never all', async () => {
    state.contract.options.sendEmailsInOrder = false;
    const { result } = await preview('remind-preview');
    expect(result.recipients).toEqual(['rita@example.com', 'sam@example.com']);
    const code = await run(['remind', D, CID, '--version', result.version, '--recipients', 'sam@example.com,rita@example.com', '--confirmed', '--reaches-people']);
    expect(code).toBe(0);
    const posts = writes();
    expect(posts.map((p) => p.path)).toEqual([
      `/v2/contract/resendEmail/${CID}/${S1}/single`,
      `/v2/contract/resendEmail/${CID}/${S2}/single`,
    ]);
    expect(posts.some((p) => p.path.endsWith('/all'))).toBe(false);
    expect(emails).toEqual(['rita@example.com', 'sam@example.com']);
  });

  test.each([
    ['a signer who already signed', () => { state.contract.signerEvidences[S1].status = 'Signed'; }, S1, 'already signed'],
    ['a contact who is not a participant', () => {}, STRANGER, 'not a participant'],
    ['someone whose turn has not come', () => {}, S2, 'not'],
  ])('refuses %s', async (_name, mutate, signer, text) => {
    mutate();
    const { code, result } = await preview('remind-preview', ['--signer', signer]);
    expect(code).toBe(3);
    expect(result.blockers.join(' ')).toContain(text);
    expect(writes()).toHaveLength(0);
  });

  test.each([
    ['a Draft', (c) => { c.status = 'Draft'; }, 'send-preview'],
    ['a signed contract', (c) => { c.status = 'Signed'; }, 'nobody to remind'],
    ['an expired deadline', (c) => { c.options.deadlineDate = '2000-01-01T00:00:00.000Z'; }, 'has passed'],
  ])('blocks %s', async (_name, mutate, text) => {
    mutate(state.contract);
    const { code, result } = await preview('remind-preview');
    expect(code).toBe(3);
    expect(result.recipients).toEqual([]);
    expect(result.blockers.join(' ')).toContain(text);
  });

  test('refuses without --reaches-people and with other recipients', async () => {
    const { result } = await preview('remind-preview');
    expect(await run(['remind', D, CID, '--version', result.version, '--recipients', 'rita@example.com', '--confirmed'])).toBe(2);
    expect(await run(['remind', D, CID, '--version', result.version, '--recipients', 'out@example.com', '--confirmed', '--reaches-people'])).toBe(3);
    expect(writes()).toHaveLength(0);
  });
});

describe('withdraw', () => {
  test('Ready without signatures goes back to Draft with only the status', async () => {
    state.contract.status = 'Ready';
    const { result } = await preview('withdraw-preview');
    expect(result.version).toBe('T1');
    expect(await run(['withdraw', D, CID, '--version', 'T1', '--confirmed'])).toBe(0);
    expect(writes()).toEqual([expect.objectContaining({ method: 'PATCH', body: { status: 'Draft' } })]);
    expect(emails).toHaveLength(0);
    expect(json()).toMatchObject({ withdrawn: true, status: 'Draft' });
  });

  test.each([['Pending', 'already signed'], ['Signed', 'cannot be withdrawn'], ['Draft', 'already a Draft']])('blocks a %s contract', async (status, text) => {
    state.contract.status = status;
    const { code, result } = await preview('withdraw-preview');
    expect(code).toBe(3);
    expect(result.blockers.join(' ')).toContain(text);
    expect(await run(['withdraw', D, CID, '--version', 'T1', '--confirmed'])).toBe(3);
    expect(writes()).toHaveLength(0);
  });

  test('refuses a stale version and a missing --confirmed', async () => {
    state.contract.status = 'Ready';
    expect(await run(['withdraw', D, CID, '--version', 'T0', '--confirmed'])).toBe(3);
    expect(await run(['withdraw', D, CID, '--version', 'T1'])).toBe(2);
    expect(writes()).toHaveLength(0);
  });
});

describe('status and list', () => {
  beforeEach(() => {
    state.contract.status = 'Pending';
    state.contract.signerEvidences[S1] = evidence(S1, 'reviewer', 'Signed', {
      email: 'rita@example.com', updatedAt: '2026-01-02', ip: '203.0.113.9', location: { lat: 1, lng: 2 }, signatureImage: 'IMG', signatureHeaders: { ua: 'x' },
    });
  });

  test('shows the turn and the trail without personal evidence or links', async () => {
    expect(await run(['status', D, CID])).toBe(0);
    const r = json();
    expect(r.whoseTurn.email).toBe('sam@example.com');
    expect(r.auditTrail.map((e) => e.event)).toEqual(['created', 'reviewed by Person c']);
    expect(out).not.toMatch(/203\.0\.113\.9|IMG|signing-documents|amazonaws/);
  });

  test('--evidence adds IP and location but never the signature image or headers', async () => {
    await run(['status', D, CID, '--evidence']);
    expect(json().evidence[0]).toEqual({ name: 'Person c', ip: '203.0.113.9', location: { lat: 1, lng: 2 } });
    expect(out).not.toMatch(/IMG|"ua"/);
  });

  test('list excludes templates and escapes the search text', async () => {
    expect(await run(['list', D, 'a.b', '--status', 'ready'])).toBe(0);
    const q = JSON.parse(calls[0].query.xquery);
    expect(q).toEqual({ isContractTemplate: { $ne: true }, status: 'Ready', contractName: { $regex: '(?i)a\\.b' } });
    expect(json().contracts[0].signed).toBe('1/2');
  });

  test('a template id is refused', async () => {
    state.contract.isContractTemplate = true;
    expect(await run(['status', D, CID])).toBe(3);
  });
});

describe('download', () => {
  test('saves the signed PDF locally and prints no address', async () => {
    state.contract.status = 'Signed';
    state.contract.signedDocuments = ['8'.repeat(24)];
    expect(await run(['download', D, CID, '--out', outDir])).toBe(0);
    const r = json();
    expect(r.saved).toHaveLength(1);
    expect(fs.readFileSync(r.saved[0].file).subarray(0, 5).toString()).toBe('%PDF-');
    expect(path.basename(r.saved[0].file)).toBe('Acme_-_Contract-signed.pdf');
    expect(out).not.toContain('amazonaws');
  });

  test('without a signed document it asks for --original', async () => {
    expect(await run(['download', D, CID, '--out', outDir])).toBe(3);
    expect(err).toContain('--original');
    expect(await run(['download', D, CID, '--original', '--out', outDir])).toBe(0);
  });

  test('refuses an address outside the file store, a non-PDF and a folder inside the repo', async () => {
    state.fileUrl = 'https://evil.example.com/x.pdf';
    expect(await run(['download', D, CID, '--original', '--out', outDir])).toBe(1);
    expect(calls.filter((c) => c.host === 'evil.example.com')).toHaveLength(0);
    state.fileUrl = undefined;
    state.notPdf = true;
    expect(await run(['download', D, CID, '--original', '--out', outDir])).toBe(1);
    expect(fs.readdirSync(outDir)).toHaveLength(0);
    expect(await run(['download', D, CID, '--original', '--out', path.join(rootDir, 'pdfs')])).toBe(2);
  });
});

describe('guards', () => {
  test('the API key never reaches the output', async () => {
    state.contract.status = 'Ready';
    state.patchError = true;
    expect(await run(['withdraw', D, CID, '--version', 'T1', '--confirmed'])).toBe(1);
    expect(err).toContain('***');
    expect(err).not.toContain(KEY);
  });

  test('an unknown contract is blocked and a bad id is a usage error', async () => {
    state.missing = true;
    expect(await run(['status', D, CID])).toBe(3);
    expect(await run(['status', D, 'not-an-id'])).toBe(2);
    expect(calls.filter((c) => c.path === '/v2/contract/not-an-id')).toHaveLength(0);
  });

  test('sameRecipients compares sets case-insensitively', () => {
    expect(contract.sameRecipients(['B@example.com', 'a@example.com'], ['a@example.com', 'b@example.com'])).toBe(true);
    expect(contract.sameRecipients(['a@example.com'], ['a@example.com', 'b@example.com'])).toBe(false);
  });
});

describe('--profile and 403', () => {
  test('--profile reads profile.<name>.json, and a 403 stops at once with a clear message', async () => {
    const SELLER_KEY = 'seller-key-not-the-admin-one';
    fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.seller.json'), JSON.stringify({ apiKey: SELLER_KEY }));
    const seen = [];
    let stdout = '';
    let stderr = '';
    const code = await contract.main(['status', D, 'a'.repeat(24), '--profile', 'seller'], {
      rootDir,
      fetchImpl: async (url, init) => {
        seen.push({ path: new URL(url).pathname, auth: init.headers.Authorization });
        return { status: 403, text: async () => JSON.stringify({ statusCode: 403, error: 'Prohibido' }) };
      },
      stdout: { write: (s) => { stdout += s; } },
      stderr: { write: (s) => { stderr += s; } },
    });
    expect(code).toBe(1);
    expect(stderr).toMatch(/^FORBIDDEN: .*403: Prohibido/);
    expect(stderr).toContain('did not retry it or try another profile');
    expect(seen).toHaveLength(1);
    expect(seen[0].auth).toBe(`Bearer ${SELLER_KEY}`);
    expect(stdout + stderr).not.toContain(SELLER_KEY);
  });
});
