#!/usr/bin/env node
'use strict';

// Recognitions and gamification (badges, coins, challenges, prizes, budgets), the way the
// Prolibu app handles them.
//
//   recognition.js overview    <domain>                          settings, badge types, prizes, challenges, budgets
//   recognition.js funds       <domain> [--user <email>]         coins earned, spent and left
//   recognition.js budgets     <domain> [--at YYYY-MM-DD] [--manager <email>]   what each manager has left
//   recognition.js leaderboard <domain> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--top <n>]
//   recognition.js challenge   <domain> <challenge code | name | id>   details + applications + winners
//   recognition.js pending     <domain>                          challenge applications waiting for review
//   recognition.js preview     <domain> '<plan>'                 writes nothing; returns a version
//   recognition.js apply       <domain> '<plan>' --version <v> --confirmed [--reaches-people]
//
// Plan kinds: badge-type | award | reward | challenge | review | prize | budget | redeem | update.
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
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BLOCKED = 3;
const PAGE = 500;
const SCAN_CAP = 20000;
const MAX_PEOPLE = 50;
const MAX_REVIEWS = 50;
const KINDS = ['badge-type', 'award', 'reward', 'challenge', 'review', 'prize', 'budget', 'redeem', 'update'];
const PEOPLE_KINDS = new Set(['award', 'reward']);

// Objects the plans touch: REST path, code field, name field, fields an update may set.
const OBJECTS = {
  'badge-type': {
    path: 'badgenomination', code: 'badgeNominationCode', name: 'badgeNominationName',
    fields: { name: 'badgeNominationName', description: 'description', coins: 'coins', iconUrl: 'iconUrl', active: 'active' },
  },
  challenge: {
    path: 'challenge', code: 'challengeCode', name: 'challengeName',
    fields: { name: 'challengeName', description: 'description', coins: 'coins', maxWinners: 'maxWinners', startDate: 'period.startDate', endDate: 'period.endDate', active: 'active' },
  },
  prize: {
    path: 'prize', code: 'prizeCode', name: 'prizeName',
    fields: { name: 'prizeName', description: 'description', coins: 'coins', stock: 'stock', active: 'active', isNewPrize: 'isNewPrize' },
  },
  budget: {
    path: 'rewardsbudget', code: 'rewardsBudgetCode', name: 'rewardsBudgetName',
    fields: { name: 'rewardsBudgetName', managers: 'managers', totalCoins: 'totalCoins', startDate: 'spendingPeriod.startDate', endDate: 'spendingPeriod.endDate' },
  },
};

const STOP = 'Show this to the user in plain words (amounts, people, budget left). STOP HERE and end your turn; '
  + 'never write in the same turn as this preview. Only after the user answers with an explicit yes in a later message, run ';

class Blocked extends Error {}

// ─── Pure helpers ──────────────────────────────────────────────────────────────

const idOf = (v) => (v && typeof v === 'object' ? String(v._id || '') : v ? String(v) : '');
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const fullName = (r) => (r && typeof r === 'object' ? [r.firstName, r.lastName].filter(Boolean).join(' ').trim() || null : null);
const qs = (params) => new URLSearchParams(Object.fromEntries(Object.entries(params)
  .filter(([, v]) => v !== undefined)
  .map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])));
const rowsOf = (body) => (Array.isArray(body) ? body : (body && body.data) || []);
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const day = (d) => (d ? String(d).slice(0, 10) : null);
const isInt = (n) => Number.isInteger(n);
const getPath = (o, key) => key.split('.').reduce((x, k) => (x && typeof x === 'object' ? x[k] : undefined), o);

// The first 8 hex digits of an _id are its creation second: a floor _id walks the index.
function idFloor(date) {
  const secs = Math.floor(new Date(date).getTime() / 1000);
  return `${secs.toString(16).padStart(8, '0')}${'0'.repeat(16)}`;
}

function startOfDay(d) {
  return new Date(`${d}T00:00:00.000Z`).toISOString();
}

function endOfDay(d) {
  return new Date(`${d}T23:59:59.999Z`).toISOString();
}

function requireDate(value, label) {
  if (!DATE_RE.test(String(value || '')) || Number.isNaN(new Date(value).getTime())) {
    throw new UsageError(`${label} must be a date as YYYY-MM-DD.`);
  }
  return value;
}

function requireText(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim()) throw new UsageError(`${label} is required (text).`);
  if (value.length > max) throw new UsageError(`${label} is longer than ${max} characters.`);
  return value.trim();
}

function optionalText(value, label, max = 2000) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new UsageError(`${label} must be text.`);
  if (value.length > max) throw new UsageError(`${label} is longer than ${max} characters.`);
  return value.trim();
}

function requireCoins(value, label, { allowZero = false } = {}) {
  if (!isInt(value) || value < (allowZero ? 0 : 1) || value > 10000000) {
    throw new UsageError(`${label} must be a whole number of coins${allowZero ? ' (0 or more)' : ' above 0'}.`);
  }
  return value;
}

function requireEmail(value, label) {
  if (typeof value !== 'string' || !EMAIL_RE.test(value.trim())) throw new UsageError(`${label} must be an e-mail.`);
  return value.trim().toLowerCase();
}

function requireRef(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new UsageError(`${label} must be a code, a name or an id.`);
  return value.trim();
}

function httpsUrl(value, label) {
  if (value === undefined) return undefined;
  let u;
  try {
    u = new URL(String(value));
  } catch {
    throw new UsageError(`${label} must be an https URL.`);
  }
  if (u.protocol !== 'https:') throw new UsageError(`${label} must be an https URL.`);
  return u.toString();
}

function readPlan(arg, rootDir) {
  let text = String(arg || '');
  if (!text.trim().startsWith('{')) {
    if (!text.trim()) throw new UsageError('Missing plan (inline JSON or a JSON file in a temp folder).');
    assertDataFileAllowed(text, rootDir);
    text = fs.readFileSync(text, 'utf8');
  }
  let plan;
  try {
    plan = JSON.parse(text);
  } catch {
    throw new UsageError('The plan is not valid JSON.');
  }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new UsageError('The plan must be a JSON object.');
  if (!KINDS.includes(plan.kind)) throw new UsageError(`Plan "kind" must be one of: ${KINDS.join(', ')}.`);
  return plan;
}

// Who must agree before the write, and what the write sends to people.
function needsReachesPeople(plan) {
  if (PEOPLE_KINDS.has(plan.kind)) return true;
  if (plan.kind === 'review') return (plan.decisions || []).some((d) => d && d.decision === 'approve');
  return false;
}

