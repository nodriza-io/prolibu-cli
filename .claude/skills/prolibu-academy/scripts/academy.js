#!/usr/bin/env node
'use strict';

// Academy (learning) the way the Prolibu app handles it: programs, courses, modules,
// lessons, enrollments, lesson progress and certificates.
//
//   academy.js programs      <domain>                                   programs with access and certificate settings
//   academy.js course        <domain> <course id | code | exact name>   outline in the order students see it + publish check
//   academy.js progress      <domain> <course> [--status InProgress|Completed|Failed|NotFinished] [--limit <n>]
//   academy.js diagnose      <domain> <user e-mail> <course>            why a certificate was or was not issued
//   academy.js certificates  <domain> [--user <e-mail>] [--limit <n>]
//   academy.js preview       <domain> '<plan>'                          writes nothing; returns a version
//   academy.js apply         <domain> '<plan>' --version <v> --confirmed [--reaches-people]
//
// Plan kinds: build | publish | enroll | complete | reissue (see SKILL.md for each shape).
// Plans are inline JSON or the path of a JSON file in a temp folder.
// Every command accepts --profile <name> (reads accounts/<domain>/profile.<name>.json).
// Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked (nothing written).

const fs = require('fs');
const crypto = require('crypto');
const {
  createClient, assertDataFileAllowed, UsageError, DEFAULT_ROOT,
} = require('../../_shared/prolibu-api');

const ID_RE = /^[a-f0-9]{24}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BLOCKED = 3;
const MAX_USERS = 100;
const MAX_LESSONS = 200;
const STATUSES = ['Draft', 'Published', 'Archived'];
const LESSON_TYPES = ['Article', 'Video', 'Quiz', 'File'];
const RULES = ['View', 'Interact', 'Score', 'Manual'];
const LEVELS = ['Beginner', 'Intermediate', 'Advanced', 'Expert'];
const COURSE_KEYS = new Set(['courseName', 'description', 'shortDescription', 'level', 'estimatedDuration', 'navigationMode',
  'passingScore', 'tags', 'certificate']);
const PROGRAM_KEYS = new Set(['programName', 'description', 'tags', 'allowEveryone', 'teams', 'certificate']);
const LESSON_KEYS = new Set(['lessonName', 'type', 'content', 'videoUrl', 'assessment', 'required', 'completionRule', 'minScore', 'duration']);
const CERT_VARS = ['userName', 'firstName', 'lastName', 'email', 'certificateCode', 'issuedAt', 'courseName', 'programName', 'type'];

const STOP = 'Show this to the user. STOP HERE and end your turn; never write in the same turn as this preview. '
  + 'Only after the user answers with an explicit yes in a later message, run ';

class Blocked extends Error {}

// ─── Pure helpers ──────────────────────────────────────────────────────────────

const idOf = (v) => (v && typeof v === 'object' ? String(v._id || '') : v ? String(v) : '');
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const fullName = (r) => (r && typeof r === 'object' ? [r.firstName, r.lastName].filter(Boolean).join(' ').trim() || null : null);
const qs = (params) => new URLSearchParams(Object.fromEntries(Object.entries(params)
  .filter(([, v]) => v !== undefined)
  .map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])));
const rowsOf = (body) => (Array.isArray(body) ? body : (body && body.data) || []);
const byOrder = (a, b) => (Number(a.order) || 0) - (Number(b.order) || 0);
const day = (d) => (d ? String(d).slice(0, 10) : null);

// Admin-written HTML still reaches every student's browser: refuse scripts, inline
// handlers and javascript: URLs instead of trusting the renderer to strip them.
function unsafeHtml(html) {
  const s = String(html || '');
  if (/<\s*(script|iframe|object|embed)\b/i.test(s)) return 'it has <script>, <iframe>, <object> or <embed> tags';
  if (/\son[a-z]+\s*=/i.test(s)) return 'it has inline event handlers (onclick=…)';
  if (/javascript\s*:/i.test(s)) return 'it has javascript: links';
  return null;
}

function httpsUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}

// Mirrors LessonProgress.recalculateEnrollmentProgress: completed required lessons over
// all required lessons of the course's modules, rounded. 100 completes the enrollment.
function progressOf(requiredIds, completedIds) {
  if (!requiredIds.length) return null;
  const done = requiredIds.filter((id) => completedIds.has(id)).length;
  return Math.round((done / requiredIds.length) * 100);
}

function readPlan(arg, rootDir) {
  let text = String(arg || '');
  if (!text.trim()) throw new UsageError('Missing the plan (inline JSON or a temp file path).');
  if (!text.trim().startsWith('{')) {
    assertDataFileAllowed(text, rootDir);
    try {
      text = fs.readFileSync(text, 'utf8');
    } catch {
      throw new UsageError(`Cannot read the plan file ${arg}.`);
    }
  }
  let plan;
  try {
    plan = JSON.parse(text);
  } catch {
    throw new UsageError('The plan is not valid JSON.');
  }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new UsageError('The plan must be a JSON object.');
  return plan;
}

// A reference from the user is a string: an id, a code or an exact name. Objects would
// reach the server's query as operators ($ne, $gt), so they are refused here.
function refString(value, what) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new UsageError(`${what} must be an id, a code or a name (text).`);
  return value.trim();
}

// ─── API access ────────────────────────────────────────────────────────────────

async function call(client, method, path, opts) {
  const res = await client.request(method, path, opts);
  if (!res.ok) {
    const body = res.body && typeof res.body === 'object' ? res.body : { error: res.body };
    const err = new Error(`${method} ${path.split('?')[0]} answered ${res.status}: ${body.error || body.message || 'no message'}`);
    err.status = res.status;
    throw err;
  }
  return res.body;
}

async function list(client, object, params) {
  return rowsOf(await call(client, 'GET', `/v2/${object}?${qs(params)}`));
}

async function findOne(client, object, ref, { codeField, nameField, select, populatePath }) {
  const r = refString(ref, object);
  const queries = ID_RE.test(r) ? [{ _id: r }] : [{ [codeField]: r }, { [nameField]: r }];
  for (const xquery of queries) {
    const rows = await list(client, object, { xquery, select, populatePath, limit: '2' });
    if (rows.length > 1) throw new Blocked(`More than one ${object} is called "${r}". Use its id or code.`);
    if (rows.length) return rows[0];
  }
  throw new Blocked(`No ${object} found for "${r}".`);
}

const OUTLINE_POPULATE = [{
  path: 'modules',
  select: 'moduleName moduleCode order lessons updatedAt',
  populate: { path: 'lessons', select: 'lessonName lessonCode type order required completionRule minScore assessment videoUrl duration' },
}];
const COURSE_SELECT = 'courseName courseCode status active modules navigationMode passingScore prerequisites certificate badgeNomination updatedAt';
const PROGRAM_SELECT = 'programName programCode status active courses requiredCourses allowEveryone teams certificate updatedAt';

async function loadCourse(client, ref) {
  return findOne(client, 'course', ref, {
    codeField: 'courseCode', nameField: 'courseName', select: COURSE_SELECT, populatePath: OUTLINE_POPULATE,
  });
}

async function loadProgram(client, ref) {
  return findOne(client, 'program', ref, { codeField: 'programCode', nameField: 'programName', select: PROGRAM_SELECT });
}

