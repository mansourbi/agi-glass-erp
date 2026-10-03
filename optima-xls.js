// optima-xls.js — writes the Edit-Way import file for a cutting batch.
//
// Spec: C:\AGI\docs\optima-export-spec.md §4 (filename, archive) and §5 (content).
// The facts below are from live import tests on the real machine, not the PDF spec,
// which has column-position errors. Do not "tidy" any of them.
//
//   * Legacy .xls (BIFF8). A file written by Python xlwt was REJECTED with
//     "External table is not in the expected format."
//   * Sheet must be named Sheet1; one header row, which Edit-Way skips.
//   * Column 5 (MATERIAL) must be a TEXT cell. An unknown code leaves Edit-Way's
//     material prompt BLANK and any manual pick is accepted silently, which puts
//     pieces on the wrong thickness. That is why the code comes from the material
//     map and is never improvised.
//   * Arabic is destroyed - every non-ASCII character becomes '?' in every field.
//   * Columns 8-12 stay EMPTY so Edit-Way never adds allowances a second time.
//   * Decision 11: columns 1-2 carry the FINISHED size. The allowance belongs to
//     Optima; the operator enters it per side in Edit-Way.

const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { assertIdentity, sanitise } = require('./optima-text');

const HEADERS = ['X', 'Y', 'QTY', 'CUSTOMER', 'MATERIAL', 'ORDER', 'NOTE',
                 'GRIND', 'MX1', 'MY1', 'MX2', 'MY2', 'RACK', 'PRIORITY', 'NOTE1', 'NOTE2'];

// Filename, spec §4. Batch number first so it stays unique even if Edit-Way
// truncates. Thickness is the TRUE one (5.5mm), never the Edit-Way code.
// Timestamp from LOCAL date parts — toISOString() would roll the date back in
// UTC+3 (landmines.md §5).
function buildFileName(batch, when) {
  const d = when || new Date();
  const p2 = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
  let nums = [];
  try { nums = JSON.parse(batch.order_nums || '[]'); } catch (e) { nums = []; }
  if (!Array.isArray(nums)) nums = [];
  const shown = nums.slice(0, 3);
  const rest = nums.length - shown.length;
  const parts = [batch.batch_no, batch.thickness + 'mm', ...shown];
  if (rest > 0) parts.push('+' + rest);
  parts.push(stamp);
  // ASCII only, no spaces. Dots survive (Edit-Way accepts "5.5mm").
  const name = parts.join('_').replace(/[^A-Za-z0-9._+-]/g, '');
  return name + '.xls';
}

// One row per piece, QTY always 1, so every piece carries its own ID.
function buildRows(batch, pieces) {
  if (!pieces.length) throw new Error('batch has no pieces');
  const material = String(batch.material_code == null ? '' : batch.material_code).trim();
  if (!material) throw new Error('BLOCK: batch has no Edit-Way material code');

  const aoa = [HEADERS.slice()];
  const textCells = [];                       // rows needing MATERIAL forced to text
  pieces.forEach((p, i) => {
    const row = new Array(16).fill(null);
    row[0] = Number(p.w);                                        // FINISHED width
    row[1] = Number(p.h);                                        // FINISHED height
    if (!(row[0] > 0) || !(row[1] > 0)) throw new Error('BLOCK: piece ' + p.piece_uid + ' has a non-positive size');
    row[2] = 1;
    row[3] = assertIdentity('CUSTOMER', p.optima_name, 12);
    row[4] = material;                                           // forced to text below
    row[5] = assertIdentity('ORDER', p.order_num, 12);
    row[6] = assertIdentity('NOTE (piece UID)', p.piece_uid, 32);
    // 7..11 GRIND, MX1, MY1, MX2, MY2 and 12 RACK stay null
    row[13] = 0;                                                 // PRIORITY
    row[14] = sanitise(p.note1, 32);                             // descriptive
    row[15] = sanitise(p.note2, 32);                             // descriptive
    aoa.push(row);
    textCells.push(i + 1);
  });
  return { aoa, textCells, material };
}

function toBuffer(batch, pieces) {
  const { aoa, textCells, material } = buildRows(batch, pieces);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  // MATERIAL must be a text cell, not a number, or Edit-Way will not match the code.
  for (const r of textCells) {
    ws[XLSX.utils.encode_cell({ c: 4, r })] = { t: 's', v: material };
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const buf = XLSX.write(wb, { bookType: 'biff8', type: 'buffer' });
  // Cheap structural check: BIFF8 is an OLE2 container. xlwt produced something
  // that looked like a valid .xls and was still rejected, so verify the container.
  const sig = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
  if (!buf.slice(0, 8).equals(sig)) throw new Error('writer produced a non-OLE2 file; Edit-Way will reject it');
  return buf;
}

// Archive outside the repo: OPTIMA_ARCHIVE_DIR\YYYY-MM\<filename>
function archivePathFor(fileName, when) {
  const d = when || new Date();
  const p2 = n => String(n).padStart(2, '0');
  const root = process.env.OPTIMA_ARCHIVE_DIR || 'C:\\AGI\\exports\\optima';
  return path.join(root, d.getFullYear() + '-' + p2(d.getMonth() + 1), fileName);
}

function writeArchive(batch, pieces, when) {
  const d = when || new Date();
  const fileName = buildFileName(batch, d);
  const dest = archivePathFor(fileName, d);
  const buf = toBuffer(batch, pieces);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return { fileName, archivePath: dest, bytes: buf.length, rows: pieces.length };
}

module.exports = { HEADERS, buildFileName, buildRows, toBuffer, archivePathFor, writeArchive };
