/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const files = require('../.claude/skills/prolibu-files/scripts/files');

const D = 'dev99.example.com';
const KEY = 'SECRET-KEY-123';
const ME = 'a'.repeat(24);
const OTHER = 'b'.repeat(24);
const id = (n) => n.toString(16).padStart(24, 'c');

let rootDir;
let tmpDir;
let out;
let err;
let calls;
let probes;
let state;

function respond(status, body) {
  return { status, text: async () => JSON.stringify(body) };
}

const S3 = `https://s3.amazonaws.com/store/domains/${D}/files`;
function fileDoc(n, filePath, extra = {}) {
  const isDir = filePath.endsWith('/');
  return {
    _id: id(n), filePath, type: isDir ? 'Directory' : 'File', isPublic: false, createdBy: ME, updatedAt: `T${n}`,
    ...(isDir ? {} : { url: `${S3}/${extra.createdBy || ME}/${encodeURI(filePath)}`, size: 10 }),
    ...extra,
  };
}

function matches(f, cond) {
  return Object.entries(cond).every(([k, v]) => {
    if (k === '$and') return v.every((c) => matches(f, c));
    const val = f[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if ('$regex' in v) return new RegExp(v.$regex).test(val || '');
      if ('$in' in v) return v.$in.includes(val);
      if ('$ne' in v) return val !== v.$ne;
      if ('$gt' in v) return String(val) > String(v.$gt);
      if ('$exists' in v) return (val !== undefined) === v.$exists;
    }
    return String(val) === String(v);
  });
}

// A small fake of the routes the script uses, shaped after the verified server behavior.
async function fakeFetch(url, init) {
  const u = new URL(url);
  const q = Object.fromEntries(u.searchParams);
  let body;
  if (init.body instanceof FormData) body = { form: true, fileName: init.body.get('file').name };
  else if (init.body) body = JSON.parse(init.body);
  calls.push({ method: init.method, path: u.pathname, query: q, body });
  const p = u.pathname;
  if (state.leakKey) return respond(500, { error: `boom ${KEY}` });
  if (p === '/v2/user/me') return respond(200, { profile: { _id: ME, email: 'me@example.com', isAdmin: false }, permissions: state.scopes });
  if (p === '/v2/user/preferences') return respond(200, { modules: { tools: { cloudDrive: { uploadRestrictions: { maxFileSizeMB: state.maxMB } } } } });
  if (p === '/v2/preference/read') return respond(403, { error: 'Forbidden' });
  if (p === '/v2/file/userStorage') return respond(403, { error: 'Forbidden' });
  if (p === '/v2/site') return respond(200, { data: state.sites.filter((s) => s.siteCode === JSON.parse(q.xquery).siteCode) });
  if (p === '/v2/user') return respond(200, { data: state.users.filter((x) => JSON.parse(q.xquery).email.$in.includes(x.email)) });
  if (p === '/v2/file' && init.method === 'GET') {
    let rows = state.files.filter((f) => matches(f, JSON.parse(q.xquery || '{}')));
    if (q.sort === '_id') rows = rows.sort((a, b) => (a._id < b._id ? -1 : 1));
    const limit = Number(q.limit || 20);
    return respond(200, { pagination: { count: rows.length }, data: rows.slice(0, limit) });
  }
  if (p === '/v2/file' && init.method === 'POST') {
    const filePath = (body && body.filePath) || q.filePath;
    if (state.files.some((f) => f.filePath === filePath && f.createdBy === ME)) return respond(400, { error: 'File already exists' });
    const doc = fileDoc(900 + state.files.length, filePath, { isPublic: q.isPublic === 'true', size: body && body.form ? state.uploadSize : undefined });
    state.files.push(doc);
    return respond(201, doc);
  }
  const m = p.match(/^\/v2\/file\/([a-f0-9]{24})$/);
  if (m) {
    const f = state.files.find((x) => x._id === m[1]);
    if (init.method === 'GET') return f ? respond(200, f) : respond(404, { error: 'Not found' });
    if (init.method === 'PATCH') {
      Object.assign(f, body, { updatedAt: `${f.updatedAt}+` });
      if ('filePath' in body) f.url = `${S3}/${f.createdBy}/${encodeURI(f.filePath)}`;
      return respond(200, f);
    }
    if (init.method === 'DELETE') {
      state.files = state.files.filter((x) => x !== f);
      if (q.permanentlyDelete !== 'true') state.files.push({ ...f, _id: id(800 + state.files.length), filePath: `Trash/${f.filePath}`, isPublic: false, trashedFrom: { filePath: f.filePath, isPublic: f.isPublic } });
      state.closed.push(f.url);
      return respond(204, '');
    }
  }
  if (p.startsWith('/v2/file/share/')) return respond(200, {});
  if (p.startsWith('/v2/file/actions/restoreFromTrash/')) return respond(200, {});
  if (p === '/v2/shorturl' && init.method === 'GET') return respond(200, { data: [] });
  if (p === '/v2/shorturl' && init.method === 'POST') {
    const doc = { shortUrlCode: body.shortUrlCode || 'Ab12Cd34', url: body.url, updatedAt: 'T1' };
    state.links.push(doc);
    return respond(201, doc);
  }
  const lm = p.match(/^\/v2\/shorturl\/([^/]+)$/);
  if (lm) {
    const l = state.links.find((x) => x.shortUrlCode === lm[1]);
    if (!l) return respond(404, { error: 'Not found' });
    if (init.method === 'GET') return respond(200, l);
  }
  return respond(404, { error: `unexpected ${init.method} ${p}` });
}

