/* global describe, test, expect, beforeEach */
const fs = require('fs');
const os = require('os');
const path = require('path');
const rec = require('../.claude/skills/prolibu-recognition/scripts/recognition');
const { heavyReadFindings } = require('../.claude/skills/_shared/heavy-read-check');

const D = 'dev99.example.com';
const KEY = 'test-key-123456';
const ME = 'a'.repeat(24);
const LAURA = 'b'.repeat(24);
const PEDRO = 'c'.repeat(24);
const BT_HAPPY = 'd'.repeat(24);
const BT_OFF = 'e'.repeat(24);
const CHALLENGE = 'f'.repeat(24);
const PRIZE = '1'.repeat(24);
const PRIZE_NOSTOCK = '2'.repeat(24);
const BUDGET = '3'.repeat(24);

let rootDir;
let calls;
let state;
let seq;
let forbid;
let prefs;

const respond = (status, body) => ({ status, text: async () => JSON.stringify(body) });
const idOf = (v) => (v && typeof v === 'object' ? String(v._id) : v === null || v === undefined ? null : String(v));
const newId = () => `9${String(seq++).padStart(23, '0')}`;
const getPath = (o, key) => key.split('.').reduce((x, k) => (x && typeof x === 'object' ? x[k] : undefined), o);
const NOW = new Date();
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();
const idAt = (iso) => `${Math.floor(new Date(iso).getTime() / 1000).toString(16).padStart(8, '0')}${'0'.repeat(15)}${seq++ % 10}`;

// A small Mongo matcher: the operators the script sends.
function cmp(field, op, v) {
  const f = field instanceof Date ? field.toISOString() : field;
  if (op === '$gt') return f > v;
  if (op === '$gte') return f >= v;
  if (op === '$lte') return f <= v;
  if (op === '$lt') return f < v;
  if (op === '$ne') return v === null ? f !== null && f !== undefined : f !== v;
  if (op === '$in') return [].concat(f ?? []).some((x) => v.map(String).includes(idOf(x)));
  if (op === '$regex') return new RegExp(v.replace(/^\(\?i\)/, ''), 'i').test(String(f || ''));
  throw new Error(`fake: unsupported ${op}`);
}

function matches(record, q) {
  return Object.entries(q || {}).every(([k, v]) => {
    if (k === '$and') return v.every((s) => matches(record, s));
    if (k === '$or') return v.some((s) => matches(record, s));
    const field = getPath(record, k);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const ops = Object.keys(v);
      // The real server keeps only the last operator of a field: fail loudly if the script sends two.
      if (ops.length > 1) throw new Error(`fake: two operators on ${k}`);
      return cmp(field, ops[0], v[ops[0]]);
    }
    if (Array.isArray(field)) return field.map(idOf).includes(String(v));
    return idOf(field) === String(v) || field === v;
  });
}

// Verified server behaviour (see the private report): Reward checks the giver's active budgets
// only when the preference requires it; Badge with a coin-bearing type creates a Reward; approve
// creates a Reward of floor(coins/maxWinners); redeem checks stock and funds and lowers stock.
function createReward(body, by) {
  const r = { _id: newId(), createdBy: by, createdAt: NOW.toISOString(), updatedAt: `R${seq++}`, ...body };
  state.reward.push(r);
  return r;
}

function funds(userId) {
  const earned = state.reward.filter((r) => r.assignee === userId).reduce((a, r) => a + r.coins, 0);
  const spent = state.redeemedprize.filter((r) => r.createdBy === userId).reduce((a, r) => a + r.spentFunds, 0);
  return { totalEarned: earned, totalRedeemed: spent, funds: earned - spent };
}

