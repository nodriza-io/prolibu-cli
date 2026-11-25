/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const rec = require('../.claude/skills/prolibu-recruitment/scripts/recruitment');

const D = 'dev99.example.com';
const KEY = 'test-key-123456';
const SELLER_KEY = 'seller-key-987654';

// Fake record ids are built at run time. Factory stage ids follow the script's own rule
// (pipeline prefix + number), so the fake server knows them the same way the platform does.
const fid = (ch) => ch.repeat(24);
const RECRUITER = fid('a');
const PANEL = fid('b');
const NEWHIRE = fid('c');
const VAC = fid('d');
const CAND = fid('e');
const APP = fid('f');
const ASSET = fid('1');
const FORM = fid('2');
const PREFIX = {
  vacancy: 'a99c41069c71267e72fec00', application: 'a99c41069c71267e72fea00', candidate: 'a99c41069c71267e72fed00', asset: 'a55e41069c71267e72fb000',
};
const SHORT = {
  vacancy: ['draft', 'open', 'onhold', 'filled', 'closed'],
  application: ['applied', 'screening', 'interview', 'offer', 'hired', 'rejected'],
  candidate: ['prospect', 'active', 'talent-pool', 'hired', 'archived'],
  asset: ['inStock', 'reserved', 'assigned', 'inMaintenance', 'retired', 'lost', 'disposed'],
};
const S = (pipeline, short) => `${PREFIX[pipeline]}${SHORT[pipeline].indexOf(short) + 1}`;

let rootDir;
let calls;
let state;
let seq;
let formForbidden;
let hrPrefs;

const respond = (status, body) => ({ status, text: async () => JSON.stringify(body) });
const idOf = (v) => (v && typeof v === 'object' ? String(v._id) : v === null || v === undefined ? null : String(v));
const newId = () => `9${String(seq++).padStart(23, '0')}`;

function matches(record, xquery) {
  return Object.entries(xquery || {}).every(([k, v]) => {
    if (k === '$and') return v.every((q) => matches(record, q));
    if (k === '$or') return v.some((q) => matches(record, q));
    const field = record[k];
    if (v && typeof v === 'object' && v.$in) return [].concat(field ?? []).some((f) => v.$in.map(String).includes(idOf(f)));
    if (v && typeof v === 'object' && v.$regex) {
      const m = /^\(\?i\)(.*)$/.exec(v.$regex);
      return new RegExp(m ? m[1] : v.$regex, m ? 'i' : '').test(field || '');
    }
    if (Array.isArray(field)) return field.map(idOf).includes(String(v));
    return idOf(field) === String(v) || field === v;
  });
}

const POP = { candidate: 'candidate', vacancy: 'vacancy', assignee: 'user', assignedTo: 'user', asset: 'asset', organizer: 'user', jobApplication: 'jobapplication', user: 'user' };
function populated(r, pop) {
  if (!pop) return r;
  const out = { ...r };
  for (const [field, object] of Object.entries(POP)) {
    if (pop.includes(`"${field}"`) && r[field] && typeof r[field] === 'string') out[field] = state[object].find((x) => x._id === r[field]) || null;
  }
  if (pop.includes('"interviewers"')) out.interviewers = (r.interviewers || []).map((id) => state.user.find((u) => u._id === id));
  return out;
}

// Mirrors Vacancy.syncOpenings: hired applications fill openings and auto-fill the vacancy.
function syncOpenings(vacancyId) {
  const v = state.vacancy.find((x) => x._id === vacancyId);
  if (!v) return;
  v.hiredCount = state.jobapplication.filter((a) => a.vacancy === vacancyId && a.stage === S('application', 'hired')).length;
  if (v.hiredCount >= (v.openings || 1)) v.stage = S('vacancy', 'filled');
}

