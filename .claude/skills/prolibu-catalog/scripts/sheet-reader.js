'use strict';

// Reads .xlsx and .csv files into rows without any dependency, so an agent can see a
// user's spreadsheet. Only what a catalog needs: cell values (text, numbers, booleans,
// dates by their number format), one header row, every sheet. Formulas give their
// cached value; styles, merged cells and images are ignored.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MAX_FILE_BYTES = 50 * 1024 * 1024;

// ─── ZIP ───────────────────────────────────────────────────────────────────────

function readZip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This file is not an .xlsx workbook (no zip directory found).');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('The workbook zip directory is damaged.');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.set(name, { method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return {
    has: (name) => entries.has(name),
    text(name) {
      const entry = entries.get(name);
      if (!entry) return null;
      const local = entry.localOffset;
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const data = buffer.subarray(start, start + entry.compressedSize);
      if (entry.method === 0) return data.toString('utf8');
      if (entry.method === 8) return zlib.inflateRawSync(data).toString('utf8');
      throw new Error(`Unsupported compression in ${name}.`);
    },
  };
}

// ─── XML helpers (the workbook parts are simple, machine-written XML) ──────────

function decodeXml(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (m, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function attr(tag, name) {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag);
  return match ? decodeXml(match[1]) : undefined;
}

// Text of every <t> inside a fragment, skipping phonetic runs (<rPh>).
function runText(fragment) {
  const clean = fragment.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  const re = /<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g;
  let m;
  while ((m = re.exec(clean)) !== null) out += m[1] ? decodeXml(m[1]) : '';
  return out;
}

function columnIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref)[0];
  let index = 0;
  for (const ch of letters) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function isDateFormatCode(code) {
  const bare = String(code).replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  return /[dmyhs]/i.test(bare) && !/^[#0.,%\s]*$/.test(bare);
}

function dateStyles(stylesXml) {
  const styles = new Set();
  if (!stylesXml) return styles;
  const custom = new Map();
  for (const m of stylesXml.matchAll(/<numFmt\b[^>]*>/g)) {
    custom.set(Number(attr(m[0], 'numFmtId')), attr(m[0], 'formatCode') || '');
  }
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml);
  if (!xfs) return styles;
  let index = 0;
  for (const m of xfs[1].matchAll(/<xf\b[^>]*?(?:\/>|>)/g)) {
    const id = Number(attr(m[0], 'numFmtId') || 0);
    if (BUILTIN_DATE_FORMATS.has(id) || (custom.has(id) && isDateFormatCode(custom.get(id)))) styles.add(index);
    index += 1;
  }
  return styles;
}

// Excel serial day (1900 system) to YYYY-MM-DD, or YYYY-MM-DDTHH:mm:ss when it has a time.
function serialToDate(serial) {
  const ms = Math.round((serial - 25569) * 86400000);
  const iso = new Date(ms).toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 19);
}

function parseSheetXml(xml, shared, dates) {
  const grid = [];
  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowNumber = Number(attr(rowMatch[1], 'r'));
    const cells = [];
    for (const cell of rowMatch[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const head = cell[1];
      const body = cell[2] || '';
      const ref = attr(head, 'r');
      const type = attr(head, 't') || 'n';
      const style = Number(attr(head, 's') || 0);
      const v = /<v>([\s\S]*?)<\/v>/.exec(body);
      let value;
      if (type === 's') value = v ? shared[Number(v[1])] : undefined;
      else if (type === 'inlineStr') value = runText(body);
      else if (type === 'str') value = v ? decodeXml(v[1]) : '';
      else if (type === 'b') value = v ? v[1] === '1' : undefined;
      else if (type === 'e') value = v ? { error: decodeXml(v[1]) } : undefined;
      else if (v) {
        const number = Number(v[1]);
        value = dates.has(style) && Number.isFinite(number) ? serialToDate(number) : number;
      }
      if (value === undefined) continue;
      cells[ref ? columnIndex(ref) : cells.length] = value;
    }
    if (Number.isFinite(rowNumber)) grid[rowNumber - 1] = cells;
    else grid.push(cells);
  }
  return grid;
}

function readXlsx(buffer) {
  const zip = readZip(buffer);
  const workbook = zip.text('xl/workbook.xml');
  if (!workbook) throw new Error('This zip file is not an Excel workbook (no xl/workbook.xml).');
  const rels = zip.text('xl/_rels/workbook.xml.rels') || '';
  const targets = new Map();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) targets.set(attr(m[0], 'Id'), attr(m[0], 'Target'));
  const shared = [];
  const sharedXml = zip.text('xl/sharedStrings.xml');
  if (sharedXml) for (const m of sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) shared.push(runText(m[1]));
  const dates = dateStyles(zip.text('xl/styles.xml'));
  const sheets = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], 'name');
    const rid = attr(m[0], 'r:id');
    let target = targets.get(rid) || '';
    target = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    const xml = zip.text(target);
    sheets.push({ name, grid: xml ? parseSheetXml(xml, shared, dates) : [] });
  }
  return sheets;
}

// ─── CSV ───────────────────────────────────────────────────────────────────────

function readCsv(text, name = 'csv') {
  const body = text.replace(/^\uFEFF/, '');
  const firstLine = body.split(/\r?\n/, 1)[0] || '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const ch of firstLine) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch in counts) counts[ch] += 1;
  }
  const delimiter = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  const grid = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inQuotes) {
      if (ch === '"' && body[i + 1] === '"') { field += '"'; i += 1; } else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delimiter) { row.push(field); field = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && body[i + 1] === '\n') i += 1;
      row.push(field); grid.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); grid.push(row); }
  return [{ name, grid: grid.map((r) => r.map((v) => (v === '' ? undefined : v))) }];
}

// ─── Rows ──────────────────────────────────────────────────────────────────────

function readWorkbook(file) {
  const stat = fs.statSync(file);
  if (stat.size > MAX_FILE_BYTES) throw new Error('The file is larger than 50 MB.');
  const ext = path.extname(file).toLowerCase();
  if (ext === '.csv' || ext === '.txt') return readCsv(fs.readFileSync(file, 'utf8'), path.basename(file, ext));
  if (ext === '.xlsx' || ext === '.xlsm') return readXlsx(fs.readFileSync(file));
  if (ext === '.xls') throw new Error('Old .xls files cannot be read. Save it as .xlsx or .csv.');
  throw new Error('Unsupported file. Use .xlsx or .csv.');
}

function isBlank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

// Turns a sheet's grid into rows keyed by the header row. `rowNumber` is the
// spreadsheet's own row number, so problems can point at it.
function sheetRows(sheet, headerRow = 1) {
  const grid = sheet.grid;
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