// The server checks one reward at a time: it passes when ANY active budget of the giver has room
// for (what the giver already gave in that budget's period + this reward). Each manager is checked
// alone against the budget's whole total: the budget is not a shared pool.
function budgetCheck(budgets, spentByBudget, amounts) {
  const rows = budgets.map((b) => {
    const spent = spentByBudget[idOf(b)] || 0;
    return {
      budget: b.rewardsBudgetName, code: b.rewardsBudgetCode, totalCoins: b.totalCoins, spentByYou: spent,
      leftBefore: b.totalCoins - spent, period: `${day(b.spendingPeriod && b.spendingPeriod.startDate)} → ${day(b.spendingPeriod && b.spendingPeriod.endDate)}`,
    };
  });
  let given = 0;
  let failsAt = null;
  amounts.forEach((coins, i) => {
    const ok = budgets.some((b) => (spentByBudget[idOf(b)] || 0) + given + coins <= b.totalCoins);
    if (!ok && failsAt === null) failsAt = i;
    given += coins;
  });
  const total = amounts.reduce((a, c) => a + c, 0);
  return {
    rows: rows.map((r) => ({ ...r, leftAfter: r.leftBefore - total })),
    planTotal: total,
    fits: failsAt === null,
    failsAt,
  };
}

function splitCoins(challenge) {
  const max = challenge.maxWinners || 1;
  return Math.floor((challenge.coins || 0) / max);
}

// ─── API ───────────────────────────────────────────────────────────────────────

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

// A read the user's role may not allow: 403 becomes { forbidden: true } instead of an error.
async function optional(fn) {
  try {
    return { value: await fn() };
  } catch (err) {
    if (err.status === 403) return { forbidden: true };
    throw err;
  }
}

// Every matching record, oldest first, by cursor on _id (indexed); one call at a time.
async function scan(client, object, filter, select, cap = SCAN_CAP) {
  const out = [];
  let last = null;
  for (;;) {
    const parts = [filter];
    if (last) parts.push({ _id: { $gt: last } });
    const xquery = parts.length === 1 ? filter : { $and: parts };
    const rows = await list(client, object, { xquery, select, sort: '_id', limit: String(PAGE) });
    out.push(...rows);
    if (rows.length < PAGE) return { rows: out, truncated: false };
    if (out.length >= cap) return { rows: out.slice(0, cap), truncated: true };
    last = idOf(rows[rows.length - 1]);
  }
}

function periodFilter(start, end) {
  const parts = [];
  if (start) parts.push({ _id: { $gte: idFloor(start) } }, { createdAt: { $gte: start } });
  if (end) parts.push({ createdAt: { $lte: end } });
  return parts;
}

async function me(client) {
  const body = await call(client, 'GET', `/v2/user/me?${qs({ select: '_id firstName lastName email' })}`);
  const p = body && (body.profile || body);
  return { _id: idOf(p), email: p.email || null, name: fullName(p) };
}

async function userByEmail(client, email) {
  const rows = await list(client, 'user', { xquery: { email }, select: 'firstName lastName email status', limit: '2' });
  if (!rows.length) throw new Blocked(`No user with e-mail ${email} on this account.`);
  return rows[0];
}

async function usersById(client, ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  const out = {};
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const rows = await list(client, 'user', { xquery: { _id: { $in: chunk } }, select: 'firstName lastName email', limit: String(chunk.length) });
    for (const u of rows) out[idOf(u)] = { name: fullName(u), email: u.email || null };
  }
  return out;
}

// Achievements settings. /v2/user/preferences carries only the public ones (coin name) for
// every key, the admin's included; the budget, circulation and redemption switches come from
// the admin-only /v2/preference/read. Any other key gets 403 there: unknown stays null.
async function settings(client) {
  const admin = await optional(() => call(client, 'GET', '/v2/preference/read'));
  const pub = admin.value ? null : await optional(() => call(client, 'GET', '/v2/user/preferences'));
  const root = admin.value ? admin.value.preference : pub.value;
  const a = (root && root.modules && root.modules.achievements) || {};
  const has = (o, k) => o && Object.prototype.hasOwnProperty.call(o, k);
  return {
    coinName: (a.rewards && a.rewards.coinName) || 'Coin',
    budgetsEnforced: has(a.rewardsBudgets, 'required') ? Boolean(a.rewardsBudgets.required) : null,
    coinCirculationLimit: has(a.rewards, 'coinCirculationLimit') ? (a.rewards.coinCirculationLimit || 0) : null,
    redemptionsOff: has(a.redeemedPrizes, 'deactivated') ? Boolean(a.redeemedPrizes.deactivated) : null,
  };
}

// One record of OBJECTS by id, exact code or exact name (case-insensitive).
async function findOne(client, kind, ref) {
  const o = OBJECTS[kind];
  if (ID_RE.test(ref)) return call(client, 'GET', `/v2/${o.path}/${ref}`);
  const xquery = { $or: [{ [o.code]: ref }, { [o.name]: { $regex: `(?i)^${escapeRegex(ref)}$` } }] };
  const rows = await list(client, o.path, { xquery, limit: '5' });
  if (!rows.length) throw new Blocked(`No ${kind} named or coded "${ref}".`);
  if (rows.length > 1) throw new Blocked(`Several ${kind} records match "${ref}": ${rows.map((r) => `${r[o.name]} (${r[o.code]})`).join('; ')}. Use the code.`);
  return rows[0];
}

async function applicationByCode(client, code) {
  const rows = await list(client, 'challengeapplication', { xquery: { challengeApplicationCode: code }, limit: '2' });
  if (!rows.length) throw new Blocked(`No challenge application with code ${code}.`);
  return rows[0];
}

// The giver's budgets active on a date, and what the giver already gave in each period.
async function budgetState(client, userId, at = new Date()) {
  const now = new Date(at).toISOString();
  const res = await optional(() => list(client, 'rewardsbudget', {
    xquery: { $and: [{ managers: userId }, { 'spendingPeriod.startDate': { $lte: now } }, { 'spendingPeriod.endDate': { $gte: now } }] },
    limit: '50',
  }));
  if (res.forbidden) return { forbidden: true, budgets: [], spent: {} };
  const budgets = res.value;
  const spent = {};
  for (const b of budgets) {
    const start = new Date(b.spendingPeriod.startDate).toISOString();
    const end = new Date(b.spendingPeriod.endDate).toISOString();
    const { rows } = await scan(client, 'reward', { $and: [{ createdBy: userId }, ...periodFilter(start, end)] }, 'coins');
    spent[idOf(b)] = rows.reduce((acc, r) => acc + (Number(r.coins) || 0), 0);
  }
  return { forbidden: false, budgets, spent };
}

async function circulation(client, limit) {
  if (!limit) return null;
  const { rows, truncated } = await scan(client, 'reward', {}, 'coins');
  return { limit, inCirculation: rows.reduce((a, r) => a + (Number(r.coins) || 0), 0), truncated };
}