async function fakeFetch(url, init) {
  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body });
  if (forbid && forbid(init.method, u.pathname)) return respond(403, { error: 'Forbidden. User has no permission.' });
  if (u.pathname === '/v2/user/me') return respond(200, { profile: { _id: ME, email: 'me@example.com', firstName: 'Me', apiKey: KEY } });
  // Live shape (dev12, admin key): user/preferences hides the admin-only switches even for the
  // owner; preference/read (admins only) has them under preference.modules.
  if (u.pathname === '/v2/user/preferences') return respond(200, { modules: { achievements: { rewards: { coinName: prefs.rewards.coinName } } } });
  if (u.pathname === '/v2/preference/read') return respond(200, { preference: { modules: { achievements: prefs } } });
  if (u.pathname === '/v2/reward/getFunds') return respond(200, funds(ME));
  const m = /^\/v2\/challengeapplication\/(approve|reject)\/(.+)$/.exec(u.pathname);
  if (m && init.method === 'PUT') {
    const app = state.challengeapplication.find((a) => a.challengeApplicationCode === decodeURIComponent(m[2]));
    if (!app) return respond(404, { error: 'Not found' });
    if (m[1] === 'approve') {
      const ch = state.challenge.find((c) => c._id === app.challenge);
      const coins = Math.floor(ch.coins / ch.maxWinners);
      const r = createReward({ coins, assignee: app.applicant, reason: 'Granted for Challenge' }, ME);
      Object.assign(app, { status: 'approved', coins, rewards: [r._id], reviewedBy: ME, updatedAt: `A${seq++}` });
    } else Object.assign(app, { status: 'rejected', updatedAt: `A${seq++}` });
    return respond(200, app);
  }
  const [, , object, id] = u.pathname.split('/');
  const coll = state[object];
  if (!coll) return respond(404, { error: 'not found' });
  if (init.method === 'GET') {
    if (id) {
      const r = coll.find((x) => x._id === id);
      return r ? respond(200, r) : respond(404, { error: 'not found' });
    }
    if (u.searchParams.get('sort') && !/^-?_id$/.test(u.searchParams.get('sort'))) throw new Error(`fake: sort on ${u.searchParams.get('sort')}`);
    const xquery = u.searchParams.get('xquery') ? JSON.parse(u.searchParams.get('xquery')) : {};
    const limit = Number(u.searchParams.get('limit') || 20);
    let rows = coll.filter((r) => matches(r, xquery));
    if (u.searchParams.get('sort') === '_id') rows = [...rows].sort((a, b) => a._id.localeCompare(b._id));
    return respond(200, { pagination: { count: rows.length }, data: rows.slice(0, limit) });
  }
  if (init.method === 'POST') {
    const r = { _id: newId(), createdBy: ME, createdAt: NOW.toISOString(), updatedAt: `N${seq++}`, ...body };
    if (object === 'badge') {
      const bt = state.badgenomination.find((b) => b._id === body.badgeNomination);
      if (bt.coins) r.rewards = [createReward({ coins: bt.coins, assignee: body.assignee, reason: 'Granted for Badge Award' }, ME)._id];
    }
    if (object === 'reward' && prefs.rewardsBudgets && prefs.rewardsBudgets.required) {
      const ok = state.rewardsbudget.some((b) => b.managers.includes(ME)
        && state.reward.filter((x) => x.createdBy === ME).reduce((a, x) => a + x.coins, 0) + body.coins <= b.totalCoins);
      if (!ok) return respond(400, { error: 'Cannot find an active rewards budget to cover the reward.' });
    }
    if (object === 'redeemedprize') {
      const p = state.prize.find((x) => x._id === body.redeemedPrize);
      p.stock -= body.quantity;
      r.spentFunds = p.coins * body.quantity;
    }
    coll.push(r);
    if (object === 'reward') r.createdBy = ME;
    return respond(201, r);
  }
  if (init.method === 'PATCH') {
    const r = coll.find((x) => x._id === id);
    Object.assign(r, body, { updatedAt: `U${seq++}` });
    return respond(200, r);
  }
  return respond(405, { error: 'unexpected' });
}

let stdout;
let stderr;
async function run(args) {
  stdout = '';
  stderr = '';
  const code = await rec.main([args[0], D, ...args.slice(1)], {
    rootDir, fetchImpl: fakeFetch, stdout: { write: (t) => { stdout += t; } }, stderr: { write: (t) => { stderr += t; } },
  });
  let json = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    // Errors go to stderr.
  }
  return { code, json };
}

const writes = () => calls.filter((c) => c.method !== 'GET');

async function preview(plan) {
  const p = await run(['preview', JSON.stringify(plan)]);
  return p;
}