async function userByEmail(client, email) {
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) throw new UsageError(`"${email}" is not an e-mail.`);
  const rows = await list(client, 'user', {
    xquery: { email: email.toLowerCase().trim() }, select: 'firstName lastName email isAdmin active status', limit: '2',
  });
  if (!rows.length) throw new Blocked(`No user with e-mail ${email}.`);
  return rows[0];
}

const userView = (u) => ({ _id: idOf(u), email: u.email || null, name: fullName(u) });
// A populated assignee comes back null when the user was deleted.
const personOf = (v) => (v && typeof v === 'object' ? userView(v) : { _id: null, note: 'this user no longer exists' });

function outlineOf(course) {
  const modules = (course.modules || []).filter((m) => m && typeof m === 'object').sort(byOrder);
  return modules.map((m) => ({
    _id: idOf(m),
    moduleName: m.moduleName,
    order: m.order || 0,
    lessons: (m.lessons || []).filter((l) => l && typeof l === 'object').sort(byOrder).map((l) => ({
      _id: idOf(l),
      lessonName: l.lessonName,
      type: l.type,
      order: l.order || 0,
      required: l.required !== false,
      completionRule: l.completionRule || 'View',
      ...(l.minScore !== undefined ? { minScore: l.minScore } : {}),
      ...(l.type === 'Quiz' ? { assessment: idOf(l.assessment) || null } : {}),
      ...(l.type === 'Video' ? { videoUrl: l.videoUrl || null } : {}),
    })),
  }));
}

const lessonsOf = (outline) => outline.flatMap((m) => m.lessons);

async function programsWithCourse(client, courseId) {
  return list(client, 'program', { xquery: { courses: courseId }, select: PROGRAM_SELECT, limit: '50' });
}

function accessView(p) {
  if (p.allowEveryone && p.allowEveryone.view) return 'everyone';
  if ((p.teams || []).length) return `${p.teams.length} team(s)`;
  return 'admins only';
}

// Mirrors Course.isReachable: a published, active program that holds the course and is
// open to everyone or to one of the user's teams. An admin sees every published program.
async function reachablePrograms(client, programs, user) {
  const live = programs.filter((p) => p.status === 'Published' && p.active !== false);
  if (user.isAdmin) return live;
  const teams = await list(client, 'team', { xquery: { users: idOf(user) }, select: '_id', limit: '200' });
  const mine = new Set(teams.map(idOf));
  return live.filter((p) => (p.allowEveryone && p.allowEveryone.view) || (p.teams || []).map(idOf).some((t) => mine.has(t)));
}

// Problems that keep a course from working for students. Blockers stop a publish.
function courseReadiness(course, outline, programs) {
  const blockers = [];
  const warnings = [];
  const lessons = lessonsOf(outline);
  const required = lessons.filter((l) => l.required);
  if (!outline.length) blockers.push('The course has no modules: progress can never be computed and nobody can finish it.');
  else if (!required.length) blockers.push('The course has no required lessons: progress stays at 0 and nobody can finish it or get the certificate.');
  for (const l of lessons) {
    if (l.type === 'Quiz' && !l.assessment) blockers.push(`Quiz lesson "${l.lessonName}" has no assessment linked: students see an empty lesson.`);
    if (l.type === 'Video' && !l.videoUrl) warnings.push(`Video lesson "${l.lessonName}" has no video URL (or plays an uploaded file; check it in the app).`);
    if (l.required && l.completionRule === 'Manual') warnings.push(`"${l.lessonName}" is Manual: only an instructor can mark it done, so students cannot finish alone.`);
  }
  if (!programs.length) warnings.push('The course is in no program: students only see courses through a published program.');
  else if (!programs.some((p) => p.status === 'Published' && p.active !== false)) warnings.push('None of its programs is published: students do not see it yet.');
  if (course.certificate && course.certificate.enabled && !course.certificate.template) {
    warnings.push('Certificates are on but there is no design (template): the certificate is issued without a PDF, and the app keeps saying "preparing" for a while.');
  }
  return { blockers, warnings };
}

// ─── Read commands ─────────────────────────────────────────────────────────────

async function cmdPrograms(client) {
  const programs = await list(client, 'program', { select: PROGRAM_SELECT, sort: 'programName', limit: '200' });
  return {
    programs: programs.map((p) => ({
      _id: idOf(p),
      code: p.programCode,
      name: p.programName,
      status: p.status || 'Draft',
      active: p.active !== false,
      access: accessView(p),
      courses: (p.courses || []).length,
      requiredCourses: (p.requiredCourses || []).length,
      certificate: !!(p.certificate && p.certificate.enabled),
    })),
  };
}

async function cmdCourse(client, [ref]) {
  const course = await loadCourse(client, ref);
  const outline = outlineOf(course);
  const programs = await programsWithCourse(client, idOf(course));
  const check = courseReadiness(course, outline, programs);
  return {
    course: {
      _id: idOf(course),
      code: course.courseCode,
      name: course.courseName,
      status: course.status || 'Draft',
      active: course.active !== false,
      navigationMode: course.navigationMode || 'Free',
      certificate: !!(course.certificate && course.certificate.enabled),
      certificateDesign: !!(course.certificate && course.certificate.template),
      badge: !!course.badgeNomination,
    },
    programs: programs.map((p) => ({
      _id: idOf(p), name: p.programName, status: p.status, access: accessView(p), requiredHere: (p.requiredCourses || []).map(idOf).includes(idOf(course)),
    })),
    outline,
    requiredLessons: lessonsOf(outline).filter((l) => l.required).length,
    readyToPublish: !check.blockers.length,
    blockers: check.blockers,
    warnings: check.warnings,
  };
}

async function cmdProgress(client, [ref], flags) {
  const course = await loadCourse(client, ref);
  const xquery = { course: idOf(course) };
  if (flags.status === 'NotFinished') xquery.status = { $in: ['InProgress', 'Failed'] };
  else if (flags.status) {
    if (!['InProgress', 'Completed', 'Failed'].includes(flags.status)) throw new UsageError('--status must be InProgress, Completed, Failed or NotFinished.');
    xquery.status = flags.status;
  }
  const rows = await list(client, 'enrollment', {
    xquery,
    select: 'enrollmentCode assignee program status progressPercent score lastLesson completedAt createdAt',
    populatePath: [{ path: 'assignee', select: 'firstName lastName email' }, { path: 'lastLesson', select: 'lessonName' }],
    sort: '-updatedAt',
    limit: String(flags.limit || 100),
  });
  const enrollments = rows.map((e) => ({
    enrollment: idOf(e),
    code: e.enrollmentCode,
    user: personOf(e.assignee),
    status: e.status,
    progressPercent: e.progressPercent || 0,
    score: e.score ?? null,
    lastLesson: e.lastLesson && typeof e.lastLesson === 'object' ? e.lastLesson.lessonName : null,
    program: idOf(e.program) || null,
    enrolledAt: day(e.createdAt),
    completedAt: day(e.completedAt),
  }));
  const counts = { InProgress: 0, Completed: 0, Failed: 0 };
  enrollments.forEach((e) => { counts[e.status] = (counts[e.status] || 0) + 1; });
  return {
    course: { _id: idOf(course), name: course.courseName },
    counts,
    enrollments,
    note: 'Only people who enrolled appear here. Someone who never enrolled has no record at all; compare with your list of people.',
  };
}

