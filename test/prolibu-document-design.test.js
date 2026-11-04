/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const ds = require('../.claude/skills/prolibu-document-design/scripts/design');

const D = 'dev99.example.com';
const KEY = 'test-key-123456';
const SELLER_KEY = 'seller-key-654321';
const LAYOUT = 'a'.repeat(24);
const SNIPPET = 'b'.repeat(24);
const GLOBAL = 'c'.repeat(24);
const DEAL = 'd'.repeat(24);
const PRES = 'e'.repeat(24);
const FAMILY = 'f'.repeat(24);
const VIEW = '1'.repeat(24);
const CONTACT = '2'.repeat(24);

let rootDir;
let out;
let err;
let calls;
let state;
let seq;

const respond = (status, body) => ({ status, text: async () => JSON.stringify(body) });

function freshState() {
  return {
    contenttemplate: [
      {
        _id: LAYOUT, contentTemplateName: 'Brand layout', contentTemplateCode: 'brand-layout', templateType: 'layout',
        pages: [{ id: 'p1' }], html: '<div>design</div>', codes: [{ c: 1 }], meta: { agentCard: true }, assets: ['9'.repeat(24)],
        defaultFont: 'FNT-1', embeddedFonts: ['FNT-1'], taxonomy: { language: 'es' }, active: true,
        retargeting: { metaPixelId: '1234567890' }, library: { publish: true, previewData: { contact: { email: 'x@example.com' } } },
        defaultLayout: { origin: 'User Company', company: '3'.repeat(24) }, updatedAt: '2026-01-01T00:00:00.000Z',
      },
      { _id: SNIPPET, contentTemplateName: 'Terms', contentTemplateCode: 'terms', templateType: 'snippet', html: '<p>t</p>', updatedAt: '2026-01-02T00:00:00.000Z' },
      { _id: GLOBAL, contentTemplateName: 'Global', contentTemplateCode: 'global', templateType: 'layout', html: '<p>g</p>', defaultLayout: { origin: 'Global Layout' }, updatedAt: '2026-01-03T00:00:00.000Z' },
    ],
    deal: [{ _id: DEAL, dealName: 'Big deal', 'proposal.template.layout': LAYOUT }],
    presentation: [{
      _id: PRES, title: 'Hello', presentationCode: 'presentation1', contact: { _id: CONTACT, firstName: 'Ana', lastName: 'Ruiz', email: 'ana@example.com' },
      layout: { _id: LAYOUT, contentTemplateName: 'Brand layout' }, expirationDate: '2020-01-01T00:00:00.000Z',
      tracking: {
        totalViews: 1, lastSeenAt: '2026-01-05T00:00:00.000Z', engagement: 4.43,
        views: [{ openedAt: '2026-01-05T00:00:00.000Z', viewDuration: 9281, contact: { firstName: 'Ana', lastName: 'Ruiz' }, ip: '203.0.113.9', agent: { device: 'Desktop', browser: 'Chrome' }, location: { city: 'Bogotá', country: 'Colombia', isp: 'Some ISP' } }],
      },
      layoutId: LAYOUT,
    }],
    contact: [{ _id: CONTACT, email: 'ana@example.com' }],
    messagetemplate: [],
    emailcampaign: [],
    proposalwizard: [],
    product: [{ _id: '4'.repeat(24), productName: 'Room', snippets: SNIPPET }],
    productfamily: [{ _id: FAMILY, productFamilyName: 'Rooms', snippets: null }],
    productgroup: [],
    font: [{ _id: '5'.repeat(24), fontName: 'Brand Sans', fontCode: 'FNT-1', updatedAt: 'x' }],
    customview: [{ _id: VIEW, customViewName: 'No prices', customViewCode: 'CVI-1', display: { quote: false, internalNotes: false }, updatedAt: '2026-01-04T00:00:00.000Z' }],
    dropFilters: [],
    forbid: false,
    leakKey: false,
  };
}

// Fields the fake server pretends not to know: it drops them from the filter, like the real one.
function filterFor(object, xq) {
  const kept = {};
  for (const [k, v] of Object.entries(xq || {})) if (!state.dropFilters.includes(`${object}.${k}`)) kept[k] = v;
  return kept;
}

