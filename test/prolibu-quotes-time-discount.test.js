/* global describe, test, expect */
const td = require('../.claude/skills/prolibu-quotes/scripts/time-discount');

const NOW = new Date('2026-11-10T16:00:00.000Z');
const BOGOTA = 'America/Bogota';

describe('time-discount helpers', () => {
  test('wallTimeIn reads a local wall time in the given zone', () => {
    expect(td.wallTimeIn('2026-11-14T18:00', BOGOTA)).toBe('2026-11-14T23:00:00.000Z');
  });

  test('wallTimeIn follows a DST change', () => {
    expect(td.wallTimeIn('2026-09-06T12:00', 'America/Santiago')).toBe('2026-09-06T15:00:00.000Z');
    expect(td.wallTimeIn('2026-09-05T12:00', 'America/Santiago')).toBe('2026-09-05T16:00:00.000Z');
  });

  test('parseInstant accepts an ISO instant with a zone', () => {
    expect(td.parseInstant('2026-11-14T18:00:00-05:00', { now: NOW, where: 'endAt' })).toBe('2026-11-14T23:00:00.000Z');
    expect(td.parseInstant('2026-11-14T23:00:00Z', { now: NOW, allowNow: false, allowLocal: false, where: 'endAt' }))
      .toBe('2026-11-14T23:00:00.000Z');
  });

  test('parseInstant resolves "now" only when allowed', () => {
    expect(td.parseInstant('now', { now: NOW, allowNow: true, where: 'startFrom' })).toBe(NOW.toISOString());
    expect(() => td.parseInstant('now', { now: NOW, allowNow: false, where: 'startFrom' })).toThrow(/resolvedTimeDiscount/);
  });

  test('parseInstant reads local times with a zone, and refuses them when not allowed', () => {
    expect(td.parseInstant('2026-11-14T18:00', { now: NOW, timeZone: BOGOTA, allowLocal: true, where: 'endAt' }))
      .toBe('2026-11-14T23:00:00.000Z');
    expect(() => td.parseInstant('2026-11-14T18:00', { now: NOW, allowLocal: true, where: 'endAt' })).toThrow(/timeZone/);
    expect(() => td.parseInstant('2026-11-14T18:00', { now: NOW, timeZone: BOGOTA, allowLocal: false, where: 'endAt' }))
      .toThrow(/resolvedTimeDiscount/);
  });

  test('parseInstant refuses anything else', () => {
    expect(() => td.parseInstant('mañana', { now: NOW, timeZone: BOGOTA, allowLocal: true, where: 'endAt' }))
      .toThrow(/YYYY-MM-DDTHH:mm/);
    expect(() => td.parseInstant(5, { now: NOW, timeZone: BOGOTA, allowLocal: true, where: 'endAt' }))
      .toThrow(/YYYY-MM-DDTHH:mm/);
  });
});

describe('resolveTimeDiscount', () => {
  const opts = { now: NOW, timeZone: BOGOTA, forApply: false };
  const stored = {
    enabled: true, strategy: 'Limited-Time', startFrom: '2026-11-09T00:00:00.000Z', endAt: '2026-11-12T00:00:00.000Z',
  };

  test('a new window starts now', () => {
    expect(td.resolveTimeDiscount({ strategy: 'Real-Time', endAt: '2026-11-14T18:00' }, undefined, opts)).toEqual({
      enabled: true, strategy: 'Real-Time', startFrom: NOW.toISOString(), endAt: '2026-11-14T23:00:00.000Z',
      replaces: false, keptStoredStart: false,
    });
  });

  test('changing an existing window keeps its start and strategy', () => {
    expect(td.resolveTimeDiscount({ endAt: '2026-11-16T18:00' }, stored, opts)).toEqual({
      enabled: true, strategy: 'Limited-Time', startFrom: '2026-11-09T00:00:00.000Z', endAt: '2026-11-16T23:00:00.000Z',
      replaces: true, keptStoredStart: true,
    });
  });

  test('"now" restarts an existing window', () => {
    const r = td.resolveTimeDiscount({ startFrom: 'now', endAt: '2026-11-16T18:00' }, stored, opts);
    expect(r.startFrom).toBe(NOW.toISOString());
    expect(r.keptStoredStart).toBe(false);
  });

  test('a disabled stored window counts as none', () => {
    expect(() => td.resolveTimeDiscount({ endAt: '2026-11-16T18:00' }, { ...stored, enabled: false }, opts)).toThrow(/strategy/);
  });

  test('the strategy is required and must be exact', () => {
    expect(() => td.resolveTimeDiscount({ endAt: '2026-11-14T18:00' }, undefined, opts)).toThrow(/strategy/);
    expect(() => td.resolveTimeDiscount({ strategy: 'realtime', endAt: '2026-11-14T18:00' }, undefined, opts)).toThrow(/Real-Time/);
    expect(() => td.resolveTimeDiscount({ strategy: 'Real-Time' }, undefined, opts)).toThrow(/endAt/);
  });

  test('the window must end in the future and after its start', () => {
    expect(() => td.resolveTimeDiscount({ strategy: 'Real-Time', endAt: '2026-11-09T18:00' }, undefined, opts)).toThrow(/future/);
    const late = { ...stored, startFrom: '2026-11-20T00:00:00.000Z', endAt: '2026-11-25T00:00:00.000Z' };
    expect(() => td.resolveTimeDiscount({ endAt: '2026-11-14T18:00' }, late, opts)).toThrow(/before/);
  });

  test('off stands alone', () => {
    expect(td.resolveTimeDiscount({ off: true }, stored, opts)).toEqual({ off: true });
    expect(() => td.resolveTimeDiscount({ off: true, strategy: 'Real-Time' }, stored, opts)).toThrow(/off/);
  });

  test('unknown keys are refused', () => {
    expect(() => td.resolveTimeDiscount({ strategy: 'Real-Time', endAt: '2026-11-14T18:00', numberOfNotifications: 3 }, undefined, opts))
      .toThrow(/numberOfNotifications/);
  });

  test('apply takes only the resolved instants', () => {
    expect(() => td.resolveTimeDiscount({ strategy: 'Real-Time', startFrom: 'now', endAt: '2026-11-14T23:00:00.000Z' }, undefined, { ...opts, forApply: true }))
      .toThrow(/resolvedTimeDiscount/);
    expect(() => td.resolveTimeDiscount({ strategy: 'Real-Time', endAt: '2026-11-14T23:00:00.000Z' }, undefined, { ...opts, forApply: true }))
      .toThrow(/resolvedTimeDiscount/);
    expect(td.resolveTimeDiscount({ strategy: 'Real-Time', startFrom: NOW.toISOString(), endAt: '2026-11-14T23:00:00.000Z' }, undefined, { ...opts, forApply: true }).endAt)
      .toBe('2026-11-14T23:00:00.000Z');
  });
});