async function cmdCertificates(client, args, flags) {
  const xquery = {};
  if (flags.user) xquery.assignee = idOf(await userByEmail(client, flags.user));
  const rows = await list(client, 'certificate', {
    xquery,
    select: 'certificateCode type assignee enrollment issuedAt expiresAt status pdfFile',
    populatePath: [{ path: 'assignee', select: 'firstName lastName email' }, { path: 'enrollment', select: 'course program', populate: { path: 'course', select: 'courseName' } }],
    sort: '-issuedAt',
    limit: String(flags.limit || 50),
  });
  return {
    certificates: rows.map((c) => ({
      _id: idOf(c),
      code: c.certificateCode,
      type: c.type,
      user: personOf(c.assignee),
      course: c.enrollment && c.enrollment.course && typeof c.enrollment.course === 'object' ? c.enrollment.course.courseName : null,
      enrollmentExists: !!(c.enrollment && typeof c.enrollment === 'object'),
      status: c.status,
      issuedAt: day(c.issuedAt),
      expiresAt: day(c.expiresAt),
      pdf: !!c.pdfFile,
    })),
  };
}

async function enrollmentsOf(client, userId, courseId) {
  return list(client, 'enrollment', {
    xquery: { assignee: userId, course: courseId },
    select: 'enrollmentCode status progressPercent program completedAt updatedAt createdAt',
    sort: '-createdAt',
    limit: '20',
  });
}

async function progressOfEnrollment(client, enrollmentId) {
  const rows = await list(client, 'lessonprogress', {
    xquery: { enrollment: enrollmentId }, select: 'lesson status completedBy completedAt score', limit: '500',
  });
  return new Map(rows.map((r) => [idOf(r.lesson), r]));
}

async function cmdDiagnose(client, [email, ref]) {
  if (!email || !ref) throw new UsageError('Usage: academy.js diagnose <domain> <user e-mail> <course>');
  const user = await userByEmail(client, email);
  const course = await loadCourse(client, ref);
  const outline = outlineOf(course);
  const required = lessonsOf(outline).filter((l) => l.required);
  const enrollments = await enrollmentsOf(client, idOf(user), idOf(course));
  const findings = [];
  const fixes = [];
  const result = {
    user: userView(user),
    course: { _id: idOf(course), name: course.courseName, certificate: !!(course.certificate && course.certificate.enabled), certificateDesign: !!(course.certificate && course.certificate.template) },
    enrollments: enrollments.map((e) => ({ enrollment: idOf(e), status: e.status, progressPercent: e.progressPercent || 0, program: idOf(e.program) || null, completedAt: day(e.completedAt) })),
    findings,
    fixes,
  };
  if (!enrollments.length) {
    findings.push('The user never enrolled in this course, so there is nothing to complete or certify.');
    fixes.push('Enroll them with an "enroll" plan.');
    return result;
  }
  const latest = enrollments[0];
  const done = await progressOfEnrollment(client, idOf(latest));
  const completed = new Set([...done.entries()].filter(([, p]) => p.status === 'Completed').map(([id]) => id));
  const pending = required.filter((l) => !completed.has(l._id));
  result.pendingLessons = pending.map((l) => ({ _id: l._id, lessonName: l.lessonName, type: l.type, completionRule: l.completionRule }));
  result.expectedProgress = progressOf(required.map((l) => l._id), completed);
  const certs = await list(client, 'certificate', {
    xquery: { enrollment: { $in: enrollments.map(idOf) } }, select: 'certificateCode type status pdfFile issuedAt enrollment', limit: '20',
  });
  result.certificates = certs.map((c) => ({ code: c.certificateCode, type: c.type, status: c.status, pdf: !!c.pdfFile, issuedAt: day(c.issuedAt) }));
  const courseCert = certs.find((c) => c.type === 'Course' && idOf(c.enrollment) === idOf(latest));

  if (!required.length) findings.push('The course has no required lessons, so progress never moves and it never completes.');
  if (latest.status === 'InProgress') {
    findings.push(`The enrollment is in progress at ${latest.progressPercent || 0}%: ${pending.length} required lesson(s) are not done.`);
    const manual = pending.filter((l) => l.completionRule === 'Manual');
    if (manual.length) {
      findings.push(`${manual.length} pending lesson(s) are Manual: only an instructor can mark them done.`);
      fixes.push('If the instructor confirms them, preview a "complete" plan for those lessons.');
    }
    const quizzes = pending.filter((l) => l.type === 'Quiz');
    if (quizzes.length) findings.push(`${quizzes.length} pending quiz lesson(s): the student has to pass them (see attempts in the app).`);
    if (result.expectedProgress === 100) {
      findings.push('Every required lesson is done but the enrollment did not move to Completed (progress is only recomputed when a lesson is saved).');
      fixes.push('Preview a "reissue" plan: it marks the enrollment Completed, which issues the certificate.');
    }
  }
  if (latest.status === 'Failed') findings.push('The enrollment is Failed. The user can enroll again and start a new attempt.');
  if (latest.status === 'Completed') {
    if (!(course.certificate && course.certificate.enabled)) {
      findings.push('The course was completed, but the course does not issue certificates (certificate is off).');
      fixes.push('Turn the course certificate on in the app (or a build plan), then preview a "reissue" plan.');
    } else if (!courseCert) {
      findings.push('The course was completed and issues certificates, but this enrollment has none. Most likely the certificate was turned on after the user finished.');
      fixes.push('Preview a "reissue" plan for this user and course.');
    } else if (!courseCert.pdfFile) {
      findings.push(course.certificate.template
        ? 'The certificate exists but its PDF was not generated (the print service failed when it was issued). The app shows the certificate page; there is no way to regenerate the PDF from here.'
        : 'The certificate exists but has no PDF because the course has no certificate design. The app shows the certificate page; only new certificates get a PDF once a design exists.');
    } else {
      findings.push(`The certificate ${courseCert.certificateCode} was issued with its PDF. The user finds it under Certificates.`);
    }
  }
  // Program certificate: the server only checks it while issuing a course certificate.
  const programs = await programsWithCourse(client, idOf(course));
  const withCert = programs.filter((p) => p.certificate && p.certificate.enabled);
  for (const p of withCert) {
    const req = (p.requiredCourses || []).map(idOf);
    if (!req.includes(idOf(course))) continue;
    if (!enrollments.some((e) => idOf(e.program) === idOf(p))) {
      findings.push(`Program "${p.programName}" issues a certificate, but this enrollment is not linked to the program: it never counts for the program certificate.`);
    }
    if (!(course.certificate && course.certificate.enabled)) {
      findings.push(`Program "${p.programName}" is only checked when a course certificate is issued; this course has certificates off, so finishing it never triggers the program certificate.`);
    }
  }
  return result;
}

// ─── Plans ─────────────────────────────────────────────────────────────────────

function checkCertificate(cert, where, blockers) {
  if (cert === undefined) return undefined;
  if (!cert || typeof cert !== 'object' || Array.isArray(cert)) throw new UsageError(`${where}.certificate must be an object {enabled, template}.`);
  const out = {};
  if (cert.enabled !== undefined) out.enabled = cert.enabled === true;
  if (cert.template !== undefined) {
    if (typeof cert.template !== 'string') throw new UsageError(`${where}.certificate.template must be HTML text.`);
    const bad = unsafeHtml(cert.template);
    if (bad) blockers.push(`${where} certificate design refused: ${bad}.`);
    out.template = cert.template;
  }
  return out;
}

