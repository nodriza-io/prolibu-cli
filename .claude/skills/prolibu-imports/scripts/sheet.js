'use strict';

// Reads the rows of a CSV/TSV or Excel (.xlsx) file without extra dependencies.
// readTable(path, { sheet, headerRow }) → { format, sheets, sheet, headers, rows, warnings }
// Each row is { row: <number as the spreadsheet shows it>, values: { <header>: <value> } }.
// Excel cells keep their type: numbers stay numbers, booleans stay booleans, and cells with a
// date format become "YYYY-MM-DD" or "YYYY-MM-DD HH:mm:ss" (no time zone yet).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MAX_FILE_BYTES = 50 * 1024 * 1024;

class SheetError extends Error {}

// ─── CSV ───────────────────────────────────────────────────────────────────────

function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf-16le' };
  let start = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) start = 3;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(start));
    return { text, encoding: 'utf-8' };
  } catch {
    // Excel on Windows saves "CSV" in the system code page. Latin-1 keeps accents readable.
    return { text: buf.toString('latin1'), encoding: 'latin1' };
  }
}

function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const ch of firstLine) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch in counts) counts[ch] += 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ',';
}

// RFC 4180: quoted fields may hold the delimiter, line breaks and "" for a quote.
function parseCsv(text, delimiter) {
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        field += ch;
      }
      i += 1;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      record.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
    } else field += ch;
    i += 1;
  }
  if (field !== '' || record.length) {
    record.push(field);
    records.push(record);
  }
  return records;
}

// ─── XLSX (a zip of XML parts) ─────────────────────────────────────────────────

function unzipEntries(buf) {
  let eocd = -1;
  for (let p = buf.length - 22; p >= Math.max(0, buf.length - 65557); p -= 1) {
    if (buf.readUInt32LE(p) === 0x06054b50) {
      eocd = p;
      break;
    }
  }
  if (eocd < 0) throw new SheetError('The file is not a valid .xlsx (no zip directory). Open it in Excel and save it again, or save it as CSV.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (p === 0xffffffff) throw new SheetError('This .xlsx is too large or unusual to read here. Save it as CSV (UTF-8).');
  const entries = new Map();
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new SheetError('The .xlsx file is damaged. Save it again or as CSV.');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, size, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    has: (name) => entries.has(name),
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
      const data = buf.subarray(start, start + e.size);
      if (e.method === 0) return data.toString('utf8');
      if (e.method === 8) return zlib.inflateRawSync(data).toString('utf8');
      throw new SheetError(`Unsupported compression in ${name}. Save the file as CSV.`);
    },
  };
}

function decodeXml(s) {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
    const map = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
    if (map[e.toLowerCase()]) return map[e.toLowerCase()];
    const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });
}

function attrs(text) {
  const out = {};
  for (const m of String(text).matchAll(/([\w:]+)="([^"]*)"/g)) out[m[1]] = decodeXml(m[2]);
  return out;
}