async function fundsOf(client, userId, self) {
  if (self) return call(client, 'GET', '/v2/reward/getFunds');
  const earned = await scan(client, 'reward', { assignee: userId }, 'coins');
  const spent = await scan(client, 'redeemedprize', { createdBy: userId }, 'spentFunds');
  const totalEarned = earned.rows.reduce((a, r) => a + (Number(r.coins) || 0), 0);
  const totalRedeemed = spent.rows.reduce((a, r) => a + (Number(r.spentFunds) || 0), 0);
  return { totalEarned, totalRedeemed, funds: totalEarned - totalRedeemed, truncated: earned.truncated || spent.truncated };
}

// ─── Read commands ─────────────────────────────────────────────────────────────

async function cmdOverview(client) {
  const who = await me(client);
  const cfg = await settings(client);
  const section = async (object, params, map) => {
    const res = await optional(() => list(client, object, params));
    return res.forbidden ? { forbidden: true } : res.value.map(map);
  };
  const now = new Date().toISOString();
  return {
    you: who,
    settings: cfg,
    badgeTypes: await section('badgenomination', { xquery: { active: { $ne: false } }, select: 'badgeNominationName badgeNominationCode coins', limit: '100', sort: '_id' },
      (b) => ({ name: b.badgeNominationName, code: b.badgeNominationCode, coins: b.coins || 0 })),
    prizes: await section('prize', { select: 'prizeName prizeCode coins stock active', limit: '100', sort: '_id' },
      (p) => ({ name: p.prizeName, code: p.prizeCode, coins: p.coins === undefined ? null : p.coins, stock: p.stock === undefined ? null : p.stock, active: p.active !== false })),
    challenges: await section('challenge', { xquery: { active: { $ne: false } }, select: 'challengeName challengeCode coins maxWinners period', limit: '100', sort: '-_id' },
      (c) => ({ name: c.challengeName, code: c.challengeCode, coins: c.coins, maxWinners: c.maxWinners, coinsPerWinner: splitCoins(c), from: day(c.period && c.period.startDate), to: day(c.period && c.period.endDate) })),
    budgetsActiveNow: await section('rewardsbudget', { xquery: { $and: [{ 'spendingPeriod.startDate': { $lte: now } }, { 'spendingPeriod.endDate': { $gte: now } }] }, select: 'rewardsBudgetName rewardsBudgetCode totalCoins managers spendingPeriod', limit: '100' },
      (b) => ({ name: b.rewardsBudgetName, code: b.rewardsBudgetCode, totalCoins: b.totalCoins, managers: (b.managers || []).length, from: day(b.spendingPeriod.startDate), to: day(b.spendingPeriod.endDate) })),
    note: 'Sections with forbidden:true are not visible to this key (its role). Settings with null are admin-only.',
  };
}

async function cmdFunds(client, rest, flags) {
  const who = await me(client);
  let target = who;
  if (flags.user) {
    const u = await userByEmail(client, requireEmail(flags.user, '--user'));
    target = { _id: idOf(u), email: u.email, name: fullName(u) };
  }
  const self = target._id === who._id;
  const res = await optional(() => fundsOf(client, target._id, self));
  if (res.forbidden) throw new Blocked('This key may not read other people\'s rewards or redemptions. Ask an achievements manager.');
  const cfg = await settings(client);
  return { user: target, coinName: cfg.coinName, ...res.value };
}

async function cmdBudgets(client, rest, flags) {
  const at = flags.at ? startOfDay(requireDate(flags.at, '--at')) : new Date().toISOString();
  let managerFilter = null;
  if (flags.manager) managerFilter = idOf(await userByEmail(client, requireEmail(flags.manager, '--manager')));
  const filter = { $and: [{ 'spendingPeriod.startDate': { $lte: at } }, { 'spendingPeriod.endDate': { $gte: at } }] };
  if (managerFilter) filter.$and.push({ managers: managerFilter });
  const res = await optional(() => list(client, 'rewardsbudget', { xquery: filter, limit: '100' }));
  if (res.forbidden) throw new Blocked('This key may not read rewards budgets (achievements manager role needed).');
  const budgets = res.value;
  const managerIds = [...new Set(budgets.flatMap((b) => (b.managers || []).map(idOf)))].filter((id) => !managerFilter || id === managerFilter);
  const names = await usersById(client, managerIds);
  const out = [];
  for (const b of budgets) {
    const start = new Date(b.spendingPeriod.startDate).toISOString();
    const end = new Date(b.spendingPeriod.endDate).toISOString();
    const managers = [];
    for (const m of (b.managers || []).map(idOf)) {
      if (managerFilter && m !== managerFilter) continue;
      const { rows } = await scan(client, 'reward', { $and: [{ createdBy: m }, ...periodFilter(start, end)] }, 'coins');
      const spent = rows.reduce((a, r) => a + (Number(r.coins) || 0), 0);
      managers.push({ manager: names[m] || { name: null, email: null, _id: m }, spent, left: b.totalCoins - spent });
    }
    out.push({ budget: b.rewardsBudgetName, code: b.rewardsBudgetCode, totalCoins: b.totalCoins, from: day(start), to: day(end), managers });
  }
  const cfg = await settings(client);
  return {
    at: day(at),
    budgetsEnforced: cfg.budgetsEnforced,
    budgets: out,
    howToRead: 'Each manager is checked alone against the budget total: a budget with 3 managers and 1,000 coins lets each of them give up to 1,000. '
      + '"spent" counts every reward the manager created in the period (direct rewards, coins of badges they awarded, challenge winners they approved).'
      + (cfg.budgetsEnforced === false ? ' Budgets are NOT enforced on this account: rewards are created even with no budget left.' : ''),
  };
}

async function cmdLeaderboard(client, rest, flags) {
  const from = flags.from ? startOfDay(requireDate(flags.from, '--from')) : null;
  const to = flags.to ? endOfDay(requireDate(flags.to, '--to')) : null;
  const top = flags.top ? Number(flags.top) : 10;
  if (!isInt(top) || top < 1 || top > 100) throw new UsageError('--top must be a whole number from 1 to 100.');
  const parts = periodFilter(from, to);
  const rewardsRes = await optional(() => scan(client, 'reward', parts.length ? { $and: [{ assignee: { $ne: null } }, ...parts] } : { assignee: { $ne: null } }, 'coins assignee'));
  if (rewardsRes.forbidden) throw new Blocked('This key may not read rewards (achievements manager role needed).');
  const badgesRes = await optional(() => scan(client, 'badge', parts.length ? { $and: parts } : {}, 'assignee'));
  const board = {};
  const row = (id) => {
    if (!board[id]) board[id] = { userId: id, coins: 0, rewards: 0, badges: 0 };
    return board[id];
  };
  for (const r of rewardsRes.value.rows) {
    const id = idOf(r.assignee);
    if (!id) continue;
    row(id).coins += Number(r.coins) || 0;
    row(id).rewards += 1;
  }
  if (!badgesRes.forbidden) for (const b of badgesRes.value.rows) if (idOf(b.assignee)) row(idOf(b.assignee)).badges += 1;
  const ranked = Object.values(board).sort((a, b) => b.coins - a.coins || b.badges - a.badges).slice(0, top);
  const names = await usersById(client, ranked.map((r) => r.userId));
  const cfg = await settings(client);
  return {
    period: { from: day(from), to: day(to) },
    coinName: cfg.coinName,
    ranking: ranked.map((r, i) => ({ position: i + 1, ...(names[r.userId] || {}), coins: r.coins, rewards: r.rewards, badges: badgesRes.forbidden ? null : r.badges })),
    truncated: rewardsRes.value.truncated || Boolean(badgesRes.value && badgesRes.value.truncated),
    note: 'Coins earned in the period (rewards by date of grant), not coins left. Only records this key may read are counted.',
  };
}