function lessonBody(raw, where, blockers, warnings, assessments) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new UsageError(`${where} must be an object.`);
  const unknown = Object.keys(raw).filter((k) => !LESSON_KEYS.has(k));
  if (unknown.length) throw new UsageError(`${where}: unknown field(s) ${unknown.join(', ')}.`);
  if (typeof raw.lessonName !== 'string' || !raw.lessonName.trim()) throw new UsageError(`${where} needs a lessonName.`);
  const name = raw.lessonName.trim();
  if (!LESSON_TYPES.includes(raw.type)) throw new UsageError(`${where} ("${name}"): type must be one of ${LESSON_TYPES.join(', ')}.`);
  const body = { lessonName: name, type: raw.type };
  if (raw.required !== undefined) body.required = raw.required === true;
  if (raw.duration !== undefined) body.duration = Number(raw.duration) || 0;
  let rule = raw.completionRule;
  if (raw.type === 'Quiz' && rule === undefined) rule = 'Score';
  if (rule !== undefined) {
    if (!RULES.includes(rule)) throw new UsageError(`${where} ("${name}"): completionRule must be one of ${RULES.join(', ')}.`);
    body.completionRule = rule;
  }
  if (raw.minScore !== undefined) {
    const n = Number(raw.minScore);
    if (!(n >= 0 && n <= 100)) throw new UsageError(`${where} ("${name}"): minScore must be 0–100.`);
    body.minScore = n;
  }
  if (raw.type === 'Article') {
    if (typeof raw.content !== 'string' || !raw.content.trim()) blockers.push(`Article "${name}" has no content.`);
    else {
      const bad = unsafeHtml(raw.content);
      if (bad) blockers.push(`Article "${name}" refused: ${bad}.`);
      body.content = raw.content;
    }
  }
  if (raw.type === 'Video') {
    if (!httpsUrl(raw.videoUrl)) blockers.push(`Video "${name}" needs an https videoUrl (uploaded video files are added in the app).`);
    else body.videoUrl = raw.videoUrl;
    body.videoSource = 'Url';
  }
  if (raw.type === 'File') blockers.push(`File lesson "${name}": downloadable files are uploaded in the app; create it there.`);
  if (raw.type === 'Quiz') {
    if (raw.assessment === undefined) blockers.push(`Quiz "${name}" needs an existing assessment (create it in the app's assessment designer, then give its id or name).`);
    else assessments.push({ ref: refString(raw.assessment, `${where}.assessment`), body, name });
    if (rule === 'Score' && body.minScore === undefined) warnings.push(`Quiz "${name}" has no minScore: the quiz's own passing score decides.`);
  }
  if (rule === 'Manual' && body.required !== false) warnings.push(`"${name}" is Manual: students cannot finish the course until an instructor marks it done.`);
  return body;
}

async function resolveTeams(client, refs) {
  if (!Array.isArray(refs)) throw new UsageError('program.teams must be a list of team ids or names.');
  const out = [];
  for (const r of refs) {
    const ref = refString(r, 'team');
    const rows = await list(client, 'team', { xquery: ID_RE.test(ref) ? { _id: ref } : { teamName: ref }, select: 'teamName', limit: '2' });
    if (rows.length !== 1) throw new Blocked(`Team "${ref}" ${rows.length ? 'is ambiguous' : 'was not found'}.`);
    out.push(idOf(rows[0]));
  }
  return out;
}