function textOf(xml) {
  const clean = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').replace(/<t\b[^>]*\/>/g, '');
  let out = '';
  for (const m of clean.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) out += decodeXml(m[1]);
  return out;
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function isDateFormat(id, code) {
  if (BUILTIN_DATE_FORMATS.has(id)) return true;
  if (!code) return false;
  const bare = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  return /[ymdhs]/i.test(bare) && !/^general$/i.test(bare.trim());
}

function columnIndex(ref) {
  const letters = /^([A-Z]+)/i.exec(ref || '');
  if (!letters) return null;
  let n = 0;
  for (const ch of letters[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// Excel stores dates as days since 1899-12-30 (or 1904-01-01 in the 1904 system).
function serialToText(serial, date1904) {
  const days = serial + (date1904 ? 1462 : 0);
  const ms = Math.round((days - 25569) * 86400000);
  const d = new Date(ms);
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (Number.isInteger(serial)) return date;
  return `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function readXlsx(buf, wantedSheet) {
  const zip = unzipEntries(buf);
  const workbook = zip.read('xl/workbook.xml');
  if (!workbook) throw new SheetError('The file is not an Excel workbook (.xlsx). Save it as .xlsx or CSV.');
  const date1904 = /<workbookPr\b[^>]*date1904="(1|true)"/.test(workbook);
  const rels = {};
  for (const m of (zip.read('xl/_rels/workbook.xml.rels') || '').matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const a = attrs(m[1]);
    rels[a.Id] = a.Target;
  }
  const sheets = [];
  for (const m of workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const a = attrs(m[1]);
    let target = rels[a['r:id']] || '';
    target = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    sheets.push({ name: a.name, target: path.posix.normalize(target) });
  }
  if (!sheets.length) throw new SheetError('The workbook has no sheets.');
  const sheet = wantedSheet ? sheets.find((s) => s.name === wantedSheet) : sheets[0];
  if (!sheet) throw new SheetError(`There is no sheet named "${wantedSheet}". Sheets: ${sheets.map((s) => s.name).join(', ')}.`);

  const shared = [];
  for (const m of (zip.read('xl/sharedStrings.xml') || '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) {
    shared.push(m[1] === undefined ? '' : textOf(m[1]));
  }
  const styles = zip.read('xl/styles.xml') || '';
  const formats = {};
  for (const m of styles.matchAll(/<numFmt\b([^>]*?)\/?>/g)) {
    const a = attrs(m[1]);
    formats[Number(a.numFmtId)] = a.formatCode;
  }
  const xfBlock = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles);
  const dateStyles = [];
  if (xfBlock) {
    for (const m of xfBlock[1].matchAll(/<xf\b([^>]*?)(\/>|>)/g)) {
      const id = Number(attrs(m[1]).numFmtId || 0);
      dateStyles.push(isDateFormat(id, formats[id]));
    }
  }

  const xml = zip.read(sheet.target);
  if (xml === null) throw new SheetError(`The sheet "${sheet.name}" could not be read.`);
  const grid = [];
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowNumber = Number(attrs(rm[1]).r) || grid.length + 1;
    const cells = [];
    let position = 0;
    for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = attrs(cm[1]);
      const inner = cm[2] || '';
      const col = a.r ? columnIndex(a.r) : position;
      position = col + 1;
      const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
      const raw = v ? decodeXml(v[1]) : null;
      let value;
      if (a.t === 's') value = raw === null ? undefined : shared[Number(raw)];
      else if (a.t === 'inlineStr') value = textOf(inner);
      else if (a.t === 'str' || a.t === 'd') value = raw === null ? undefined : raw;
      else if (a.t === 'b') value = raw === '1';
      else if (a.t === 'e') value = undefined;
      else if (raw !== null && raw !== '') {
        const num = Number(raw);
        value = dateStyles[Number(a.s || 0)] ? serialToText(num, date1904) : num;
      }
      if (value !== undefined) cells[col] = value;
    }
    grid.push({ row: rowNumber, cells });
  }
  return { sheets: sheets.map((s) => s.name), sheet: sheet.name, grid };
}

// ─── Table ─────────────────────────────────────────────────────────────────────

function isBlank(v) {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

function toTable(grid, headerRow) {
  const warnings = [];
  const headerAt = headerRow
    ? grid.findIndex((r) => r.row === headerRow)
    : grid.findIndex((r) => r.cells.some((c) => !isBlank(c)));
  if (headerAt < 0) return { headers: [], rows: [], warnings: ['The file has no header row.'] };
  const seen = new Map();
  const headers = [];
  grid[headerAt].cells.forEach((cell, col) => {
    if (isBlank(cell)) return;
    let name = String(cell).trim();
    if (seen.has(name)) {
      const n = seen.get(name) + 1;
      seen.set(name, n);
      warnings.push(`Two columns are called "${name}"; the second is read as "${name} (${n})".`);
      name = `${name} (${n})`;
    } else seen.set(name, 1);
    headers[col] = name;
  });
  const rows = [];
  for (const { row, cells } of grid.slice(headerAt + 1)) {
    const values = {};
    let any = false;
    cells.forEach((cell, col) => {
      if (isBlank(cell)) return;
      if (headers[col] === undefined) return;
      values[headers[col]] = typeof cell === 'string' ? cell.trim() : cell;
      any = true;
    });
    if (any) rows.push({ row, values });
  }
  const unnamed = grid[headerAt].cells.length;
  if (grid.slice(headerAt + 1).some((r) => r.cells.some((c, col) => !isBlank(c) && headers[col] === undefined && col < Math.max(unnamed, r.cells.length)))) {
    warnings.push('Some columns with data have no header; they are ignored.');
  }
  return { headers: headers.filter(Boolean), rows, warnings };
}

function readTable(file, { sheet, headerRow } = {}) {
  const ext = path.extname(file).toLowerCase();
  if (!['.csv', '.tsv', '.txt', '.xlsx'].includes(ext)) {
    throw new SheetError('Only .csv, .tsv, .txt and .xlsx files can be read. Save the file in one of those formats (old .xls: save as .xlsx).');
  }
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new SheetError(`Cannot read the file ${file}.`);
  }
  if (!stat.isFile()) throw new SheetError(`${file} is not a file.`);
  if (stat.size > MAX_FILE_BYTES) throw new SheetError('The file is larger than 50 MB. Split it into smaller files.');
  const buf = fs.readFileSync(file);
  if (ext === '.xlsx') {
    const book = readXlsx(buf, sheet);
    const table = toTable(book.grid, headerRow);
    return { format: 'xlsx', sheets: book.sheets, sheet: book.sheet, ...table };
  }
  if (sheet) throw new SheetError('A CSV file has no sheets; leave "sheet" out.');
  const { text, encoding } = decodeText(buf);
  const delimiter = ext === '.tsv' ? '\t' : detectDelimiter(text);
  const grid = parseCsv(text, delimiter).map((cells, i) => ({ row: i + 1, cells }));
  const table = toTable(grid, headerRow);
  if (encoding === 'latin1') table.warnings.push('The file is not UTF-8; it was read as Latin-1 (Windows). Check that accents look right in the sample.');
  return {
    format: 'csv', delimiter, encoding, sheets: null, sheet: null, ...table,
  };
}

// Inline rows from a plan: [{ "<column>": value }] numbered from 2, like a sheet under its header.
function tableFromRows(rows) {
  const headers = [];
  const out = rows.map((values, i) => {
    const clean = {};
    for (const [k, v] of Object.entries(values || {})) {
      if (!headers.includes(k)) headers.push(k);
      if (!isBlank(v)) clean[k] = typeof v === 'string' ? v.trim() : v;
    }
    return { row: i + 2, values: clean };
  }).filter((r) => Object.keys(r.values).length);
  return {
    format: 'inline', sheets: null, sheet: null, headers, rows: out, warnings: [],
  };
}

module.exports = {
  readTable, tableFromRows, parseCsv, detectDelimiter, decodeText, readXlsx, serialToText, isDateFormat, SheetError,
};