async function challengeView(client, challenge) {
  const apps = (await scan(client, 'challengeapplication', { challenge: idOf(challenge) }, 'challengeApplicationCode applicant status submission coins reviewedAt reviewedBy reviewNote createdAt', 2000)).rows;
  const names = await usersById(client, apps.flatMap((a) => [idOf(a.applicant), idOf(a.reviewedBy)]));
  const view = (a) => ({
    code: a.challengeApplicationCode, applicant: names[idOf(a.applicant)] || { _id: idOf(a.applicant) }, status: a.status,
    submission: a.submission || null, appliedOn: day(a.createdAt), coins: a.coins || null,
    reviewedBy: a.reviewedBy ? (names[idOf(a.reviewedBy)] || { _id: idOf(a.reviewedBy) }) : null, reviewedOn: day(a.reviewedAt), reviewNote: a.reviewNote || null,
  });
  const approved = apps.filter((a) => a.status === 'approved');
  return {
    challenge: {
      name: challenge.challengeName, code: challenge.challengeCode, description: challenge.description || null, active: challenge.active !== false,
      coins: challenge.coins, maxWinners: challenge.maxWinners, coinsPerWinner: splitCoins(challenge),
      from: day(challenge.period && challenge.period.startDate), to: day(challenge.period && challenge.period.endDate),
    },
    winners: approved.sort((a, b) => String(a.reviewedAt).localeCompare(String(b.reviewedAt))).map(view),
    slotsLeft: Math.max(0, (challenge.maxWinners || 1) - approved.length),
    pending: apps.filter((a) => a.status === 'pending').map(view),
    rejected: apps.filter((a) => a.status === 'rejected').map(view),
    note: 'A challenge does not measure anything by itself: people apply with their evidence and a manager approves up to maxWinners. '
      + 'To rank people by a business result (deals won, amounts), use a Prolibu report (prolibu-reports-dashboards).',
  };
}

async function cmdChallenge(client, [ref]) {
  const challenge = await findOne(client, 'challenge', requireRef(ref, 'Challenge'));
  return challengeView(client, challenge);
}

async function cmdPending(client) {
  const res = await optional(() => scan(client, 'challengeapplication', { status: 'pending' }, 'challengeApplicationCode challenge applicant submission createdAt', 2000));
  if (res.forbidden) throw new Blocked('This key may not read challenge applications (achievements manager role needed).');
  const apps = res.value.rows;
  const challengeIds = [...new Set(apps.map((a) => idOf(a.challenge)))];
  const challenges = {};
  for (let i = 0; i < challengeIds.length; i += 100) {
    const chunk = challengeIds.slice(i, i + 100);
    const rows = await list(client, 'challenge', { xquery: { _id: { $in: chunk } }, select: 'challengeName challengeCode coins maxWinners', limit: String(chunk.length) });
    for (const c of rows) challenges[idOf(c)] = c;
  }
  const names = await usersById(client, apps.map((a) => idOf(a.applicant)));
  return {
    pending: apps.map((a) => {
      const c = challenges[idOf(a.challenge)] || {};
      return {
        code: a.challengeApplicationCode, challenge: c.challengeName || null, challengeCode: c.challengeCode || null,
        coinsIfApproved: c.coins ? splitCoins(c) : null, applicant: names[idOf(a.applicant)] || { _id: idOf(a.applicant) },
        submission: a.submission || null, appliedOn: day(a.createdAt),
      };
    }),
    note: 'Badges have no approval step in Prolibu: awarding one is immediate. The only review queue is challenge applications.',
  };
}

// ─── Planners (read, validate, describe; never write) ─────────────────────────

async function planBadgeType(client, plan) {
  const body = {
    badgeNominationName: requireText(plan.name, 'name', 120),
    description: optionalText(plan.description, 'description'),
    coins: plan.coins === undefined ? 0 : requireCoins(plan.coins, 'coins', { allowZero: true }),
    iconUrl: httpsUrl(plan.iconUrl, 'iconUrl'),
    active: plan.active === undefined ? true : Boolean(plan.active),
  };
  const same = await list(client, 'badgenomination', { xquery: { badgeNominationName: { $regex: `(?i)^${escapeRegex(body.badgeNominationName)}$` } }, select: 'badgeNominationName badgeNominationCode', limit: '5' });
  const blockers = same.length ? [`A badge type named "${same[0].badgeNominationName}" already exists (${same[0].badgeNominationCode}). Use it or pick another name.`] : [];
  const warnings = [];
  if (body.coins > 0) warnings.push(`Every award of this badge will give ${body.coins} coins to the person, charged to the budget of whoever awards it.`);
  if (!body.iconUrl) warnings.push('No icon given: the platform\'s default badge image is used.');
  return {
    summary: `Create the badge type "${body.badgeNominationName}" (${body.coins} coins per award). Nobody is notified.`,
    calls: [{ method: 'POST', path: '/v2/badgenomination', data: JSON.parse(JSON.stringify(body)) }],
    blockers, warnings, versionParts: { body },
  };
}