async function apply(plan, version, extra = ['--reaches-people']) {
  calls = [];
  return run(['apply', JSON.stringify(plan), '--version', version, '--confirmed', ...extra]);
}

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recognition-root-'));
  fs.mkdirSync(path.join(rootDir, 'accounts', D), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'accounts', D, 'profile.json'), JSON.stringify({ apiKey: KEY }));
  calls = [];
  seq = 0;
  forbid = null;
  prefs = { rewards: { coinName: 'Coin', coinCirculationLimit: 0 }, rewardsBudgets: { required: true }, redeemedPrizes: { deactivated: false } };
  state = {
    user: [
      { _id: ME, email: 'me@example.com', firstName: 'Me' },
      { _id: LAURA, email: 'laura@example.com', firstName: 'Laura', lastName: 'Test' },
      { _id: PEDRO, email: 'pedro@example.com', firstName: 'Pedro', lastName: 'Test' },
    ],
    badgenomination: [
      { _id: BT_HAPPY, badgeNominationName: 'Cliente Feliz', badgeNominationCode: 'BNM-1', coins: 50, active: true, updatedAt: 'B1' },
      { _id: BT_OFF, badgeNominationName: 'Old badge', badgeNominationCode: 'BNM-2', coins: 0, active: false, updatedAt: 'B2' },
    ],
    badge: [],
    reward: [
      { _id: idAt(daysAgo(10)), coins: 900, assignee: PEDRO, createdBy: ME, createdAt: daysAgo(10), updatedAt: 'R0' },
      { _id: idAt(daysAgo(400)), coins: 500, assignee: LAURA, createdBy: ME, createdAt: daysAgo(400), updatedAt: 'R0' },
    ],
    rewardsbudget: [
      { _id: BUDGET, rewardsBudgetName: 'Q4', rewardsBudgetCode: 'RWB-1', managers: [ME, PEDRO], totalCoins: 1000, spendingPeriod: { startDate: daysAgo(30), endDate: daysAgo(-60) }, updatedAt: 'W1' },
    ],
    challenge: [
      { _id: CHALLENGE, challengeName: '10 deals in December', challengeCode: 'CHL-1', coins: 300, maxWinners: 2, active: true, period: { startDate: daysAgo(5), endDate: daysAgo(-20) }, updatedAt: 'C1' },
    ],
    challengeapplication: [
      { _id: newId(), challengeApplicationCode: 'CAP-1', challenge: CHALLENGE, applicant: LAURA, status: 'pending', submission: 'Won 11', updatedAt: 'P1' },
      { _id: newId(), challengeApplicationCode: 'CAP-2', challenge: CHALLENGE, applicant: PEDRO, status: 'pending', updatedAt: 'P2' },
      { _id: newId(), challengeApplicationCode: 'CAP-3', challenge: CHALLENGE, applicant: ME, status: 'pending', updatedAt: 'P3' },
    ],
    prize: [
      { _id: PRIZE, prizeName: 'Mug', prizeCode: 'PRZ-1', coins: 20, stock: 3, active: true, updatedAt: 'Z1' },
      { _id: PRIZE_NOSTOCK, prizeName: 'Hoodie', prizeCode: 'PRZ-2', coins: 10, active: true, updatedAt: 'Z2' },
    ],
    redeemedprize: [],
  };
});

describe('pure rules', () => {
  test('a budget is checked per manager against its whole total', () => {
    const b = { _id: BUDGET, rewardsBudgetName: 'Q4', totalCoins: 1000, spendingPeriod: {} };
    const r = rec.budgetCheck([b], { [BUDGET]: 900 }, [50, 50, 50]);
    expect(r.fits).toBe(false);
    expect(r.failsAt).toBe(2);
    expect(r.planTotal).toBe(150);
    expect(rec.budgetCheck([b], { [BUDGET]: 900 }, [50, 50]).fits).toBe(true);
  });

  test('the challenge pot splits rounded down', () => {
    expect(rec.splitCoins({ coins: 100, maxWinners: 3 })).toBe(33);
    expect(rec.splitCoins({ coins: 1, maxWinners: 2 })).toBe(0);
  });

  test('approvals, awards and rewards need --reaches-people; rejections and catalog changes do not', () => {
    expect(rec.needsReachesPeople({ kind: 'award' })).toBe(true);
    expect(rec.needsReachesPeople({ kind: 'reward' })).toBe(true);
    expect(rec.needsReachesPeople({ kind: 'review', decisions: [{ decision: 'reject' }] })).toBe(false);
    expect(rec.needsReachesPeople({ kind: 'review', decisions: [{ decision: 'approve' }] })).toBe(true);
    expect(rec.needsReachesPeople({ kind: 'prize' })).toBe(false);
  });

  test('the script passes the heavy-read check', () => {
    const rel = '.claude/skills/prolibu-recognition/scripts/recognition.js';
    const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    expect(heavyReadFindings([{ rel, text }])).toEqual([]);
  });
});

