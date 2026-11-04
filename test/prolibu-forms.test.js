/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const form = require('../.claude/skills/prolibu-forms/scripts/form');

const D = 'dev99.example.com';
const FORM = 'f'.repeat(24);
const CONTACT = 'c'.repeat(24);

let rootDir;
let tmpDir;
let out;
let err;
let calls;
let state;

const CONTACT_FIELDS = [
  { attrPath: 'createdBy', type: 'objectid', ref: 'User', required: true },
  { attrPath: 'firstName', type: 'string', required: false },
  { attrPath: 'email', type: 'string', required: true },
  { attrPath: 'mobile', type: 'string', required: false },
  { attrPath: 'source', type: 'string', required: false },
  { attrPath: 'direction', type: 'string', enum: ['Inbound', 'Outbound'], required: false },
  { attrPath: 'address.city', type: 'string', required: false },
  { attrPath: 'tags', type: 'string', ref: 'Tag', required: false },
];

const goodSchema = {
  fullName: { type: 'String', label: 'Name', required: true },
  email: { type: 'String', format: 'email', label: 'Email', required: true },
  phone: { type: 'String', uiCom: 'PhoneWithIndicative', label: 'Phone' },
};

const goodDefinition = () => ({
  formName: 'QA web form',
  formSchema: goodSchema,
  mappings: [{ modelName: 'Contact', action: 'create', fieldMap: { fullName: 'firstName', email: 'email', phone: 'mobile' } }],
  access: { mode: 'public', enableCaptcha: true },
  thankYou: { title: 'Thanks', message: 'We got it.' },
  submissions: { persist: true },
});

function respond(status, body) {
  return { status, text: async () => JSON.stringify(body) };
}

function dropNulls(value) {
  return JSON.parse(JSON.stringify(value, (k, v) => (v === null && k ? undefined : v)));
}

// A small fake of the endpoints the script uses, shaped after the verified server behavior.
async function fakeFetch(url, init) {
  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body });
  const p = u.pathname;
  if (init.method === 'GET' && p === '/v2/form/getmodelfields/Contact') return respond(200, CONTACT_FIELDS);
  if (init.method === 'GET' && p.startsWith('/v2/form/getmodelfields/')) return respond(404, { statusCode: 404, error: 'Model not found' });
  if (init.method === 'GET' && p === '/v2/servicecredential') return respond(200, { data: state.credential ? [{ _id: 'x' }] : [] });
  if (init.method === 'GET' && p === `/v2/form/jsonschema/${FORM}`) {
    if (!state.form || state.form.active === false) return respond(404, { error: 'Form not found or inactive' });
    return respond(200, { formName: state.form.formName, turnstileSiteKey: state.credential ? 'site-key' : '' });
  }
  if (init.method === 'POST' && p === '/v2/form') {
    state.form = { active: true, ...dropNulls(body), _id: FORM, formCode: 'FRM-1', type: 'web', updatedAt: 'T1' };
    return respond(200, state.form);
  }
  if (init.method === 'GET' && (p === `/v2/form/${FORM}` || p === '/v2/form/FRM-1')) {
    return state.form ? respond(200, state.form) : respond(404, { error: 'Not found' });
  }
  if (init.method === 'PATCH' && p === `/v2/form/${FORM}`) {
    const next = { ...state.form };
    for (const [k, v] of Object.entries(body)) {
      next[k] = ['access', 'thankYou', 'submissions', 'uploads'].includes(k) ? { ...next[k], ...v } : dropNulls(v);
    }
    state.form = { ...next, updatedAt: 'T2' };
    return respond(200, state.form);
  }
  if (init.method === 'PUT' && p === '/v2/form/register') {
    state.registered = body;
    return respond(200, { results: state.registerResults || [{ modelName: 'Contact', action: 'create', recordId: CONTACT, status: 'success' }], redirectURL: null });
  }
  if (init.method === 'GET' && p === `/v2/contact/${CONTACT}`) return respond(200, state.contact);
  if (init.method === 'GET' && p === '/v2/formsubmission') {
    return respond(200, { data: [{ _id: 's1', status: 'processed', mappingResults: [], data: {}, createdAt: 'T3' }], pagination: { count: 1 } });
  }
  if (init.method === 'GET' && p === '/v2/form') return respond(200, { data: [state.form].filter(Boolean) });
  return respond(404, { error: `unexpected ${init.method} ${p}` });
}

const run = (argv) => form.main(argv, {
  rootDir, fetchImpl: fakeFetch,
  stdout: { write: (s) => { out += s; } },
  stderr: { write: (s) => { err += s; } },
});