async function planAward(client, plan, ctx) {
  const badgeType = await findOne(client, 'badge-type', requireRef(plan.badgeType, 'badgeType'));
  const to = [].concat(plan.to || []);
  if (!to.length || to.length > MAX_PEOPLE) throw new UsageError(`"to" needs 1 to ${MAX_PEOPLE} e-mails.`);
  const note = optionalText(plan.note, 'note', 1000);
  const people = [];
  for (const e of to) people.push(await userByEmail(client, requireEmail(e, 'to')));
  const blockers = [];
  const warnings = [];
  if (badgeType.active === false) blockers.push(`The badge type "${badgeType.badgeNominationName}" is inactive. Activate it first (its own change) or pick another.`);
  if (people.some((p) => idOf(p) === ctx.me._id)) blockers.push('You cannot award a badge to yourself with this skill.');
  if (new Set(people.map(idOf)).size !== people.length) blockers.push('The same person is listed twice.');
  const coins = badgeType.coins || 0;
  const money = coins > 0 ? await moneyCheck(client, ctx, people.map(() => coins), blockers, warnings) : null;
  return {
    summary: `Award "${badgeType.badgeNominationName}" to ${people.map((p) => `${fullName(p)} <${p.email}>`).join(', ')}`
      + `${coins ? `: ${coins} coins each, ${coins * people.length} in total, charged to your budget` : ' (no coins)'}.`,
    people: people.map((p) => ({ name: fullName(p), email: p.email })),
    reachesPeople: `Each person gets a notification and, by default, an e-mail ("ganó la insignia"); ${coins ? 'also a coins notification; ' : ''}`
      + 'the award shows to their workspace colleagues in the home widget "Recent awards". This cannot be unsent.',
    money,
    calls: people.map((p) => ({ method: 'POST', path: '/v2/badge', data: JSON.parse(JSON.stringify({ badgeNomination: idOf(badgeType), assignee: idOf(p), note })) })),
    blockers, warnings,
    versionParts: { badgeType: [idOf(badgeType), badgeType.updatedAt, coins], people: people.map(idOf), note, money: money && money.fingerprint },
  };
}

// Budget and circulation figures for coins the caller is about to give.
async function moneyCheck(client, ctx, amounts, blockers, warnings) {
  const state = await budgetState(client, ctx.me._id);
  const check = budgetCheck(state.budgets, state.spent, amounts);
  const cfg = ctx.settings;
  if (state.forbidden) warnings.push('This key cannot read rewards budgets, so the budget left is unknown.');
  else if (!state.budgets.length) {
    if (cfg.budgetsEnforced) blockers.push('You have no rewards budget active today, and this account requires one: the server would refuse.');
    else warnings.push('You have no rewards budget active today.' + (cfg.budgetsEnforced === null ? ' If the account requires budgets, the server will refuse.' : ' Budgets are not enforced on this account.'));
  } else if (!check.fits) {
    const msg = `Not enough budget: it runs out at item ${check.failsAt + 1} of ${amounts.length}.`;
    if (cfg.budgetsEnforced === false) warnings.push(`${msg} Budgets are not enforced here, so it would still be given.`);
    else blockers.push(`${msg} The server would refuse from that item on (earlier items would already be saved). Give less or raise the budget first.`);
  }
  const circ = await circulation(client, cfg.coinCirculationLimit);
  if (circ && circ.inCirculation + check.planTotal > circ.limit) {
    blockers.push(`The account caps coins in circulation at ${circ.limit}; ${circ.inCirculation} exist, and this plan adds ${check.planTotal}.`);
  }
  return {
    planTotal: check.planTotal,
    budgetsEnforced: cfg.budgetsEnforced,
    yourBudgets: state.forbidden ? 'unknown (no permission)' : check.rows,
    circulation: circ,
    fingerprint: hash([check.rows.map((r) => [r.code, r.spentByYou, r.totalCoins]), circ && circ.inCirculation]),
  };
}

async function planReward(client, plan, ctx) {
  const to = [].concat(plan.to || []);
  if (!to.length || to.length > MAX_PEOPLE) throw new UsageError(`"to" needs 1 to ${MAX_PEOPLE} e-mails.`);
  const coins = requireCoins(plan.coins, 'coins');
  const reason = requireText(plan.reason, 'reason', 300);
  const people = [];
  for (const e of to) people.push(await userByEmail(client, requireEmail(e, 'to')));
  const blockers = [];
  const warnings = [];
  if (people.some((p) => idOf(p) === ctx.me._id)) blockers.push('You cannot give coins to yourself with this skill.');
  if (new Set(people.map(idOf)).size !== people.length) blockers.push('The same person is listed twice.');
  const money = await moneyCheck(client, ctx, people.map(() => coins), blockers, warnings);
  return {
    summary: `Give ${coins} coins to each of ${people.length} person(s): ${money.planTotal} coins in total, charged to your budget. Reason: "${reason}".`,
    people: people.map((p) => ({ name: fullName(p), email: p.email, coins })),
    reachesPeople: 'Each person gets an in-app notification with the coins and the reason. This cannot be unsent.',
    money,
    calls: people.map((p) => ({ method: 'POST', path: '/v2/reward', data: { reason, coins, assignee: idOf(p) } })),
    blockers, warnings,
    versionParts: { people: people.map(idOf), coins, reason, money: money.fingerprint },
  };
}

async function planChallenge(client, plan) {
  const startDate = requireDate(plan.startDate, 'startDate');
  const endDate = requireDate(plan.endDate, 'endDate');
  if (endDate < startDate) throw new UsageError('endDate is before startDate.');
  const body = {
    challengeName: requireText(plan.name, 'name', 150),
    description: optionalText(plan.description, 'description', 4000),
    coins: requireCoins(plan.coins, 'coins'),
    maxWinners: plan.maxWinners === undefined ? 1 : plan.maxWinners,
    period: { startDate: startOfDay(startDate), endDate: endOfDay(endDate) },
    active: plan.active === undefined ? true : Boolean(plan.active),
  };
  if (!isInt(body.maxWinners) || body.maxWinners < 1 || body.maxWinners > 1000) throw new UsageError('maxWinners must be a whole number from 1 to 1000.');
  const per = Math.floor(body.coins / body.maxWinners);
  const blockers = per < 1 ? ['The coin pot split among the winners rounds to 0 coins each: the server would refuse every approval.'] : [];
  const warnings = [];
  if (per * body.maxWinners !== body.coins) warnings.push(`The pot does not split evenly: each winner gets ${per} (rounded down), ${body.coins - per * body.maxWinners} coins are never given.`);
  warnings.push('The challenge does not measure results by itself: people apply with their evidence and a manager approves winners. Each approval charges the approving manager\'s budget.');
  warnings.push('Once a winner is approved, the coins and the number of winners can no longer be changed.');
  const same = await list(client, 'challenge', { xquery: { challengeName: { $regex: `(?i)^${escapeRegex(body.challengeName)}$` } }, select: 'challengeName challengeCode', limit: '5' });
  if (same.length) blockers.push(`A challenge named "${same[0].challengeName}" already exists (${same[0].challengeCode}).`);
  return {
    summary: `Create the challenge "${body.challengeName}": ${body.coins} coins for up to ${body.maxWinners} winner(s) (${per} each), applications open ${startDate} to ${endDate} (UTC days). Nobody is notified.`,
    calls: [{ method: 'POST', path: '/v2/challenge', data: JSON.parse(JSON.stringify(body)) }],
    blockers, warnings, versionParts: { body },
  };
}

