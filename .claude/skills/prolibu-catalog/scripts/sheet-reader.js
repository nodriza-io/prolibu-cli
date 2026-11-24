'use strict';

// Catalog view of the shared spreadsheet reader (../../_shared/sheet.js): every sheet of a
// workbook as a grid of rows (index = spreadsheet row - 1), and rows keyed by one header row.
// Dates come as YYYY-MM-DD, or YYYY-MM-DDTHH:mm:ss when they carry a time.

const fs = require('fs');
const path = require('path');
const shared = require('../../_shared/sheet');

const { isBlank, MAX_FILE_BYTES } = shared;

// Excel serial day to YYYY-MM-DD, or YYYY-MM-DDTHH:mm:ss when it has a time.
function serialToDate(serial, date1904 = false) {
  const ms = Math.round((serial + (date1904 ? 1462 : 0) - 25569) * 86400000);
  const iso = new Date(ms).toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 19);
}

function isDateFormatCode(code) {
  return shared.isDateFormat(-1, String(code));
}

// [{ row, cells }] → cells indexed by spreadsheet row - 1, blanks as undefined.
function toGrid(rows) {
  const grid = [];
  for (const { row, cells } of rows) grid[row - 1] = cells.map((v) => (v === '' ? undefined : v));
  return grid;
}

function readXlsx(buffer) {
  return shared.readAllSheets(buffer, { dateText: serialToDate }).map((s) => ({ name: s.name, grid: toGrid(s.grid) }));
}

function readCsv(text, name = 'csv') {
  const body = String(text).replace(/^\uFEFF/, '');
  const records = shared.parseCsv(body, shared.detectDelimiter(body));
  return [{ name, grid: records.map((r) => r.map((v) => (v === '' ? undefined : v))) }];
}

function readWorkbook(file) {
  const stat = fs.statSync(file);
  if (stat.size > MAX_FILE_BYTES) throw new Error('The file is larger than 50 MB.');
  const ext = path.extname(file).toLowerCase();
  if (ext === '.csv' || ext === '.txt' || ext === '.tsv') {
    const { text } = shared.decodeText(fs.readFileSync(file));
    return readCsv(text, path.basename(file, ext));
  }
  if (ext === '.xlsx' || ext === '.xlsm') return readXlsx(fs.readFileSync(file));
  if (ext === '.xls') throw new Error('Old .xls files cannot be read. Save it as .xlsx or .csv.');
  throw new Error('Unsupported file. Use .xlsx or .csv.');
}

// Turns a sheet's grid into rows keyed by the header row. `rowNumber` is the
// spreadsheet's own row number, so problems can point at it.
function sheetRows(sheet, headerRow = 1) {
  const { grid } = sheet;
  const header = grid[headerRow - 1] || [];
  const headers = [];
  for (let c = 0; c < header.length; c += 1) {
    if (!isBlank(header[c])) headers[c] = String(header[c]).trim();
  }
  const rows = [];
  for (let r = headerRow; r < grid.length; r += 1) {
    const cells = grid[r];
    if (!cells || cells.every(isBlank)) continue;
    const row = { rowNumber: r + 1, values: {} };
    headers.forEach((name, c) => {
      if (name && !isBlank(cells[c])) row.values[name] = typeof cells[c] === 'string' ? cells[c].trim() : cells[c];
    });
    rows.push(row);
  }
  return { headers: headers.filter(Boolean), rows };
}

module.exports = {
  readWorkbook, readXlsx, readCsv, sheetRows, serialToDate, isDateFormatCode, isBlank,
};