function matches(record, xq) {
  return Object.entries(xq).every(([k, v]) => {
    if (v && typeof v === 'object' && v.$regex) {
      const raw = v.$regex.replace(/^\(\?i\)/, '');
      return new RegExp(raw, 'i').test(String(record[k] || ''));
    }
    if (k === 'layout') return String(record.layoutId || record.layout) === String(v);
    const actual = k.split('.').length > 1 && record[k] === undefined
      ? k.split('.').reduce((o, p) => (o ? o[p] : undefined), record)
      : record[k];
    return String(actual && typeof actual === 'object' ? actual._id : actual) === String(v);
  });
}

async function fakeFetch(url, init) {
  const u = new URL(url);
  let body;
  if (init.body instanceof FormData) body = { form: Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : `file:${v.size}`])) };
  else if (init.body) body = JSON.parse(init.body);
  calls.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body, auth: init.headers.Authorization });
  if (state.forbid || (init.headers.Authorization === `Bearer ${SELLER_KEY}` && init.method !== 'GET')) {
    return respond(403, { error: 'Forbidden. User has no permission.' });
  }
  const [, object, id] = u.pathname.split('/').filter(Boolean);
  if (u.pathname === '/v2/contenttemplate/defaultLayout') {
    return respond(200, { defaultLayoutType: 'Global Layout', contentTemplate: { _id: GLOBAL, contentTemplateName: 'Global', html: '<p>g</p>' } });
  }
  const coll = state[object];
  if (!coll) return respond(404, { error: `unexpected ${init.method} ${u.pathname}` });
  if (init.method === 'GET' && id) {
    const rec = coll.find((x) => x._id === id || x.contentTemplateCode === id || x.presentationCode === id || x.customViewCode === id || x.fontCode === id);
    if (!rec) return respond(404, { error: 'Not found' });
    const copy = JSON.parse(JSON.stringify(rec));
    if (object === 'font' && copy.fontFile) copy.fontFile = { _id: copy.fontFile, size: 20, url: 'https://files.example.com/f.woff' };
    if (state.leakKey) return respond(500, { error: `upstream rejected key ${KEY}` });
    return respond(200, copy);
  }
  if (init.method === 'GET') {
    const xq = u.searchParams.get('xquery') ? JSON.parse(u.searchParams.get('xquery')) : {};
    const kept = filterFor(object, xq);
    const data = coll.filter((r) => matches(r, kept));
    const limit = Number(u.searchParams.get('limit') || 200);
    return respond(200, { data: data.slice(0, limit), pagination: { count: data.length }, query: kept });
  }
  if (init.method === 'POST') {
    seq += 1;
    const fields = body.form ? { fontName: body.form.fontName, fontFile: '8'.repeat(24), fontCode: `FNT-N${seq}` } : body;
    const rec = { _id: `${'7'.repeat(20)}${String(seq).padStart(4, '0')}`, ...fields, updatedAt: `N${seq}` };
    if (object === 'customview') rec.customViewCode = `CVI-N${seq}`;
    coll.push(rec);
    return respond(200, rec);
  }
  if (init.method === 'PATCH') {
    const rec = coll.find((x) => x._id === id);
    seq += 1;
    const next = { ...body };
    if (next.defaultLayout && next.defaultLayout.origin === null) next.defaultLayout = null;
    if (next.retargeting && next.retargeting.metaPixelId === '') next.retargeting = {};
    Object.assign(rec, next, { updatedAt: `U${seq}` });
    return respond(200, rec);
  }
  return respond(404, { error: 'unexpected' });
}

async function run(...args) {
  out = '';
  err = '';
  const code = await ds.main(args, {
    rootDir, fetchImpl: fakeFetch, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } },
  });
  return { code, json: out ? JSON.parse(out) : null };
}

const writes = () => calls.filter((c) => c.method !== 'GET');