async function planReview(client, plan, ctx) {
  const decisions = [].concat(plan.decisions || []);
  if (!decisions.length || decisions.length > MAX_REVIEWS) throw new UsageError(`"decisions" needs 1 to ${MAX_REVIEWS} items.`);
  const blockers = [];
  const warnings = [];
  const items = [];
  const seen = new Set();
  const byChallenge = {};
  for (const d of decisions) {
    if (!d || typeof d !== 'object') throw new UsageError('Each decision is {"application":"<code>","decision":"approve|reject","note":"…"}.');
    const code = requireRef(d.application, 'application');
    if (!['approve', 'reject'].includes(d.decision)) throw new UsageError(`Decision for ${code} must be "approve" or "reject".`);
    if (seen.has(code)) throw new UsageError(`Application ${code} is listed twice.`);
    seen.add(code);
    const note = optionalText(d.note, 'note', 1000);
    const app = await applicationByCode(client, code);
    const cid = idOf(app.challenge);
    if (!byChallenge[cid]) {
      const challenge = await call(client, 'GET', `/v2/challenge/${cid}`);
      const approved = (await scan(client, 'challengeapplication', { $and: [{ challenge: cid }, { status: 'approved' }] }, '_id', 2000)).rows.length;
      byChallenge[cid] = { challenge, approved, adding: 0 };
    }
    const c = byChallenge[cid];
    const per = splitCoins(c.challenge);
    const item = { application: code, decision: d.decision, challenge: c.challenge.challengeName, applicantId: idOf(app.applicant), status: app.status, coins: d.decision === 'approve' ? per : 0, note, updatedAt: app.updatedAt };
    if (app.status !== 'pending') {
      blockers.push(`${code} is already ${app.status}. ${app.status === 'approved' ? 'Rejecting it now would NOT take the coins back.' : 'Approving a rejected application needs the user\'s explicit reason; do it in the app.'}`);
    }
    if (item.applicantId === ctx.me._id) blockers.push(`${code} is your own application: someone else must review it.`);
    if (d.decision === 'approve') {
      c.adding += 1;
      if (c.approved + c.adding > (c.challenge.maxWinners || 1)) blockers.push(`"${c.challenge.challengeName}" allows ${c.challenge.maxWinners} winner(s) and already has ${c.approved}: ${code} would go over.`);
      if (per < 1) blockers.push(`"${c.challenge.challengeName}" splits to 0 coins per winner: the server refuses approvals.`);
    }
    items.push(item);
  }
  const names = await usersById(client, items.map((i) => i.applicantId));
  const approvals = items.filter((i) => i.decision === 'approve');
  const money = approvals.length ? await moneyCheck(client, ctx, approvals.map((i) => i.coins), blockers, warnings) : null;
  if (approvals.length) warnings.push('Approvals are saved one by one: if one fails, the ones before it stay approved.');
  return {
    summary: `${approvals.length} approval(s) (${approvals.reduce((a, i) => a + i.coins, 0)} coins in total, charged to your budget) and ${items.length - approvals.length} rejection(s).`,
    decisions: items.map((i) => ({ application: i.application, challenge: i.challenge, applicant: names[i.applicantId] || { _id: i.applicantId }, decision: i.decision, coins: i.coins, note: i.note || null })),
    reachesPeople: approvals.length ? 'Each approved person gets an in-app notification with the coins. Rejections notify nobody. This cannot be unsent.' : null,
    money,
    calls: items.map((i) => ({ method: 'PUT', path: `/v2/challengeapplication/${i.decision}/${encodeURIComponent(i.application)}`, data: i.note ? { reviewNote: i.note } : {} })),
    blockers, warnings,
    versionParts: { items: items.map((i) => [i.application, i.decision, i.note, i.updatedAt]), challenges: Object.values(byChallenge).map((c) => [idOf(c.challenge), c.challenge.updatedAt, c.approved]), money: money && money.fingerprint },
  };
}

async function planPrize(client, plan) {
  const body = {
    prizeName: requireText(plan.name, 'name', 150),
    description: optionalText(plan.description, 'description', 4000),
    coins: requireCoins(plan.coins, 'coins', { allowZero: true }),
    stock: plan.stock,
    active: plan.active === undefined ? true : Boolean(plan.active),
    isNewPrize: plan.isNew === undefined ? undefined : Boolean(plan.isNew),
  };
  if (!isInt(body.stock) || body.stock < 0) throw new UsageError('stock must be a whole number (0 or more). A prize without stock cannot be redeemed.');
  const same = await list(client, 'prize', { xquery: { prizeName: { $regex: `(?i)^${escapeRegex(body.prizeName)}$` } }, select: 'prizeName prizeCode', limit: '5' });
  const blockers = same.length ? [`A prize named "${same[0].prizeName}" already exists (${same[0].prizeCode}).`] : [];
  return {
    summary: `Create the prize "${body.prizeName}" for ${body.coins} coins, ${body.stock} in stock${body.active ? ', available right away' : ', inactive'}. Nobody is notified.`,
    calls: [{ method: 'POST', path: '/v2/prize', data: JSON.parse(JSON.stringify(body)) }],
    blockers,
    warnings: [
      ...(body.active ? ['Anyone with the prizes role can redeem it as soon as it is created, with no approval.'] : []),
      ...(body.coins === 0 ? ['It costs 0 coins: anyone with the prizes role can take it for free until the stock runs out.'] : []),
    ],
    versionParts: { body },
  };
}

async function planBudget(client, plan) {
  const startDate = requireDate(plan.startDate, 'startDate');
  const endDate = requireDate(plan.endDate, 'endDate');
  if (endDate < startDate) throw new UsageError('endDate is before startDate.');
  const managersIn = [].concat(plan.managers || []);
  if (!managersIn.length || managersIn.length > 50) throw new UsageError('"managers" needs 1 to 50 e-mails.');
  const managers = [];
  for (const e of managersIn) managers.push(await userByEmail(client, requireEmail(e, 'managers')));
  const body = {
    rewardsBudgetName: requireText(plan.name, 'name', 150),
    managers: [...new Set(managers.map(idOf))],
    totalCoins: requireCoins(plan.totalCoins, 'totalCoins'),
    spendingPeriod: { startDate: startOfDay(startDate), endDate: endOfDay(endDate) },
  };
  const warnings = [];
  if (body.managers.length > 1) warnings.push(`Each of the ${body.managers.length} managers may give up to ${body.totalCoins} coins on their own (the server checks each one alone), so up to ${body.totalCoins * body.managers.length} in total.`);
  warnings.push('Rewards already given by these managers inside the period count against it from the start.');
  return {
    summary: `Create the budget "${body.rewardsBudgetName}": ${body.totalCoins} coins, ${startDate} to ${endDate}, managers ${managers.map((m) => m.email).join(', ')}. Nobody is notified.`,
    calls: [{ method: 'POST', path: '/v2/rewardsbudget', data: body }],
    blockers: [], warnings, versionParts: { body },
  };
}