async function fakeProbe(url) {
  probes.push(url);
  const u = new URL(url);
  if (u.pathname.startsWith('/r/')) {
    const l = state.links.find((x) => `/r/${x.shortUrlCode}` === u.pathname);
    return { status: l ? 302 : 404, headers: { get: (h) => (h === 'location' && l ? l.url : null) } };
  }
  if ((state.leftOpen || []).includes(url)) return { status: 200, headers: { get: () => null } };
  const f = state.files.find((x) => x.url === url);
  const open = f && f.isPublic && !state.closed.includes(url);
  return { status: open ? 200 : 403, headers: { get: () => null } };
}

const run = (argv) => files.main([...argv], {
  rootDir, fetchImpl: fakeFetch, probeFetch: fakeProbe,
  stdout: { write: (s) => { out += s; } },
  stderr: { write: (s) => { err += s; } },
});
const json = () => JSON.parse(out);
const writes = () => calls.filter((c) => c.method !== 'GET');

async function previewThenApply(plan, extra = []) {
  out = '';
  const code = await run(['preview', D, JSON.stringify(plan)]);
  const pv = json();
  out = '';
  if (code !== 0) return { code, pv };
  const applyCode = await run(['apply', D, JSON.stringify(plan), '--version', pv.version, '--confirmed', ...extra]);
  return { code: applyCode, pv, result: out ? json() : null };
}

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-files-root-'));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-files-tmp-'));
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: KEY }));
  out = '';
  err = '';
  calls = [];
  probes = [];
  state = {
    scopes: ['Resource@File.*', 'Resource@ShortUrl.*'],
    maxMB: 20,
    uploadSize: 0,
    sites: [{ siteCode: 'landing' }],
    users: [{ _id: OTHER, email: 'ana@example.com' }],
    links: [],
    closed: [],
    files: [
      fileDoc(1, 'Contratos/'),
      fileDoc(2, 'Contratos/acuerdo.pdf'),
      fileDoc(3, 'Catalogos/', { isPublic: true }),
      fileDoc(4, 'Catalogos/catalogo.pdf', { isPublic: true }),
      fileDoc(5, 'oferta.pdf', { isPublic: true }),
      fileDoc(6, '.api/Deal/' + 'd'.repeat(24) + '/thumbnail/x.jpg', { isPublic: true }),
      fileDoc(7, 'public/landing/index.html', { isPublic: true }),
      fileDoc(8, 'Ajeno.pdf', { createdBy: OTHER }),
    ],
  };
});
afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('reads', () => {
  test('list pages on _id over createdBy + a filePath prefix, without the trash or attachments', async () => {
    expect(await run(['list', D])).toBe(0);
    const listCalls = calls.filter((c) => c.path === '/v2/file');
    expect(listCalls.every((c) => c.query.sort === '_id')).toBe(true);
    const and = JSON.parse(listCalls[0].query.xquery).$and;
    expect(and[0]).toEqual({ createdBy: ME });
    expect(and[1].filePath.$regex).toBe('^(?!Trash/)(?!\\.api/)[^/]+/?$');
    const paths = [...json().folders, ...json().files].map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(['Contratos/', 'oferta.pdf']));
    expect(paths.some((x) => x.startsWith('.api/'))).toBe(false);
  });

  test('a long list walks with a cursor, one call at a time, and stops at --max', async () => {
    for (let i = 0; i < 30; i += 1) state.files.push(fileDoc(100 + i, `Lote/f${i}.pdf`));
    expect(await run(['list', D, '--folder', 'Lote', '--max', '25'])).toBe(0);
    expect(json().shown).toBe(25);
    expect(json().capped).toMatch(/Stopped at 25 of 30/);
  });

  test('public groups site packages and attachments apart and gives the anonymous folder listing', async () => {
    expect(await run(['public', D])).toBe(0);
    const r = json();
    expect(r.driveFiles.map((f) => f.path)).toEqual(expect.arrayContaining(['oferta.pdf', 'Catalogos/catalogo.pdf']));
    expect(r.sitePackages.sites).toEqual(['landing']);
    expect(r.recordAttachments.byModel).toEqual({ Deal: 1 });
    expect(r.publicFolders[0].anonymousListing).toBe(`https://${D}/v2/file/list/view/${ME}/?filePath=Catalogos/`);
  });

  test('show explains why a file is public and checks the URL from outside', async () => {
    expect(await run(['show', D, id(4)])).toBe(0);
    const { exposure } = json();
    expect(exposure.publicBecause).toMatch(/folder "Catalogos\/" is public/);
    expect(exposure.anonymousCheck).toMatchObject({ checked: true, status: 200, opensWithoutSignIn: true, noindexHeader: false });
  });

  test('the outside check never carries the key and only goes to the account or the file store', async () => {
    state.files.push(fileDoc(50, 'raro.pdf', { isPublic: true, url: 'https://evil.example.org/raro.pdf' }));
    await run(['show', D, id(50)]);
    expect(json().exposure.anonymousCheck).toEqual({ checked: false, reason: 'host not checked' });
    expect(probes).toEqual([]);
  });
});

