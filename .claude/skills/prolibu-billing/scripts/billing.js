#!/usr/bin/env node
'use strict';

// Reads and writes Prolibu billing the way the platform expects it: invoices from a won deal
// or from catalog lines, payments one invoice at a time, emit and void. It never deletes
// invoices, never regenerates a deal's invoices, and never sets "paid" by hand.
//
//   billing.js invoices        <domain> [--deal <id>] [--contact <id>] [--status <s>] [--limit <n>]
//   billing.js show            <domain> <invoiceNumber|_id>
//   billing.js receivables     <domain> [--as-of YYYY-MM-DD] [--contact <id>]
//   billing.js metrics         <domain> [--months <1-36>] [--from YYYY-MM]
//   billing.js subscriptions   <domain> [<subscriptionCode|_id>]
//   billing.js payment-methods <domain> <contactId>
//   billing.js preview         <domain> '<plan json>'                  writes nothing; returns a version
//   billing.js apply           <domain> '<plan json>' --version <v> --confirmed
//
// Plan kinds: fromDeal, manual, pay, unpay, emit, void (see SKILL.md). The plan is inline
// JSON, or the path of a JSON file in a temp folder.
//
// Every command accepts --profile <name> (reads accounts/<domain>/profile.<name>.json).
// Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked (nothing written).

const fs = require('fs');
const crypto = require('crypto');
const {
  createClient, assertDataFileAllowed, UsageError, DEFAULT_ROOT,
} = require('../../_shared/prolibu-api');

const ID_RE = /^[a-f0-9]{24}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const BLOCKED = 3;
const STATUSES = ['draft', 'scheduled', 'open', 'paid', 'void'];
const METHODS = ['Bank Transfer', 'Credit Card', 'Cash', 'Check', 'Other'];
const WON_STAGE_CODE = 'deal-stage-approved';
const MAX_PAGES = 10; // 10 × 500 open invoices for receivables
const STOP = 'Show this to the user in plain words. STOP HERE and end your turn; never write in the same turn as '
  + 'this preview. Only after the user answers with an explicit yes in a later message, run apply with the same '
  + 'plan and --version set to this version.';

class Blocked extends Error {}