async function prepareBuild(client, plan) {
  const blockers = [];
  const warnings = [];
  const versionParts = [];
  if (!Array.isArray(plan.modules)) throw new UsageError('A build plan needs "modules": [{moduleName, lessons: […]}] (or {module: "<existing>", lessons}).');
  // Course: a new one (object) or an existing one (reference).
  let course = null;
  let courseBody = null;
  if (plan.course && typeof plan.course === 'object' && !Array.isArray(plan.course)) {
    const unknown = Object.keys(plan.course).filter((k) => !COURSE_KEYS.has(k));
    if (unknown.length) throw new UsageError(`course: unknown field(s) ${unknown.join(', ')}.`);
    if (typeof plan.course.courseName !== 'string' || !plan.course.courseName.trim()) throw new UsageError('course.courseName is required.');
    courseBody = { ...plan.course, courseName: plan.course.courseName.trim(), status: 'Draft' };
    if (courseBody.level !== undefined && !LEVELS.includes(courseBody.level)) throw new UsageError(`course.level must be one of ${LEVELS.join(', ')}.`);
    if (courseBody.navigationMode !== undefined && !['Free', 'Sequential'].includes(courseBody.navigationMode)) throw new UsageError('course.navigationMode must be Free or Sequential.');
    if (courseBody.certificate !== undefined) courseBody.certificate = checkCertificate(courseBody.certificate, 'course', blockers);
    const same = await list(client, 'course', { xquery: { courseName: courseBody.courseName }, select: '_id', limit: '1' });
    if (same.length) blockers.push(`A course called "${courseBody.courseName}" already exists (${idOf(same[0])}). Use it as "course" to add to it, or pick another name.`);
  } else if (plan.course !== undefined) {
    course = await loadCourse(client, plan.course);
    versionParts.push(course.updatedAt);
  } else throw new UsageError('A build plan needs "course": a new course object or an existing course id/code/name.');

  // Settings of an existing course. certificate is merged so a template is never lost
  // when only "enabled" changes (the server replaces the whole sub-object).
  let courseSet = null;
  if (plan.set !== undefined) {
    if (!course) throw new UsageError('"set" changes an existing course; for a new one put the fields in "course".');
    if (!plan.set || typeof plan.set !== 'object' || Array.isArray(plan.set)) throw new UsageError('"set" must be an object.');
    const unknown = Object.keys(plan.set).filter((k) => !COURSE_KEYS.has(k));
    if (unknown.length) throw new UsageError(`set: unknown field(s) ${unknown.join(', ')}.`);
    courseSet = { ...plan.set };
    if (courseSet.level !== undefined && !LEVELS.includes(courseSet.level)) throw new UsageError(`set.level must be one of ${LEVELS.join(', ')}.`);
    if (courseSet.navigationMode !== undefined && !['Free', 'Sequential'].includes(courseSet.navigationMode)) throw new UsageError('set.navigationMode must be Free or Sequential.');
    if (courseSet.certificate !== undefined) courseSet.certificate = { ...(course.certificate || {}), ...checkCertificate(courseSet.certificate, 'course', blockers) };
  }

  const outline = course ? outlineOf(course) : [];
  versionParts.push(outline.map((m) => [m._id, m.lessons.map((l) => l._id)]));
  let nextModuleOrder = outline.reduce((max, m) => Math.max(max, m.order + 1), 0);
  const assessments = [];
  const modules = [];
  let lessonCount = 0;
  plan.modules.forEach((m, i) => {
    if (!m || typeof m !== 'object') throw new UsageError(`modules[${i}] must be an object.`);
    if (!Array.isArray(m.lessons)) throw new UsageError(`modules[${i}] needs "lessons": [].`);
    let existing = null;
    if (m.module !== undefined) {
      const ref = refString(m.module, `modules[${i}].module`);
      existing = outline.find((x) => x._id === ref || x.moduleName === ref);
      if (!existing) throw new Blocked(`modules[${i}]: the course has no module "${ref}".`);
    } else if (typeof m.moduleName !== 'string' || !m.moduleName.trim()) throw new UsageError(`modules[${i}] needs a moduleName (new) or "module" (existing).`);
    let nextLessonOrder = existing ? existing.lessons.reduce((max, l) => Math.max(max, l.order + 1), 0) : 0;
    const lessons = m.lessons.map((l, j) => {
      lessonCount += 1;
      const body = lessonBody(l, `modules[${i}].lessons[${j}]`, blockers, warnings, assessments);
      body.order = nextLessonOrder;
      nextLessonOrder += 1;
      return body;
    });
    modules.push(existing
      ? { existing: existing._id, moduleName: existing.moduleName, lessons }
      : {
        body: {
          moduleName: m.moduleName.trim(), ...(m.description ? { description: String(m.description) } : {}), order: (nextModuleOrder += 1) - 1,
        },
        lessons,
      });
  });
  if (lessonCount > MAX_LESSONS) throw new UsageError(`At most ${MAX_LESSONS} lessons per plan.`);
  for (const a of assessments) {
    const found = await findOne(client, 'assessment', a.ref, { codeField: 'assessmentCode', nameField: 'assessmentName', select: 'assessmentName status attemptsAllowed passingScore' });
    a.body.assessment = idOf(found);
    if (found.status !== 'Published') warnings.push(`Assessment "${found.assessmentName}" for quiz "${a.name}" is ${found.status || 'Draft'}.`);
  }

  // Program: optional; new (object) or existing (reference). The course is appended to it.
  let program = null;
  let programBody = null;
  if (plan.program && typeof plan.program === 'object' && !Array.isArray(plan.program)) {
    const unknown = Object.keys(plan.program).filter((k) => !PROGRAM_KEYS.has(k));
    if (unknown.length) throw new UsageError(`program: unknown field(s) ${unknown.join(', ')}.`);
    if (typeof plan.program.programName !== 'string' || !plan.program.programName.trim()) throw new UsageError('program.programName is required.');
    programBody = { programName: plan.program.programName.trim(), status: 'Draft' };
    if (plan.program.description) programBody.description = String(plan.program.description);
    if (plan.program.tags) programBody.tags = plan.program.tags;
    programBody.allowEveryone = { view: plan.program.allowEveryone === true };
    if (plan.program.teams) programBody.teams = await resolveTeams(client, plan.program.teams);
    if (plan.program.certificate !== undefined) programBody.certificate = checkCertificate(plan.program.certificate, 'program', blockers);
    if (!programBody.allowEveryone.view && !(programBody.teams || []).length) warnings.push('The program is open to nobody (no "everyone", no teams): only admins will see it.');
    const same = await list(client, 'program', { xquery: { programName: programBody.programName }, select: '_id', limit: '1' });
    if (same.length) blockers.push(`A program called "${programBody.programName}" already exists (${idOf(same[0])}). Use it by name or id.`);
  } else if (plan.program !== undefined) {
    program = await loadProgram(client, plan.program);
    versionParts.push(program.updatedAt);
  }
  const requiredInProgram = plan.requiredInProgram !== false;
  if (!course && !program && !programBody) warnings.push('No program given: students only reach courses through a published program. Add it to one before publishing.');

  const changes = [];
  if (courseBody) changes.push(`Create course "${courseBody.courseName}" as Draft${courseBody.certificate && courseBody.certificate.enabled ? ' with certificate' : ''}.`);
  else changes.push(`Add to course "${course.courseName}" (${course.status || 'Draft'}).`);
  if (courseSet) {
    Object.entries(courseSet).forEach(([k, v]) => changes.push(k === 'certificate'
      ? `Course certificate: ${v.enabled ? 'on' : 'off'}${v.template ? ', with design' : ', no design (no PDF)'}.`
      : `Course ${k}: ${JSON.stringify(course[k] ?? null)} → ${JSON.stringify(v)}.`));
    if (courseSet.certificate && courseSet.certificate.enabled && !(course.certificate && course.certificate.enabled)) {
      warnings.push('Turning certificates on does not certify people who already finished: use a "reissue" plan for each of them.');
    }
  }
  for (const m of modules) {
    changes.push(`${m.existing ? 'Module' : 'New module'} "${m.existing ? m.moduleName : m.body.moduleName}": ${m.lessons.map((l) => `${l.lessonName} [${l.type}${l.required === false ? ', optional' : ''}]`).join('; ') || 'no lessons'}.`);
  }
  if (programBody) changes.push(`Create program "${programBody.programName}" as Draft (access: ${programBody.allowEveryone.view ? 'everyone' : `${(programBody.teams || []).length} team(s)`}) and put the course in it${requiredInProgram ? ' as required' : ''}.`);
  if (program) changes.push(`Add the course to program "${program.programName}"${requiredInProgram ? ' as required for its certificate' : ''}.`);
  if (course && course.status === 'Published' && lessonCount) warnings.push('The course is already published: students see the new lessons right away, and in-progress students now have more required lessons (their percentage drops).');
  return {
    kind: 'build', course, courseBody, courseSet, modules, program, programBody, requiredInProgram, blockers, warnings, changes, recipients: [],
    version: hash({ k: 'build', plan, v: versionParts }),
  };
}

async function preparePublish(client, plan) {
  const status = plan.status === undefined ? 'Published' : plan.status;
  if (!STATUSES.includes(status)) throw new UsageError(`status must be one of ${STATUSES.join(', ')}.`);
  if (plan.course === undefined && plan.program === undefined) throw new UsageError('A publish plan needs "course", "program" or both.');
  const blockers = [];
  const warnings = [];
  const changes = [];
  const targets = [];
  const parts = [];
  let course = null;
  if (plan.course !== undefined) {
    course = await loadCourse(client, plan.course);
    const outline = outlineOf(course);
    const programs = await programsWithCourse(client, idOf(course));
    parts.push(course.updatedAt);
    if (status === 'Published') {
      const check = courseReadiness(course, outline, programs);
      blockers.push(...check.blockers);
      if (plan.program === undefined) warnings.push(...check.warnings);
      else warnings.push(...check.warnings.filter((w) => !/program/.test(w)));
    } else {
      const active = await list(client, 'enrollment', { xquery: { course: idOf(course), status: 'InProgress' }, select: '_id', limit: '200' });
      if (active.length) warnings.push(`${active.length} person(s) are taking this course: it disappears from their home and the catalog.`);
    }
    targets.push({ object: 'course', _id: idOf(course), body: { status, active: true } });
    changes.push(`Course "${course.courseName}": ${course.status || 'Draft'} → ${status}.`);
  }
  if (plan.program !== undefined) {
    const program = await loadProgram(client, plan.program);
    parts.push(program.updatedAt);
    if (status === 'Published') {
      if (!(program.courses || []).length) blockers.push(`Program "${program.programName}" has no courses.`);
      if (course && !(program.courses || []).map(idOf).includes(idOf(course))) blockers.push(`Course "${course.courseName}" is not in program "${program.programName}". Add it with a build plan first.`);
      if (accessView(program) === 'admins only') warnings.push(`Program "${program.programName}" is open to nobody (no "everyone", no teams): only admins will see it.`);
      if (program.certificate && program.certificate.enabled && !(program.requiredCourses || []).length) warnings.push('The program issues a certificate but has no required courses: that certificate is never issued.');
      const courses = (program.courses || []).length
        ? await list(client, 'course', { xquery: { _id: { $in: (program.courses || []).map(idOf) } }, select: 'courseName status active', limit: '200' })
        : [];
      const drafts = courses.filter((c) => c.status !== 'Published' && (!course || idOf(c) !== idOf(course)));
      if (drafts.length) warnings.push(`Courses not published yet (students will not see them): ${drafts.map((c) => c.courseName).join(', ')}.`);
    }
    targets.push({ object: 'program', _id: idOf(program), body: { status, active: true } });
    changes.push(`Program "${program.programName}": ${program.status || 'Draft'} → ${status}.`);
  }
  if (status === 'Published') warnings.push('Publishing sends no e-mail or notice: people see it in the catalog and on their home.');
  return {
    kind: 'publish', targets, blockers, warnings, changes, recipients: [], version: hash({ k: 'publish', plan, v: parts }),
  };
}

