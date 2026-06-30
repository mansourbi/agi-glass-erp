// routes/access.js - Roles & Privileges API (R-1: foundation + read endpoints)
const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const P = require('../middleware/permissions');

// schema + seed on load (runs during startup, before serving traffic -> wedge-safe)
try { P.ensureSchema(); P.seedRolesIfEmpty(); }
catch (e) { console.error('[access] schema/seed failed:', e.message); }

router.use(requireAuth);

// GET /api/access/me - the signed-in user's resolved permissions (drives frontend gating)
router.get('/me', (req, res) => {
  try {
    const p = P.resolvePerms(req.user.id);
    res.json({
      user: { id: req.user.id, name: req.user.name, role_string: req.user.role },
      role: p.role ? { id: p.role.id, name: p.role.name, superadmin: !!p.role.superadmin }
                   : (p.legacy ? { id: null, name: '(legacy: ' + req.user.role + ')', superadmin: false } : null),
      superadmin: p.superadmin,
      portal_access: p.portal,
      workerapp_access: p.workerapp,
      permissions: p.superadmin ? P.ALL_KEYS : Array.from(p.keys)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/access/catalog - the full permission catalog (for the admin UI in R-4)
router.get('/catalog', (req, res) => {
  res.json({ catalog: P.CATALOG, groups: Object.keys(P.GROUPS) });
});


/* R4A-ROLES: Roles & Privileges CRUD (gated settings.roles.manage). Added by R-4a. */
const db = require('../db');
const _SENS = new Set(P.CATALOG.filter(function(c){return c.s;}).map(function(c){return c.k;}));
const _VALID = new Set(P.ALL_KEYS);
function _callerSA(req){ try { return !!P.resolvePerms(req.user.id).superadmin; } catch(e){ return false; } }
function _roleMeta(r){ return { id:r.id, name:r.name, description:r.description||'', is_system:!!r.is_system, superadmin:!!r.superadmin, portal_access:!!r.portal_access, workerapp_access:!!r.workerapp_access }; }

router.get('/roles', P.requirePerm('settings.roles.manage'), function(req,res){
  try {
    var roles = db.prepare('SELECT * FROM roles ORDER BY is_system DESC, name').all();
    var pm={}, um={};
    db.prepare('SELECT role_id, COUNT(*) c FROM role_permissions GROUP BY role_id').all().forEach(function(x){ pm[x.role_id]=x.c; });
    db.prepare('SELECT role_id, COUNT(*) c FROM workers WHERE role_id IS NOT NULL AND is_active=1 GROUP BY role_id').all().forEach(function(x){ um[x.role_id]=x.c; });
    res.json(roles.map(function(r){ var m=_roleMeta(r); m.perm_count = r.superadmin ? P.ALL_KEYS.length : (pm[r.id]||0); m.user_count = um[r.id]||0; return m; }));
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.get('/roles/:id', P.requirePerm('settings.roles.manage'), function(req,res){
  try {
    var r = db.prepare('SELECT * FROM roles WHERE id=?').get(+req.params.id);
    if(!r) return res.status(404).json({error:'Role not found'});
    var m = _roleMeta(r);
    m.permissions = r.superadmin ? P.ALL_KEYS.slice() : db.prepare('SELECT perm_key FROM role_permissions WHERE role_id=?').all(r.id).map(function(x){return x.perm_key;});
    res.json(m);
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.post('/roles', P.requirePerm('settings.roles.manage'), function(req,res){
  try {
    var b = req.body||{};
    var name = (b.name||'').trim();
    if(!name) return res.status(400).json({error:'name required'});
    var wantSA = !!b.superadmin;
    var keys = Array.isArray(b.permissions) ? b.permissions.filter(function(k){return _VALID.has(k);}) : [];
    if(!_callerSA(req)){
      if(wantSA) return res.status(403).json({error:'Only a superadmin can create a superadmin role'});
      var bad = keys.filter(function(k){return _SENS.has(k);});
      if(bad.length) return res.status(403).json({error:'Only a superadmin can grant sensitive permissions', keys:bad});
    }
    var now = new Date().toISOString();
    var portal = (b.portal_access===undefined||b.portal_access) ? 1 : 0;
    var app = (b.workerapp_access) ? 1 : 0;
    var rid = db.transaction(function(){
      var id = db.prepare('INSERT INTO roles(name,description,is_system,superadmin,portal_access,workerapp_access,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(name, (b.description||'').trim(), 0, wantSA?1:0, portal, app, now, now).lastInsertRowid;
      if(!wantSA){ var ins=db.prepare('INSERT OR IGNORE INTO role_permissions(role_id,perm_key) VALUES(?,?)'); keys.forEach(function(k){ ins.run(id,k); }); }
      return id;
    })();
    res.status(201).json({ id:rid });
  } catch(e){
    if(String(e.message).indexOf('UNIQUE')>=0) return res.status(409).json({error:'A role with that name already exists'});
    res.status(500).json({error:e.message});
  }
});

router.put('/roles/:id', P.requirePerm('settings.roles.manage'), function(req,res){
  try {
    var id = +req.params.id;
    var r = db.prepare('SELECT * FROM roles WHERE id=?').get(id);
    if(!r) return res.status(404).json({error:'Role not found'});
    if(r.is_system && r.superadmin) return res.status(403).json({error:'The Superadmin role cannot be modified'});
    var b = req.body||{};
    var newName = r.is_system ? r.name : ((b.name||'').trim() || r.name);
    var keys = Array.isArray(b.permissions) ? b.permissions.filter(function(k){return _VALID.has(k);}) : null;
    if(!_callerSA(req) && keys){ var bad = keys.filter(function(k){return _SENS.has(k);}); if(bad.length) return res.status(403).json({error:'Only a superadmin can grant sensitive permissions', keys:bad}); }
    var now = new Date().toISOString();
    var portal = (b.portal_access===undefined) ? r.portal_access : (b.portal_access?1:0);
    var app = (b.workerapp_access===undefined) ? r.workerapp_access : (b.workerapp_access?1:0);
    var desc = (b.description!==undefined) ? (b.description||'').trim() : r.description;
    db.transaction(function(){
      db.prepare('UPDATE roles SET name=?,description=?,portal_access=?,workerapp_access=?,updated_at=? WHERE id=?').run(newName, desc, portal, app, now, id);
      if(keys){ db.prepare('DELETE FROM role_permissions WHERE role_id=?').run(id); var ins=db.prepare('INSERT OR IGNORE INTO role_permissions(role_id,perm_key) VALUES(?,?)'); keys.forEach(function(k){ ins.run(id,k); }); }
    })();
    res.json({ ok:true });
  } catch(e){
    if(String(e.message).indexOf('UNIQUE')>=0) return res.status(409).json({error:'A role with that name already exists'});
    res.status(500).json({error:e.message});
  }
});

router.delete('/roles/:id', P.requirePerm('settings.roles.manage'), function(req,res){
  try {
    var id = +req.params.id;
    var r = db.prepare('SELECT * FROM roles WHERE id=?').get(id);
    if(!r) return res.status(404).json({error:'Role not found'});
    if(r.is_system) return res.status(403).json({error:'System roles cannot be deleted'});
    var users = db.prepare('SELECT COUNT(*) c FROM workers WHERE role_id=? AND is_active=1').get(id).c;
    if(users>0) return res.status(409).json({error:'Reassign the '+users+' user(s) in this role before deleting it'});
    db.transaction(function(){ db.prepare('DELETE FROM role_permissions WHERE role_id=?').run(id); db.prepare('DELETE FROM roles WHERE id=?').run(id); })();
    res.json({ ok:true });
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.post('/roles/:id/users', P.requirePerm('settings.roles.manage'), function(req,res){
  try {
    var id = +req.params.id;
    var r = db.prepare('SELECT * FROM roles WHERE id=?').get(id);
    if(!r) return res.status(404).json({error:'Role not found'});
    if(r.superadmin && !_callerSA(req)) return res.status(403).json({error:'Only a superadmin can assign users to a superadmin role'});
    var ids = (req.body && Array.isArray(req.body.userIds)) ? req.body.userIds.map(function(x){return +x;}).filter(function(x){return x>0;}) : [];
    if(!ids.length) return res.status(400).json({error:'userIds[] required'});
    var upd = db.prepare('UPDATE workers SET role_id=? WHERE id=?');
    db.transaction(function(){ ids.forEach(function(uid){ upd.run(id, uid); }); })();
    res.json({ ok:true, assigned:ids.length });
  } catch(e){ res.status(500).json({error:e.message}); }
});
/* /R4A-ROLES */


module.exports = router;

