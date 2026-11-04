/* global describe, test, expect, beforeEach, afterEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vt = require('../.claude/skills/prolibu-virtual-tours/scripts/vt');

const D = 'dev99.example.com';
const TOUR = 'a'.repeat(24);
const OTHER = 'b'.repeat(24);
const RED = 'c'.repeat(24);
const SCENE = 'd'.repeat(24);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

let rootDir;
let out;
let err;
let calls;
let state;
let cliRuns;

function respond(status, body) {
  return { status, text: async () => JSON.stringify(body) };
}

const redColor = () => ({ _id: RED, url: `https://cdn.example.com/x/.api/VirtualTour/${TOUR}/config.automotiveColors.external/red.png`, meta: { name: 'Red', hex: '#ff0000' } });

// A small fake of the endpoints, shaped after what a test account answered (see the private report).
async function fakeFetch(url, init) {
  const u = new URL(url);
  const body = init.body && JSON.parse(init.body);
  calls.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body });
  if (init.method === 'GET' && u.pathname.startsWith('/v2/virtualTour/view/')) {
    const id = u.pathname.split('/').pop();
    const t = state.tours[id];
    return t ? respond(200, t) : respond(404, { error: 'Virtual tour not found' });
  }
  if (init.method === 'GET' && u.pathname === '/v2/virtualtour') {
    const xq = u.searchParams.get('xquery');
    let data = Object.values(state.tours);
    if (xq) {
      const q = JSON.parse(xq);
      if (q.virtualTourCode) data = data.filter((t) => t.virtualTourCode === q.virtualTourCode);
      if (q.$and) {
        const ids = q.$and[0].scenes.$in;
        data = data.filter((t) => t._id !== q.$and[1]._id.$ne && (t.scenes || []).some((s) => ids.includes(s._id || s)));
      }
    }
    return respond(200, { pagination: { count: data.length, lastPage: 1 }, data });
  }
  if (init.method === 'GET' && u.pathname.startsWith('/v2/file/')) return respond(200, { _id: RED, sha256: state.colorSha || null });
  if (init.method === 'PATCH' && u.pathname === `/v2/virtualtour/${TOUR}`) {
    const t = state.tours[TOUR];
    const byId = { [RED]: redColor() };
    t.config.automotiveColors = {
      external: body.config.automotiveColors.external.map((id) => byId[id] || { _id: id }),
      internal: body.config.automotiveColors.internal.map((id) => byId[id] || { _id: id }),
    };
    return respond(200, t);
  }
  if (init.method === 'PATCH' && u.pathname.startsWith('/v2/scene/')) {
    const id = u.pathname.split('/').pop();
    const s = state.tours[TOUR].scenes.find((x) => x._id === id);
    s.automotiveColor = body.automotiveColor;
    return respond(200, s);
  }
  return respond(404, { error: `unexpected ${init.method} ${u.pathname}` });
}

const run = (argv) => vt.main(argv, {
  rootDir,
  fetchImpl: fakeFetch,
  runCli: (opts) => {
    cliRuns.push(opts);
    return state.cli ? state.cli(opts) : { status: 0, output: '' };
  },
  stdout: { write: (s) => { out += s; } },
  stderr: { write: (s) => { err += s; } },
});

function tourDir(prefix = 'p', folder = 'CAR') {
  return path.join(rootDir, 'accounts', D, 'vt', prefix, 'virtualTours', folder);
}

function put(rel, content = PNG, folder = 'CAR') {
  const file = path.join(tourDir('p', folder), rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : content);
}

function config(obj, folder = 'CAR') {
  put('_config.json', JSON.stringify(obj), folder);
}

function existingTour(extra = {}) {
  return {
    _id: TOUR,
    virtualTourCode: 'CAR',
    virtualTourName: 'Car',
    eventType: 'Automotive',
    updatedAt: 'T1',
    config: { theme: 'flow', automotiveColors: { external: [redColor()], internal: [] } },
    scenes: [{ _id: SCENE, sceneName: 'Front', sceneType: '2d', automotiveType: 'external', automotiveColor: RED, media: [{ _id: 'm1' }], spots: [] }],
    floorPlans: [],
    ...extra,
  };
}

async function previewJson(folder = 'CAR') {
  out = '';
  const code = await run(['preview', D, 'p', folder]);
  return { code, json: out ? JSON.parse(out) : null };
}

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prolibu-vt-root-'));
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: 'SECRET123' }));
  out = '';
  err = '';
  calls = [];
  cliRuns = [];
  state = { tours: {} };
});
afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('reading the folder like vt push', () => {
  test('prefixes set the scene type, seq_ files make one ordered scene named after its first frame, files without prefix are skipped', () => {
    config({ eventType: 'Automotive' });
    put('_colors/external/red.png');
    put('external/red/2d_front-view_001.png');
    put('external/red/seq_10.png');
    put('external/red/seq_2.png');
    put('external/red/photo.png');
    put('internal/red/360_cabin.webp');
    const local = vt.readLocal(tourDir());
    expect(local.scenes.map((s) => [s.sceneName, s.sceneType, s.automotiveType, s.colorSlug])).toEqual([
      ['Front View', '2d', 'external', 'red'],
      ['2', 'sequence', 'external', 'red'],
      ['Cabin', '360', 'internal', null],
    ]);
    expect(local.scenes[1].files).toEqual(['external/red/seq_2.png', 'external/red/seq_10.png']);
    expect(local.skipped).toEqual(['external/red/photo.png (no 2d_, 360_ or seq_ prefix)']);
  });

  test('Spaces: files without prefix become 360 scenes and floor plans are read', () => {
    config({ eventType: 'Spaces' }, 'FLAT');
    put('scenes/living-room.jpg', PNG, 'FLAT');
    put('scenes/2d_plan-view.png', PNG, 'FLAT');
    put('_floorplans/ground-floor.png', PNG, 'FLAT');
    const local = vt.readLocal(tourDir('p', 'FLAT'));
    expect(local.scenes.map((s) => [s.sceneName, s.sceneType])).toEqual([['Plan View', '2d'], ['Living Room', '360']]);
    expect(local.floorPlans).toEqual([{ floorPlanName: 'Ground Floor', file: '_floorplans/ground-floor.png' }]);
  });

  test('files the server rejects block the push; folders the CLI ignores are reported', () => {
    config({ eventType: 'Automotive' });
    put('external/red/2d_front.avif');
    put('details/red/2d_scratch.png');
    const local = vt.readLocal(tourDir());
    expect(local.blockers.join(' ')).toContain('.avif');
    expect(local.skipped.join(' ')).toContain('details/');
  });
});

describe('preview', () => {
  test('a new code previews a create with a version and writes nothing', async () => {
    config({ virtualTourName: 'Car', eventType: 'Automotive', config: { theme: 'flow' } });
    put('_colors/external/red.png');
    put('external/red/2d_front.png');
    const { code, json } = await previewJson();
    expect(code).toBe(0);
    expect(json.action).toBe('create');
    expect(json.version).toMatch(/^[a-f0-9]{16}$/);
    expect(json.upload.colors[0].status).toContain('#000000');
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  test('an unlinked folder whose code belongs to another tour is blocked', async () => {
    state.tours[TOUR] = existingTour();
    config({ eventType: 'Automotive' });
    put('external/red/2d_front.png');
    const { code, json } = await previewJson();
    expect(code).toBe(3);
    expect(json.blockers.join(' ')).toContain('not linked');
  });

  test('a stale _id is blocked instead of silently creating a new tour', async () => {
    config({ _id: OTHER, eventType: 'Automotive' });
    put('external/red/2d_front.png');
    const { code, json } = await previewJson();
    expect(code).toBe(3);
    expect(json.blockers.join(' ')).toContain('no longer exists');
  });

  test('an update with no images is blocked: the CLI would delete every scene', async () => {
    state.tours[TOUR] = existingTour();
    config({ _id: TOUR, eventType: 'Automotive' });
    const { code, json } = await previewJson();
    expect(code).toBe(3);
    expect(json.blockers.join(' ')).toContain('delete them all');
  });

  test('a pulled config with a whole file object and a bad theme is blocked', async () => {
    state.tours[TOUR] = existingTour();
    config({ _id: TOUR, eventType: 'Automotive', config: { theme: 'dark', ui: { splash: { image: { _id: 'f1', url: 'https://x/y.png' } } } } });
    put('external/red/2d_front.png');
    const { code, json } = await previewJson();
    expect(code).toBe(3);
    expect(json.blockers.join(' ')).toContain('config.ui.splash.image');
    expect(json.blockers.join(' ')).toContain('config.theme');
  });

  test('hotspots and initial views are listed as losses; config defaults show as setting changes', async () => {
    state.tours[TOUR] = existingTour();
    state.tours[TOUR].scenes[0].spots = [{ _id: 's1' }];
    state.tours[TOUR].scenes[0].camera = { lon: 1, lat: 2, fov: 75 };
    state.tours[TOUR].config.ui = { splash: { enabled: true } };
    config({ _id: TOUR, eventType: 'Automotive', config: { theme: 'flow' } });
    put('_colors/external/red.png');
    put('external/red/2d_front.png');
    const { code, json } = await previewJson();
    expect(code).toBe(0);
    expect(json.losses.join(' ')).toContain('1 hotspot(s), its initial view');
    expect(json.settingsChanged).toContainEqual({ field: 'config.ui.splash.enabled', from: true, to: false });
    expect(json.upload.colors[0].status).toContain('keeps its current color');
  });

  test('scenes shared with another tour are blocked', async () => {
    state.tours[TOUR] = existingTour();
    state.tours[OTHER] = { _id: OTHER, virtualTourCode: 'CLONE', virtualTourName: 'Clone', scenes: [SCENE] };
    config({ _id: TOUR, eventType: 'Automotive' });
    put('external/red/2d_front.png');
    const { code, json } = await previewJson();
    expect(code).toBe(3);
    expect(json.blockers.join(' ')).toContain('"Clone"');
  });

  test('a folder name the CLI cannot select is a usage error', async () => {
    fs.mkdirSync(tourDir('p', '2024'), { recursive: true });
    expect(await run(['preview', D, 'p', '2024'])).toBe(2);
    expect(await run(['preview', D, 'p', '../x'])).toBe(2);
  });
});

describe('push', () => {
  function simulateCliUpdate() {
    // What the test account did: the color upload answered 400 (file exists) and the new scene came back without color.
    state.cli = () => {
      state.tours[TOUR].scenes = [{ _id: 'e'.repeat(24), sceneName: 'Front', sceneType: '2d', automotiveType: 'external', media: [{ _id: 'm2' }], spots: [] }];
      state.tours[TOUR].updatedAt = 'T2';
      return { status: 0, output: '   ⚠️  Color upload failed: Red - Request failed with status code 400\n   ✅ Updated (1 scenes)' };
    };
  }

  async function versionOf() {
    const { json } = await previewJson();
    return json.version;
  }

  test('needs --version and --confirmed, and refuses a stale version', async () => {
    state.tours[TOUR] = existingTour();
    config({ _id: TOUR, eventType: 'Automotive' });
    put('_colors/external/red.png');
    put('external/red/2d_front.png');
    const v = await versionOf();
    expect(v).toMatch(/^[a-f0-9]{16}$/);
    expect(await run(['push', D, 'p', 'CAR', '--confirmed'])).toBe(2);
    expect(await run(['push', D, 'p', 'CAR', '--version', 'x'])).toBe(2);
    err = '';
    expect(await run(['push', D, 'p', 'CAR', '--version', '0000000000000000', '--confirmed'])).toBe(3);
    expect(err).toContain('changed since the preview');
    expect(cliRuns).toHaveLength(0);
  });

  test('losses need --accept-losses before the CLI runs', async () => {
    state.tours[TOUR] = existingTour();
    state.tours[TOUR].scenes[0].spots = [{ _id: 's1' }];
    config({ _id: TOUR, eventType: 'Automotive' });
    put('_colors/external/red.png');
    put('external/red/2d_front.png');
    const v = await versionOf();
    expect(await run(['push', D, 'p', 'CAR', '--version', v, '--confirmed'])).toBe(3);
    expect(err).toContain('--accept-losses');
    expect(cliRuns).toHaveLength(0);
  });

  test('runs the CLI for this one folder only, then re-links the scene to its existing color', async () => {
    state.tours[TOUR] = existingTour();
    config({ _id: TOUR, eventType: 'Automotive' });
    put('_colors/external/red.png');
    put('external/red/2d_front.png');
    const v = await versionOf();
    simulateCliUpdate();
    out = '';
    const code = await run(['push', D, 'p', 'CAR', '--version', v, '--confirmed']);
    expect(code).toBe(0);
    expect(cliRuns).toEqual([{ rootDir, domain: D, prefix: 'p', folder: 'CAR' }]);
    const res = JSON.parse(out);
    expect(res.saved).toBe(true);
    expect(res.relinked.scenes).toBe(1);
    expect(res.cliWarnings[0]).toContain('Color upload failed');
    expect(calls.find((c) => c.method === 'PATCH' && c.path.startsWith('/v2/scene/')).body).toEqual({ automotiveColor: RED });
    expect(state.tours[TOUR].scenes[0].automotiveColor).toBe(RED);
  });

  test('a pushed tour that comes back short is reported as not saved', async () => {
    state.tours[TOUR] = existingTour();
    config({ _id: TOUR, eventType: 'Automotive' });
    put('_colors/external/red.png');
    put('external/red/2d_front.png');
    put('external/red/2d_side.png');
    const v = await versionOf();
    simulateCliUpdate();
    out = '';
    expect(await run(['push', D, 'p', 'CAR', '--version', v, '--confirmed'])).toBe(1);
    expect(JSON.parse(out).problems.join(' ')).toContain('1 of 2 scenes');
  });

  test('never prints the key', async () => {
    state.tours[TOUR] = existingTour();
    config({ _id: TOUR, eventType: 'Automotive' });
    put('_colors/external/red.png');
    put('external/red/2d_front.png');
    const v = await versionOf();
    state.cli = () => ({ status: 1, output: 'Authorization: Bearer SECRET123 failed' });
    out = '';
    await run(['push', D, 'p', 'CAR', '--version', v, '--confirmed']);
    expect(cliRuns).toHaveLength(1);
    expect(out).toContain('Bearer ***');
    expect(out + err).not.toContain('SECRET123');
  });
});

describe('list and show', () => {
  test('list returns every tour with its viewer link', async () => {
    state.tours[TOUR] = existingTour();
    expect(await run(['list', D])).toBe(0);
    const res = JSON.parse(out);
    expect(res.tours[0]).toMatchObject({ _id: TOUR, scenes: 1, link: `https://${D}/ui/spa/virtualTour/view/${TOUR}` });
  });

  test('show resolves a code and names each scene color', async () => {
    state.tours[TOUR] = existingTour();
    expect(await run(['show', D, 'CAR'])).toBe(0);
    expect(JSON.parse(out).scenes[0]).toMatchObject({ sceneName: 'Front', color: 'Red' });
  });
});