const contactModels = () => ({ Contact: new Map(CONTACT_FIELDS.map((f) => [f.attrPath, f])) });

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-forms-root-'));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-forms-def-'));
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: 'SECRET123' }));
  out = '';
  err = '';
  calls = [];
  state = { credential: true, contact: { _id: CONTACT, firstName: 'Ann', email: 'ann@example.com', mobile: '+1 555' } };
});
afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('flattenFields and mergeForm', () => {
  test('a flat schema skips the meta keys; a paged one merges pages and reports repeated keys', () => {
    expect(Object.keys(form.flattenFields({ title: 'T', theme: {}, a: { type: 'String' } }).fields)).toEqual(['a']);
    const paged = form.flattenFields({ pages: [{ fields: { a: { type: 'String' } } }, { fields: { a: { type: 'Number' }, b: { type: 'String' } } }] });
    expect(paged.fields.a.type).toBe('Number');
    expect(paged.duplicates).toEqual(['a']);
  });

  test('sub-objects merge key by key while formSchema and mappings are replaced', () => {
    const stored = { access: { mode: 'public', enableCaptcha: true }, formSchema: { a: { type: 'String' } }, mappings: [{ modelName: 'Contact' }] };
    const merged = form.mergeForm(stored, { access: { mode: 'password', password: 'x' }, formSchema: { b: { type: 'String' } }, mappings: [] });
    expect(merged.access).toEqual({ mode: 'password', enableCaptcha: true, password: 'x' });
    expect(merged.formSchema).toEqual({ b: { type: 'String' } });
    expect(merged.mappings).toEqual([]);
    expect(stored.access.mode).toBe('public');
  });

  test('a definition may not set type, endings or formCode, and a new form needs a name', () => {
    expect(() => form.normalizeDefinition({ formName: 'x', endings: [] }, { forCreate: true })).toThrow('deprecated');
    expect(() => form.normalizeDefinition({ formName: 'x', type: 'meta' }, { forCreate: true })).toThrow('cannot be set');
    expect(() => form.normalizeDefinition({ formName: 'x', formCode: 'FRM-2' }, { forCreate: true })).toThrow('cannot be set');
    expect(() => form.normalizeDefinition({ formSchema: {} }, { forCreate: true })).toThrow('formName');
    expect(form.normalizeDefinition({ formName: 'x', formSchema: '{"a":{"type":"String"}}' }, { forCreate: true }).formSchema).toEqual({ a: { type: 'String' } });
  });
});

describe('checkForm', () => {
  test('a form built like the app builds it passes', () => {
    const result = form.checkForm({ ...goodDefinition(), _id: FORM }, contactModels(), { captchaReady: true });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.submittable.ok).toBe(true);
  });

  test('mirrors the server rules that reject a save', () => {
    const def = {
      ...goodDefinition(),
      formSchema: { ...goodSchema, quiz: { type: 'Object', uiCom: 'Matching' }, bare: { label: 'x' } },
      mappings: [
        { modelName: 'Contact', fieldMap: { email: 'email', missing: 'firstName' } },
        { modelName: 'Contact', action: 'update', fieldMap: {} },
        { modelName: 'Lead', fieldMap: { email: 'email' } },
      ],
    };
    const { errors } = form.checkForm(def, { ...contactModels(), Lead: null }, { captchaReady: true });
    const text = errors.join('\n');
    expect(text).toContain('invalid type "Object"');
    expect(text).toContain('Field "bare" has no "type"');
    expect(text).toContain('fieldMap key "missing" is not a field of the form');
    expect(text).toContain('action "update" is not supported');
    expect(text).toContain('needs a non-empty "fieldMap"');
    expect(text).toContain('"Lead" is not an object of this account');
  });

  test('catches what saves but never creates the record', () => {
    const def = {
      ...goodDefinition(),
      mappings: [{ modelName: 'Contact', fieldMap: { fullName: 'fistName', phone: 'mobile' }, defaults: { direction: 'Walk-in' } }],
    };
    const text = form.checkForm(def, contactModels(), { captchaReady: true }).errors.join('\n');
    expect(text).toContain('"fistName", which is not a field of Contact');
    expect(text).toContain('Contact requires email');
    expect(text).toContain('default "Walk-in" is not a value of Contact.direction');
  });

  test('a default fills a required field', () => {
    const def = { ...goodDefinition(), mappings: [{ modelName: 'Contact', fieldMap: { fullName: 'firstName' }, defaults: { email: 'web@example.com' } }] };
    expect(form.checkForm(def, contactModels(), { captchaReady: true }).errors).toEqual([]);
  });

  test('warns about fields the hosted page does not understand and weak mappings', () => {
    const def = {
      ...goodDefinition(),
      formSchema: {
        fullName: { type: 'String', label: 'Name' },
        email: { type: 'email', label: 'Email', required: true },
        kind: { type: 'String', enum: ['Inbound', 'Walk-in'] },
        about: { uiCom: 'Section', label: 'About you' },
        title: { type: 'String', label: 'Title' },
      },
      mappings: [{ modelName: 'Contact', fieldMap: { fullName: 'firstName', email: 'email', kind: 'direction', about: 'source' } }],
    };
    const text = form.checkForm(def, contactModels(), { captchaReady: true }).warnings.join('\n');
    expect(text).toContain('uses type "email"');
    expect(text).toContain('{"type":"String","format":"email"}');
    expect(text).toContain('["Walk-in"]');
    expect(text).toContain('section title');
    expect(text).toContain('A field named "title" is ignored');
  });

  test('a required object field fed by an optional form field is a warning', () => {
    const def = { ...goodDefinition(), formSchema: { ...goodSchema, email: { type: 'String', format: 'email' } } };
    expect(form.checkForm(def, contactModels(), { captchaReady: true }).warnings.join(' ')).toContain('"email" is optional');
  });

  test('an empty access mode with captcha on can never be submitted', () => {
    const def = { ...goodDefinition(), access: { enableCaptcha: true } };
    const result = form.checkForm(def, contactModels(), { captchaReady: true });
    expect(result.errors.join(' ')).toContain('access.mode is empty');
    expect(result.submittable).toEqual({ ok: false, reason: 'access.mode is empty' });
    const open = form.checkForm({ ...def, access: { enableCaptcha: false } }, contactModels());
    expect(open.errors).toEqual([]);
    expect(open.warnings.join(' ')).toContain('Set it explicitly');
  });

  test('public with captcha needs a Turnstile credential', () => {
    const result = form.checkForm(goodDefinition(), contactModels(), { captchaReady: false });
    expect(result.submittable.ok).toBe(false);
    expect(result.warnings.join(' ')).toContain('Cloudflare Turnstile');
  });

  test('the server only generates a password on create', () => {
    const def = { ...goodDefinition(), access: { mode: 'password' } };
    expect(form.checkForm(def, contactModels()).notes.join(' ')).toContain('generates one');
    expect(form.checkForm({ ...def, _id: FORM }, contactModels()).errors.join(' ')).toContain('Set access.password');
  });
});

