/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const academy = require('../.claude/skills/prolibu-academy/scripts/academy');

const D = 'dev99.example.com';
const KEY = 'test-key-123456';
const SELLER_KEY = 'seller-key-987654';
const ADMIN = 'a'.repeat(24);
const STUDENT = 'b'.repeat(24);
const OUTSIDER = 'c'.repeat(24);
const TEAM = 'd'.repeat(24);
const PROGRAM = 'e'.repeat(24);
const COURSE = 'f'.repeat(24);
const MODULE = '1'.repeat(24);
const L1 = '2'.repeat(24);
const L2 = '3'.repeat(24);
const QUIZ = '4'.repeat(24);
const BADGE = '5'.repeat(24);

let rootDir;
let calls;
let state;
let seq;
let forbid;

const respond = (status, body) => ({ status, text: async () => JSON.stringify(body) });
const idOf = (v) => (v && typeof v === 'object' ? String(v._id) : v === null || v === undefined ? null : String(v));
const newId = () => `9${String(seq++).padStart(23, '0')}`;

function matches(record, xquery) {
  return Object.entries(xquery || {}).every(([k, v]) => {
    const field = record[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && v.$in) return [].concat(field ?? []).some((f) => v.$in.map(String).includes(idOf(f)));
    if (Array.isArray(field)) return field.map(idOf).includes(String(v));
    return idOf(field) === String(v) || field === v;
  });
}

function populated(object, rec, populatePath) {
  if (!populatePath) return rec;
  const out = { ...rec };
  if (object === 'course') {
    out.modules = (rec.modules || []).map((id) => {
      const m = state.module.find((x) => x._id === id);
      return m && { ...m, lessons: (m.lessons || []).map((l) => state.lesson.find((x) => x._id === l)).filter(Boolean) };
    }).filter(Boolean);
  }
  if (object === 'enrollment' || object === 'certificate') out.assignee = state.user.find((u) => u._id === rec.assignee) || null;
  if (object === 'certificate') {
    const e = state.enrollment.find((x) => x._id === rec.enrollment);
    out.enrollment = e ? { ...e, course: state.course.find((c) => c._id === e.course) } : null;
  }
  return out;
}

// Mirrors LessonProgress.recalculateEnrollmentProgress and Enrollment.issueCertificate.
function recalc(enrollmentId) {
  const e = state.enrollment.find((x) => x._id === enrollmentId);
  const c = state.course.find((x) => x._id === e.course);
  const lessonIds = (c.modules || []).flatMap((m) => (state.module.find((x) => x._id === m) || {}).lessons || []);
  const required = lessonIds.filter((id) => (state.lesson.find((l) => l._id === id) || {}).required !== false);
  const done = state.lessonprogress.filter((p) => p.enrollment === enrollmentId && p.status === 'Completed' && required.includes(p.lesson)).length;
  e.progressPercent = Math.round((done / required.length) * 100);
  if (e.progressPercent >= 100) complete(e);
}

function complete(e) {
  e.status = 'Completed';
  const c = state.course.find((x) => x._id === e.course);
  if (c.certificate && c.certificate.enabled && !state.certificate.some((x) => x.enrollment === e._id)) {
    state.certificate.push({ _id: newId(), certificateCode: `ACR-${seq}`, type: 'Course', enrollment: e._id, assignee: e.assignee, pdfFile: c.certificate.template ? newId() : undefined });
  }
}