describe('writes', () => {
  test('preview writes nothing and tells the agent to stop; apply needs --confirmed and the same version', async () => {
    const plan = { action: 'folder', path: 'Nuevos' };
    expect(await run(['preview', D, JSON.stringify(plan)])).toBe(0);
    expect(writes()).toEqual([]);
    expect(json().nextStep).toMatch(/STOP HERE/);
    expect(await run(['apply', D, JSON.stringify(plan), '--version', json().version])).toBe(2);
    out = '';
    expect(await run(['apply', D, JSON.stringify(plan), '--version', 'stale', '--confirmed'])).toBe(3);
    expect(writes()).toEqual([]);
  });

  test('upload is private unless asked, sends one multipart call and reads back', async () => {
    const local = path.join(tmpDir, 'cat.pdf');
    fs.writeFileSync(local, '%PDF-1');
    state.uploadSize = 6;
    const { code, pv, result } = await previewThenApply({ action: 'upload', file: local, to: 'Contratos/' });
    expect(pv.public).toBe(false);
    expect(code).toBe(0);
    const post = writes().find((c) => c.method === 'POST');
    expect(post.query).toMatchObject({ filePath: 'Contratos/cat.pdf', isPublic: 'false' });
    expect(post.body).toEqual({ form: true, fileName: 'cat.pdf' });
    expect(result.done[0]).toMatchObject({ path: 'Contratos/cat.pdf', public: false });
  });

  test('upload refuses keys and profiles, too-big files and taken names', async () => {
    expect(await run(['preview', D, JSON.stringify({ action: 'upload', file: path.join(rootDir, 'accounts', D, 'profile.json') })])).toBe(2);
    expect(err).toMatch(/key or an account profile/);
    const big = path.join(tmpDir, 'big.pdf');
    fs.writeFileSync(big, Buffer.alloc(2 * 1024 * 1024));
    state.maxMB = 1;
    out = '';
    expect(await run(['preview', D, JSON.stringify({ action: 'upload', file: big })])).toBe(3);
    expect(json().blockers.join(' ')).toMatch(/allows 1 MB/);
    const dup = path.join(tmpDir, 'acuerdo.pdf');
    fs.writeFileSync(dup, 'x');
    out = '';
    expect(await run(['preview', D, JSON.stringify({ action: 'upload', file: dup, to: 'Contratos/' })])).toBe(3);
    expect(json().blockers.join(' ')).toMatch(/already exists/);
    expect(writes()).toEqual([]);
  });

  test('making a file private inside a public folder is blocked (the server would turn it public again)', async () => {
    const { code, pv } = await previewThenApply({ action: 'visibility', ids: [id(4)], public: false });
    expect(code).toBe(3);
    expect(pv.blockers.join(' ')).toMatch(/inside the public folder "Catalogos\/"/);
    expect(writes()).toEqual([]);
  });

  test('making a file private checks from outside that the URL closed', async () => {
    const { code, result } = await previewThenApply({ action: 'visibility', ids: [id(5)], public: false });
    expect(code).toBe(0);
    expect(writes()).toEqual([expect.objectContaining({ method: 'PATCH', body: { isPublic: false } })]);
    expect(result.done[0].anonymousCheck).toMatchObject({ status: 403, opensWithoutSignIn: false });
  });

  test('a role without the permission is blocked before any write', async () => {
    state.scopes = ['Resource@File.create', 'Resource@File.find', 'Resource@File.findOne'];
    const { code, pv } = await previewThenApply({ action: 'rename', id: id(2), name: 'nuevo.pdf' });
    expect(code).toBe(3);
    expect(pv.blockers.join(' ')).toMatch(/Resource@File.update/);
    expect(writes()).toEqual([]);
  });

  test('attachments and site packages are never changed through the drive', async () => {
    let r = await previewThenApply({ action: 'trash', ids: [id(6)] });
    expect(r.pv.blockers.join(' ')).toMatch(/thumbnail attachment of the Deal/);
    r = await previewThenApply({ action: 'visibility', ids: [id(7)], public: false });
    expect(r.pv.blockers.join(' ')).toMatch(/belongs to the site "landing".*prolibu-sites/);
    expect(writes()).toEqual([]);
  });

  test('moving a public file goes private → move → public, so no public copy stays at the old name', async () => {
    const { code } = await previewThenApply({ action: 'move', ids: [id(5)], to: 'Contratos/' });
    expect(code).toBe(0);
    expect(writes().map((c) => c.body)).toEqual([{ isPublic: false }, { filePath: 'Contratos/oferta.pdf' }, { isPublic: true }]);
  });

  test('a move checks the old public URL from outside and reports a copy left open there', async () => {
    const oldUrl = state.files.find((f) => f._id === id(5)).url;
    let r = await previewThenApply({ action: 'move', ids: [id(5)], to: 'Contratos/' });
    expect(r.result.done[0].oldLinkCheck).toMatchObject({ checked: true, status: 403, opensWithoutSignIn: false });
    expect(r.result.saved).toBe(true);
    // Live shape: the platform copies the bytes and keeps the old copy with its access.
    state.leftOpen = [state.files.find((f) => f._id === id(5)).url];
    r = await previewThenApply({ action: 'move', ids: [id(5)], to: '' });
    expect(r.result.saved).toBe(false);
    expect(r.result.problems.join(' ')).toMatch(/old public URL .* still opens/);
    expect(probes).toContain(oldUrl);
  });

  test('an image preview is its own public record: show gives its id and how to close it; a move warns it stays behind', async () => {
    const thumbPath = 'Contratos/.thumb-foto.jpg';
    state.files.push(fileDoc(20, thumbPath, { isPublic: true, isThumbnail: true }));
    state.files.push(fileDoc(21, 'Contratos/foto.png', { thumbnail: `${S3}/${ME}/${encodeURI(thumbPath)}` }));
    expect(await run(['show', D, id(21)])).toBe(0);
    const { thumbnail } = json().exposure;
    expect(thumbnail).toMatchObject({ id: id(20), public: true, check: { status: 200, opensWithoutSignIn: true } });
    expect(thumbnail.howToClose).toContain(`"ids":["${id(20)}"],"public":false`);
    out = '';
    expect(await run(['preview', D, JSON.stringify({ action: 'move', ids: [id(21)], to: 'Catalogos/' })])).toBe(0);
    expect(json().warnings.join(' ')).toMatch(/preview image: it stays at the old name/);
  });

  test('a folder that holds files cannot be moved or renamed', async () => {
    const { code, pv } = await previewThenApply({ action: 'rename', id: id(1), name: 'Acuerdos' });
    expect(code).toBe(3);
    expect(pv.blockers.join(' ')).toMatch(/holds 1 item/);
    expect(writes()).toEqual([]);
  });

  test('trash finds the trash copy (new id) and checks that the old public link closed', async () => {
    const { code, result } = await previewThenApply({ action: 'trash', ids: [id(5)] });
    expect(code).toBe(0);
    expect(result.done[0].trashCopy.path).toBe('Trash/oferta.pdf');
    expect(result.done[0].trashCopy.id).not.toBe(id(5));
    expect(result.done[0].oldLinkCheck.opensWithoutSignIn).toBe(false);
  });

  test('deleting for good needs its own flag, and only from the trash', async () => {
    let r = await previewThenApply({ action: 'purge', ids: [id(2)] }, ['--confirmed-permanent']);
    expect(r.pv.blockers.join(' ')).toMatch(/not in the trash/);
    await previewThenApply({ action: 'trash', ids: [id(2)] });
    const trashId = state.files.find((f) => f.filePath === 'Trash/Contratos/acuerdo.pdf')._id;
    calls = [];
    r = await previewThenApply({ action: 'purge', ids: [trashId] });
    expect(r.code).toBe(2);
    expect(writes()).toEqual([]);
    r = await previewThenApply({ action: 'purge', ids: [trashId] }, ['--confirmed-permanent']);
    expect(r.code).toBe(0);
    expect(writes()[0].query).toEqual({ permanentlyDelete: 'true' });
  });

  test('only the owner can change sharing', async () => {
    const { code, pv } = await previewThenApply({ action: 'share', id: id(8), everyone: true });
    expect(code).toBe(3);
    expect(pv.blockers.join(' ')).toMatch(/Only the owner/);
  });
});

