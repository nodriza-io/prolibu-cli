/* global describe, test, expect */
const { heavyReadFindings } = require('../.claude/skills/_shared/heavy-read-check');

const file = (rel, text) => ({ rel, text, size: Buffer.byteLength(text) });
const rules = (files) => heavyReadFindings(files).map((f) => `${f.level}:${f.rule}`);

describe('heavyReadFindings', () => {
  test('the incident: pages of 500 sorted by createdAt is blocked', () => {
    const page = file('app.js', `
      async function loadAll() {
        const rows = [];
        for (let page = 1; ; page++) {
          const body = await ProlibuSession.api('/deal?limit=500&page=' + page + '&sort=createdAt');
          rows.push(...body.data);
          if (page >= body.pagination.lastPage) break;
        }
        return rows;
      }`);
    expect(rules([page])).toEqual(expect.arrayContaining(['blocker:heavyListSort', 'warning:bulkListRead']));
  });

  test('a paged table sorted newest first by createdAt is blocked (baseline A)', () => {
    const page = file('public/app.js', `
      const q = new URLSearchParams({ limit: String(PAGE_SIZE), page: String(state.page), sort: '-createdAt,-_id' });
      const body = await ProlibuSession.api('/deal?' + q);`);
    const found = heavyReadFindings([page]);
    expect(found).toEqual([expect.objectContaining({ level: 'blocker', rule: 'heavyListSort', file: 'public/app.js', line: 2, field: 'createdAt' })]);
  });

  test('a cursor on createdAt is blocked too (baseline B)', () => {
    const script = file('export.js', `
      const params = { select: FIELDS, sort: 'createdAt,_id', limit: '500', page: '1' };
      params.xquery = JSON.stringify({ $or: [{ createdAt: { $gt: last.createdAt } }] });
      await call('GET', '/v2/deal?' + new URLSearchParams(params));`);
    expect(rules([script])).toContain('blocker:heavyListSort');
  });

  test('sorting by _id, newest or oldest first, passes', () => {
    const page = file('app.js', `
      await ProlibuSession.api('/deal?limit=50&page=2&sort=-_id&select=dealName');
      await ProlibuSession.api('/deal?' + new URLSearchParams({ sort: '_id', limit: '50' }));`);
    expect(heavyReadFindings([page])).toEqual([]);
  });

  test('the report stream is the recommended read and passes', () => {
    const page = file('app.js', `
      const rows = await ProlibuSession.api('/report/generate/?reportId=RPT-1&downloadFormat=json&xquery=' + encodeURIComponent(q));
      rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));`);
    expect(heavyReadFindings([page])).toEqual([]);
  });

  test('other sorts only warn: fine for stages or users, not for big objects', () => {
    const page = file('app.js', `
      await ProlibuSession.api('/stage?' + new URLSearchParams({ sort: 'index', limit: '200' }));`);
    expect(rules([page])).toEqual(['warning:listSort', 'warning:bulkListRead']);
  });

  test('calls in parallel over a list or a worker pool are blocked; two different lookups are not', () => {
    const pool = file('a.js', `
      const CONCURRENCY = 3;
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, run));
      async function run() { await ProlibuSession.api('/deal?limit=1&select=_id&stage=' + next()); }`);
    const mapped = file('b.js', `
      const counts = await Promise.all(stages.map((s) => ProlibuSession.api('/deal?limit=1&stage=' + s._id)));`);
    const lookups = file('c.js', `
      const [stages, users] = await Promise.all([
        ProlibuSession.api('/stage?select=stageName'),
        ProlibuSession.api('/user?select=firstName'),
      ]);`);
    expect(rules([pool])).toContain('blocker:parallelListCalls');
    expect(rules([mapped])).toContain('blocker:parallelListCalls');
    expect(rules([lookups])).not.toContain('blocker:parallelListCalls');
  });

  test('one count call per group warns', () => {
    const page = file('app.js', `
      for (const s of stages) totals[s._id] = (await ProlibuSession.api('/deal?limit=1&select=_id&stage=' + s._id)).pagination.count;`);
    expect(rules([page])).toContain('warning:countPerGroup');
  });

  test('files that never call the API, array sorts, the session helper and non-code files are ignored', () => {
    const files = [
      file('util.js', "const x = { sort: 'createdAt' }; list.sort((a, b) => a - b);"),
      file('prolibu-session.js', "fetch('/v2' + path); const sort = 'createdAt';"),
      file('styles.css', '.sort-createdAt { color: red }'),
      file('app.js.map', '{"sourcesContent":["sort: \'createdAt\' /v2/deal"]}'),
      { rel: 'logo.png', size: 10 },
    ];
    expect(heavyReadFindings(files)).toEqual([]);
  });

  test('a minified bundle is checked as well', () => {
    const bundle = file('assets/index-abc.js', 'const e=await t.api("/deal?"+new URLSearchParams({sort:"-updatedAt",limit:"500",page:String(n)}));');
    expect(rules([bundle])).toContain('blocker:heavyListSort');
  });

  test('a heavy sort kept in a variable or a default is blocked', () => {
    const page = file('js/common.js', `
      async function list(object, select, xquery, sort) {
        const order = sort || '-createdAt';
        return fetch(location.origin + '/v2/' + object + '?limit=500&sort=' + encodeURIComponent(order));
      }`);
    const lib = file('lib/report.js', `
      RG.list = async function (object, op) {
        const q = 'limit=500&sort=' + encodeURIComponent(op.sort || 'closeDate');
        return RG.api('/' + object + '?' + q);
      };
      RG.api = (route) => fetch('/v2' + route);`);
    expect(rules([page])).toContain('blocker:heavyListSort');
    expect(rules([lib])).toContain('blocker:heavyListSort');
  });

  test('two operators on one field are blocked; the same range inside $and passes', () => {
    const bad = file('a.js', `
      const range = { $gte: iso(from), $lte: iso(to) };
      await fetch('/v2/deal?xquery=' + JSON.stringify({ createdAt: range }));`);
    const good = file('b.js', `
      const xq = { $and: [{ createdAt: { $gte: iso(from) } }, { createdAt: { $lte: iso(to) } }] };
      await fetch('/v2/deal?sort=_id&xquery=' + JSON.stringify(xq));`);
    expect(rules([bad])).toContain('blocker:sameFieldOperators');
    expect(rules([good])).not.toContain('blocker:sameFieldOperators');
  });

  test('parallel calls through the page own helpers are blocked, also across files', () => {
    const common = file('js/common.js', `
      async function request(route) { return (await fetch('/v2' + route)).json(); }
      async function listAll(object) { return request('/' + object + '?limit=500&sort=_id'); }
      window.APP = { loadNotes: async function () { return listAll('note'); }, loadTasks: async () => listAll('task') };
      async function pages(rest) {
        for (let i = 0; i < rest.length; i += 5) await Promise.all(rest.slice(i, i + 5).map((n) => request('/deal?page=' + n)));
      }
      async function load() {
        return Promise.all([listAll('deal'), listAll('deal'), listAll('deal')]);
      }`);
    const team = file('js/team.js', `
      const r = await Promise.all([APP.loadNotes(), APP.loadTasks(), APP.loadNotes()]);`);
    const found = heavyReadFindings([common, team]).filter((f) => f.rule === 'parallelListCalls');
    expect(found.map((f) => f.file + ':' + f.line)).toEqual(['js/common.js:6', 'js/common.js:9', 'js/team.js:2']);
  });

  test('sort values that are chart options are not fields', () => {
    const page = file('chart.js', `
      await fetch('/v2/deal?sort=_id');
      chart.setOption({ series: [{ type: 'funnel', sort: 'none' }] });`);
    expect(heavyReadFindings([page])).toEqual([]);
  });
});