async function planRedeem(client, plan, ctx) {
  const prize = await findOne(client, 'prize', requireRef(plan.prize, 'prize'));
  const quantity = plan.quantity === undefined ? 1 : plan.quantity;
  if (!isInt(quantity) || quantity < 1 || quantity > 1000) throw new UsageError('quantity must be a whole number from 1 to 1000.');
  const funds = await call(client, 'GET', '/v2/reward/getFunds');
  const blockers = [];
  if (ctx.settings.redemptionsOff) blockers.push('Prize redemption is turned off on this account.');
  if (prize.active === false) blockers.push(`"${prize.prizeName}" is not available (inactive).`);
  if (!isInt(prize.coins) || prize.coins < 0) blockers.push(`"${prize.prizeName}" has no price in coins: an admin must set one first.`);
  if (!isInt(prize.stock)) blockers.push(`"${prize.prizeName}" has no stock number: an admin must set one first.`);
  else if (prize.stock < quantity) blockers.push(`Only ${prize.stock} left of "${prize.prizeName}".`);
  const cost = (prize.coins || 0) * quantity;
  if (funds.funds < cost) blockers.push(`You have ${funds.funds} coins; this costs ${cost}.`);
  return {
    summary: `Redeem ${quantity} × "${prize.prizeName}" for ${cost} coins. You have ${funds.funds}; you would keep ${funds.funds - cost}. Stock goes from ${prize.stock} to ${prize.stock - quantity}.`,
    calls: [{ method: 'POST', path: '/v2/redeemedprize', data: { redeemedPrize: idOf(prize), quantity } }],
    blockers,
    warnings: ['A redemption is final and has no approval step: coins are spent and stock drops at once. Nobody is notified automatically: tell whoever hands out the prize.'],
    versionParts: { prize: [idOf(prize), prize.updatedAt, prize.stock], quantity, funds: funds.funds },
    redeemedBy: ctx.me,
  };
}

async function planUpdate(client, plan) {
  const o = OBJECTS[plan.object];
  if (!o) throw new UsageError(`"object" must be one of: ${Object.keys(OBJECTS).join(', ')}. Awards (badges) and rewards are not edited: see SKILL.md.`);
  const record = await findOne(client, plan.object, requireRef(plan.ref, 'ref'));
  if (!plan.set || typeof plan.set !== 'object' || !Object.keys(plan.set).length) throw new UsageError('The plan changes nothing: add "set".');
  const body = {};
  const changes = [];
  const blockers = [];
  const warnings = [];
  for (const [key, value] of Object.entries(plan.set)) {
    const field = o.fields[key];
    if (!field) throw new UsageError(`"${key}" cannot be set on ${plan.object}. Allowed: ${Object.keys(o.fields).join(', ')}.`);
    let v = value;
    if (key === 'name') v = requireText(value, 'name', 150);
    else if (key === 'description') v = optionalText(value, 'description', 4000);
    else if (key === 'active' || key === 'isNewPrize') v = Boolean(value);
    else if (key === 'iconUrl') v = httpsUrl(value, 'iconUrl');
    else if (key === 'startDate') v = startOfDay(requireDate(value, 'startDate'));
    else if (key === 'endDate') v = endOfDay(requireDate(value, 'endDate'));
    else if (key === 'managers') {
      const ids = [];
      for (const e of [].concat(value)) ids.push(idOf(await userByEmail(client, requireEmail(e, 'managers'))));
      v = [...new Set(ids)];
    } else if (key === 'maxWinners') {
      if (!isInt(value) || value < 1) throw new UsageError('maxWinners must be a whole number above 0.');
    } else if (key === 'stock') {
      if (!isInt(value) || value < 0) throw new UsageError('stock must be a whole number (0 or more).');
    } else v = requireCoins(value, key, { allowZero: plan.object === 'badge-type' });
    const before = getPath(record, field);
    const same = JSON.stringify(Array.isArray(before) ? before.map(idOf) : before) === JSON.stringify(v);
    if (same) continue;
    if (field.includes('.')) {
      const [parent, child] = field.split('.');
      body[parent] = { ...(body[parent] || record[parent] || {}), [child]: v };
    } else body[field] = v;
    changes.push({ field: key, before: before === undefined ? null : before, after: v });
  }
  if (plan.object === 'challenge' && changes.some((c) => c.field === 'coins' || c.field === 'maxWinners')) {
    const approved = (await scan(client, 'challengeapplication', { $and: [{ challenge: idOf(record) }, { status: 'approved' }] }, '_id', 2000)).rows.length;
    if (approved) blockers.push(`"${record.challengeName}" already has ${approved} approved winner(s): the server refuses changing coins or maxWinners.`);
  }
  if (plan.object === 'badge-type' && changes.some((c) => c.field === 'coins')) warnings.push('New coins apply to future awards only; past awards keep what they gave.');
  if (plan.object === 'prize' && changes.some((c) => c.field === 'coins')) warnings.push('A new price applies to future redemptions only.');
  const p = body.period || body.spendingPeriod;
  if (p && p.startDate && p.endDate && p.endDate < p.startDate) blockers.push('The end date would be before the start date.');
  return {
    summary: changes.length ? `Change ${plan.object} "${record[o.name]}" (${record[o.code]}): ${changes.map((c) => c.field).join(', ')}. Nobody is notified.` : 'Nothing to change.',
    changes,
    calls: changes.length ? [{ method: 'PATCH', path: `/v2/${o.path}/${idOf(record)}`, data: body }] : [],
    blockers, warnings, versionParts: { id: idOf(record), updatedAt: record.updatedAt, body },
  };
}

const PLANNERS = {
  'badge-type': planBadgeType, award: planAward, reward: planReward, challenge: planChallenge,
  review: planReview, prize: planPrize, budget: planBudget, redeem: planRedeem, update: planUpdate,
};

async function buildPlan(client, plan) {
  const ctx = { me: await me(client), settings: await settings(client) };
  let result;
  try {
    result = await PLANNERS[plan.kind](client, plan, ctx);
  } catch (err) {
    if (err.status === 403) throw new Blocked(`Your role may not do this (${err.message.replace(/^.*answered 403: /, '')}). It needs the achievements manager role; ask an admin. Do not look for another way.`);
    throw err;
  }
  const version = hash({ kind: plan.kind, me: ctx.me._id, parts: result.versionParts });
  return { ...result, version, me: ctx.me };
}