function fakeFetch(url, init) {
  const u = new URL(url);
  const method = init.method;
  const body = init.body ? JSON.parse(init.body) : undefined;
  const auth = init.headers.Authorization;
  calls.push({ method, path: u.pathname, query: Object.fromEntries(u.searchParams), body });
  if (auth === `Bearer ${SELLER_KEY}` || forbid) return respond(403, { error: 'Forbidden. User has no permission.' });
  const [, , object, id] = u.pathname.split('/');
  if (object === 'lessonprogress' && id === 'trackProgress') {
    let p = state.lessonprogress.find((x) => x.enrollment === body.enrollment && x.lesson === body.lesson);
    if (!p) state.lessonprogress.push(p = { _id: newId(), ...body });
    else Object.assign(p, body);
    recalc(body.enrollment);
    return respond(200, p);
  }
  const rows = state[object];
  if (!rows) return respond(404, { error: 'not found' });
  if (method === 'GET') {
    const xquery = u.searchParams.get('xquery') ? JSON.parse(u.searchParams.get('xquery')) : {};
    const pop = u.searchParams.get('populatePath');
    return respond(200, { data: rows.filter((r) => matches(r, xquery)).map((r) => populated(object, r, pop)) });
  }
  if (method === 'POST') {
    const rec = { _id: newId(), updatedAt: `t${seq}`, ...body };
    if (object === 'enrollment') Object.assign(rec, { status: 'InProgress', progressPercent: 0, enrollmentCode: `ACE-${seq}` });
    if (body.origin) {
      const parent = state[body.origin.modelName.toLowerCase()].find((x) => x._id === body.origin.docId);
      const key = `${object}s`;
      parent[key] = [rec._id, ...(parent[key] || [])];
      delete rec.origin;
    }
    rows.push(rec);
    return respond(201, rec);
  }
  if (method === 'PATCH') {
    const rec = rows.find((r) => r._id === id);
    Object.assign(rec, body, { updatedAt: `t${seq++}` });
    if (object === 'enrollment' && body.status === 'Completed') complete(rec);
    return respond(200, rec);
  }
  return respond(405, { error: 'no' });
}

function seed() {
  state = {
    user: [
      { _id: ADMIN, email: 'admin@example.com', firstName: 'Ada', isAdmin: true },
      { _id: STUDENT, email: 'student@example.com', firstName: 'Sam', isAdmin: false },
      { _id: OUTSIDER, email: 'outsider@example.com', firstName: 'Out', isAdmin: false },
    ],
    team: [{ _id: TEAM, teamName: 'Sales', users: [STUDENT] }],
    program: [{
      _id: PROGRAM, programName: 'Sales program', programCode: 'ACP-1', status: 'Published', active: true, courses: [COURSE], requiredCourses: [COURSE], allowEveryone: { view: false }, teams: [TEAM], certificate: { enabled: true }, updatedAt: 'p1',
    }],
    course: [{
      _id: COURSE, courseName: 'Onboarding', courseCode: 'ACC-1', status: 'Published', active: true, modules: [MODULE], certificate: { enabled: true, template: '<p>[[userName]]</p>' }, updatedAt: 'c1',
    }],
    module: [{ _id: MODULE, moduleName: 'Intro', order: 0, lessons: [L2, L1] }],
    lesson: [
      { _id: L1, lessonName: 'Welcome', type: 'Article', order: 0, required: true, completionRule: 'View' },
      { _id: L2, lessonName: 'Role play', type: 'Article', order: 1, required: true, completionRule: 'Manual' },
    ],
    assessment: [{ _id: QUIZ, assessmentName: 'Final quiz', assessmentCode: 'ACA-1', status: 'Published' }],
    enrollment: [],
    lessonprogress: [],
    certificate: [],
  };
}

async function run(args, { profile } = {}) {
  let out = '';
  let err = '';
  const code = await academy.main([...args, ...(profile ? ['--profile', profile] : [])], {
    rootDir, fetchImpl: async (u, i) => fakeFetch(u, i), stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } },
  });
  let json = null;
  try { json = JSON.parse(out); } catch { /* not JSON */ }
  return { code, out, err, json };
}

const writes = () => calls.filter((c) => c.method !== 'GET');

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'academy-'));
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: KEY }));
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.seller.json'), JSON.stringify({ apiKey: SELLER_KEY }));
  calls = [];
  seq = 1;
  forbid = false;
  seed();
});

afterEach(() => fs.rmSync(rootDir, { recursive: true, force: true }));

