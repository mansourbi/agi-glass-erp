# ============================================================================
#  BLOCK F-1  -  Pricing admin API (CRUD for profiles/rules/categories/defaults)
#  Deploys routes/pricing_admin.js + registers it in server.js + restarts.
#  Defensive: backs up server.js, node-checks BOTH files before restart,
#  registration idempotent. Touches only the Block E-1 pricing tables.
# ============================================================================
$ts      = Get-Date -Format 'yyyyMMdd-HHmmss'
$srv     = 'C:\agi-server'
$routes  = Join-Path $srv 'routes'
$bkDir   = Join-Path $srv '_route_backups'
New-Item -ItemType Directory -Force -Path $bkDir | Out-Null

Copy-Item (Join-Path $srv 'server.js') (Join-Path $bkDir "server.js.$ts.bak")
$routeFile = Join-Path $routes 'pricing_admin.js'
if (Test-Path $routeFile) { Copy-Item $routeFile (Join-Path $bkDir "pricing_admin.js.$ts.bak") }

$padmin = @'
// routes/pricing_admin.js
// BLOCK F-1 - CRUD admin for the modular pricing model (profiles, rules,
// extra-charge categories, product default attachments). Reads/writes ONLY the
// Block E-1 tables; does not touch orders or live billing.
const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
router.use(requireAuth);

const BASES   = ['per_sqm','per_linear_meter'];
const LENBAS  = ['perimeter','edges'];
const CONDS   = ['area_gt','side_gt','holes_gt','cutouts_gt','thickness_gt','qty_gt'];
const ACTS    = ['pct_uplift','flat_add','per_unit_add','set_min'];
const num = v => (v==null||v==='') ? null : Number(v);

// -- vocabulary for UI dropdowns --
router.get('/meta', (req,res) => res.json({
  bases: BASES, length_bases: LENBAS, condition_types: CONDS, action_types: ACTS,
  condition_help: { area_gt:'piece area (m2)', side_gt:'longest side (mm)', holes_gt:'drill holes',
                    cutouts_gt:'cutouts', thickness_gt:'thickness (mm)', qty_gt:'piece qty' },
  action_help: { pct_uplift:'add % of base', flat_add:'add fixed JD', per_unit_add:'add JD per unit beyond threshold', set_min:'raise base to at least' }
}));