async function previewThenApply(plan, ...extra) {
  const p = await run('preview', D, JSON.stringify(plan), ...extra);
  expect(p.code).toBe(0);
  expect(writes()).toHaveLength(0);
  return run('apply', D, JSON.stringify(plan), '--version', p.json.version, '--confirmed', ...extra);
}

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-root-'));
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: KEY }));
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.vendedor.json'), JSON.stringify({ apiKey: SELLER_KEY }));
  calls = [];
  seq = 0;
  state = freshState();
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('reads', () => {
  test('show lists every use of a layout and says what is live', async () => {
    const { code, json } = await run('show', D, 'brand-layout');
    expect(code).toBe(0);
    expect(json.uses.deals.count).toBe(1);
    expect(json.uses.deals.sample[0].name).toBe('Big deal');
    expect(json.uses.presentations.count).toBe(1);
    expect(json.reach.join(' ')).toMatch(/read live/);
    expect(json.reach.join(' ')).toMatch(/default layout/);
    expect(json.template.html).toBeUndefined();
    expect(json.template.pages).toBe(1);
    expect(writes()).toHaveLength(0);
  });

  test('a filter the server drops is reported as unknown, never as the full count', async () => {
    state.dropFilters = ['deal.proposal.template.layout'];
    state.deal.push({ _id: '6'.repeat(24), dealName: 'Other' });
    const { json } = await run('show', D, LAYOUT);
    expect(json.uses.deals.count).toBeNull();
    expect(json.uses.deals.note).toMatch(/unknown/);
  });

  test('show finds a template by its exact name and blocks an ambiguous one', async () => {
    const { code, json } = await run('show', D, 'brand LAYOUT');
    expect(code).toBe(0);
    expect(json.template.id).toBe(LAYOUT);
    state.contenttemplate.push({ _id: '0'.repeat(24), contentTemplateName: 'Brand layout', templateType: 'content' });
    expect((await run('show', D, 'Brand layout')).code).toBe(3);
    expect(err).toMatch(/Several templates/);
  });

  test('snippet uses come from products, families and groups', async () => {
    const { json } = await run('show', D, 'terms');
    expect(json.uses.products.count).toBe(1);
    expect(json.reach[0]).toMatch(/read live/);
  });

  test('presentation views leave out the IP and the network provider', async () => {
    const { code, json } = await run('presentation', D, 'presentation1');
    expect(code).toBe(0);
    expect(json.presentation.expired).toBe(true);
    expect(json.views[0]).toMatchObject({ seconds: 9, who: 'Ana Ruiz', place: 'Bogotá, Colombia' });
    expect(out).not.toContain('203.0.113.9');
    expect(out).not.toContain('Some ISP');
  });

  test('presentations by contact e-mail resolve the contact first', async () => {
    const { json } = await run('presentations', D, '--contact', 'ANA@example.com');
    expect(calls[0].path).toBe('/v2/contact');
    expect(json.presentations[0].contact.name).toBe('Ana Ruiz');
  });

  test('a 403 stops with FORBIDDEN and is not retried', async () => {
    state.forbid = true;
    const { code } = await run('presentations', D);
    expect(code).toBe(1);
    expect(err).toMatch(/^FORBIDDEN/);
    expect(err).toMatch(/did not retry/);
    expect(calls).toHaveLength(1);
  });

  test('the API key never reaches the output', async () => {
    state.leakKey = true;
    const { code } = await run('show', D, LAYOUT);
    expect(code).toBe(1);
    expect(err).not.toContain(KEY);
    expect(err).toContain('***');
  });
});

