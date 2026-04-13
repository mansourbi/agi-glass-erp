// routes/scan.js — Public QR scan page (no auth required)
// Mounted at /piece in server.js  →  handles GET /piece/:uid
const router = require('express').Router();
const db     = require('../db');

function cap(s)         { return s ? s.charAt(0).toUpperCase()+s.slice(1) : ''; }
function safeJson(s,fb) { try{ return JSON.parse(s||'[]'); }catch{ return fb; } }
function row(lbl, val) {
  if (val === null || val === undefined || val === '') return '';
  return lbl.padEnd(16) + ': ' + val + '\n';
}
function div(ch, len) { return (ch||'-').repeat(len||40) + '\n'; }
function today() {
  return new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'});
}
const PROC_LABELS = {
  cutting:'Cutting', arrising:'Arrising', flatpolish:'Flat Polish',
  roundpolish:'Round Polish', bevel:'Bevelling', drilling:'Drilling',
  tempering:'Tempering', laminating:'Laminating', paint:'Paint',
  sandblasting:'Sand Blasting', poly:'Poly', igu:'IGU'
};
function procLabel(p) { return PROC_LABELS[p] || cap(p); }

// GET /:uid  (mounted at /piece → full path = /piece/:uid)
router.get('/:uid', (req, res) => {
  try {
    const uid = req.params.uid.toUpperCase();

    const label   = db.prepare('SELECT * FROM label_items WHERE uid=? COLLATE NOCASE').get(uid);
    const remnant = !label ? db.prepare('SELECT * FROM remnants WHERE uid=? COLLATE NOCASE').get(uid) : null;

    if (!label && !remnant) {
      return res.type('text/plain').status(404)
        .setHeader('Content-Disposition', 'attachment; filename="' + uid + '.txt"')
        .send(buildNotFoundText(uid));
    }

    const txt = label ? buildPieceText(uid, label) : buildRemnantText(uid, remnant);
    res.type('text/plain');
    res.setHeader('Content-Disposition', 'attachment; filename="' + uid + '.txt"');
    res.send(txt);

  } catch(e) {
    console.error('[scan route]', e.message);
    res.status(500).type('text/plain').send('ERROR: ' + e.message);
  }
});

// ── Text builders ──────────────────────────────────────────────────────────

function buildPieceText(uid, label) {
  const isManual = label.cut_type === 'manual';
  const procs    = safeJson(label.processes, []);
  const cutW     = label.cut_w || label.w;
  const cutH     = label.cut_h || label.h;
  const hasComp  = cutW != label.w || cutH != label.h;

  // Order info — NO customer name (public facing)
  const order = label.order_id
    ? db.prepare('SELECT num, date, extref, notes FROM orders WHERE id=?').get(label.order_id)
    : null;

  // Scan log
  const logs = db.prepare(
    'SELECT worker_name, process, action, ts FROM scan_log WHERE piece_uid=? ORDER BY ts'
  ).all(uid);

  let t = '';
  t += div('=', 40);
  t += '  AGI GLASS FACTORY\n';
  t += div('=', 40);
  t += '\nPIECE DETAILS\n';
  t += div('-', 40);
  t += row('Piece ID',   uid);
  t += row('Order',      order ? order.num || '' : label.order_num || '');
  if (order && order.extref) t += row('Reference',  order.extref);
  if (order && order.date)   t += row('Order Date', order.date);
  t += '\n';
  t += row('Final Size',  label.w + ' x ' + label.h + ' mm');
  if (hasComp) t += row('Cut Size', cutW + ' x ' + cutH + ' mm');
  t += row('Thickness',   label.thickness + ' mm');
  t += row('Glass Type',  cap(label.glass_type || 'glass'));
  t += row('Color',       cap(label.color || 'clear'));
  if (label.bevel_mm) t += row('Bevel', label.bevel_mm + ' mm');
  t += row('Cut Type',    isManual ? 'Manual / Remnant' : 'Machine Cut');
  t += row('Date',        label.date || '');

  if (order && order.notes) {
    t += '\nNOTES\n' + div('-', 40);
    t += order.notes + '\n';
  }

  if (procs.length) {
    t += '\nPROCESSES\n' + div('-', 40);
    procs.forEach(p => {
      const done = logs.find(l => l.process === p && l.action === 'done');
      t += '  ' + (done ? '[DONE]' : '[    ]') + '  ' + procLabel(p) + '\n';
      if (done) {
        const ts = (done.ts || '').slice(0, 16).replace('T', ' ');
        t += '           by ' + done.worker_name + '  ' + ts + '\n';
      }
    });
  }

  if (logs.length) {
    t += '\nSCAN HISTORY\n' + div('-', 40);
    logs.forEach(s => {
      const ts = (s.ts || '').slice(0, 16).replace('T', ' ');
      t += '  ' + ts + '  ' + (s.action || '').toUpperCase().padEnd(6) +
           '  ' + procLabel(s.process) + '  (' + s.worker_name + ')\n';
    });
  }

  t += '\n' + div('-', 40);
  t += 'AGI Glass Factory Management System\n';
  t += today() + '\n';
  return t;
}

function buildRemnantText(uid, rem) {
  let t = '';
  t += div('=', 40);
  t += '  AGI GLASS FACTORY\n';
  t += div('=', 40);
  t += '\nREMNANT PLATE\n';
  t += div('-', 40);
  t += row('Remnant ID',   uid);
  t += row('Size',         rem.w + ' x ' + rem.h + ' mm');
  t += row('Thickness',    rem.thickness + ' mm');
  t += row('Glass Type',   cap(rem.glass_type || 'glass'));
  t += row('Color',        cap(rem.color || 'clear'));
  t += row('Brand',        rem.brand || '');
  t += row('Status',       cap(rem.status || 'available'));
  t += row('Storage Slot', rem.slot_code || 'Unassigned');
  t += row('Date Added',   (rem.created_at || '').slice(0, 10));
  if (rem.status === 'used') {
    t += '\nUSAGE\n' + div('-', 40);
    t += row('Used For Order', rem.used_for_order || '');
    t += row('Used At',        (rem.used_at || '').slice(0, 16).replace('T', ' '));
  }
  t += '\n' + div('-', 40);
  t += 'AGI Glass Factory Management System\n';
  t += today() + '\n';
  return t;
}

function buildNotFoundText(uid) {
  let t = '';
  t += div('=', 40);
  t += '  AGI GLASS FACTORY\n';
  t += div('=', 40);
  t += '\nPIECE NOT FOUND\n';
  t += div('-', 40);
  t += row('Scanned ID', uid);
  t += '\nThis piece ID was not found in the system.\n';
  t += 'Please contact your supervisor.\n\n';
  t += div('-', 40);
  t += 'AGI Glass Factory Management System\n';
  t += today() + '\n';
  return t;
}

module.exports = router;