async function cmdPreview(client, [planArg], flags, ctx) {
  const plan = readPlan(planArg, ctx.rootDir);
  const built = await buildPlan(client, plan);
  const people = needsReachesPeople(plan);
  const cmd = `apply with the same plan, --version ${built.version} --confirmed${people ? ' --reaches-people (this one only after the user agreed to notify exactly these people)' : ''}.`;
  const out = {
    kind: plan.kind,
    account: client.domain,
    actingAs: built.me,
    summary: built.summary,
  };
  for (const k of ['people', 'decisions', 'changes', 'reachesPeople', 'money']) if (built[k]) out[k] = built[k];
  Object.assign(out, {
    blockers: built.blockers,
    warnings: built.warnings,
    version: built.version,
    nextStep: built.blockers.length ? 'Blocked: tell the user why in plain words; do not apply.' : STOP + cmd,
  });
  return out;
}

// ─── Write ─────────────────────────────────────────────────────────────────────

async function readBack(client, kind, sent, res) {
  const problems = [];
  if (kind === 'review') {
    const code = decodeURIComponent(sent.path.split('/').pop());
    const app = await applicationByCode(client, code);
    const want = sent.path.includes('/approve/') ? 'approved' : 'rejected';
    if (app.status !== want) problems.push(`${code} is ${app.status}, expected ${want}.`);
    if (want === 'approved' && !(app.rewards || []).length) problems.push(`${code} was approved but no reward is linked.`);
    return { record: { code, status: app.status, coins: app.coins || 0 }, problems };
  }
  const object = sent.path.split('/')[2];
  const id = sent.method === 'PATCH' ? sent.path.split('/')[3] : idOf(res);
  if (!ID_RE.test(id)) return { record: null, problems: [`${sent.method} ${sent.path} returned no id.`] };
  const after = await call(client, 'GET', `/v2/${object}/${id}`);
  for (const [k, v] of Object.entries(sent.data || {})) {
    if (k === 'period' || k === 'spendingPeriod') {
      for (const [ck, cv] of Object.entries(v)) if (new Date(getPath(after, `${k}.${ck}`)).getTime() !== new Date(cv).getTime()) problems.push(`${k}.${ck} did not save as sent.`);
    } else if (k === 'managers') {
      if (JSON.stringify((after.managers || []).map(idOf).sort()) !== JSON.stringify([...v].sort())) problems.push('managers did not save as sent.');
    } else if (['assignee', 'badgeNomination', 'redeemedPrize'].includes(k)) {
      if (idOf(after[k]) !== String(v)) problems.push(`${k} did not save as sent.`);
    } else if (JSON.stringify(after[k]) !== JSON.stringify(v)) problems.push(`${k} did not save as sent.`);
  }
  return { record: { object, _id: id, code: after[Object.keys(after).find((f) => /Code$/.test(f))] || null, rewards: after.rewards ? after.rewards.length : undefined, spentFunds: after.spentFunds }, problems };
}

async function cmdApply(client, [planArg], flags, ctx) {
  if (!flags.version) throw new UsageError('Missing --version. Run preview first and pass its version.');
  if (!flags.confirmed) throw new UsageError('Refusing to write without --confirmed. Show the preview and wait for a yes.');
  const plan = readPlan(planArg, ctx.rootDir);
  if (needsReachesPeople(plan) && !flags.reachesPeople) {
    throw new UsageError('This plan notifies people (and gives coins). It needs --reaches-people on top of --confirmed, given only after the user agreed to exactly that.');
  }
  const built = await buildPlan(client, plan);
  if (built.version !== flags.version) throw new Blocked('Something changed since the preview (records, budget spent or funds). Preview again and show the user the new figures.');
  if (built.blockers.length) throw new Blocked(built.blockers.join(' '));
  if (!built.calls.length) return { saved: true, unchanged: true, problems: [] };
  const done = [];
  const problems = [];
  for (const c of built.calls) {
    let res;
    try {
      res = await call(client, c.method, c.path, { data: c.data, confirmed: true, reachesPeople: needsReachesPeople(plan) });
    } catch (err) {
      problems.push(`Stopped at ${c.method} ${c.path.split('?')[0]}: ${err.message}`);
      break;
    }
    const back = await readBack(client, plan.kind, c, res);
    done.push(back.record);
    problems.push(...back.problems);
  }
  return {
    saved: problems.length === 0 && done.length === built.calls.length,
    written: done.length,
    of: built.calls.length,
    records: done,
    problems,
    nextStep: done.length < built.calls.length && done.length
      ? 'Partly written: tell the user exactly which items were saved and which were not. Do not retry the whole plan; preview the rest.'
      : 'Report what was saved, with the codes.',
  };
}

// ─── CLI ───────────────────────────────────────────────────────────────────────

function parseCli(argv) {
  const positional = [];
  const flags = {};
  const valued = { '--version': 'version', '--profile': 'profile', '--user': 'user', '--at': 'at', '--manager': 'manager', '--from': 'from', '--to': 'to', '--top': 'top' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--confirmed') flags.confirmed = true;
    else if (arg === '--reaches-people') flags.reachesPeople = true;
    else if (valued[arg]) {
      if (i + 1 >= argv.length) throw new UsageError(`Missing value for ${arg}.`);
      i += 1;
      flags[valued[arg]] = argv[i];
    } else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  return { command: positional[0], domain: positional[1], rest: positional.slice(2), flags };
}

const COMMANDS = {
  overview: cmdOverview, funds: cmdFunds, budgets: cmdBudgets, leaderboard: cmdLeaderboard,
  challenge: cmdChallenge, pending: cmdPending, preview: cmdPreview, apply: cmdApply,
};

async function main(argv, opts = {}) {
  const rootDir = opts.rootDir || DEFAULT_ROOT;
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  let client;
  const hide = (text) => (client ? client.redact(text) : String(text));
  try {
    const { command, domain, rest, flags } = parseCli(argv);
    const handler = COMMANDS[command];
    if (!handler || !domain) throw new UsageError(`Usage: recognition.js <${Object.keys(COMMANDS).join('|')}> <domain> …`);
    client = createClient({ domain, rootDir, profile: flags.profile, fetchImpl: opts.fetchImpl, stderr });
    const result = await handler(client, rest, flags, { rootDir });
    stdout.write(`${hide(JSON.stringify(result, null, 2))}\n`);
    if (command === 'apply' && !result.saved) return 1;
    return result.blockers && result.blockers.length ? BLOCKED : 0;
  } catch (err) {
    if (err instanceof UsageError) {
      stderr.write(`${hide(err.message)}\n`);
      return 2;
    }
    if (err instanceof Blocked) {
      stderr.write(`BLOCKED: ${hide(err.message)}\n`);
      return BLOCKED;
    }
    stderr.write(`Request failed: ${hide(err && err.message)}\n`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = {
  main, budgetCheck, splitCoins, idFloor, needsReachesPeople, readPlan,
};
