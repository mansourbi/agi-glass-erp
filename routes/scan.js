// routes/scan.js — Public QR scan page (no auth required)
// Regular camera/browser scan → plain text file download
// Worker app scans via AGI.Labels.get() API directly — does NOT hit this route
const router = require('express').Router();
const db     = require('../db');

router.get('/piece/:uid', (req, res) => {
  try {
    const uid = req.params.uid.toUpperCase();

    // Check label_items (cut pieces) then remnants
    const label   = db.prepare('SELECT * FROM label_items WHERE uid=? COLLATE NOCASE').get(uid);
    const remnant = !label ? db.prepare('SELECT * FROM remnants WHERE uid=? COLLATE NOCASE').get(uid) : null;

    if (!label && !remnant) {
      return res.status(404)
        .type('text/plain')
        .send(buildNotFoundText(uid));
    }

    const txt      = label ? buildPieceText(uid, label) : buildRemnantText(uid, remnant);
    const filename = uid + '.txt';

    res.type('text/plain');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.send(txt);

  } catch(e) {
    res.status(500).type('text/plain').send('ERROR: ' + e.message);
  }
});

// ── Text builders ─────────────────────────────────────────────────────────

function row(label, value) {
  if (value === null || value === undefined || value === '') return '';
  return label.padEnd(16) + ': ' + value + '\n';
}
function div(char, len) { return (char||'-').repeat(len||40) + '\n'; }
function cap(s)         { return s ? s.charAt(0).toUpperCase()+s.slice(1) : ''; }
function safeJson(s,fb) { try{return JSON.parse(s||'[]');}catch{return fb;} }
function today()        { return new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}); }

function buildPieceText(uid, label) {
  const isManual = label.cut_type === 'manual';
  const procs    = safeJson(label.processes, []);
  const logs     = db.prepare(
    "SELECT worker_name, process, action, ts FROM scan_log WHERE piece_uid=? ORDER BY ts"
  ).all(uid);

  let t = '';
  t += div('=',40);
  t += '  AGI GLASS FACTORY\n';
  t += div('=',40);
  t += '\nPIECE DETAILS\n';
  t += div('-',40);
  t += row('Piece ID',   uid);
  t += row('Order',      label.order_num || label.orderNum || '');
  t += row('Size',       label.w + ' x ' + label.h + ' mm');
  t += row('Thickness',  label.thickness + ' mm');
  t += row('Glass Type', cap(label.glass_type || 'glass'));
  t += row('Color',      cap(label.color || 'clear'));
  t += row('Cut Type',   isManual ? 'Manual / Remnant' : 'Machine Cut');
  t += row('Date',       label.date || '');
  if (procs.length) {
    t += '\nPROCESSES\n' + div('-',40);
    procs.forEach(p => { t += '  - ' + p + '\n'; });
  }
  if (logs.length) {
    t += '\nSCAN HISTORY\n' + div('-',40);
    logs.forEach(s => {
      const ts = (s.ts||'').slice(0,16).replace('T',' ');
      t += '  '+ts+'  '+(s.action||'').toUpperCase().padEnd(6)+'  '+s.process+'  ('+s.worker_name+')\n';
    });
  }
  t += '\n' + div('-',40);
  t += 'AGI Glass Factory Management System\n';
  t += today() + '\n';
  return t;
}

function buildRemnantText(uid, rem) {
  let t = '';
  t += div('=',40);
  t += '  AGI GLASS FACTORY\n';
  t += div('=',40);
  t += '\nREMNANT PLATE\n';
  t += div('-',40);
  t += row('Remnant ID',   uid);
  t += row('Size',         rem.w + ' x ' + rem.h + ' mm');
  t += row('Thickness',    rem.thickness + ' mm');
  t += row('Glass Type',   cap(rem.glass_type || 'glass'));
  t += row('Color',        cap(rem.color || 'clear'));
  t += row('Brand',        rem.brand || '');
  t += row('Origin',       rem.origin || '');
  t += row('Status',       cap(rem.status || 'available'));
  t += row('Storage Slot', rem.slot_code || 'Unassigned');
  t += row('Source Opt',   rem.opt_file_name || '');
  t += row('Date Added',   (rem.created_at||'').slice(0,10));
  if (rem.status === 'used') {
    t += '\nUSAGE\n' + div('-',40);
    t += row('Used For Order', rem.used_for_order || '');
    t += row('Piece',          rem.used_for_piece || '');
    t += row('Used By',        rem.used_by_worker || '');
    t += row('Used At',        (rem.used_at||'').slice(0,16).replace('T',' '));
  }
  t += '\n' + div('-',40);
  t += 'AGI Glass Factory Management System\n';
  t += today() + '\n';
  return t;
}

function buildNotFoundText(uid) {
  let t = '';
  t += div('=',40);
  t += '  AGI GLASS FACTORY\n';
  t += div('=',40);
  t += '\nPIECE NOT FOUND\n';
  t += div('-',40);
  t += row('Scanned ID', uid);
  t += '\nThis piece ID was not found in the system.\n';
  t += 'Please contact your supervisor.\n\n';
  t += div('-',40);
  t += 'AGI Glass Factory Management System\n';
  return t;
}

module.exports = router;