describe('pure helpers', () => {
  test('progressOf rounds completed required lessons like the server', () => {
    expect(academy.progressOf(['a', 'b', 'c'], new Set(['a']))).toBe(33);
    expect(academy.progressOf(['a'], new Set(['a']))).toBe(100);
    expect(academy.progressOf([], new Set())).toBeNull();
  });
  test('unsafeHtml refuses scripts, handlers and javascript links', () => {
    expect(academy.unsafeHtml('<p>ok</p>')).toBeNull();
    expect(academy.unsafeHtml('<script>x</script>')).toMatch(/script/);
    expect(academy.unsafeHtml('<img src=x onerror=alert(1)>')).toMatch(/handlers/);
    expect(academy.unsafeHtml('<a href="javascript:alert(1)">')).toMatch(/javascript/);
  });
});

describe('reads', () => {
  test('course outline follows the order field, not the array order', async () => {
    const r = await run(['course', D, 'Onboarding']);
    expect(r.code).toBe(0);
    expect(r.json.outline[0].lessons.map((l) => l.lessonName)).toEqual(['Welcome', 'Role play']);
    expect(r.json.warnings.join(' ')).toMatch(/Manual/);
  });
  test('a 403 stops with FORBIDDEN after one request', async () => {
    const r = await run(['programs', D], { profile: 'seller' });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/FORBIDDEN/);
    expect(calls).toHaveLength(1);
  });
  test('an object as a reference is refused before any request', async () => {
    const r = await run(['preview', D, JSON.stringify({ kind: 'enroll', course: { $ne: null }, users: ['student@example.com'] })]);
    expect(r.code).toBe(2);
    expect(calls).toHaveLength(0);
  });
  test('the API key never reaches the output', async () => {
    state.course[0].courseName = `Onboarding ${KEY}`;
    const r = await run(['course', D, COURSE]);
    expect(r.out).not.toContain(KEY);
  });
});

