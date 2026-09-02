// middleware/auth.js
const jwt = require('jsonwebtoken');
const SECRET = process.env.JWT_SECRET || 'agi-glass-secret-change-in-production';

function requireAuth(req, res, next) {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin')
    return res.status(403).json({ error: 'Admin only' });
  next();
}

function signToken(payload, expiresIn = '12h') {
  return jwt.sign(payload, SECRET, { expiresIn });
}

// Permission check against role_permissions(role_id, perm_key).
// Superadmin and the legacy 'admin' role always pass.
function requirePerm(key){
  return function(req,res,next){
    try{
      const u=req.user||{};
      if(u.role==='admin') return next();
      const db=require('../db');
      const w=db.prepare('SELECT role_id FROM workers WHERE id=?').get(u.id);
      if(!w||!w.role_id) return res.status(403).json({error:'Forbidden'});
      const role=db.prepare('SELECT superadmin FROM roles WHERE id=?').get(w.role_id);
      if(role&&role.superadmin) return next();
      const hit=db.prepare('SELECT 1 x FROM role_permissions WHERE role_id=? AND perm_key=?').get(w.role_id,key);
      if(hit) return next();
      return res.status(403).json({error:'Forbidden: '+key+' required'});
    }catch(e){ return res.status(500).json({error:e.message}); }
  };
}

module.exports = { requireAuth, requireAdmin, requirePerm, signToken };