describe('edit plans', () => {
  test.each(['html', 'pages', 'codes', 'meta', 'assets', 'templateType', 'library', 'allowEveryone'])('refuses %s without calling the server', async (field) => {
    const { code } = await run('preview', D, JSON.stringify({ kind: 'edit', id: LAYOUT, set: { [field]: 'x' } }));
    expect(code).toBe(2);
    expect(err).not.toMatch(/cannot be edited here/);
    expect(writes()).toHaveLength(0);
  });

  test('a live change on a template in use warns and suggests a copy', async () => {
    const { json } = await run('preview', D, JSON.stringify({ kind: 'edit', id: LAYOUT, set: { language: 'en' } }));
    expect(json.warnings.join(' ')).toMatch(/duplicate the template/);
    expect(json.nextStep).toMatch(/STOP HERE/);
    expect(json.send).toEqual({ taxonomy: { language: 'en' } });
  });

  test('an unknown font code blocks', async () => {
    const { code, json } = await run('preview', D, JSON.stringify({ kind: 'edit', id: LAYOUT, set: { defaultFont: 'FNT-NOPE' } }));
    expect(code).toBe(3);
    expect(json.blockers[0]).toMatch(/FNT-NOPE/);
  });

  test('legacy file ids in embeddedFonts are kept, not blocked', async () => {
    const { code, json } = await run('preview', D, JSON.stringify({ kind: 'edit', id: LAYOUT, set: { embeddedFonts: ['FNT-1', '9'.repeat(24)] } }));
    expect(code).toBe(0);
    expect(json.blockers).toEqual([]);
  });

  test('a bad pixel is refused; null removes it and reads back', async () => {
    expect((await run('preview', D, JSON.stringify({ kind: 'edit', id: LAYOUT, set: { metaPixelId: '12ab' } }))).code).toBe(2);
    const { code, json } = await previewThenApply({ kind: 'edit', id: LAYOUT, set: { metaPixelId: null } });
    expect(code).toBe(0);
    expect(json.template.metaPixelId).toBeNull();
  });

  test('apply needs the version and --confirmed, and refuses a stale version', async () => {
    const plan = JSON.stringify({ kind: 'edit', id: LAYOUT, set: { name: 'Renamed' } });
    expect((await run('apply', D, plan, '--confirmed')).code).toBe(2);
    expect((await run('apply', D, plan, '--version', '2026-01-01T00:00:00.000Z')).code).toBe(2);
    expect((await run('apply', D, plan, '--version', 'old', '--confirmed')).code).toBe(3);
    expect(writes()).toHaveLength(0);
    const ok = await previewThenApply({ kind: 'edit', id: LAYOUT, set: { name: 'Renamed' } });
    expect(ok.json.saved).toBe(true);
    expect(writes()).toHaveLength(1);
    expect(writes()[0].body).toEqual({ contentTemplateName: 'Renamed' });
  });
});

describe('duplicate', () => {
  test('copies the design whole and leaves out default, library and pixel', async () => {
    const { code, json } = await previewThenApply({ kind: 'duplicate', from: 'brand-layout', name: 'Brand X proposal', language: 'en' });
    expect(code).toBe(0);
    const sent = writes()[0].body;
    expect(sent).toMatchObject({ contentTemplateName: 'Brand X proposal', templateType: 'layout', html: '<div>design</div>', pages: [{ id: 'p1' }], codes: [{ c: 1 }], taxonomy: { language: 'en' } });
    expect(sent.defaultLayout).toBeUndefined();
    expect(sent.library).toBeUndefined();
    expect(sent.retargeting).toBeUndefined();
    expect(json.problems).toEqual([]);
  });

  test('warns about shared images and the pixel', async () => {
    const { json } = await run('preview', D, JSON.stringify({ kind: 'duplicate', from: LAYOUT, name: 'Copy' }));
    expect(json.warnings.join(' ')).toMatch(/same 1 image/);
    expect(json.warnings.join(' ')).toMatch(/pixel is not copied/);
    expect(json.send.html).toMatch(/characters copied/);
  });

  test('a second apply is blocked by the existing name', async () => {
    const plan = { kind: 'duplicate', from: LAYOUT, name: 'Copy' };
    const first = await previewThenApply(plan);
    expect(first.code).toBe(0);
    const again = await run('preview', D, JSON.stringify(plan));
    expect(again.code).toBe(3);
    expect(again.json.blockers[0]).toMatch(/already exists/);
  });
});

describe('default layout', () => {
  test('blocked while another template holds the scope', async () => {
    const { code, json } = await run('preview', D, JSON.stringify({ kind: 'default', id: SNIPPET.replace(/b/g, 'a'), origin: 'Global Layout' }));
    expect(code).toBe(3);
    expect(json.blockers[0]).toMatch(/Global/);
  });

  test('clearing a default reads back null', async () => {
    const { code, json } = await previewThenApply({ kind: 'default', id: GLOBAL, origin: null });
    expect(code).toBe(0);
    expect(json.template.defaultLayout).toBeNull();
  });
});

