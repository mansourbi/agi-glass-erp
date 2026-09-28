// optima-text.js — Optima export text rules. ONE engine; never re-implement these.
//
// Decision 5 (Ala, 2026-09-28): identity fields validate and BLOCK, never rewrite.
// Only descriptive text (NOTE1, NOTE2) is sanitised. Rationale: columns 6 and 7 are
// the links back to the ERP, so transliterating or truncating them silently breaks
// the round trip — the one thing those columns exist to preserve.
//
// See C:\AGI\docs\optima-export-spec.md §5.

const isAscii = s => /^[\x20-\x7E]*$/.test(String(s));

// Identity — cols 4 (CUSTOMER), 6 (ORDER), 7 (NOTE = piece UID).
// Throws an Error naming the offender. Never alters the value.
function assertIdentity(label, value, max) {
  const v = String(value == null ? '' : value);
  if (!v)             throw new Error(`BLOCK: ${label} is empty`);
  if (!isAscii(v))    throw new Error(`BLOCK: ${label} is not ASCII: ${JSON.stringify(v)}`);
  if (v.length > max) throw new Error(`BLOCK: ${label} is ${v.length} chars, limit ${max}: ${v}`);
  return v;
}

// Descriptive — cols 15 (NOTE1), 16 (NOTE2). Drop non-ASCII, collapse whitespace,
// trim, enforce the limit. May legitimately return '': these carry no identity.
function sanitise(value, max) {
  let v = String(value == null ? '' : value)
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (v.length > max) v = v.slice(0, max).trim();
  if (!isAscii(v)) throw new Error('sanitise left non-ASCII: ' + JSON.stringify(v));
  return v;
}

// customers.optima_name — ^[A-Z0-9-]{1,12}$. Edit-Way hard-cuts CUSTOMER at 12 chars
// and its manual entry rejects spaces, so the stored value is constrained at entry
// and can never need sanitising at export time.
const OPTIMA_NAME_RE = /^[A-Z0-9-]{1,12}$/;
function validateOptimaName(value) {
  const v = String(value == null ? '' : value).trim();
  if (!v) return null;                       // cleared: stored as NULL
  if (!OPTIMA_NAME_RE.test(v)) {
    throw new Error('Optima name must be 1-12 characters, A-Z, 0-9 or hyphen only (no spaces)');
  }
  return v;
}

module.exports = { isAscii, assertIdentity, sanitise, validateOptimaName, OPTIMA_NAME_RE };