describe('build', () => {
  const plan = {
    kind: 'build',
    program: 'Sales program',
    course: { courseName: 'Induction', certificate: { enabled: true, template: '<p>[[userName]]</p>' } },
    modules: [{ moduleName: 'Week 1', lessons: [
      { lessonName: 'Hello', type: 'Article', content: '<p>Hi</p>' },
      { lessonName: 'Clip', type: 'Video', videoUrl: 'https://example.com/v' },
      { lessonName: 'Check', type: 'Quiz', assessment: 'Final quiz', minScore: 80 },
    ] }],
  };

  test('preview writes nothing and apply creates a Draft course, ordered lessons and links the program', async () => {
    const p = await run(['preview', D, JSON.stringify(plan)]);
    expect(p.code).toBe(0);
    expect(writes()).toHaveLength(0);
    expect(p.json.nextStep).toMatch(/STOP HERE/);
    const a = await run(['apply', D, JSON.stringify(plan), '--version', p.json.version, '--confirmed']);
    expect(a.code).toBe(0);
    const course = writes().find((c) => c.path === '/v2/course');
    expect(course.body.status).toBe('Draft');
    const mod = writes().find((c) => c.path === '/v2/module');
    expect(mod.body.origin).toEqual({ modelName: 'Course', docId: a.json.created.course });
    const lessons = writes().filter((c) => c.path === '/v2/lesson');
    expect(lessons.map((c) => c.body.order)).toEqual([0, 1, 2]);
    expect(lessons[2].body).toMatchObject({ assessment: QUIZ, completionRule: 'Score', minScore: 80 });
    const prog = writes().find((c) => c.path === `/v2/program/${PROGRAM}`);
    expect(prog.body.courses).toContain(a.json.created.course);
    expect(prog.body.requiredCourses).toContain(a.json.created.course);
    expect(a.json.course.outline[0].lessons.map((l) => l.lessonName)).toEqual(['Hello', 'Clip', 'Check']);
  });

  test('apply needs --confirmed and the preview version', async () => {
    expect((await run(['apply', D, JSON.stringify(plan), '--version', 'x'])).code).toBe(2);
    expect((await run(['apply', D, JSON.stringify(plan), '--version', 'stale', '--confirmed'])).code).toBe(3);
    expect(writes()).toHaveLength(0);
  });

  test('unsafe HTML, file lessons and quizzes without assessment are blockers', async () => {
    const bad = {
      kind: 'build', course: { courseName: 'Bad' }, modules: [{ moduleName: 'M', lessons: [
        { lessonName: 'X', type: 'Article', content: '<script>alert(1)</script>' },
        { lessonName: 'F', type: 'File' },
        { lessonName: 'Q', type: 'Quiz' },
      ] }],
    };
    const r = await run(['preview', D, JSON.stringify(bad)]);
    expect(r.code).toBe(3);
    expect(r.json.blockers).toHaveLength(3);
    expect(writes()).toHaveLength(0);
  });

  test('set merges the certificate so the existing design survives', async () => {
    const p = { kind: 'build', course: 'Onboarding', set: { certificate: { enabled: false } }, modules: [] };
    const pre = await run(['preview', D, JSON.stringify(p)]);
    await run(['apply', D, JSON.stringify(p), '--version', pre.json.version, '--confirmed']);
    const patch = writes().find((c) => c.path === `/v2/course/${COURSE}`);
    expect(patch.body.certificate).toEqual({ enabled: false, template: '<p>[[userName]]</p>' });
  });

  test('unknown fields and a missing name are usage errors', async () => {
    expect((await run(['preview', D, JSON.stringify({ kind: 'build', course: { courseName: 'A', price: 1 }, modules: [] })])).code).toBe(2);
    expect((await run(['preview', D, JSON.stringify({ kind: 'build', course: { courseName: 'A' }, modules: [{ lessons: [] }] })])).code).toBe(2);
    const lesson = { lessonName: 'L', type: 'Article', content: '<p>x</p>', origin: { modelName: 'Module', docId: MODULE } };
    expect((await run(['preview', D, JSON.stringify({ kind: 'build', course: { courseName: 'A' }, modules: [{ moduleName: 'M', lessons: [lesson] }] })])).code).toBe(2);
  });
});

describe('publish', () => {
  test('a course without required lessons cannot be published', async () => {
    state.lesson.forEach((l) => { l.required = false; });
    state.course[0].status = 'Draft';
    const r = await run(['preview', D, JSON.stringify({ kind: 'publish', course: 'Onboarding' })]);
    expect(r.code).toBe(3);
    expect(r.json.blockers.join(' ')).toMatch(/no required lessons/);
  });
  test('publishing a program open to nobody warns', async () => {
    state.program[0].teams = [];
    state.program[0].status = 'Draft';
    const r = await run(['preview', D, JSON.stringify({ kind: 'publish', program: 'Sales program' })]);
    expect(r.code).toBe(0);
    expect(r.json.warnings.join(' ')).toMatch(/only admins/);
  });
});

describe('enroll', () => {
  const plan = { kind: 'enroll', course: 'Onboarding', users: ['student@example.com', 'outsider@example.com'] };

  test('a user outside the program teams is blocked', async () => {
    const r = await run(['preview', D, JSON.stringify(plan)]);
    expect(r.code).toBe(3);
    expect(r.json.blockers.join(' ')).toMatch(/outsider@example.com cannot reach/);
  });

  test('enrolls with the program, warns about permissions and notifies nobody', async () => {
    const one = { ...plan, users: ['student@example.com'] };
    const p = await run(['preview', D, JSON.stringify(one)]);
    expect(p.json.recipients).toEqual([]);
    expect(p.json.warnings.join(' ')).toMatch(/Academy permissions/);
    const a = await run(['apply', D, JSON.stringify(one), '--version', p.json.version, '--confirmed']);
    expect(a.code).toBe(0);
    expect(writes()[0].body).toEqual({ assignee: STUDENT, course: COURSE, program: PROGRAM });
  });

  test('an in-progress enrollment is skipped, a draft course blocks', async () => {
    state.enrollment.push({ _id: newId(), assignee: STUDENT, course: COURSE, status: 'InProgress', progressPercent: 50 });
    const r = await run(['preview', D, JSON.stringify({ ...plan, users: ['student@example.com'] })]);
    expect(r.json.changes[0]).toMatch(/skipped/);
    state.course[0].status = 'Draft';
    const d = await run(['preview', D, JSON.stringify({ ...plan, users: ['student@example.com'] })]);
    expect(d.code).toBe(3);
  });
});