function fakeFetch(url, init) {
  const u = new URL(url);
  const method = init.method;
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method, path: u.pathname, query: Object.fromEntries(u.searchParams), body });
  if (init.headers.Authorization === `Bearer ${SELLER_KEY}`) return respond(403, { statusCode: 403, error: 'Forbidden. User has no permission.' });
  const parts = u.pathname.split('/').filter(Boolean); // v2, object, id|action, id
  const [, object, a, b] = parts;
  if (object === 'user' && a === 'preferences') return respond(200, { modules: { hr: hrPrefs } });
  if (object === 'user' && a) {
    const user = state.user.find((x) => x.email === decodeURIComponent(a));
    return user ? respond(200, user) : respond(404, { statusCode: 404, error: 'Not found' });
  }
  if (object === 'stage' && a === 'search') {
    const xq = JSON.parse(u.searchParams.get('xquery'));
    return respond(200, { data: state.stage.filter((s) => matches(s, xq)) });
  }
  if (object === 'vacancy' && a === 'publish') {
    const v = state.vacancy.find((x) => x._id === b);
    v.stage = S('vacancy', 'open');
    if (!v.applicationForm) {
      state.form.push({ _id: FORM, formName: 'Apply', active: true, access: { mode: 'public', enableCaptcha: true } });
      v.applicationForm = FORM;
    }
    return respond(200, v);
  }
  if (object === 'form' && method === 'PATCH' && formForbidden) return respond(403, { statusCode: 403, error: 'Forbidden' });
  const rows = state[object];
  if (!rows) return respond(404, { error: 'not found' });
  if (method === 'GET') {
    if (a) {
      const r = rows.find((x) => x._id === a);
      if (!r) return respond(404, { error: 'not found' });
      // Like the live server, a select on a single record returns only those fields (plus _id).
      const sel = u.searchParams.get('select');
      const picked = sel ? Object.fromEntries(Object.entries(r).filter(([k]) => k === '_id' || sel.split(' ').includes(k))) : r;
      return respond(200, populated(picked, u.searchParams.get('populatePath')));
    }
    const xq = u.searchParams.get('xquery') ? JSON.parse(u.searchParams.get('xquery')) : {};
    const data = rows.filter((r) => matches(r, xq)).map((r) => populated(r, u.searchParams.get('populatePath')));
    return respond(200, { pagination: { count: data.length }, data });
  }
  if (method === 'POST') {
    const r = { _id: newId(), updatedAt: `t${seq}`, ...body };
    if (object === 'vacancy') Object.assign(r, { vacancyCode: `VAC-${seq}`, stage: S('vacancy', 'draft') });
    if (object === 'interview') {
      r.interviewCode = `INT-${seq}`;
      r.status = 'scheduled';
      const app = state.jobapplication.find((x) => x._id === body.jobApplication);
      app.interviews = [...(app.interviews || []), r._id];
    }
    if (object === 'employee') r.employeeCode = `EMP-${seq}`;
    if (object === 'assetassignment') {
      const asset = state.asset.find((x) => x._id === body.asset);
      if (state.assetassignment.some((x) => x.asset === body.asset && ['Assigned', 'Overdue'].includes(x.status))) return respond(400, { error: 'This asset is already assigned.' });
      Object.assign(r, { assignmentCode: `ASG-${seq}`, status: 'Assigned' });
      Object.assign(asset, { stage: S('asset', 'assigned'), assignedTo: body.assignedTo, currentAssignment: r._id });
    }
    rows.push(r);
    return respond(201, r);
  }
  if (method === 'PATCH') {
    const r = rows.find((x) => x._id === a);
    Object.assign(r, body, { updatedAt: `t${seq++}` });
    if (object === 'jobapplication' && body.stage) {
      if (body.stage === S('application', 'hired')) r.hiredAt = '2026-11-24T10:00:00Z';
      syncOpenings(r.vacancy);
    }
    if (object === 'assetassignment' && ['Returned', 'Lost'].includes(body.status)) {
      const asset = state.asset.find((x) => x._id === r.asset);
      Object.assign(asset, { stage: S('asset', body.status === 'Lost' ? 'lost' : 'inStock'), assignedTo: null, currentAssignment: null });
      r.returnedAt = '2026-11-24T10:00:00Z';
    }
    return respond(200, r);
  }
  return respond(405, { error: 'no' });
}

function seed() {
  const stage = [];
  for (const [pipeline, shorts] of Object.entries(SHORT)) {
    shorts.forEach((short) => stage.push({
      _id: S(pipeline, short), stageName: short, requiredFields: pipeline === 'application' && short === 'rejected' ? ['rejection.reason'] : [],
    }));
  }
  state = {
    stage,
    user: [
      { _id: RECRUITER, email: 'recruiter@example.com', firstName: 'Rita', lastName: 'Recruiter' },
      { _id: PANEL, email: 'panel@example.com', firstName: 'Pablo', lastName: 'Panel' },
      { _id: NEWHIRE, email: 'ana@example.com', firstName: 'Ana', lastName: 'Gomez' },
    ],
    vacancy: [{
      _id: VAC, title: 'Sales advisor', vacancyCode: 'VAC-1', location: 'Bogota', stage: S('vacancy', 'draft'), openings: 1, hiredCount: 0, assignee: RECRUITER, updatedAt: 'v1',
    }],
    form: [],
    candidate: [{
      _id: CAND, candidateCode: 'CAN-1', firstName: 'Ana', lastName: 'Gomez', email: 'ana@example.com', stage: S('candidate', 'active'), resume: fid('7'), salaryExpectation: { min: 5000000 }, updatedAt: 'c1',
    }],
    jobapplication: [{
      _id: APP, jobApplicationCode: 'APP-1', candidate: CAND, email: 'ana@example.com', vacancy: VAC, stage: S('application', 'applied'), coverLetter: 'secret letter', resume: fid('7'), updatedAt: 'a1',
    }],
    interview: [],
    employee: [],
    asset: [{
      _id: ASSET, assetCode: 'AST-1', assetName: 'Laptop 14', serialNumber: 'SN-1', stage: S('asset', 'inStock'), updatedAt: 's1',
    }],
    assetassignment: [],
  };
}

