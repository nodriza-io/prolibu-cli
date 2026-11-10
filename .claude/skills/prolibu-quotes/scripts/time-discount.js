'use strict';

// Time-limited discounts on a deal quote (`quote.timeSensitiveDiscounts`): parsing the
// deadline the user gives, validating the window, writing it into the quote the way the
// app does, and describing it in the preview. Pure functions: no API calls here.

const { UsageError } = require('../../_shared/prolibu-api');

// Offset of a time zone at a given instant, in ms (positive east of UTC).
function zoneOffsetMs(epoch, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(epoch));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - epoch;
}

// The instant a wall-clock time happens in a zone. Two passes settle the offset across DST.
function wallEpoch(year, month, day, hour, minute, timeZone) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let epoch = wall;
  for (let i = 0; i < 2; i += 1) epoch = wall - zoneOffsetMs(epoch, timeZone);
  return epoch;
}

function midnightIn(year, month, day, timeZone) {
  return new Date(wallEpoch(year, month, day, 0, 0, timeZone)).toISOString();
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const ISO_ZONED_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function wallTimeIn(text, timeZone) {
  const match = LOCAL_RE.exec(String(text));
  if (!match) throw new UsageError(`Invalid local time "${text}". Use YYYY-MM-DDTHH:mm.`);
  const [y, m, d, hh, mm] = match.slice(1).map(Number);
  return new Date(wallEpoch(y, m, d, hh, mm, timeZone)).toISOString();
}

const FIXED_HINT = 'apply only takes the exact instants of the preview: pass its "resolvedTimeDiscount" as the plan\'s "timeDiscount".';

function parseInstant(value, {
  timeZone, now, allowNow = true, allowLocal = true, where,
} = {}) {
  if (value === 'now') {
    if (!allowNow) throw new UsageError(`${where}: "now" is not accepted here; ${FIXED_HINT}`);
    return now.toISOString();
  }
  const text = typeof value === 'string' ? value : '';
  if (ISO_ZONED_RE.test(text) && !Number.isNaN(Date.parse(text))) return new Date(text).toISOString();
  if (LOCAL_RE.test(text)) {
    if (!allowLocal) throw new UsageError(`${where}: a local time is not accepted here; ${FIXED_HINT}`);
    if (!timeZone) throw new UsageError(`${where}: a local time needs a time zone. Add "timeZone" to the plan.`);
    return wallTimeIn(text, timeZone);
  }
  throw new UsageError(`${where}: "${value}" is not a date. Use YYYY-MM-DDTHH:mm (local time), an ISO instant with a zone, or "now".`);
}

const STRATEGIES = ['Real-Time', 'Limited-Time'];
const PLAN_KEYS = new Set(['strategy', 'endAt', 'startFrom', 'off']);

// Turns the plan's `timeDiscount` into the exact window to save. `stored` is the quote's
// current `timeSensitiveDiscounts`. Changing a live window keeps its start unless the plan
// asks for "now"; apply (`forApply`) only takes the exact instants the preview resolved.
function resolveTimeDiscount(input, stored, { timeZone, now, forApply = false } = {}) {
  const where = 'timeDiscount';
  for (const key of Object.keys(input)) {
    if (!PLAN_KEYS.has(key)) {
      throw new UsageError(`${where}: "${key}" cannot be set. Allowed: ${[...PLAN_KEYS].join(', ')}. The server keeps the rest.`);
    }
  }
  if (input.off !== undefined) {
    if (input.off !== true || Object.keys(input).length > 1) {
      throw new UsageError(`${where}: "off" must be true and come alone.`);
    }
    return { off: true };
  }
  const live = Boolean(stored && stored.enabled);
  const parse = (value, key) => parseInstant(value, {
    timeZone, now, allowNow: !forApply, allowLocal: !forApply, where: `${where}.${key}`,
  });

  const strategy = input.strategy !== undefined ? input.strategy : (live ? stored.strategy : undefined);
  if (strategy === undefined) throw new UsageError(`${where}: "strategy" is required (Real-Time or Limited-Time). Ask the user.`);
  if (!STRATEGIES.includes(strategy)) throw new UsageError(`${where}: strategy must be exactly "Real-Time" or "Limited-Time".`);

  let endAt;
  if (input.endAt !== undefined) endAt = parse(input.endAt, 'endAt');
  else if (live && stored.endAt) endAt = new Date(stored.endAt).toISOString();
  else throw new UsageError(`${where}: "endAt" is required: when does the discount end?`);

  let startFrom;
  let keptStoredStart = false;
  if (input.startFrom !== undefined) startFrom = parse(input.startFrom, 'startFrom');
  else if (live && stored.startFrom) {
    startFrom = new Date(stored.startFrom).toISOString();
    keptStoredStart = true;
  } else startFrom = parse('now', 'startFrom');

  if (Date.parse(endAt) <= now.getTime()) throw new UsageError(`${where}: the end (${endAt}) must be in the future.`);
  if (Date.parse(startFrom) >= Date.parse(endAt)) {
    throw new UsageError(`${where}: the start (${startFrom}) must be before the end (${endAt}).`);
  }
  return {
    enabled: true, strategy, startFrom, endAt, replaces: live, keptStoredStart,
  };
}

module.exports = {
  zoneOffsetMs, midnightIn, wallTimeIn, parseInstant, resolveTimeDiscount, STRATEGIES,
};