// ─── Pure helpers ──────────────────────────────────────────────────────────────

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function money(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function ymd(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function todayYmd(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromDay, toDay) {
  return Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / 86400000);
}

function rows(body) {
  return Array.isArray(body) ? body : (body && body.data) || [];
}

function refId(value) {
  return value && typeof value === 'object' ? value._id : value;
}

function contactName(contact) {
  if (!contact || typeof contact !== 'object') return null;
  return [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.email || null;
}

function summarizeInvoice(inv) {
  const q = inv.quote || {};
  return {
    _id: inv._id,
    invoiceNumber: inv.invoiceNumber,
    title: inv.title,
    status: inv.status,
    contact: contactName(inv.contact) || refId(inv.contact) || null,
    contactId: refId(inv.contact) || null,
    issueDate: ymd(inv.issueDate),
    dueDate: ymd(inv.dueDate),
    currency: q.quoteCurrency || null,
    total: money(q.total),
    balance: money(inv.balance),
    paymentsCount: (inv.payments || []).length,
    originDeal: refId(inv.originDeal) || null,
    subscription: refId(inv.subscription) || null,
  };
}

function summarizeLine(line) {
  return {
    product: line.productName || line.description || null,
    quantity: line.quantity,
    price: line.price,
    discountRate: line.discountRate || 0,
    currency: line.currency || null,
    total: money(line.total),
  };
}

// Mongo keeps only one operator when two land on the same field in one object, so date ranges
// go through $and. The server also drops filters on quote.* (a mixed field).
function invoiceFilter({ deal, contact, status } = {}) {
  const and = [];
  if (deal) and.push({ originDeal: deal });
  if (contact) and.push({ contact });
  if (status) and.push({ status });
  if (!and.length) return {};
  return and.length === 1 ? and[0] : { $and: and };
}

// Client-side aging of open invoices: per contact and per currency (never adds currencies).
function agingReport(invoices, asOf) {
  const byContact = new Map();
  const totals = {};
  for (const inv of invoices) {
    const s = summarizeInvoice(inv);
    if (s.status !== 'open' || !(s.balance > 0)) continue;
    const cur = s.currency || 'unknown';
    const key = s.contactId || 'none';
    if (!byContact.has(key)) byContact.set(key, { contactId: s.contactId, contact: s.contact, currencies: {} });
    const entry = byContact.get(key);
    const c = entry.currencies[cur] || (entry.currencies[cur] = {
      open: 0, overdue: 0, invoices: 0, overdueInvoices: 0, aging: { '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 }, oldestDueDate: null,
    });
    const t = totals[cur] || (totals[cur] = { open: 0, overdue: 0 });
    c.open = round2(c.open + s.balance);
    c.invoices += 1;
    t.open = round2(t.open + s.balance);
    const late = s.dueDate ? daysBetween(s.dueDate, asOf) : 0;
    if (late > 0) {
      c.overdue = round2(c.overdue + s.balance);
      c.overdueInvoices += 1;
      t.overdue = round2(t.overdue + s.balance);
      const bucket = late <= 30 ? '1-30' : late <= 60 ? '31-60' : late <= 90 ? '61-90' : '90+';
      c.aging[bucket] = round2(c.aging[bucket] + s.balance);
      if (!c.oldestDueDate || s.dueDate < c.oldestDueDate) c.oldestDueDate = s.dueDate;
    }
  }
  const clients = [...byContact.values()].sort((a, b) => {
    const sum = (x) => Object.values(x.currencies).reduce((acc, c) => acc + c.overdue, 0);
    return sum(b) - sum(a);
  });
  return { asOf, totalsByCurrency: totals, clients };
}

// What generateFromDeal will create, replayed from the deal (the server does not dry-run).
function simulateFromDeal(deal, { today, defaultDueDateDays = 0, accountCurrency, invoiceWord = 'Invoice' }) {
  const quote = (deal.proposal && deal.proposal.quote) || {};
  const proposalTitle = (deal.proposal && deal.proposal.title) || deal.dealName || '';
  const plan = quote.paymentPlan || {};
  const dealCurrency = quote.quoteCurrency || accountCurrency || null;
  const due = (issue) => (defaultDueDateDays ? addDays(issue, defaultDueDateDays) : issue);
  if (!plan.enabled) {
    return [{
      title: `${invoiceWord} - ${(deal.proposal && deal.proposal.title) || ''}`,
      issueDate: today, dueDate: due(today), status: 'draft', currency: dealCurrency, total: money(quote.total),
    }];
  }
  const out = [];
  (plan.payments || []).forEach((payment, index) => {
    const total = typeof payment.total === 'number'
      ? payment.total
      : ((payment.quote && payment.quote.lineItems) || []).reduce((acc, li) => acc + (Number(li.total) || 0), 0);
    if (total <= 0) return;
    let title = `${invoiceWord} - ${(deal.proposal && deal.proposal.title) || ''} (${payment.title})`;
    if (plan.titleTemplate) {
      title = plan.titleTemplate.replace(/{{(.*?)}}/g, (match, key) => {
        if (key.trim() === 'number') return String(index + 1);
        if (key.trim() === 'proposalTitle') return proposalTitle;
        return match;
      });
    }
    const issueDate = ymd(payment.issueDate) || today;
    let dueDate = ymd(payment.dueDate);
    if (!dueDate && payment.dueInDays != null) dueDate = addDays(issueDate, Number(payment.dueInDays) || 0);
    if (!dueDate) dueDate = due(issueDate);
    if (dueDate < issueDate) dueDate = issueDate;
    // Instalments carry their own quote, usually without quoteCurrency: the server then falls
    // back to the account currency (and converts foreign lines at today's rate).
    const currency = (payment.quote && payment.quote.quoteCurrency) || accountCurrency || null;
    out.push({
      title, issueDate, dueDate, status: issueDate > today ? 'scheduled' : 'draft', currency, total: round2(total),
    });
  });
  return out;
}

// Plans the payments: one Payment per invoice, numbers only, never above the balance.
function planPayments(entries, invoicesByRef, { today }) {
  const blockers = [];
  const warnings = [];
  const steps = [];
  const pending = new Map();
  entries.forEach((p, i) => {
    const inv = invoicesByRef.get(String(p.invoice));
    const s = summarizeInvoice(inv);
    const already = pending.get(s._id) || 0;
    const available = round2((s.balance || 0) - already);
    if (s.status !== 'open') {
      blockers.push(`payments[${i}]: invoice ${s.invoiceNumber} is ${s.status}. Payments go only on open invoices`
        + `${s.status === 'draft' || s.status === 'scheduled' ? ' (emit it first, with its own yes)' : ''}.`);
    }
    if (p.amount > available) {
      blockers.push(`payments[${i}]: ${p.amount} is more than the balance of ${s.invoiceNumber} (${available} ${s.currency}). `
        + 'Split the payment over other invoices or lower it.');
    }
    if (round2(p.amount) !== p.amount) {
      warnings.push(`payments[${i}]: ${p.amount} has more than 2 decimals; send it rounded so the balance can reach exactly 0.`);
    }
    pending.set(s._id, round2(already + p.amount));
    const newBalance = round2(available - p.amount);
    const note = [p.date && p.date !== today ? `Pago recibido el ${p.date}.` : null, p.note || null].filter(Boolean).join(' ');
    steps.push({
      invoice: s.invoiceNumber,
      invoiceId: s._id,
      title: s.title,
      contact: s.contact,
      currency: s.currency,
      amount: p.amount,
      method: p.method,
      note: note || null,
      balanceBefore: available,
      balanceAfter: newBalance,
      statusAfter: newBalance === 0 ? 'paid' : s.status,
      body: { invoiceId: s._id, paymentMethod: p.method, paidAmount: p.amount, ...(note ? { specialNote: note } : {}) },
    });
  });
  const currencies = [...new Set(steps.map((s) => s.currency))];
  if (currencies.length > 1) {
    warnings.push(`The invoices are in different currencies (${currencies.join(', ')}). Each payment is recorded in its `
      + 'invoice\'s currency, without conversion: confirm each amount in that currency.');
  }
  if (entries.some((p) => p.date && p.date !== today)) {
    warnings.push('Payments have no date field: the platform dates them today. The real date goes into the note.');
  }
  return { steps, blockers, warnings };
}

// ─── Plan reading ──────────────────────────────────────────────────────────────

const KIND_KEYS = {
  fromDeal: ['kind', 'dealId', 'notWonConfirmed'],
  manual: ['kind', 'contactId', 'title', 'issueDate', 'dueDate', 'currency', 'emit', 'lines'],
  pay: ['kind', 'payments'],
  unpay: ['kind', 'invoice', 'paymentId'],
  emit: ['kind', 'invoice'],
  void: ['kind', 'invoice'],
};

function readPlan(arg, rootDir, today = todayYmd()) {
  let text = String(arg || '');
  if (!text.trim().startsWith('{')) {
    if (!text.trim()) throw new UsageError('Missing the plan JSON.');
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
  if ('deleteInvoicesWithOriginDeal' in plan) {
    throw new UsageError('deleteInvoicesWithOriginDeal is never sent: it deletes every invoice of the deal, paid ones and their '
      + 'payments included. Void the wrong invoices and create new ones by hand instead.');
  }
  const allowed = KIND_KEYS[plan.kind];
  if (!allowed) throw new UsageError(`"kind" must be one of ${Object.keys(KIND_KEYS).join(', ')}.`);
  for (const key of Object.keys(plan)) {
    if (!allowed.includes(key)) throw new UsageError(`"${key}" is not allowed in a ${plan.kind} plan. Allowed: ${allowed.join(', ')}.`);
  }
  const ref = (v, where) => {
    if (typeof v !== 'string' || !v.trim() || v.length > 64 || /[$\s{}]/.test(v)) {
      throw new UsageError(`${where} must be an invoice number or a 24-hex _id.`);
    }
    return v.trim();
  };
  if (plan.kind === 'fromDeal') {
    if (!ID_RE.test(String(plan.dealId))) throw new UsageError('"dealId" must be a 24-hex _id.');
    if ('notWonConfirmed' in plan && typeof plan.notWonConfirmed !== 'boolean') throw new UsageError('"notWonConfirmed" is true or false.');
  }
  if (plan.kind === 'manual') {
    if (!ID_RE.test(String(plan.contactId))) throw new UsageError('"contactId" must be a 24-hex _id.');
    if (typeof plan.title !== 'string' || !plan.title.trim() || plan.title.length > 200) throw new UsageError('"title" is required (up to 200 characters).');
    for (const k of ['issueDate', 'dueDate']) {
      if (!DAY_RE.test(String(plan[k])) || !ymd(plan[k])) throw new UsageError(`"${k}" must be YYYY-MM-DD.`);
    }
    if (plan.currency !== undefined && !/^[A-Z]{3}$/.test(String(plan.currency))) throw new UsageError('"currency" is a 3-letter ISO code.');
    if ('emit' in plan && typeof plan.emit !== 'boolean') throw new UsageError('"emit" is true or false.');
    if (!Array.isArray(plan.lines) || !plan.lines.length || plan.lines.length > 100) throw new UsageError('"lines" needs 1 to 100 catalog lines.');
    plan.lines.forEach((l, i) => {
      if (!l || !ID_RE.test(String(l.pricebookEntryId))) throw new UsageError(`lines[${i}]: "pricebookEntryId" is required (find it with prolibu-quotes search).`);
      for (const k of Object.keys(l)) {
        if (!['pricebookEntryId', 'quantity', 'discountRate', 'description'].includes(k)) throw new UsageError(`lines[${i}]: "${k}" cannot be set.`);
      }
      if (typeof l.quantity !== 'number' || !(l.quantity > 0)) throw new UsageError(`lines[${i}]: quantity must be a number greater than 0.`);
      if ('discountRate' in l && (typeof l.discountRate !== 'number' || l.discountRate < 0 || l.discountRate > 1)) {
        throw new UsageError(`lines[${i}]: discountRate is a decimal between 0 and 1 (10% = 0.1).`);
      }
      if ('description' in l && (typeof l.description !== 'string' || l.description.length > 2000)) throw new UsageError(`lines[${i}]: description is text.`);
    });
  }
  if (plan.kind === 'pay') {
    if (!Array.isArray(plan.payments) || !plan.payments.length || plan.payments.length > 50) throw new UsageError('"payments" needs 1 to 50 entries.');
    plan.payments.forEach((p, i) => {
      const where = `payments[${i}]`;
      for (const k of Object.keys(p || {})) {
        if (!['invoice', 'amount', 'method', 'date', 'note'].includes(k)) throw new UsageError(`${where}: "${k}" cannot be set.`);
      }
      ref(p.invoice, `${where}.invoice`);
      if (typeof p.amount !== 'number' || !Number.isFinite(p.amount) || p.amount <= 0) {
        throw new UsageError(`${where}: amount must be a number greater than 0 (not text: the server would add it as text).`);
      }
      if (!METHODS.includes(p.method)) throw new UsageError(`${where}: method must be one of ${METHODS.join(', ')}.`);
      if (p.date !== undefined && (!DAY_RE.test(String(p.date)) || !ymd(p.date))) throw new UsageError(`${where}: date must be YYYY-MM-DD.`);
      if (p.date && p.date > today) throw new UsageError(`${where}: the payment date ${p.date} is in the future.`);
      if (p.note !== undefined && (typeof p.note !== 'string' || p.note.length > 500)) throw new UsageError(`${where}: note is text up to 500 characters.`);
    });
  }
  if (plan.kind === 'unpay') {
    ref(plan.invoice, '"invoice"');
    if (!ID_RE.test(String(plan.paymentId))) throw new UsageError('"paymentId" must be a 24-hex _id (from show).');
  }
  if (plan.kind === 'emit' || plan.kind === 'void') ref(plan.invoice, '"invoice"');
  return plan;
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

const INVOICE_SELECT = 'invoiceNumber title status contact issueDate dueDate quote balance payments originDeal subscription updatedAt';
const CONTACT_POP = JSON.stringify([{ path: 'contact', select: 'firstName lastName email' }]);

async function findInvoice(client, ref) {
  const filter = ID_RE.test(ref) ? { _id: ref } : { invoiceNumber: ref };
  const q = new URLSearchParams({ xquery: JSON.stringify(filter), select: INVOICE_SELECT, populatePath: CONTACT_POP, limit: '2' });
  const found = rows(await call(client, 'GET', `/v2/invoice?${q}`));
  if (!found.length) throw new Blocked(`No invoice ${ref} (or this user cannot see it).`);
  if (found.length > 1) throw new Blocked(`More than one invoice matches ${ref}; use its _id.`);
  return found[0];
}

async function paymentsOf(client, invoiceId) {
  const q = new URLSearchParams({
    xquery: JSON.stringify({ paidInvoices: invoiceId }),
    select: 'paymentCode paidAmount currency paymentMethod specialNote createdAt paidInvoices',
    sort: 'createdAt',
    limit: '500',
  });
  return rows(await call(client, 'GET', `/v2/payment?${q}`)).map((p) => ({
    _id: p._id, paymentCode: p.paymentCode, amount: p.paidAmount, currency: p.currency, method: p.paymentMethod,
    note: p.specialNote || null, recordedAt: p.createdAt,
  }));
}

async function billingPrefs(client) {
  const prefs = await call(client, 'GET', '/v2/user/preferences');
  const billing = (prefs && prefs.modules && prefs.modules.billing) || {};
  const invoices = billing.invoices || {};
  const locale = prefs.globalLocale || {};
  const lang = String(locale.language || 'en').slice(0, 2);
  return {
    menuOn: Boolean(billing.general && billing.general.enabled),
    defaultDueDateDays: Number(invoices.defaultDueDateDays) || 0,
    numbering: Boolean(invoices.ascendingDocumentNumber),
    accountCurrency: locale.currency || null,
    invoiceWord: { es: 'Factura', pt: 'Fatura' }[lang] || 'Invoice',
  };
}

function prefWarnings(prefs, creates) {
  const out = [];
  if (!prefs.menuOn) out.push('Billing is turned off in this account\'s menu: the invoices exist and the API works, but users will not see a Billing menu until an admin turns it on.');
  if (prefs.numbering && creates) out.push(`Fiscal numbering is on: each invoice created takes the next number, for good (${creates} number${creates > 1 ? 's' : ''}).`);
  return out;
}

// ─── Read commands ─────────────────────────────────────────────────────────────

async function cmdInvoices(client, rest, flags) {
  for (const k of ['deal', 'contact']) {
    if (flags[k] && !ID_RE.test(flags[k])) throw new UsageError(`--${k} must be a 24-hex _id.`);
  }
  if (flags.status && !STATUSES.includes(flags.status)) throw new UsageError(`--status must be one of ${STATUSES.join(', ')}.`);
  const q = new URLSearchParams({
    xquery: JSON.stringify(invoiceFilter(flags)), select: INVOICE_SELECT, populatePath: CONTACT_POP,
    sort: '-issueDate', limit: String(flags.limit || 20),
  });
  const body = await call(client, 'GET', `/v2/invoice?${q}`);
  const list = rows(body).map(summarizeInvoice);
  return {
    count: (body.pagination && body.pagination.count) ?? list.length,
    invoices: list,
    note: flags.deal ? 'A deal\'s invoices are found by originDeal; invoices made by hand are never linked to a deal.' : undefined,
  };
}

async function cmdShow(client, [ref]) {
  if (!ref) throw new UsageError('Usage: show <domain> <invoiceNumber|_id>');
  const inv = await findInvoice(client, ref);
  const payments = await paymentsOf(client, inv._id);
  return {
    invoice: summarizeInvoice(inv),
    lines: ((inv.quote && inv.quote.lineItems) || []).map(summarizeLine),
    payments,
    paid: round2(payments.reduce((a, p) => a + (p.amount || 0), 0)),
    version: inv.updatedAt,
  };
}

async function cmdReceivables(client, rest, flags) {
  const asOf = flags.asOf || todayYmd();
  if (!DAY_RE.test(asOf)) throw new UsageError('--as-of must be YYYY-MM-DD.');
  if (flags.contact && !ID_RE.test(flags.contact)) throw new UsageError('--contact must be a 24-hex _id.');
  const and = [{ status: 'open' }, { balance: { $gt: 0 } }];
  if (flags.contact) and.push({ contact: flags.contact });
  const all = [];
  let truncated = false;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const q = new URLSearchParams({
      xquery: JSON.stringify({ $and: and }), select: INVOICE_SELECT, populatePath: CONTACT_POP,
      sort: 'dueDate', limit: '500', page: String(page),
    });
    const body = await call(client, 'GET', `/v2/invoice?${q}`);
    all.push(...rows(body));
    const last = body.pagination ? body.pagination.lastPage : 1;
    if (page >= last) break;
    if (page === MAX_PAGES) truncated = true;
  }
  return {
    ...agingReport(all, asOf),
    openInvoices: all.length,
    truncated,
    note: 'Amounts are open balances per currency; currencies are never added together. Overdue = due date before the as-of day.',
  };
}

async function cmdMetrics(client, rest, flags) {
  const q = new URLSearchParams();
  if (flags.months) {
    if (!/^\d+$/.test(flags.months) || Number(flags.months) < 1 || Number(flags.months) > 36) throw new UsageError('--months is 1 to 36.');
    q.set('months', flags.months);
  }
  if (flags.from) {
    if (!/^\d{4}-\d{2}$/.test(flags.from)) throw new UsageError('--from is YYYY-MM.');
    q.set('from', flags.from);
  }
  const body = await call(client, 'GET', `/v2/invoice/metrics${q.toString() ? `?${q}` : ''}`);
  return {
    metrics: body,
    note: 'Metrics cover every non-void invoice of the account, converted to the account currency.',
  };
}

function subStatus(sub, now = new Date()) {
  const at = (v) => (v ? new Date(v) : null);
  if (sub.cancelledAt && at(sub.cancelledAt) <= now) return 'cancelled';
  if (sub.startDate && at(sub.startDate) > now) return 'pending';
  if (sub.endDate && at(sub.endDate) <= now) return 'expired';
  return 'active';
}

async function cmdSubscriptions(client, [ref]) {
  const select = 'subscriptionCode title contact deal contractCode startDate endDate termMonths paymentInterval autoRenew activatedAt cancelledAt source payments';
  const filter = ref ? (ID_RE.test(ref) ? { _id: ref } : { subscriptionCode: ref }) : {};
  if (ref && (ref.length > 64 || /[$\s{}]/.test(ref))) throw new UsageError('Give a subscription code or _id.');
  const q = new URLSearchParams({ xquery: JSON.stringify(filter), select, populatePath: CONTACT_POP, sort: '-startDate', limit: ref ? '2' : '50' });
  const body = await call(client, 'GET', `/v2/subscription?${q}`);
  const list = rows(body).map((s) => {
    const entries = (s.payments || []).filter((p) => !p.removedByEvent);
    return {
      _id: s._id, subscriptionCode: s.subscriptionCode, title: s.title, contact: contactName(s.contact) || refId(s.contact),
      deal: refId(s.deal) || null, status: subStatus(s), startDate: ymd(s.startDate), endDate: ymd(s.endDate),
      paymentInterval: s.paymentInterval || null, autoRenew: Boolean(s.autoRenew),
      calendar: ref ? entries.map((p) => ({ title: p.title, issueDate: ymd(p.issueDate), dueDate: ymd(p.dueDate), invoice: p.invoice || null })) : undefined,
      entriesWithoutInvoice: entries.filter((p) => !p.invoice).length,
    };
  });
  return {
    count: (body.pagination && body.pagination.count) ?? list.length,
    subscriptions: list,
    note: 'Read only in this skill. Billing subscriptions are not the account\'s own Prolibu plan (SubscriptionPlan).',
  };
}

// Only fields that say a method exists; never card, bank or gateway identifiers.
async function cmdPaymentMethods(client, [contactId]) {
  if (!ID_RE.test(String(contactId))) throw new UsageError('Usage: payment-methods <domain> <contactId>');
  const q = new URLSearchParams({ xquery: JSON.stringify({ contact: contactId }), select: 'gateway isDefault isVerified active', limit: '50' });
  const body = await call(client, 'GET', `/v2/paymentmethod?${q}`);
  const list = rows(body).map((m) => ({ gateway: m.gateway || null, isDefault: Boolean(m.isDefault), isVerified: Boolean(m.isVerified), active: m.active !== false }));
  return { count: list.length, paymentMethods: list, note: 'Card and bank details are never shown. Payment methods are read only.' };
}

// ─── Planning (shared by preview and apply) ────────────────────────────────────

async function planFromDeal(client, plan) {
  const today = todayYmd();
  const q = new URLSearchParams({ select: 'dealName contact stage proposal.enabled proposal.title proposal.quote updatedAt' });
  const deal = await call(client, 'GET', `/v2/deal/${plan.dealId}?${q}`);
  const stage = deal.stage ? await call(client, 'GET', `/v2/stage/${refId(deal.stage)}?select=stageName%20stageCode`) : null;
  const existing = rows(await call(client, 'GET', `/v2/invoice?${new URLSearchParams({ xquery: JSON.stringify({ originDeal: plan.dealId }), select: INVOICE_SELECT, limit: '100' })}`));
  const subs = rows(await call(client, 'GET', `/v2/subscription?${new URLSearchParams({ xquery: JSON.stringify({ deal: plan.dealId }), select: 'subscriptionCode', limit: '5' })}`));
  const prefs = await billingPrefs(client);
  const quote = (deal.proposal && deal.proposal.quote) || {};
  const blockers = [];
  const warnings = [];
  if (!deal.contact) blockers.push('The deal has no contact; the server refuses to invoice it.');
  if (!(deal.proposal && deal.proposal.enabled)) blockers.push('The deal\'s proposal is turned off; the server refuses to invoice it.');
  if (!(money(quote.total) > 0)) blockers.push('The deal\'s quote total is not greater than 0.');
  if (subs.length) blockers.push(`The deal has a subscription (${subs[0].subscriptionCode}); its invoices come from the subscription calendar, which this skill does not write.`);
  if (existing.length) {
    blockers.push(`The deal already has ${existing.length} invoice(s) (${existing.map((i) => `${i.invoiceNumber} ${i.status}`).join(', ')}). `
      + 'Generating again answers 400, and the server\'s delete-and-regenerate option erases them with their payments, so it is not offered. '
      + 'To fix one, void it and create a new invoice by hand.');
  }
  const won = Boolean(stage && stage.stageCode === WON_STAGE_CODE);
  if (!won && !plan.notWonConfirmed) {
    blockers.push(`The deal is not in the won stage (it is in ${stage ? stage.stageName : 'no stage'}). The server would invoice it anyway; `
      + 'ask the user whether it is really won, and only on a clear yes add "notWonConfirmed": true.');
  } else if (!won) {
    warnings.push(`The deal is in ${stage ? stage.stageName : 'no stage'}, not won; the user confirmed invoicing it anyway.`);
  }
  const invoices = simulateFromDeal(deal, { today, ...prefs });
  if (quote.paymentPlan && quote.paymentPlan.enabled) {
    const foreign = invoices.filter((i) => quote.quoteCurrency && i.currency && i.currency !== quote.quoteCurrency);
    if (foreign.length) {
      warnings.push(`The deal is quoted in ${quote.quoteCurrency}, but ${foreign.length} instalment(s) carry no currency of their own, so `
        + `the server will quote them in the account currency (${prefs.accountCurrency}) and convert at today's rate. Tell the user before generating.`);
    }
    const skipped = (quote.paymentPlan.payments || []).length - invoices.length;
    if (skipped > 0) warnings.push(`${skipped} instalment(s) with total 0 are skipped.`);
    if (invoices.some((i) => i.status === 'scheduled')) warnings.push('Instalments with a future issue date are born "scheduled" and open by themselves on that date.');
  }
  warnings.push('Invoices are born as drafts (or scheduled). Any later edit of a draft, even its title, emits it (status open).');
  warnings.push(...prefWarnings(prefs, invoices.length));
  const version = hash({ deal: deal.updatedAt, existing: existing.map((i) => [i._id, i.updatedAt]), subs: subs.map((s) => s._id), kind: 'fromDeal' });
  return {
    summary: {
      deal: { _id: deal._id, dealName: deal.dealName, stage: stage ? stage.stageName : null, won, currency: quote.quoteCurrency || prefs.accountCurrency, total: money(quote.total) },
      invoices,
    },
    blockers, warnings, version, expectedCount: invoices.length,
  };
}

async function planManual(client, plan) {
  const contact = await call(client, 'GET', `/v2/contact/${plan.contactId}?select=firstName%20lastName%20email%20updatedAt`);
  const prefs = await billingPrefs(client);
  const formatted = [];
  for (const l of plan.lines) {
    const line = await call(client, 'GET', `/v2/quote/formatLineItem?${new URLSearchParams({ pricebookEntryId: l.pricebookEntryId })}`);
    const built = { ...line, quantity: l.quantity };
    delete built.lineId;
    if ('discountRate' in l) Object.assign(built, { discountRate: l.discountRate, discountAmount: 0 });
    if (l.description) built.description = l.description;
    formatted.push(built);
  }
  const quote = { quoteCurrency: plan.currency || prefs.accountCurrency || undefined, lineItems: formatted };
  // /v2/quote/calculate adds the account's automatic charges; an invoice does not, so the
  // preview drops them with a second pass to show the total the invoice will really have.
  let calculated = await call(client, 'PUT', '/v2/quote/calculate', { data: quote });
  const autoKeys = (calculated.lineItems || [])
    .filter((li) => li.meta && li.meta.percentOfTotal && ['preference', 'productFamily'].includes(li.meta.percentOfTotal.source))
    .map((li) => `${li.meta.percentOfTotal.source}:${refId(li.meta.percentOfTotal.productFamily) || ''}:${li.meta.percentOfTotal.scopeKey || ''}`);
  if (autoKeys.length) {
    calculated = await call(client, 'PUT', '/v2/quote/calculate', { data: { ...quote, autoPercentOfTotal: { dismissed: autoKeys } } });
  }
  // A second apply of the same plan must not create a twin: invoices of this contact with the
  // same title go into the version and block the plan.
  const twinsQuery = new URLSearchParams({
    xquery: JSON.stringify({ $and: [{ contact: plan.contactId }, { title: plan.title.trim() }] }), select: 'invoiceNumber status updatedAt', limit: '20',
  });
  const twins = rows(await call(client, 'GET', `/v2/invoice?${twinsQuery}`));
  const blockers = [];
  const warnings = [];
  const liveTwins = twins.filter((t) => t.status !== 'void');
  if (liveTwins.length) {
    blockers.push(`This contact already has an invoice with this title (${liveTwins.map((t) => `${t.invoiceNumber} ${t.status}`).join(', ')}). `
      + 'If it is really a new invoice, give it a different title.');
  }
  if (plan.issueDate > plan.dueDate) blockers.push('The issue date is after the due date; the server refuses it.');
  if (!(money(calculated.total) > 0)) blockers.push('The total is not greater than 0; the server refuses it.');
  for (const li of calculated.lineItems || []) {
    if (li.currency && calculated.quoteCurrency && li.currency !== calculated.quoteCurrency) {
      warnings.push(`${li.productName} is priced in ${li.currency} and converted to ${calculated.quoteCurrency} at today's rate.`);
    }
  }
  if (plan.emit) warnings.push('It is created already emitted (open): from then on its amounts, dates and contact cannot change; a mistake means voiding it.');
  else warnings.push('It is created as a draft. Any later edit of a draft, even its title, emits it (status open).');
  warnings.push('An invoice made by hand is not linked to any deal.');
  warnings.push(...prefWarnings(prefs, 1));
  const body = {
    title: plan.title.trim(), contact: plan.contactId, issueDate: plan.issueDate, dueDate: plan.dueDate,
    status: plan.emit ? 'open' : 'draft', quote,
  };
  return {
    summary: {
      contact: contactName(contact), title: body.title, status: body.status, issueDate: plan.issueDate, dueDate: plan.dueDate,
      currency: calculated.quoteCurrency, lines: (calculated.lineItems || []).map(summarizeLine), total: money(calculated.total),
    },
    blockers, warnings, body, expectedTotal: money(calculated.total),
    version: hash({ plan, contact: contact.updatedAt, twins: twins.map((t) => [t._id, t.updatedAt]), kind: 'manual' }),
  };
}

async function planPay(client, plan) {
  const today = todayYmd();
  const byRef = new Map();
  for (const p of plan.payments) {
    if (!byRef.has(String(p.invoice))) byRef.set(String(p.invoice), await findInvoice(client, String(p.invoice)));
  }
  const result = planPayments(plan.payments, byRef, { today });
  const ids = [...new Set([...byRef.values()].map((i) => i._id))];
  if (ids.length > 1) result.warnings.push(`One payment over ${ids.length} invoices is recorded as ${plan.payments.length} separate payments, one per invoice.`);
  const version = hash({ invoices: [...byRef.values()].map((i) => [i._id, i.updatedAt]), kind: 'pay' });
  return {
    summary: { payments: result.steps.map(({ body, ...rest }) => rest) },
    steps: result.steps, blockers: result.blockers, warnings: result.warnings, version,
  };
}

async function planUnpay(client, plan) {
  const inv = await findInvoice(client, plan.invoice);
  const payments = await paymentsOf(client, inv._id);
  const s = summarizeInvoice(inv);
  const blockers = [];
  const payment = payments.find((p) => p._id === plan.paymentId);
  const listed = (inv.payments || []).map(String).includes(plan.paymentId);
  if (!payment || !listed) blockers.push(`Payment ${plan.paymentId} is not a payment of invoice ${s.invoiceNumber}. The server would delete it from whatever invoice it belongs to, so it is refused.`);
  if (s.status === 'void') blockers.push(`Invoice ${s.invoiceNumber} is void.`);
  const newBalance = payment ? round2((s.balance || 0) + payment.amount) : s.balance;
  return {
    summary: {
      invoice: s.invoiceNumber, title: s.title, contact: s.contact, currency: s.currency,
      payment: payment || null, balanceBefore: s.balance, balanceAfter: newBalance,
      statusAfter: s.status === 'paid' || s.status === 'open' ? 'open' : s.status,
    },
    blockers,
    warnings: ['The payment record is deleted, not archived. To correct an amount, remove it and register the right one.'],
    invoiceId: inv._id,
    version: inv.updatedAt,
  };
}

async function planStatus(client, plan) {
  const inv = await findInvoice(client, plan.invoice);
  const s = summarizeInvoice(inv);
  const blockers = [];
  const warnings = [];
  if (plan.kind === 'emit') {
    if (!['draft', 'scheduled'].includes(s.status)) blockers.push(`Invoice ${s.invoiceNumber} is ${s.status}; only drafts and scheduled invoices are emitted.`);
    if (s.status === 'scheduled') warnings.push(`It is scheduled to open by itself on ${s.issueDate}; emitting now opens it early.`);
    warnings.push('Once emitted, its amounts, dates and contact cannot change; a mistake means voiding it and issuing a new one.');
  } else {
    if (s.status === 'void') blockers.push(`Invoice ${s.invoiceNumber} is already void.`);
    if (s.status === 'paid' || s.paymentsCount > 0) {
      blockers.push(`Invoice ${s.invoiceNumber} has payments. Remove them first (each with its own yes) or keep the invoice.`);
    }
    warnings.push('Voiding is final in practice: the app has no way to reopen it. It stays on record, with its number, as void.');
  }
  return {
    summary: { invoice: s.invoiceNumber, title: s.title, contact: s.contact, currency: s.currency, total: s.total, statusBefore: s.status, statusAfter: plan.kind === 'emit' ? 'open' : 'void' },
    blockers, warnings, invoiceId: inv._id, version: inv.updatedAt,
  };
}

const PLANNERS = {
  fromDeal: planFromDeal, manual: planManual, pay: planPay, unpay: planUnpay, emit: planStatus, void: planStatus,
};

async function cmdPreview(client, [planArg], flags, ctx) {
  const plan = readPlan(planArg, ctx.rootDir);
  const planned = await PLANNERS[plan.kind](client, plan);
  return {
    kind: plan.kind,
    ...planned.summary,
    warnings: planned.warnings,
    blockers: planned.blockers,
    version: planned.version,
    reachesPeople: false,
    nextStep: planned.blockers.length ? 'Blocked: explain the blockers to the user in plain words; do not apply.' : STOP,
  };
}

// ─── Writes ────────────────────────────────────────────────────────────────────

async function applyFromDeal(client, plan, planned) {
  const created = rows(await call(client, 'POST', '/v2/invoice/generatefromdeal', { data: { dealId: plan.dealId }, confirmed: true }));
  const q = new URLSearchParams({ xquery: JSON.stringify({ originDeal: plan.dealId }), select: INVOICE_SELECT, limit: '100' });
  const after = rows(await call(client, 'GET', `/v2/invoice?${q}`)).map(summarizeInvoice);
  const problems = [];
  if (after.length !== planned.expectedCount) problems.push(`Expected ${planned.expectedCount} invoice(s); the deal now has ${after.length}.`);
  if (created.length !== planned.expectedCount) problems.push(`The server answered with ${created.length} invoice(s), not ${planned.expectedCount}.`);
  return { saved: problems.length === 0, invoices: after, problems };
}

async function applyManual(client, plan, planned) {
  const created = await call(client, 'POST', '/v2/invoice', { data: planned.body, confirmed: true });
  const after = await findInvoice(client, created._id);
  const s = summarizeInvoice(after);
  const problems = [];
  const warnings = [];
  if (s.status !== planned.body.status) problems.push(`Saved as ${s.status}, not ${planned.body.status}.`);
  if (s.total !== planned.expectedTotal) warnings.push(`The saved total is ${s.total}, the preview said ${planned.expectedTotal}: an account script changed it. Tell the user.`);
  return { saved: problems.length === 0, invoice: s, lines: ((after.quote && after.quote.lineItems) || []).map(summarizeLine), problems, warnings };
}

async function applyPay(client, plan, planned) {
  const done = [];
  const problems = [];
  for (const step of planned.steps) {
    try {
      const res = await call(client, 'POST', '/v2/invoice/registerpayment', { data: step.body, confirmed: true });
      done.push({ invoice: step.invoice, paymentId: res.payment && res.payment._id, paymentCode: res.payment && res.payment.paymentCode, amount: step.amount });
    } catch (err) {
      problems.push(`Payment on ${step.invoice} failed: ${err.message}. The ones before it were recorded; nothing after it was sent.`);
      break;
    }
  }
  const invoices = [];
  for (const id of [...new Set(planned.steps.map((s) => s.invoiceId))]) {
    const s = summarizeInvoice(await findInvoice(client, id));
    const expected = planned.steps.filter((x) => x.invoiceId === id).pop();
    if (!problems.length && s.balance !== expected.balanceAfter) problems.push(`${s.invoiceNumber}: balance is ${s.balance}, expected ${expected.balanceAfter}.`);
    invoices.push({ invoiceNumber: s.invoiceNumber, status: s.status, balance: s.balance, currency: s.currency });
  }
  return { saved: problems.length === 0, payments: done, invoices, problems };
}

async function applyUnpay(client, plan, planned) {
  await call(client, 'POST', '/v2/invoice/removepayment', { data: { invoiceId: planned.invoiceId, paymentId: plan.paymentId }, confirmed: true });
  const s = summarizeInvoice(await findInvoice(client, planned.invoiceId));
  const problems = [];
  if ((await paymentsOf(client, planned.invoiceId)).some((p) => p._id === plan.paymentId)) problems.push('The payment is still there.');
  if (s.balance !== planned.summary.balanceAfter) problems.push(`Balance is ${s.balance}, expected ${planned.summary.balanceAfter}.`);
  return { saved: problems.length === 0, invoice: s, problems };
}

async function applyStatus(client, plan, planned) {
  const target = plan.kind === 'emit' ? 'open' : 'void';
  await call(client, 'PATCH', `/v2/invoice/${planned.invoiceId}`, { data: { status: target }, confirmed: true });
  const s = summarizeInvoice(await findInvoice(client, planned.invoiceId));
  const problems = s.status === target ? [] : [`Status is ${s.status}, not ${target}.`];
  return { saved: problems.length === 0, invoice: s, problems };
}

const APPLIERS = {
  fromDeal: applyFromDeal, manual: applyManual, pay: applyPay, unpay: applyUnpay, emit: applyStatus, void: applyStatus,
};

async function cmdApply(client, [planArg], flags, ctx) {
  if (!flags.version) throw new UsageError('Missing --version. Run preview first and pass its version.');
  if (!flags.confirmed) throw new UsageError('Refusing to write without --confirmed. Show the preview and wait for a yes.');
  const plan = readPlan(planArg, ctx.rootDir);
  const planned = await PLANNERS[plan.kind](client, plan);
  if (planned.version !== flags.version) throw new Blocked('Something changed since the preview. Nothing was written. Preview again and show the user.');
  if (planned.blockers.length) throw new Blocked(planned.blockers.join(' '));
  return { kind: plan.kind, ...(await APPLIERS[plan.kind](client, plan, planned)) };
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
    else if (arg === '--version') flags.version = next();
    else if (arg === '--profile') flags.profile = next();
    else if (arg === '--deal') flags.deal = next();
    else if (arg === '--contact') flags.contact = next();
    else if (arg === '--status') flags.status = next();
    else if (arg === '--as-of') flags.asOf = next();
    else if (arg === '--months') flags.months = next();
    else if (arg === '--from') flags.from = next();
    else if (arg === '--limit') flags.limit = Math.min(Math.max(Number(next()) || 20, 1), 500);
    else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  return { command: positional[0], domain: positional[1], rest: positional.slice(2), flags };
}

const COMMANDS = {
  invoices: cmdInvoices,
  show: cmdShow,
  receivables: cmdReceivables,
  metrics: cmdMetrics,
  subscriptions: cmdSubscriptions,
  'payment-methods': cmdPaymentMethods,
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
    if (!handler || !domain) {
      throw new UsageError(`Usage: billing.js <${Object.keys(COMMANDS).join('|')}> <domain> … (see the header of this file)`);
    }
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
  main, readPlan, simulateFromDeal, planPayments, agingReport, invoiceFilter, summarizeInvoice, subStatus,
};
