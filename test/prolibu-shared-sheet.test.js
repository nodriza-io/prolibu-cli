/* global describe, test, expect */
// One spreadsheet reader for every skill (_shared/sheet.js); catalog and imports are views of it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const shared = require('../.claude/skills/_shared/sheet');
const catalogReader = require('../.claude/skills/prolibu-catalog/scripts/sheet-reader');
const importsReader = require('../.claude/skills/prolibu-imports/scripts/sheet');

function tmpFile(name, buf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, buf);
  return file;
}

describe('shared sheet reader', () => {
  test('imports uses the shared module itself', () => {
    expect(importsReader).toBe(shared);
  });

  test('catalog reads a CSV saved by Excel on Windows (Latin-1) with its accents', () => {
    const file = tmpFile('precios.csv', Buffer.from('Código;Descripción;Precio\nA-1;Café molido;2500\n', 'latin1'));
    const [sheet] = catalogReader.readWorkbook(file);
    expect(catalogReader.sheetRows(sheet)).toEqual({
      headers: ['Código', 'Descripción', 'Precio'],
      rows: [{ rowNumber: 2, values: { Código: 'A-1', Descripción: 'Café molido', Precio: '2500' } }],
    });
  });

  test('catalog dates keep their format, also in the 1904 date system', () => {
    expect(catalogReader.serialToDate(45658)).toBe('2025-01-01');
    expect(catalogReader.serialToDate(45658.5)).toBe('2025-01-01T12:00:00');
    expect(catalogReader.serialToDate(44196, true)).toBe('2025-01-01');
  });
});