async function run(args, { profile } = {}) {
  let out = '';
  let err = '';
  const code = await rec.main([...args, ...(profile ? ['--profile', profile] : [])], {
    rootDir, fetchImpl: async (u, i) => fakeFetch(u, i), stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } },
  });
  let json = null;
  try { json = JSON.parse(out); } catch { /* not JSON */ }
  return { code, out, err, json };
}

const writes = () => calls.filter((c) => c.method !== 'GET');

async function previewApply(plan, extra = []) {
  const before = writes().length;
  const p = await run(['preview', D, JSON.stringify(plan)]);
  expect(p.code).toBe(0);
  expect(writes()).toHaveLength(before);
  expect(p.json.nextStep).toMatch(/STOP HERE/);
  const r = await run(['apply', D, JSON.stringify(plan), '--version', p.json.version, '--confirmed', ...extra]);
  return { p, r };
}

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recruitment-'));
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: KEY }));
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.seller.json'), JSON.stringify({ apiKey: SELLER_KEY }));
  calls = [];
  seq = 1;
  formForbidden = false;
  hrPrefs = { applications: { notifyCandidateOnStageChange: false, sendAcknowledgementEmail: true }, assets: {} };
  seed();
});

afterEach(() => fs.rmSync(rootDir, { recursive: true, force: true }));

describe('pure helpers', () => {
  test('htmlProblem refuses HTML on the public page and scripts', () => {
    expect(rec.htmlProblem('Plain text role summary')).toBeNull();
    expect(rec.htmlProblem('<p>Hi</p>')).toMatch(/literal text/);
    expect(rec.htmlProblem('<img src=x onerror=alert(1)>')).toMatch(/scripts|handlers/);
  });
  test('stageShort maps loose names and refuses unknown stages', () => {
    expect(rec.stageShort('vacancy', 'On Hold')).toBe('onhold');
    expect(rec.stageShort('candidate', 'talent pool')).toBe('talent-pool');
    expect(() => rec.stageShort('application', 'nope')).toThrow(/Unknown/);
  });
  test('requiredMissing counts what the move sends or the record already has', () => {
    const st = { requiredFields: ['rejection.reason'] };
    expect(rec.requiredMissing(st, { stage: 'x' }, {})).toEqual(['rejection.reason']);
    expect(rec.requiredMissing(st, { rejection: { reason: 'other' } }, {})).toEqual([]);
    expect(rec.requiredMissing(st, {}, { rejection: { reason: 'other' } })).toEqual([]);
  });
});

describe('reads keep personal data out', () => {
  test('pipeline lists names and stages, no e-mail, CV or letter unless asked', async () => {
    const r = await run(['pipeline', D, 'Sales advisor']);
    expect(r.code).toBe(0);
    expect(r.json.applications[0]).toMatchObject({ candidate: 'Ana Gomez', stage: 'applied' });
    expect(r.out).not.toMatch(/ana@example\.com|secret letter|7{24}/);
    const c = await run(['pipeline', D, 'VAC-1', '--with-contact']);
    expect(c.json.applications[0].email).toBe('ana@example.com');
  });
  test('candidate shows hasCv and no salary unless --with-salary', async () => {
    const r = await run(['candidate', D, 'Ana Gomez']);
    expect(r.json.candidate.hasCv).toBe(true);
    expect(r.out).not.toMatch(/5000000|7{24}/);
    const s = await run(['candidate', D, 'ana@example.com', '--with-salary']);
    expect(s.out).toMatch(/5000000/);
  });
  test('a 403 stops with FORBIDDEN after one request', async () => {
    const r = await run(['vacancy', D, 'VAC-1'], { profile: 'seller' });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/FORBIDDEN/);
    expect(calls).toHaveLength(1);
  });
  test('an object as a reference is refused before any request', async () => {
    const r = await run(['preview', D, JSON.stringify({ kind: 'publish', vacancy: { $ne: null } })]);
    expect(r.code).toBe(2);
    expect(calls.filter((c) => c.path !== '/v2/stage/search')).toHaveLength(0);
  });
});