describe('award a badge', () => {
  const plan = { kind: 'award', badgeType: 'cliente feliz', to: 'laura@example.com', note: 'Acme close' };

  test('previews coins against the budget, then awards only with --reaches-people', async () => {
    const p = await preview(plan);
    expect(p.code).toBe(0);
    expect(writes()).toEqual([]);
    expect(p.json.money.planTotal).toBe(50);
    expect(p.json.money.yourBudgets[0]).toMatchObject({ spentByYou: 900, leftBefore: 100, leftAfter: 50 });
    expect(p.json.reachesPeople).toMatch(/e-mail/);
    expect(p.json.nextStep).toMatch(/STOP HERE/);

    const noFlag = await apply(plan, p.json.version, []);
    expect(noFlag.code).toBe(2);
    expect(writes()).toEqual([]);

    const a = await apply(plan, p.json.version);
    expect(a.code).toBe(0);
    expect(writes()).toEqual([expect.objectContaining({ method: 'POST', path: '/v2/badge', body: { badgeNomination: BT_HAPPY, assignee: LAURA, note: 'Acme close' } })]);
    expect(a.json.records[0].rewards).toBe(1);
  });

  test('refuses an inactive badge type and awarding yourself', async () => {
    let p = await preview({ kind: 'award', badgeType: 'Old badge', to: 'laura@example.com' });
    expect(p.code).toBe(3);
    expect(p.json.blockers.join(' ')).toMatch(/inactive/);
    p = await preview({ kind: 'award', badgeType: 'BNM-1', to: 'me@example.com' });
    expect(p.code).toBe(3);
    expect(p.json.blockers.join(' ')).toMatch(/yourself/);
  });

  test('a stale version is refused when the budget moved', async () => {
    const p = await preview(plan);
    state.reward.push({ _id: newId(), coins: 10, assignee: PEDRO, createdBy: ME, createdAt: NOW.toISOString() });
    const a = await apply(plan, p.json.version);
    expect(a.code).toBe(3);
    expect(stderr).toMatch(/Preview again/);
    expect(writes()).toEqual([]);
  });
});

describe('give coins', () => {
  test('blocks a batch that does not fit the budget, with the item where it runs out', async () => {
    const p = await preview({ kind: 'reward', to: ['laura@example.com', 'pedro@example.com'], coins: 60, reason: 'Great quarter' });
    expect(p.code).toBe(3);
    expect(p.json.money.planTotal).toBe(120);
    expect(p.json.blockers.join(' ')).toMatch(/item 2 of 2/);
  });

  test('only warns when budgets are not enforced', async () => {
    prefs.rewardsBudgets.required = false;
    const plan = { kind: 'reward', to: ['laura@example.com', 'pedro@example.com'], coins: 60, reason: 'Great quarter' };
    const p = await preview(plan);
    expect(p.code).toBe(0);
    expect(p.json.warnings.join(' ')).toMatch(/not enforced/);
    const a = await apply(plan, p.json.version);
    expect(a.code).toBe(0);
    expect(writes().map((w) => w.body.assignee)).toEqual([LAURA, PEDRO]);
  });

  test('blocks going over the circulation cap', async () => {
    prefs.rewards.coinCirculationLimit = 1420;
    const p = await preview({ kind: 'reward', to: 'laura@example.com', coins: 30, reason: 'x' });
    expect(p.code).toBe(3);
    expect(p.json.blockers.join(' ')).toMatch(/circulation/);
  });

  test('rejects non-integer coins before any call', async () => {
    const p = await preview({ kind: 'reward', to: 'laura@example.com', coins: 1.5, reason: 'x' });
    expect(p.code).toBe(2);
    expect(calls.filter((c) => !['/v2/user/me', '/v2/user/preferences', '/v2/preference/read'].includes(c.path))).toEqual([]);
  });
});