async function prepareEnroll(client, plan) {
  if (!Array.isArray(plan.users) || !plan.users.length) throw new UsageError('An enroll plan needs "users": ["person@example.com", …].');
  if (plan.users.length > MAX_USERS) throw new UsageError(`At most ${MAX_USERS} users per plan.`);
  const blockers = [];
  const warnings = [];
  const course = await loadCourse(client, plan.course);
  if (course.status !== 'Published' || course.active === false) blockers.push(`Course "${course.courseName}" is ${course.status || 'Draft'}: enrolled people would not see it. Publish it first.`);
  const programs = await programsWithCourse(client, idOf(course));
  let program = null;
  if (plan.program !== undefined) {
    program = await loadProgram(client, plan.program);
    if (!programs.some((p) => idOf(p) === idOf(program))) blockers.push(`Course "${course.courseName}" is not in program "${program.programName}".`);
  }
  const items = [];
  const parts = [course.updatedAt];
  for (const email of [...new Set(plan.users.map((u) => String(u).toLowerCase().trim()))]) {
    const user = await userByEmail(client, email);
    if (user.active === false) {
      blockers.push(`${email} is an inactive user.`);
      continue;
    }
    const reach = await reachablePrograms(client, program ? [program] : programs, user);
    let viaProgram = program;
    if (!reach.length) {
      const live = (program ? [program] : programs).filter((p) => p.status === 'Published' && p.active !== false);
      blockers.push(live.length
        ? `${email} cannot reach this course: its published program(s) (${live.map((p) => p.programName).join(', ')}) are not open to everyone nor to one of their teams. Add their team to the program (in the app) or open it to everyone.`
        : `${email} cannot reach this course: no published program holds it${programs.length ? ` (${programs.map((p) => `${p.programName}: ${p.status || 'Draft'}`).join(', ')})` : ''}. Publish the program first.`);
      continue;
    }
    if (!viaProgram) {
      const certifying = reach.filter((p) => (p.requiredCourses || []).map(idOf).includes(idOf(course)));
      if (reach.length === 1) [viaProgram] = reach;
      else if (certifying.length === 1) [viaProgram] = certifying;
      else blockers.push(`${email} reaches this course through several programs (${reach.map((p) => p.programName).join(', ')}): say which one, it decides the program certificate.`);
    }
    const existing = await enrollmentsOf(client, idOf(user), idOf(course));
    parts.push(existing.map((e) => [idOf(e), e.status, e.updatedAt]));
    const open = existing.find((e) => e.status === 'InProgress');
    if (open) {
      items.push({ user, skip: `already enrolled and in progress (${open.progressPercent || 0}%)` });
      continue;
    }
    const finished = existing.find((e) => e.status === 'Completed');
    if (finished) warnings.push(`${email} already completed this course on ${day(finished.completedAt) || '?'}: this starts a new attempt from 0%.`);
    if (!user.isAdmin) warnings.push(`${email} is not an admin: they need a role with Academy permissions (for example "Profile - Academy Student"). Without it the course shows on their home but the app does not let them open it.`);
    items.push({
      user,
      body: { assignee: idOf(user), course: idOf(course), ...(viaProgram ? { program: idOf(viaProgram) } : {}) },
      program: viaProgram,
    });
  }
  const changes = items.map((i) => (i.skip
    ? `${i.user.email}: skipped, ${i.skip}.`
    : `Enroll ${i.user.email} in "${course.courseName}"${i.program ? ` (program "${i.program.programName}")` : ''}.`));
  warnings.push('Enrolling sends no e-mail and no notice: tell the people yourself (they find the course on their home and under My courses).');
  return {
    kind: 'enroll', course, items, blockers, warnings, changes, recipients: [], version: hash({ k: 'enroll', plan, v: parts }),
  };
}

// What finishing an enrollment sets off: the course certificate, a badge (which notifies
// and e-mails the person) and the program certificate check.
function completionEffects(course, enrollment, programs) {
  const effects = [];
  if (course.certificate && course.certificate.enabled) effects.push(`course certificate${course.certificate.template ? ' with PDF' : ' (no design: no PDF)'}`);
  else effects.push('no course certificate (certificate is off)');
  if (course.badgeNomination) effects.push('a badge, which notifies and e-mails the person');
  const program = programs.find((p) => idOf(p) === idOf(enrollment.program));
  if (program && program.certificate && program.certificate.enabled && course.certificate && course.certificate.enabled) {
    effects.push(`a program certificate for "${program.programName}" if all its required courses are completed`);
  }
  return effects;
}

async function prepareComplete(client, plan) {
  if (!Array.isArray(plan.lessons) || !plan.lessons.length) throw new UsageError('A complete plan needs "lessons": ["<lesson id or name>", …].');
  const blockers = [];
  const warnings = [];
  const user = await userByEmail(client, plan.user);
  const course = await loadCourse(client, plan.course);
  const outline = outlineOf(course);
  const all = lessonsOf(outline);
  const enrollment = (await enrollmentsOf(client, idOf(user), idOf(course))).find((e) => e.status === 'InProgress');
  if (!enrollment) throw new Blocked(`${user.email} has no in-progress enrollment in "${course.courseName}".`);
  const done = await progressOfEnrollment(client, idOf(enrollment));
  const lessons = plan.lessons.map((r) => {
    const ref = refString(r, 'lesson');
    const hits = all.filter((l) => l._id === ref || l.lessonName === ref);
    if (hits.length !== 1) throw new Blocked(`Lesson "${ref}" ${hits.length ? 'is ambiguous; use its id' : 'is not in this course'}.`);
    return hits[0];
  });
  const changes = [];
  const toMark = [];
  for (const l of lessons) {
    const p = done.get(l._id);
    if (p && p.status === 'Completed') {
      changes.push(`"${l.lessonName}": already done, skipped.`);
      continue;
    }
    if (l.completionRule !== 'Manual') warnings.push(`"${l.lessonName}" is ${l.completionRule}: normally the student completes it in the player. You are marking it done for them.`);
    toMark.push(l);
    changes.push(`Mark "${l.lessonName}" as done by an instructor for ${user.email}.`);
  }
  const completed = new Set([...done.entries()].filter(([, p]) => p.status === 'Completed').map(([id]) => id));
  toMark.forEach((l) => completed.add(l._id));
  const after = progressOf(all.filter((l) => l.required).map((l) => l._id), completed);
  const programs = await programsWithCourse(client, idOf(course));
  const recipients = [];
  if (after === 100) {
    const effects = completionEffects(course, enrollment, programs);
    changes.push(`The enrollment reaches 100% and becomes Completed: ${effects.join('; ')}.`);
    if (course.badgeNomination) recipients.push({ email: user.email, why: 'badge notice and e-mail' });
  } else changes.push(`Progress goes from ${enrollment.progressPercent || 0}% to ${after ?? 0}%.`);
  return {
    kind: 'complete', user, course, enrollment, toMark, blockers, warnings, changes, recipients, after,
    version: hash({ k: 'complete', plan, v: [enrollment.updatedAt, [...done.keys()]] }),
  };
}