describe('commands', () => {
  test('preview writes nothing and exits 3 when the form cannot be saved', async () => {
    const def = { ...goodDefinition(), mappings: [{ modelName: 'Contact', fieldMap: { fullName: 'firstName' } }] };
    expect(await run(['preview', D, JSON.stringify(def)])).toBe(3);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    expect(JSON.parse(out).errors.join(' ')).toContain('Contact requires email');
  });

  test('preview checks the captcha credential for a public form', async () => {
    state.credential = false;
    expect(await run(['preview', D, JSON.stringify(goodDefinition())])).toBe(0);
    expect(calls.map((c) => c.path)).toContain('/v2/servicecredential');
    expect(JSON.parse(out).submittable.ok).toBe(false);
  });

  test('create needs --confirmed and refuses a form with errors', async () => {
    expect(await run(['create', D, JSON.stringify(goodDefinition())])).toBe(2);
    expect(calls).toHaveLength(0);
    const bad = { ...goodDefinition(), access: {} };
    expect(await run(['create', D, JSON.stringify(bad), '--confirmed'])).toBe(3);
    expect(err).toContain('access.mode is empty');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  test('create posts the definition, reads it back and returns the public links', async () => {
    expect(await run(['create', D, JSON.stringify(goodDefinition()), '--confirmed'])).toBe(0);
    const post = calls.find((c) => c.method === 'POST');
    expect(post.path).toBe('/v2/form');
    expect(Object.keys(post.body).sort()).toEqual(['access', 'formName', 'formSchema', 'mappings', 'submissions', 'thankYou']);
    const result = JSON.parse(out);
    expect(result.saved).toBe(true);
    expect(result.form.links.view).toBe(`https://${D}/v2/form/view/${FORM}`);
    expect(result.form.links.viewByCode).toBe(`https://${D}/v2/form/view/FRM-1`);
    expect(result.submittable.ok).toBe(true);
  });

  test('a definition can come from a temp file, but not from anywhere else', async () => {
    const file = path.join(tmpDir, 'form.json');
    fs.writeFileSync(file, JSON.stringify(goodDefinition()));
    expect(await run(['preview', D, file])).toBe(0);
    const outside = path.join(__dirname, `outside-form-${process.pid}.json`);
    fs.writeFileSync(outside, JSON.stringify(goodDefinition()));
    try {
      calls = [];
      expect(await run(['preview', D, outside])).toBe(2);
      expect(err).toContain('temp folder');
      expect(calls).toHaveLength(0);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  test('update needs the version from preview and stops if the form changed', async () => {
    await run(['create', D, JSON.stringify(goodDefinition()), '--confirmed']);
    const change = JSON.stringify({ access: { mode: 'authenticated' } });
    calls = [];
    expect(await run(['update', D, FORM, change, '--confirmed'])).toBe(2);
    expect(await run(['update', D, FORM, change, '--form-version', 'T0', '--confirmed'])).toBe(3);
    expect(err).toContain('changed since the preview');
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  test('update sends sub-objects whole and verifies the read-back', async () => {
    await run(['create', D, JSON.stringify(goodDefinition()), '--confirmed']);
    out = '';
    calls = [];
    expect(await run(['update', D, FORM, '{"access":{"mode":"authenticated"}}', '--form-version', 'T1', '--confirmed'])).toBe(0);
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch.body).toEqual({ access: { mode: 'authenticated', enableCaptcha: true } });
    expect(JSON.parse(out)).toMatchObject({ saved: true, formVersion: 'T2' });
  });

  test('update refuses a schema change that leaves mappings pointing at removed fields', async () => {
    await run(['create', D, JSON.stringify(goodDefinition()), '--confirmed']);
    const change = JSON.stringify({ formSchema: { fullName: goodSchema.fullName, email: goodSchema.email } });
    expect(await run(['preview', D, change, '--form', FORM])).toBe(3);
    expect(JSON.parse(out.slice(out.lastIndexOf('{\n  "form"'))).hint).toContain('without phone');
    calls = [];
    expect(await run(['update', D, FORM, change, '--form-version', 'T1', '--confirmed'])).toBe(3);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  test('a null inside the schema, which the server drops, is not a read-back problem', async () => {
    const def = goodDefinition();
    def.formSchema = { ...goodSchema, company: { type: 'String', placeholder: null } };
    out = '';
    expect(await run(['create', D, JSON.stringify(def), '--confirmed'])).toBe(0);
    expect(JSON.parse(out).problems).toEqual([]);
  });

  test('submit-test needs --confirmed and never runs on a captcha form', async () => {
    state.form = { ...goodDefinition(), _id: FORM, active: true, updatedAt: 'T1' };
    const data = JSON.stringify({ fullName: 'Ann', email: 'ann@example.com' });
    expect(await run(['submit-test', D, FORM, data])).toBe(2);
    expect(calls).toHaveLength(0);
    expect(await run(['submit-test', D, FORM, data, '--confirmed'])).toBe(3);
    expect(err).toContain('captcha');
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  test('submit-test sends the stored password without printing it and reads the record back', async () => {
    state.form = { ...goodDefinition(), _id: FORM, active: true, access: { mode: 'password', password: 'pw-123' }, updatedAt: 'T1' };
    expect(await run(['submit-test', D, FORM, '{"fullName":"Ann","email":"ann@example.com","phone":"+1 555"}', '--confirmed'])).toBe(0);
    expect(state.registered).toEqual({ id: FORM, data: { fullName: 'Ann', email: 'ann@example.com', phone: '+1 555' }, password: 'pw-123' });
    const result = JSON.parse(out);
    expect(result.ok).toBe(true);
    expect(result.records[0]).toMatchObject({ status: 'success', recordId: CONTACT, stored: { firstName: 'Ann', email: 'ann@example.com', mobile: '+1 555' } });
    expect(out + err).not.toContain('pw-123');
  });

  test('submit-test checks required fields first and explains a failed mapping', async () => {
    state.form = { ...goodDefinition(), _id: FORM, active: true, access: { mode: 'authenticated' }, updatedAt: 'T1' };
    expect(await run(['submit-test', D, FORM, '{"fullName":"Ann"}', '--confirmed'])).toBe(2);
    expect(err).toContain('email');
    state.registerResults = [{ modelName: 'Contact', action: 'create', status: 'failed', error: 'Duplicated value' }];
    out = '';
    expect(await run(['submit-test', D, FORM, '{"fullName":"Ann","email":"ann@example.com"}', '--confirmed'])).toBe(1);
    expect(JSON.parse(out).records[0].explanation).toContain('already exists');
  });

  test('show never prints the form password or the API key', async () => {
    state.form = { ...goodDefinition(), _id: FORM, active: true, access: { mode: 'password', password: 'pw-123' }, updatedAt: 'T1' };
    expect(await run(['show', D, 'FRM-1'])).toBe(0);
    const result = JSON.parse(out);
    expect(result.form.access).toEqual({ mode: 'password', enableCaptcha: true, hasPassword: true });
    expect(out + err).not.toContain('pw-123');
    expect(out + err).not.toContain('SECRET123');
  });

  test('fields lists the object fields without the technical ones', async () => {
    expect(await run(['fields', D, 'Contact'])).toBe(0);
    const result = JSON.parse(out);
    expect(result.required).toEqual(['email']);
    expect(result.fields.map((f) => f.path)).not.toContain('createdBy');
    expect(result.fields.find((f) => f.path === 'tags').list).toBe(true);
    expect(await run(['fields', D, 'Nope'])).toBe(3);
  });
});