describe('review challenge applications', () => {
  test('approves within the slots and reads back the reward', async () => {
    state.rewardsbudget[0].totalCoins = 2000;
    const plan = { kind: 'review', decisions: [{ application: 'CAP-1', decision: 'approve', note: 'Verified' }, { application: 'CAP-2', decision: 'reject' }] };
    const p = await preview(plan);
    expect(p.code).toBe(0);
    expect(p.json.decisions[0]).toMatchObject({ coins: 150, decision: 'approve' });
    expect(p.json.money.planTotal).toBe(150);
    const a = await apply(plan, p.json.version);
    expect(a.code).toBe(0);
    expect(writes().map((w) => w.path)).toEqual(['/v2/challengeapplication/approve/CAP-1', '/v2/challengeapplication/reject/CAP-2']);
    expect(writes()[0].body).toEqual({ reviewNote: 'Verified' });
  });

  test('blocks self-approval, going over maxWinners and re-deciding', async () => {
    let p = await preview({ kind: 'review', decisions: [{ application: 'CAP-3', decision: 'approve' }] });
    expect(p.code).toBe(3);
    expect(p.json.blockers.join(' ')).toMatch(/your own/);
    state.challenge[0].maxWinners = 1;
    p = await preview({ kind: 'review', decisions: [{ application: 'CAP-1', decision: 'approve' }, { application: 'CAP-2', decision: 'approve' }] });
    expect(p.code).toBe(3);
    expect(p.json.blockers.join(' ')).toMatch(/would go over/);
    state.challengeapplication[0].status = 'approved';
    p = await preview({ kind: 'review', decisions: [{ application: 'CAP-1', decision: 'reject' }] });
    expect(p.code).toBe(3);
    expect(p.json.blockers.join(' ')).toMatch(/NOT take the coins back/);
  });

  test('a reject-only review needs no --reaches-people', async () => {
    const plan = { kind: 'review', decisions: [{ application: 'CAP-2', decision: 'reject' }] };
    const p = await preview(plan);
    const a = await apply(plan, p.json.version, []);
    expect(a.code).toBe(0);
  });
});

describe('challenges, prizes, budgets', () => {
  test('a pot that splits to zero is blocked', async () => {
    const p = await preview({ kind: 'challenge', name: 'Tiny', coins: 1, maxWinners: 3, startDate: '2026-12-01', endDate: '2026-12-31' });
    expect(p.code).toBe(3);
  });

  test('creates a challenge with full-day UTC bounds', async () => {
    const plan = { kind: 'challenge', name: 'QA Skills · reto', coins: 300, maxWinners: 3, startDate: '2026-12-01', endDate: '2026-12-31' };
    const p = await preview(plan);
    expect(p.code).toBe(0);
    const a = await apply(plan, p.json.version, []);
    expect(a.code).toBe(0);
    expect(writes()[0].body.period).toEqual({ startDate: '2026-12-01T00:00:00.000Z', endDate: '2026-12-31T23:59:59.999Z' });
  });

  test('changing coins after a winner is blocked', async () => {
    state.challengeapplication[0].status = 'approved';
    const p = await preview({ kind: 'update', object: 'challenge', ref: 'CHL-1', set: { coins: 500 } });
    expect(p.code).toBe(3);
  });

  test('a prize needs a stock number', async () => {
    const p = await preview({ kind: 'prize', name: 'Cap', coins: 10 });
    expect(p.code).toBe(2);
  });

  test('a free prize (0 coins) is allowed with a warning', async () => {
    const p = await preview({ kind: 'prize', name: 'Sticker', coins: 0, stock: 3 });
    expect(p.code).toBe(0);
    expect(p.json.warnings.join(' ')).toMatch(/0 coins/);
  });

  test('a multi-manager budget warns that each manager may spend the whole total', async () => {
    const p = await preview({ kind: 'budget', name: 'Q1', managers: ['me@example.com', 'pedro@example.com'], totalCoins: 1000, startDate: '2027-01-01', endDate: '2027-03-31' });
    expect(p.code).toBe(0);
    expect(p.json.warnings.join(' ')).toMatch(/up to 2000/);
  });
});