async function prepareReissue(client, plan) {
  const blockers = [];
  const warnings = [];
  const user = await userByEmail(client, plan.user);
  const course = await loadCourse(client, plan.course);
  const enrollments = await enrollmentsOf(client, idOf(user), idOf(course));
  const outline = outlineOf(course);
  const required = lessonsOf(outline).filter((l) => l.required).map((l) => l._id);
  let enrollment = enrollments.find((e) => e.status === 'Completed');
  if (!enrollment) {
    const open = enrollments.find((e) => e.status === 'InProgress');
    if (open) {
      const done = await progressOfEnrollment(client, idOf(open));
      const completed = new Set([...done.entries()].filter(([, p]) => p.status === 'Completed').map(([id]) => id));
      if (progressOf(required, completed) === 100) enrollment = open;
      else blockers.push(`${user.email} has not finished "${course.courseName}" (required lessons pending). Nothing to reissue.`);
    } else blockers.push(`${user.email} has no completed enrollment in "${course.courseName}".`);
  }
  if (!(course.certificate && course.certificate.enabled)) blockers.push(`Course "${course.courseName}" has certificates off: turn them on first.`);
  const changes = [];
  const recipients = [];
  if (enrollment) {
    const certs = await list(client, 'certificate', { xquery: { enrollment: idOf(enrollment), type: 'Course' }, select: 'certificateCode', limit: '1' });
    if (certs.length) blockers.push(`The certificate ${certs[0].certificateCode} already exists for this enrollment. A missing PDF cannot be regenerated from here.`);
    const programs = await programsWithCourse(client, idOf(course));
    changes.push(`Mark the enrollment of ${user.email} as Completed again so the server issues: ${completionEffects(course, enrollment, programs).join('; ')}.`);
    if (course.badgeNomination) {
      warnings.push('The course gives a badge: if the person does not have it yet, they get it now with a notice and an e-mail.');
      recipients.push({ email: user.email, why: 'badge notice and e-mail (only if not awarded before)' });
    }
  }
  return {
    kind: 'reissue', user, course, enrollment, blockers, warnings, changes, recipients,
    version: hash({ k: 'reissue', plan, v: enrollment ? [idOf(enrollment), enrollment.updatedAt] : [] }),
  };
}

const KINDS = {
  build: prepareBuild, publish: preparePublish, enroll: prepareEnroll, complete: prepareComplete, reissue: prepareReissue,
};

async function prepare(client, plan) {
  const fn = KINDS[plan.kind];
  if (!fn) throw new UsageError(`"kind" must be one of ${Object.keys(KINDS).join(', ')}.`);
  return fn(client, plan);
}

async function cmdPreview(client, [planArg], flags, ctx) {
  const plan = readPlan(planArg, ctx.rootDir);
  const prep = await prepare(client, plan);
  const reach = prep.recipients.length ? ' and --reaches-people (only after the user said yes to the recipients listed)' : '';
  const out = {
    kind: plan.kind,
    changes: prep.changes,
    recipients: prep.recipients,
    warnings: prep.warnings,
    blockers: prep.blockers,
    version: prep.version,
  };
  out.nextStep = prep.blockers.length
    ? 'Blocked: nothing can be written until every blocker is solved. Tell the user and ask how to proceed.'
    : `${STOP}apply with the same plan, --version ${prep.version}, --confirmed${reach}.`;
  return out;
}

// ─── Apply ─────────────────────────────────────────────────────────────────────

async function applyBuild(client, prep) {
  const created = { program: null, course: null, modules: [], lessons: [] };
  const problems = [];
  try {
    if (prep.programBody) created.program = idOf(await call(client, 'POST', '/v2/program', { data: prep.programBody, confirmed: true }));
    const courseId = prep.course ? idOf(prep.course) : idOf(await call(client, 'POST', '/v2/course', { data: prep.courseBody, confirmed: true }));
    if (!prep.course) created.course = courseId;
    if (prep.courseSet) await call(client, 'PATCH', `/v2/course/${courseId}`, { data: prep.courseSet, confirmed: true });
    for (const m of prep.modules) {
      let moduleId = m.existing;
      if (!moduleId) {
        moduleId = idOf(await call(client, 'POST', '/v2/module', { data: { ...m.body, origin: { modelName: 'Course', docId: courseId } }, confirmed: true }));
        created.modules.push(moduleId);
      }
      for (const l of m.lessons) {
        created.lessons.push(idOf(await call(client, 'POST', '/v2/lesson', { data: { ...l, origin: { modelName: 'Module', docId: moduleId } }, confirmed: true })));
      }
    }
    const programId = created.program || (prep.program && idOf(prep.program));
    if (programId) {
      const current = prep.program || { courses: [], requiredCourses: [] };
      const courses = [...new Set([...(current.courses || []).map(idOf), courseId])];
      const body = { courses };
      if (prep.requiredInProgram) body.requiredCourses = [...new Set([...(current.requiredCourses || []).map(idOf), courseId])];
      await call(client, 'PATCH', `/v2/program/${programId}`, { data: body, confirmed: true });
      const back = await loadProgram(client, programId);
      if (!(back.courses || []).map(idOf).includes(courseId)) problems.push('The program does not read back with the course in it.');
    }
    const back = await loadCourse(client, courseId);
    const outline = outlineOf(back);
    const ids = new Set(lessonsOf(outline).map((l) => l._id));
    const missing = created.lessons.filter((id) => !ids.has(id));
    if (missing.length) problems.push(`${missing.length} new lesson(s) do not read back inside the course.`);
    created.modules.forEach((id) => { if (!outline.some((m) => m._id === id)) problems.push(`Module ${id} does not read back inside the course.`); });
    if (prep.courseSet) {
      Object.entries(prep.courseSet).forEach(([k, v]) => {
        if (JSON.stringify(back[k] ?? null) !== JSON.stringify(v)) problems.push(`Course ${k} does not read back as planned.`);
      });
    }
    return { saved: !problems.length, created, course: { _id: courseId, status: back.status, outline }, problems };
  } catch (err) {
    if (err.status === 403) throw err;
    problems.push(`Stopped at: ${err.message}. Records created so far are listed in "created"; running the same plan again would create them twice: fix the cause and build only what is missing.`);
    return { saved: false, created, problems };
  }
}