describe('short links', () => {
  test('shorten creates an owned link with POST /v2/shorturl (not generate) and checks the redirect', async () => {
    const url = `https://${D}/ui/spa/suite/files`;
    const { code, result } = await previewThenApply({ action: 'shorten', url });
    expect(code).toBe(0);
    expect(writes()).toEqual([expect.objectContaining({ method: 'POST', path: '/v2/shorturl', body: { url } })]);
    expect(result.done[0]).toMatchObject({ link: `https://${D}/r/Ab12Cd34`, goesTo: url });
    expect(result.done[0].anonymousCheck.location).toBe(url);
  });

  test('another domain needs the user to confirm it, and only https is allowed', async () => {
    let r = await previewThenApply({ action: 'shorten', url: 'https://example.org/x' });
    expect(r.code).toBe(3);
    expect(r.pv.blockers.join(' ')).toMatch(/outside dev99.example.com/);
    r = await previewThenApply({ action: 'shorten', url: 'javascript:alert(1)', external: true });
    expect(r.pv.blockers.join(' ')).toMatch(/https/);
    expect(writes()).toEqual([]);
    r = await previewThenApply({ action: 'shorten', url: 'https://example.org/x', external: true });
    expect(r.code).toBe(0);
  });
});

test('the API key never reaches the output', async () => {
  state.leakKey = true;
  await run(['list', D]);
  expect(err).toMatch(/boom \*\*\*/);
  expect(err + out).not.toContain(KEY);
});

test('plans are validated before anything is sent', async () => {
  expect(await run(['preview', D, '{"action":"move","ids":["nope"],"to":"X/"}'])).toBe(2);
  expect(await run(['preview', D, '{"action":"explode"}'])).toBe(2);
  expect(calls).toEqual([]);
});