describe('redeem a prize', () => {
  test('blocks without funds and without a stock number', async () => {
    let p = await preview({ kind: 'redeem', prize: 'Mug' });
    expect(p.code).toBe(3);
    expect(p.json.blockers.join(' ')).toMatch(/You have 0 coins/);
    p = await preview({ kind: 'redeem', prize: 'Hoodie' });
    expect(p.json.blockers.join(' ')).toMatch(/no stock number/);
  });

  test('redeems when funds and stock allow', async () => {
    state.reward.push({ _id: newId(), coins: 100, assignee: ME, createdBy: PEDRO, createdAt: NOW.toISOString() });
    const plan = { kind: 'redeem', prize: 'PRZ-1', quantity: 2 };
    const p = await preview(plan);
    expect(p.code).toBe(0);
    expect(p.json.summary).toMatch(/40 coins/);
    const a = await apply(plan, p.json.version, []);
    expect(a.code).toBe(0);
    expect(state.prize[0].stock).toBe(1);
  });
});

describe('reads', () => {
  test('budgets: left per manager, cursor on _id, one operator per field', async () => {
    const r = await run(['budgets']);
    expect(r.code).toBe(0);
    const q4 = r.json.budgets[0];
    expect(q4.managers.find((m) => m.manager.email === 'me@example.com')).toMatchObject({ spent: 900, left: 100 });
    expect(q4.managers.find((m) => m.manager.email === 'pedro@example.com')).toMatchObject({ spent: 0, left: 1000 });
    expect(calls.filter((c) => c.path === '/v2/reward').every((c) => c.query.sort === '_id')).toBe(true);
  });

  test('leaderboard ranks coins earned in the period', async () => {
    const r = await run(['leaderboard', '--from', daysAgo(30).slice(0, 10)]);
    expect(r.code).toBe(0);
    expect(r.json.ranking.map((x) => x.email)).toEqual(['pedro@example.com']);
  });

  test('pending lists applications and explains badges have no approval', async () => {
    const r = await run(['pending']);
    expect(r.json.pending.map((x) => x.code)).toEqual(['CAP-1', 'CAP-2', 'CAP-3']);
    expect(r.json.note).toMatch(/no approval/);
  });

  test('a role without access gets a plain block, not a crash', async () => {
    forbid = (method, p) => p.startsWith('/v2/challengeapplication');
    const r = await run(['pending']);
    expect(r.code).toBe(3);
    expect(stderr).toMatch(/achievements manager/);
  });

  test('a preview the role cannot read is blocked with the role to ask for', async () => {
    forbid = (method, p) => p.startsWith('/v2/badgenomination');
    const r = await preview({ kind: 'award', badgeType: 'Cliente Feliz', to: 'laura@example.com' });
    expect(r.code).toBe(3);
    expect(stderr).toMatch(/achievements manager role/);
  });

  test('admin settings come from preference/read; a non-admin key sees them as unknown', async () => {
    let r = await run(['overview']);
    expect(r.json.settings).toEqual({ coinName: 'Coin', budgetsEnforced: true, coinCirculationLimit: 0, redemptionsOff: false });
    forbid = (method, p) => p === '/v2/preference/read';
    r = await run(['overview']);
    expect(r.json.settings).toEqual({ coinName: 'Coin', budgetsEnforced: null, coinCirculationLimit: null, redemptionsOff: null });
  });

  test('never prints the API key', async () => {
    await run(['overview']);
    expect(stdout).not.toContain(KEY);
  });
});

describe('guards', () => {
  test('apply needs --version and --confirmed', async () => {
    let r = await run(['apply', JSON.stringify({ kind: 'prize', name: 'x', coins: 1, stock: 1 }), '--confirmed']);
    expect(r.code).toBe(2);
    r = await run(['apply', JSON.stringify({ kind: 'prize', name: 'x', coins: 1, stock: 1 }), '--version', 'abc']);
    expect(r.code).toBe(2);
    expect(writes()).toEqual([]);
  });

  test('unknown kind and update of badges are refused', async () => {
    let r = await preview({ kind: 'delete-everything' });
    expect(r.code).toBe(2);
    r = await preview({ kind: 'update', object: 'badge', ref: 'x', set: { note: 'y' } });
    expect(r.code).toBe(2);
  });
});