async function applyPublish(client, prep) {
  const done = [];
  const problems = [];
  for (const t of prep.targets) {
    await call(client, 'PATCH', `/v2/${t.object}/${t._id}`, { data: t.body, confirmed: true });
    const back = (await list(client, t.object, { xquery: { _id: t._id }, select: 'status active', limit: '1' }))[0] || {};
    if (back.status !== t.body.status) problems.push(`${t.object} ${t._id} reads back as ${back.status}.`);
    done.push({ object: t.object, _id: t._id, status: back.status });
  }
  return { updated: done, problems };
}

async function applyEnroll(client, prep) {
  const done = [];
  const problems = [];
  for (const item of prep.items) {
    if (item.skip) {
      done.push({ user: item.user.email, skipped: item.skip });
      continue;
    }
    const res = await client.request('POST', '/v2/enrollment', { data: item.body, confirmed: true });
    if (res.status === 403) {
      const err = new Error(`POST /v2/enrollment answered 403: ${(res.body && res.body.error) || 'forbidden'}`);
      err.status = 403;
      throw err;
    }
    if (!res.ok) {
      problems.push(`${item.user.email}: the server refused (${res.status}: ${(res.body && res.body.error) || 'no message'}).`);
      continue;
    }
    const back = (await list(client, 'enrollment', { xquery: { _id: idOf(res.body) }, select: 'assignee course program status enrollmentCode', limit: '1' }))[0];
    if (!back || idOf(back.assignee) !== item.body.assignee || back.status !== 'InProgress') problems.push(`${item.user.email}: the enrollment does not read back as expected.`);
    done.push({ user: item.user.email, enrollment: idOf(res.body), code: back && back.enrollmentCode, program: back ? idOf(back.program) || null : null });
  }
  return { enrolled: done, problems };
}

async function applyComplete(client, prep) {
  const problems = [];
  for (const l of prep.toMark) {
    await call(client, 'POST', '/v2/lessonprogress/trackProgress', {
      data: {
        enrollment: idOf(prep.enrollment), lesson: l._id, status: 'Completed', completedBy: 'Admin', progressPercent: 100,
      },
      confirmed: true,
    });
  }
  const back = (await list(client, 'enrollment', { xquery: { _id: idOf(prep.enrollment) }, select: 'status progressPercent', limit: '1' }))[0] || {};
  if (prep.after !== null && (back.progressPercent || 0) !== prep.after) problems.push(`Progress reads back as ${back.progressPercent || 0}%, expected ${prep.after}%.`);
  const certs = back.status === 'Completed'
    ? await list(client, 'certificate', { xquery: { enrollment: idOf(prep.enrollment) }, select: 'certificateCode type pdfFile', limit: '5' })
    : [];
  if (back.status === 'Completed' && prep.course.certificate && prep.course.certificate.enabled && !certs.some((c) => c.type === 'Course')) {
    problems.push('The course is completed but no course certificate reads back yet. Run diagnose.');
  }
  return {
    enrollment: idOf(prep.enrollment), status: back.status, progressPercent: back.progressPercent || 0,
    certificates: certs.map((c) => ({ code: c.certificateCode, type: c.type, pdf: !!c.pdfFile })), problems,
  };
}

async function applyReissue(client, prep) {
  await call(client, 'PATCH', `/v2/enrollment/${idOf(prep.enrollment)}`, { data: { status: 'Completed' }, confirmed: true });
  const certs = await list(client, 'certificate', { xquery: { enrollment: idOf(prep.enrollment) }, select: 'certificateCode type pdfFile', limit: '5' });
  const problems = certs.some((c) => c.type === 'Course') ? [] : ['No course certificate reads back. Run diagnose.'];
  return { enrollment: idOf(prep.enrollment), certificates: certs.map((c) => ({ code: c.certificateCode, type: c.type, pdf: !!c.pdfFile })), problems };
}

const APPLY = {
  build: applyBuild, publish: applyPublish, enroll: applyEnroll, complete: applyComplete, reissue: applyReissue,
};

async function cmdApply(client, [planArg], flags, ctx) {
  if (!flags.version) throw new UsageError('Missing --version. Run preview first and pass its version.');
  if (!flags.confirmed) throw new UsageError('Refusing to write without --confirmed. Show the preview to the user and wait for a yes.');
  const plan = readPlan(planArg, ctx.rootDir);
  const prep = await prepare(client, plan);
  if (prep.blockers.length) return { applied: false, blockers: prep.blockers };
  if (prep.version !== flags.version) throw new Blocked('The records or the plan changed since the preview. Run preview again and show it to the user.');
  if (prep.recipients.length && !flags.reachesPeople) {
    throw new UsageError('This write notifies and e-mails people (see "recipients" in the preview). It needs --reaches-people, given only after the user said yes to those recipients.');
  }
  return APPLY[plan.kind](client, prep);
}

// ─── Entry point ───────────────────────────────────────────────────────────────

function parseCli(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new UsageError(`Missing value for ${arg}.`);
      i += 1;
      return argv[i];
    };
    if (arg === '--confirmed') flags.confirmed = true;
    else if (arg === '--reaches-people') flags.reachesPeople = true;
    else if (arg === '--version') flags.version = next();
    else if (arg === '--profile') flags.profile = next();
    else if (arg === '--status') flags.status = next();
    else if (arg === '--user') flags.user = next();
    else if (arg === '--limit') flags.limit = Math.min(Math.max(Number(next()) || 50, 1), 200);
    else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  return { command: positional[0], domain: positional[1], rest: positional.slice(2), flags };
}

const COMMANDS = {
  programs: cmdPrograms,
  course: cmdCourse,
  progress: cmdProgress,
  diagnose: cmdDiagnose,
  certificates: cmdCertificates,
  preview: cmdPreview,
  apply: cmdApply,
};

// A 403 is final: the profile's user may not do this. Say so plainly so nobody retries it
// another way or with another profile.
const FORBIDDEN_HINT = 'The user of this profile does not have permission for this (403). The script stopped at '
  + 'this request: it did not retry it or try another profile. Tell the user; an admin can grant the permission.';

async function main(argv, opts = {}) {
  const rootDir = opts.rootDir || DEFAULT_ROOT;
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  let client;
  const hide = (text) => (client ? client.redact(text) : String(text));
  try {
    const { command, domain, rest, flags } = parseCli(argv);
    const handler = COMMANDS[command];
    if (!handler || !domain) throw new UsageError(`Usage: academy.js <${Object.keys(COMMANDS).join('|')}> <domain> … (see the header of this file)`);
    client = createClient({ domain, rootDir, profile: flags.profile, fetchImpl: opts.fetchImpl, stderr });
    const result = await handler(client, rest, flags, { rootDir });
    stdout.write(`${hide(JSON.stringify(result, null, 2))}\n`);
    if (result.blockers && result.blockers.length && command !== 'course') return BLOCKED;
    if (result.problems && result.problems.length) return 1;
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      stderr.write(`${hide(err.message)}\n`);
      return 2;
    }
    if (err instanceof Blocked) {
      stderr.write(`BLOCKED: ${hide(err.message)}\n`);
      return BLOCKED;
    }
    if (err && err.status === 403) {
      stderr.write(`FORBIDDEN: ${hide(err.message)}\n${FORBIDDEN_HINT}\n`);
      return 1;
    }
    stderr.write(`Request failed: ${hide(err && err.message)}\n`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = {
  main, progressOf, unsafeHtml, outlineOf, courseReadiness, CERT_VARS,
};