// -- PROFILES --
router.get('/profiles', (req,res) => {
  try {
    const rows = db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM pricing_rules r WHERE r.profile_id=p.id) rule_count,
                                    (SELECT COUNT(*) FROM product_default_price d WHERE d.profile_id=p.id) default_count
                             FROM price_profiles p ORDER BY p.id`).all();
    res.json(rows);
  } catch(e){ res.status(500).json({error:e.message}); }
});
router.get('/profiles/:id', (req,res) => {
  try {
    const p = db.prepare('SELECT * FROM price_profiles WHERE id=?').get(+req.params.id);
    if(!p) return res.status(404).json({error:'Not found'});
    p.rules = db.prepare('SELECT * FROM pricing_rules WHERE profile_id=? ORDER BY priority,id').all(p.id);
    res.json(p);
  } catch(e){ res.status(500).json({error:e.message}); }
});
router.post('/profiles', requireAdmin, (req,res) => {
  try {
    const b = req.body||{};
    if(!b.name) return res.status(400).json({error:'name required'});
    const basis = BASES.includes(b.basis)? b.basis : 'per_sqm';
    const lb = LENBAS.includes(b.length_basis)? b.length_basis : 'perimeter';
    const info = db.prepare('INSERT INTO price_profiles(name,basis,length_basis,base_rate,min_per_piece,notes) VALUES(?,?,?,?,?,?)')
      .run(b.name, basis, lb, num(b.base_rate)||0, num(b.min_per_piece)||0, b.notes||null);
    res.json(db.prepare('SELECT * FROM price_profiles WHERE id=?').get(info.lastInsertRowid));
  } catch(e){ res.status(500).json({error:e.message}); }
});
router.put('/profiles/:id', requireAdmin, (req,res) => {
  try {
    const id=+req.params.id; const cur=db.prepare('SELECT * FROM price_profiles WHERE id=?').get(id);
    if(!cur) return res.status(404).json({error:'Not found'});
    const b=req.body||{};
    const basis = (b.basis!=null && BASES.includes(b.basis))? b.basis : cur.basis;
    const lb = (b.length_basis!=null && LENBAS.includes(b.length_basis))? b.length_basis : cur.length_basis;
    db.prepare('UPDATE price_profiles SET name=?,basis=?,length_basis=?,base_rate=?,min_per_piece=?,active=?,notes=? WHERE id=?')
      .run(b.name!=null?b.name:cur.name, basis, lb,
           b.base_rate!=null?num(b.base_rate):cur.base_rate,
           b.min_per_piece!=null?num(b.min_per_piece):cur.min_per_piece,
           b.active!=null?(b.active?1:0):cur.active, b.notes!=null?b.notes:cur.notes, id);
    res.json(db.prepare('SELECT * FROM price_profiles WHERE id=?').get(id));
  } catch(e){ res.status(500).json({error:e.message}); }
});
router.delete('/profiles/:id', requireAdmin, (req,res) => {
  try {
    const id=+req.params.id;
    const defs = db.prepare('SELECT COUNT(*) c FROM product_default_price WHERE profile_id=?').get(id).c;
    if(defs>0 && !req.query.force) return res.status(409).json({error:'Profile is a default on '+defs+' product(s). Pass ?force=1 to delete and clear those defaults.'});
    const tx = db.transaction(()=>{
      db.prepare('DELETE FROM product_default_price WHERE profile_id=?').run(id);
      db.prepare('DELETE FROM pricing_rules WHERE profile_id=?').run(id);
      db.prepare('DELETE FROM price_profiles WHERE id=?').run(id);
    }); tx();
    res.json({deleted:id});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// -- RULES --
router.post('/profiles/:id/rules', requireAdmin, (req,res) => {
  try {
    const pid=+req.params.id; const b=req.body||{};
    if(!CONDS.includes(b.condition_type)) return res.status(400).json({error:'bad condition_type'});
    if(!ACTS.includes(b.action_type)) return res.status(400).json({error:'bad action_type'});
    const info=db.prepare('INSERT INTO pricing_rules(profile_id,condition_type,condition_value,action_type,action_value,priority,notes) VALUES(?,?,?,?,?,?,?)')
      .run(pid, b.condition_type, num(b.condition_value)||0, b.action_type, num(b.action_value)||0, num(b.priority)||0, b.notes||null);
    res.json(db.prepare('SELECT * FROM pricing_rules WHERE id=?').get(info.lastInsertRowid));
  } catch(e){ res.status(500).json({error:e.message}); }
});
router.put('/rules/:id', requireAdmin, (req,res) => {
  try {
    const id=+req.params.id; const cur=db.prepare('SELECT * FROM pricing_rules WHERE id=?').get(id);
    if(!cur) return res.status(404).json({error:'Not found'});
    const b=req.body||{};
    const ct=(b.condition_type!=null&&CONDS.includes(b.condition_type))?b.condition_type:cur.condition_type;
    const at=(b.action_type!=null&&ACTS.includes(b.action_type))?b.action_type:cur.action_type;
    db.prepare('UPDATE pricing_rules SET condition_type=?,condition_value=?,action_type=?,action_value=?,priority=?,active=?,notes=? WHERE id=?')
      .run(ct, b.condition_value!=null?num(b.condition_value):cur.condition_value, at,
           b.action_value!=null?num(b.action_value):cur.action_value,
           b.priority!=null?num(b.priority):cur.priority,
           b.active!=null?(b.active?1:0):cur.active, b.notes!=null?b.notes:cur.notes, id);
    res.json(db.prepare('SELECT * FROM pricing_rules WHERE id=?').get(id));
  } catch(e){ res.status(500).json({error:e.message}); }
});
router.delete('/rules/:id', requireAdmin, (req,res) => {
  try { db.prepare('DELETE FROM pricing_rules WHERE id=?').run(+req.params.id); res.json({deleted:+req.params.id}); }
  catch(e){ res.status(500).json({error:e.message}); }
});

// -- EXTRA-CHARGE CATEGORIES --
router.get('/categories', (req,res) => {
  try { res.json(db.prepare('SELECT * FROM extra_charge_categories ORDER BY sort_order,id').all()); }
  catch(e){ res.status(500).json({error:e.message}); }
});
router.post('/categories', requireAdmin, (req,res) => {
  try { const b=req.body||{}; if(!b.label) return res.status(400).json({error:'label required'});
    const info=db.prepare('INSERT INTO extra_charge_categories(code,label,description,sort_order) VALUES(?,?,?,?)')
      .run(b.code||null, b.label, b.description||null, num(b.sort_order)||0);
    res.json(db.prepare('SELECT * FROM extra_charge_categories WHERE id=?').get(info.lastInsertRowid));
  } catch(e){ res.status(500).json({error:e.message}); }
});
router.put('/categories/:id', requireAdmin, (req,res) => {
  try { const id=+req.params.id; const cur=db.prepare('SELECT * FROM extra_charge_categories WHERE id=?').get(id);
    if(!cur) return res.status(404).json({error:'Not found'});
    const b=req.body||{};
    db.prepare('UPDATE extra_charge_categories SET code=?,label=?,description=?,active=?,sort_order=? WHERE id=?')
      .run(b.code!=null?b.code:cur.code, b.label!=null?b.label:cur.label, b.description!=null?b.description:cur.description,
           b.active!=null?(b.active?1:0):cur.active, b.sort_order!=null?num(b.sort_order):cur.sort_order, id);
    res.json(db.prepare('SELECT * FROM extra_charge_categories WHERE id=?').get(id));
  } catch(e){ res.status(500).json({error:e.message}); }
});
router.delete('/categories/:id', requireAdmin, (req,res) => {
  try { db.prepare('DELETE FROM extra_charge_categories WHERE id=?').run(+req.params.id); res.json({deleted:+req.params.id}); }
  catch(e){ res.status(500).json({error:e.message}); }
});

// -- PRODUCTS + DEFAULT PROFILE ATTACHMENT --
router.get('/products', (req,res) => {
  try {
    const rows = db.prepare(`SELECT pr.id product_id, pr.legacy_fp_id, pr.label,
        d.profile_id default_profile_id, pp.name default_profile_name
        FROM products pr
        LEFT JOIN product_default_price d ON d.product_id=pr.id
        LEFT JOIN price_profiles pp ON pp.id=d.profile_id
        ORDER BY pr.id`).all();
    res.json(rows);
  } catch(e){ res.status(500).json({error:e.message}); }
});
router.put('/products/:id/default', requireAdmin, (req,res) => {
  try {
    const pid=+req.params.id; const profileId=num((req.body||{}).profile_id);
    const prod=db.prepare('SELECT id FROM products WHERE id=?').get(pid);
    if(!prod) return res.status(404).json({error:'Product not found'});
    if(profileId==null){ db.prepare('DELETE FROM product_default_price WHERE product_id=?').run(pid); return res.json({product_id:pid, default_profile_id:null}); }
    const prof=db.prepare('SELECT id FROM price_profiles WHERE id=?').get(profileId);
    if(!prof) return res.status(400).json({error:'profile_id not found'});
    db.prepare('INSERT INTO product_default_price(product_id,profile_id,updated_at) VALUES(?,?,datetime(\'now\')) ON CONFLICT(product_id) DO UPDATE SET profile_id=excluded.profile_id, updated_at=datetime(\'now\')').run(pid, profileId);
    res.json({product_id:pid, default_profile_id:profileId});
  } catch(e){ res.status(500).json({error:e.message}); }
});

module.exports = router;

'@
Set-Content -Path $routeFile -Value $padmin -Encoding ascii

& node --check $routeFile
if ($LASTEXITCODE -ne 0) { Write-Host 'ABORT: pricing_admin.js failed syntax check; server NOT restarted.'; exit 1 }
Write-Host 'pricing_admin.js syntax OK'

$serverPath = Join-Path $srv 'server.js'
$content = [System.IO.File]::ReadAllText($serverPath)
if ($content -notmatch 'routes/pricing_admin') {
  $anchor = "app.use('/api/pricing2', require('./routes/pricing2'));"
  if (-not $content.Contains($anchor)) { $anchor = "app.use('/api/orderpricing', require('./routes/orderpricing'));" }
  if ($content.Contains($anchor)) {
    $insert  = $anchor + "`r`n" + "app.use('/api/pricing_admin', require('./routes/pricing_admin'));"
    $content = $content.Replace($anchor, $insert)
    [System.IO.File]::WriteAllText($serverPath, $content, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host 'Registered /api/pricing_admin in server.js'
  } else {
    Write-Host 'WARN: anchor not found; add manually:  app.use(''/api/pricing_admin'', require(''./routes/pricing_admin''));'
  }
} else { Write-Host '/api/pricing_admin already registered (idempotent skip)' }

& node --check $serverPath
if ($LASTEXITCODE -ne 0) {
  Write-Host 'ABORT: server.js failed syntax check. Restoring backup.'
  Copy-Item (Join-Path $bkDir "server.js.$ts.bak") $serverPath -Force
  exit 1
}
Write-Host 'server.js syntax OK'

Write-Host 'Restarting agi-glass service...'
Restart-Service agi-glass
Start-Sleep -Seconds 4
Write-Host ('Service status: ' + (Get-Service agi-glass).Status)
$listening = [bool]((netstat -ano | Select-String ':3000' | Select-String 'LISTENING'))
Write-Host ('Port 3000 listening: ' + $listening)
Write-Host ''
Write-Host 'Block F-1 deployed. Admin API base: /api/pricing_admin (profiles, rules, categories, products/default)'
Write-Host 'REVERT: remove the /api/pricing_admin line from server.js, Remove-Item routes\pricing_admin.js, Restart-Service agi-glass'