describe('write guards', () => {
  const plan = { kind: 'publish', vacancy: 'VAC-1' };
  test('apply needs --version and --confirmed; nothing is sent without them', async () => {
    expect((await run(['apply', D, JSON.stringify(plan), '--confirmed'])).code).toBe(2);
    expect((await run(['apply', D, JSON.stringify(plan), '--version', 'x'])).code).toBe(2);
    expect(calls).toHaveLength(0);
  });
  test('a changed record blocks the apply', async () => {
    const p = await run(['preview', D, JSON.stringify(plan)]);
    state.vacancy[0].updatedAt = 'v2';
    const r = await run(['apply', D, JSON.stringify(plan), '--version', p.json.version, '--confirmed']);
    expect(r.code).toBe(3);
    expect(writes()).toHaveLength(0);
  });
});

describe('vacancies', () => {
  test('create refuses HTML in the description and duplicates', async () => {
    const html = await run(['preview', D, JSON.stringify({ kind: 'vacancy', set: { title: 'Data analyst', description: '<p>x</p>' } })]);
    expect(html.code).toBe(3);
    const dup = await run(['preview', D, JSON.stringify({ kind: 'vacancy', set: { title: 'Sales advisor', location: 'Bogota' } })]);
    expect(dup.code).toBe(3);
    expect(dup.json.blockers.join(' ')).toMatch(/already exists/);
  });
  test('create saves a Draft with the owner resolved by e-mail', async () => {
    const { r } = await previewApply({ kind: 'vacancy', set: { title: 'Data analyst', location: 'Medellin', assignee: 'recruiter@example.com', openings: 2 } });
    expect(r.code).toBe(0);
    const v = state.vacancy.find((x) => x.title === 'Data analyst');
    expect(v).toMatchObject({ assignee: RECRUITER, stage: S('vacancy', 'draft'), openings: 2 });
  });
  test('create reads back the long texts it sent (they are outside the summary select)', async () => {
    const { r } = await previewApply({ kind: 'vacancy', set: { title: 'Support lead', location: 'Cali', description: 'Plain text only' } });
    expect(r.code).toBe(0);
    expect(r.json.problems).toEqual([]);
  });
  test('publish edits the stage through the record route first, then creates the form', async () => {
    const { p, r } = await previewApply({ kind: 'publish', vacancy: 'VAC-1' });
    expect(p.json.effects.join(' ')).toMatch(/without signing in/);
    expect(r.code).toBe(0);
    const w = writes().map((c) => `${c.method} ${c.path}`);
    expect(w).toEqual([`PATCH /v2/vacancy/${VAC}`, `POST /v2/vacancy/publish/${VAC}`]);
    expect(r.json.publicPage).toBe(`https://${D}/v2/vacancy/view/VAC-1`);
    expect(r.json.form.active).toBe(true);
  });
  test('close turns the form off; a 403 on the form is reported, not hidden', async () => {
    state.vacancy[0].stage = S('vacancy', 'open');
    state.vacancy[0].applicationForm = FORM;
    state.form.push({ _id: FORM, active: true, access: { enableCaptcha: true } });
    const ok = await previewApply({ kind: 'close', vacancy: 'VAC-1' });
    expect(ok.r.code).toBe(0);
    expect(state.form[0].active).toBe(false);

    state.form[0].active = true;
    state.vacancy[0].stage = S('vacancy', 'open');
    formForbidden = true;
    calls = [];
    const no = await previewApply({ kind: 'close', vacancy: 'VAC-1' });
    expect(no.r.code).toBe(1);
    expect(no.r.json.problems.join(' ')).toMatch(/still accepts applications/);
  });
});

