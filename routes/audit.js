// routes/audit.js — Activity / audit log read + client event logging
const router = require('express').Router();
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

// GET /api/audit — filter + paginate (admin only)
// query: from, to (YYYY-MM-DD), source, user, section, action, q, limit, offset
router.get('/', requireAuth, requireAdmin, (req, res) => {
  try {
    const { from, to, source, user, section, action, q } = req.query;
    const limit  = Math.min(+req.query.limit || 200, 1000);
    const offset = +req.query.offset || 0;
    const where = [], args = [];
    if (from)    { where.push('ts >= ?'); args.push(from); }
    if (to)      { where.push('ts <= ?'); args.push(to + ' 23:59:59'); }
    if (source)  { where.push('source = ?'); args.push(source); }
    if (user)    { where.push('(user_name LIKE ? OR user_id = ?)'); args.push('%'+user+'%', +user || -1); }
    if (section) { where.push('section LIKE ?'); args.push('%'+section+'%'); }
    if (action)  { where.push('action = ?'); args.push(action); }
    if (q)       { where.push('(detail LIKE ? OR path LIKE ? OR table_name LIKE ? OR record_id LIKE ?)');
                   args.push('%'+q+'%','%'+q+'%','%'+q+'%','%'+q+'%'); }
    const wsql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = db.prepare('SELECT COUNT(*) c FROM audit_log ' + wsql).get(...args).c;
    const rows  = db.prepare('SELECT * FROM audit_log ' + wsql + ' ORDER BY id DESC LIMIT ? OFFSET ?')
                    .all(...args, limit, offset);
    res.json({ total, rows, limit, offset });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/audit/event — navigation / page-view (and logout) logging from the apps
const _ALLOWED = ['view','open','logout','print','export','search'];
const _evt = db.prepare(`INSERT INTO audit_log
  (source,user_id,user_name,user_role,action,section,table_name,record_id,method,path,detail,status,ip)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
router.post('/event', requireAuth, (req, res) => {
  try {
    const u = req.user || {};
    const action  = _ALLOWED.includes((req.body && req.body.action)) ? req.body.action : 'view';
    const section = (req.body && req.body.section) || '';
    const path    = (req.body && req.body.path) || section;
    const detail  = (req.body && req.body.detail != null) ? JSON.stringify(req.body.detail) : null;
    const source  = ((req.headers['x-client']||'').toLowerCase()) || 'portal';
    _evt.run(source, u.id ?? null, u.name ?? null, u.role ?? null,
             action, section, '', null, 'NAV', path, detail, 200,
             req.ip || (req.socket && req.socket.remoteAddress) || '');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