describe('complete and reissue', () => {
  let enrollment;
  beforeEach(() => {
    enrollment = newId();
    state.enrollment.push({ _id: enrollment, assignee: STUDENT, course: COURSE, program: PROGRAM, status: 'InProgress', progressPercent: 50, updatedAt: 'e1' });
    state.lessonprogress.push({ _id: newId(), enrollment, lesson: L1, status: 'Completed' });
  });

  test('marking the last Manual lesson completes and certifies through trackProgress', async () => {
    const plan = { kind: 'complete', user: 'student@example.com', course: 'Onboarding', lessons: ['Role play'] };
    const p = await run(['preview', D, JSON.stringify(plan)]);
    expect(p.json.changes.join(' ')).toMatch(/reaches 100%/);
    const a = await run(['apply', D, JSON.stringify(plan), '--version', p.json.version, '--confirmed']);
    expect(a.code).toBe(0);
    expect(writes()[0]).toMatchObject({ path: '/v2/lessonprogress/trackProgress', body: { lesson: L2, completedBy: 'Admin', status: 'Completed' } });
    expect(a.json.status).toBe('Completed');
    expect(a.json.certificates[0].type).toBe('Course');
  });

  test('a course with a badge needs --reaches-people', async () => {
    state.course[0].badgeNomination = BADGE;
    const plan = { kind: 'complete', user: 'student@example.com', course: 'Onboarding', lessons: ['Role play'] };
    const p = await run(['preview', D, JSON.stringify(plan)]);
    expect(p.json.recipients[0].email).toBe('student@example.com');
    const a = await run(['apply', D, JSON.stringify(plan), '--version', p.json.version, '--confirmed']);
    expect(a.code).toBe(2);
    expect(writes()).toHaveLength(0);
  });

  test('reissue re-marks a completed enrollment and refuses when a certificate exists', async () => {
    const e = state.enrollment[0];
    e.status = 'Completed';
    state.course[0].certificate.enabled = true;
    const plan = { kind: 'reissue', user: 'student@example.com', course: 'Onboarding' };
    const p = await run(['preview', D, JSON.stringify(plan)]);
    const a = await run(['apply', D, JSON.stringify(plan), '--version', p.json.version, '--confirmed']);
    expect(writes()[0]).toMatchObject({ method: 'PATCH', path: `/v2/enrollment/${enrollment}`, body: { status: 'Completed' } });
    expect(a.json.certificates).toHaveLength(1);
    const again = await run(['preview', D, JSON.stringify(plan)]);
    expect(again.code).toBe(3);
    expect(again.json.blockers.join(' ')).toMatch(/already exists/);
  });

  test('diagnose points to reissue when the certificate is missing', async () => {
    state.enrollment[0].status = 'Completed';
    const r = await run(['diagnose', D, 'student@example.com', 'Onboarding']);
    expect(r.code).toBe(0);
    expect(r.json.fixes.join(' ')).toMatch(/reissue/);
  });

  test('diagnose lists pending lessons of an in-progress enrollment', async () => {
    const r = await run(['diagnose', D, 'student@example.com', 'Onboarding']);
    expect(r.json.pendingLessons.map((l) => l.lessonName)).toEqual(['Role play']);
    expect(r.json.findings.join(' ')).toMatch(/Manual/);
  });
});