describe('applications', () => {
  test('rejecting needs a reason and --reaches-people for the e-mail', async () => {
    const noReason = await run(['preview', D, JSON.stringify({ kind: 'move', application: 'APP-1', stage: 'rejected' })]);
    expect(noReason.code).toBe(2);
    const plan = { kind: 'move', application: 'APP-1', stage: 'rejected', rejection: { reason: 'experience_mismatch' } };
    const p = await run(['preview', D, JSON.stringify(plan)]);
    expect(p.json.recipients).toEqual([{ to: 'ana@example.com', what: 'rejection e-mail' }]);
    const without = await run(['apply', D, JSON.stringify(plan), '--version', p.json.version, '--confirmed']);
    expect(without.code).toBe(2);
    expect(writes()).toHaveLength(0);
    const ok = await run(['apply', D, JSON.stringify(plan), '--version', p.json.version, '--confirmed', '--reaches-people']);
    expect(ok.code).toBe(0);
    expect(state.jobapplication[0]).toMatchObject({ stage: S('application', 'rejected'), rejection: { reason: 'experience_mismatch' } });
  });
  test('other moves reach nobody while the account does not notify candidates', async () => {
    const { p, r } = await previewApply({ kind: 'move', application: { candidate: 'ana@example.com', vacancy: 'VAC-1' }, stage: 'screening' });
    expect(p.json.recipients).toEqual([]);
    expect(r.code).toBe(0);
    hrPrefs.applications.notifyCandidateOnStageChange = true;
    const again = await run(['preview', D, JSON.stringify({ kind: 'move', application: 'APP-1', stage: 'offer' })]);
    expect(again.json.recipients).toHaveLength(1);
  });
  test('interview needs an offset in the time and links to the application', async () => {
    const bad = await run(['preview', D, JSON.stringify({ kind: 'interview', application: 'APP-1', startDate: '2030-01-03T15:00', endDate: '2030-01-03T16:00' })]);
    expect(bad.code).toBe(2);
    const { p, r } = await previewApply({
      kind: 'interview', application: 'APP-1', startDate: '2030-01-03T15:00:00-05:00', endDate: '2030-01-03T16:00:00-05:00', interviewers: ['panel@example.com'], meetingUrl: 'https://meet.example.com/x',
    });
    expect(p.json.effects.join(' ')).toMatch(/no calendar invitation/);
    expect(r.code).toBe(0);
    expect(state.interview[0]).toMatchObject({ jobApplication: APP, vacancy: VAC, interviewers: [PANEL] });
  });
  test('hire moves application and candidate, fills the vacancy, and never creates users', async () => {
    const missing = await run(['preview', D, JSON.stringify({ kind: 'hire', application: 'APP-1', employee: { user: 'nobody@example.com' } })]);
    expect(missing.code).toBe(3);
    expect(missing.json.blockers.join(' ')).toMatch(/never creates users/);
    const { p, r } = await previewApply({ kind: 'hire', application: 'APP-1', employee: { user: 'ana@example.com', hireDate: '2026-12-01', employmentType: 'Full-time' } });
    expect(p.json.effects.join(' ')).toMatch(/Filled/);
    expect(r.code).toBe(0);
    expect(state.jobapplication[0].stage).toBe(S('application', 'hired'));
    expect(state.candidate[0].stage).toBe(S('candidate', 'hired'));
    expect(state.vacancy[0].stage).toBe(S('vacancy', 'filled'));
    expect(state.employee[0]).toMatchObject({ user: NEWHIRE, status: 'Active', hireDate: '2026-12-01' });
    expect(writes().some((c) => c.path.startsWith('/v2/user'))).toBe(false);
  });
});

describe('assets', () => {
  test('assign is blocked while someone holds the asset, then works after the return', async () => {
    const first = await previewApply({ kind: 'assign', asset: 'SN-1', to: 'ana@example.com', conditionOut: 'Good' });
    expect(first.r.code).toBe(0);
    expect(state.asset[0]).toMatchObject({ assignedTo: NEWHIRE, stage: S('asset', 'assigned') });
    const again = await run(['preview', D, JSON.stringify({ kind: 'assign', asset: 'AST-1', to: 'panel@example.com' })]);
    expect(again.code).toBe(3);
    const h = await run(['holdings', D, 'ana@example.com']);
    expect(h.json.holding[0].asset).toMatch(/Laptop 14/);
    const back = await previewApply({ kind: 'return', asset: 'Laptop 14', conditionIn: 'Fair', from: 'ana@example.com' });
    expect(back.r.code).toBe(0);
    expect(state.asset[0]).toMatchObject({ assignedTo: null, stage: S('asset', 'inStock') });
    expect(state.assetassignment[0]).toMatchObject({ status: 'Returned', conditionIn: 'Fair' });
  });
  test('return refuses a holder who does not hold it, and a retired asset cannot be assigned', async () => {
    await previewApply({ kind: 'assign', asset: 'AST-1', to: 'ana@example.com' });
    const wrong = await run(['preview', D, JSON.stringify({ kind: 'return', asset: 'AST-1', from: 'panel@example.com' })]);
    expect(wrong.code).toBe(3);
    state.asset[0].stage = S('asset', 'retired');
    state.assetassignment[0].status = 'Returned';
    const retired = await run(['preview', D, JSON.stringify({ kind: 'assign', asset: 'AST-1', to: 'panel@example.com' })]);
    expect(retired.code).toBe(3);
  });
});
