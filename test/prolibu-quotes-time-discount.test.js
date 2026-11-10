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