describe('create', () => {
  test('refuses html and creates an empty template', async () => {
    expect((await run('preview', D, JSON.stringify({ kind: 'create', name: 'X', html: '<p>x</p>' }))).code).toBe(2);
    const { code } = await previewThenApply({ kind: 'create', templateType: 'snippet', name: 'Commercial terms', language: 'es' });
    expect(code).toBe(0);
    expect(writes()[0].body).toEqual({ contentTemplateName: 'Commercial terms', templateType: 'snippet', taxonomy: { language: 'es' } });
  });
});

describe('fonts', () => {
  const fontFile = (name, bytes) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-font-'));
    const file = path.join(dir, name);
    fs.writeFileSync(file, Buffer.concat([Buffer.from(bytes, 'hex'), Buffer.alloc(16)]));
    return file;
  };

  test('a file whose content is not the font its extension says is refused', async () => {
    const file = fontFile('fake.ttf', '6e6f7420');
    const { code } = await run('preview', D, JSON.stringify({ kind: 'font', name: 'Fake', file }));
    expect(code).toBe(2);
    expect(err).toMatch(/not a ttf font/);
  });

  test('profile files are never read', () => {
    const file = path.join(rootDir, 'accounts', D, 'profile.json');
    expect(() => ds.readFontFile(file, rootDir)).toThrow(/never uploaded/);
  });

  test('an existing name blocks; a valid font uploads as multipart and reads back', async () => {
    const file = fontFile('brand.woff2', '774f4632');
    const dup = await run('preview', D, JSON.stringify({ kind: 'font', name: 'Brand Sans', file }));
    expect(dup.code).toBe(3);
    const { code, json } = await previewThenApply({ kind: 'font', name: 'Brand Serif', file });
    expect(code).toBe(0);
    expect(writes()[0]).toMatchObject({ method: 'POST', path: '/v2/font', body: { form: { fontName: 'Brand Serif', fontFile: 'file:20' } } });
    expect(json.font.code).toMatch(/^FNT-/);
  });
});

describe('custom views', () => {
  test('a new view hides internal notes unless asked, and resolves family names', async () => {
    const { json } = await run('preview', D, JSON.stringify({ kind: 'view', name: 'Rooms only', display: { productFamilies: ['rooms'] } }));
    expect(json.send.display).toMatchObject({ internalNotes: false, quote: true, productFamilies: [FAMILY] });
    const on = await run('preview', D, JSON.stringify({ kind: 'view', name: 'Notes', display: { internalNotes: true } }));
    expect(on.json.warnings[0]).toMatch(/Internal notes would be visible/);
  });

  test('an unknown family blocks and a non-boolean flag is refused', async () => {
    expect((await run('preview', D, JSON.stringify({ kind: 'view', name: 'X', display: { productFamilies: ['Nope'] } }))).code).toBe(3);
    expect((await run('preview', D, JSON.stringify({ kind: 'view', name: 'X', display: { quote: 'no' } }))).code).toBe(2);
  });

  test('editing a view keeps the settings not mentioned', async () => {
    const { code } = await previewThenApply({ kind: 'view', id: VIEW, display: { agentCard: false } });
    expect(code).toBe(0);
    expect(writes()[0].body.display).toMatchObject({ quote: false, internalNotes: false, agentCard: false });
  });

  test('a seller 403 on save stops cleanly', async () => {
    const { code } = await previewThenApply({ kind: 'view', name: 'Mine', display: {} }, '--profile', 'vendedor');
    expect(code).toBe(1);
    expect(err).toMatch(/^FORBIDDEN/);
    expect(writes()).toHaveLength(1);
  });
});

test('usage errors exit 2 without calling the server', async () => {
  expect((await run('nope', D)).code).toBe(2);
  expect((await run('preview', D, '{"kind":"other"}')).code).toBe(2);
  expect((await run('templates', D, '--type', 'poster')).code).toBe(2);
  expect(calls).toHaveLength(0);
});
