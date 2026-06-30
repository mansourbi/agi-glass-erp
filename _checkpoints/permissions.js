// middleware/permissions.js - Roles & Privileges core
// Single source of truth for the permission catalog + role resolution + enforcement.
// R-1 adds this WITHOUT enforcing on existing routes (enforcement is R-2).
const db = require('../db');

// ---- PERMISSION CATALOG (the contract; everything derives from this) ----
// {k:key, g:group, l:label, s:sensitive?}
const CATALOG = [
  // Surfaces (top-level access gates)
  {k:'portal.access',           g:'Surfaces',  l:'Log in to web portal'},
  {k:'workerapp.access',        g:'Surfaces',  l:'Use worker app'},
  // Dashboard
  {k:'dashboard.view',          g:'Dashboard', l:'View dashboard'},
  {k:'dashboard.financials',    g:'Dashboard', l:'See financial KPIs', s:1},
  // Customers
  {k:'customers.access',        g:'Customers', l:'Open Customers section'},
  {k:'customers.create',        g:'Customers', l:'Add customer'},
  {k:'customers.edit',          g:'Customers', l:'Edit customer'},
  {k:'customers.delete',        g:'Customers', l:'Delete customer'},
  {k:'customers.export',        g:'Customers', l:'Export customers (CSV)'},
  {k:'customers.profile.view',  g:'Customers', l:'View Profile tab'},
  {k:'customers.profile.edit',  g:'Customers', l:'Edit profile'},
  {k:'customers.pricelist.view',g:'Customers', l:'View Price List tab'},
  {k:'customers.pricelist.edit',g:'Customers', l:'Add/edit prices'},
  {k:'customers.priceprofiles.view',g:'Customers', l:'View Price Profiles tab'},
  {k:'customers.priceprofiles.edit',g:'Customers', l:'Edit price profiles'},
  {k:'customers.account.view',  g:'Customers', l:'View Account / Statement of Account', s:1},
  // Orders
  {k:'orders.access',           g:'Orders',    l:'Open Orders section'},
  {k:'orders.create',           g:'Orders',    l:'Create order'},
  {k:'orders.edit',             g:'Orders',    l:'Edit order'},
  {k:'orders.delete',           g:'Orders',    l:'Delete/cancel order'},
  {k:'orders.export',           g:'Orders',    l:'Export orders'},
  {k:'orders.print',            g:'Orders',    l:'Print order'},
  {k:'orders.status',           g:'Orders',    l:'Advance/complete order status'},
  {k:'orders.pricing.view',     g:'Orders',    l:'View order Pricing tab', s:1},
  {k:'orders.pricing.edit',     g:'Orders',    l:'Edit pricing (override/discount/charges)'},
  {k:'orders.pricing.finalize', g:'Orders',    l:'Finalize / un-finalize price'},
  // Cutting
  {k:'cutting.access',          g:'Cutting',   l:'Open Cutting section'},
  {k:'cutting.create',          g:'Cutting',   l:'New optimization'},
  {k:'cutting.edit',            g:'Cutting',   l:'Edit/save optimization, add pieces, load orders'},
  {k:'cutting.optimize',        g:'Cutting',   l:'Run optimize cuts'},
  {k:'cutting.labels',          g:'Cutting',   l:'Print labels / pieces'},
  {k:'cutting.export',          g:'Cutting',   l:'Export Excel'},
  {k:'cutting.print',           g:'Cutting',   l:'Print'},
  // Tracking
  {k:'tracking.access',         g:'Tracking',  l:'Open Tracking section'},
  {k:'tracking.update',         g:'Tracking',  l:'Update process/piece status'},
  {k:'tracking.export',         g:'Tracking',  l:'Export log / pivot'},
  // Reports
  {k:'reports.access',          g:'Reports',   l:'Open Reports section'},
  {k:'reports.productivity',    g:'Reports',   l:'Productivity report'},
  {k:'reports.hourly',          g:'Reports',   l:'Hourly Activity report'},
  {k:'reports.orders',          g:'Reports',   l:'Orders report'},
  {k:'reports.workers',         g:'Reports',   l:'Workers report'},
  {k:'reports.attendance',      g:'Reports',   l:'Attendance report'},
  {k:'reports.finalproducts',   g:'Reports',   l:'Final Products report'},
  {k:'reports.cutting',         g:'Reports',   l:'Cutting report'},
  {k:'reports.vacation',        g:'Reports',   l:'Vacation Balances report'},
  {k:'reports.sales',           g:'Reports',   l:'Sales report', s:1},
  {k:'reports.export',          g:'Reports',   l:'Export reports (Excel/PDF)'},
  // Remnants
  {k:'remnants.access',         g:'Remnants',  l:'Open Remnants section'},
  {k:'remnants.create',         g:'Remnants',  l:'Add remnant'},
  {k:'remnants.assign',         g:'Remnants',  l:'Assign remnant'},
  {k:'remnants.print',          g:'Remnants',  l:'Print label'},
  {k:'remnants.edit',           g:'Remnants',  l:'Edit remnant'},
  {k:'remnants.delete',         g:'Remnants',  l:'Delete remnant'},
  // Deliveries
  {k:'deliveries.access',       g:'Deliveries',l:'Open Deliveries section'},
  {k:'deliveries.create',       g:'Deliveries',l:'Create delivery'},
  {k:'deliveries.edit',         g:'Deliveries',l:'Edit delivery'},
  {k:'deliveries.finalize',     g:'Deliveries',l:'Finalize delivery'},
  {k:'deliveries.delete',       g:'Deliveries',l:'Delete delivery'},
  {k:'deliveries.print',        g:'Deliveries',l:'Print delivery'},
  {k:'deliveries.export',       g:'Deliveries',l:'Export deliveries'},
  // A-Frames
  {k:'aframes.access',          g:'A-Frames',  l:'Open A-Frames section'},
  {k:'aframes.slots.edit',      g:'A-Frames',  l:'Add/edit slots'},
  {k:'aframes.stock.assign',    g:'A-Frames',  l:'Assign stock / transfers'},
  {k:'aframes.stock.edit',      g:'A-Frames',  l:'Add/edit stock'},
  {k:'aframes.print',           g:'A-Frames',  l:'Print'},
  {k:'aframes.export',          g:'A-Frames',  l:'Export'},
  // Layout
  {k:'layout.access',           g:'Layout',    l:'Open Layout section'},
  {k:'layout.edit',             g:'Layout',    l:'Edit/save layout'},
  // Purchasing
  {k:'purchasing.access',       g:'Purchasing',l:'Open Purchasing section', s:1},
  {k:'purchasing.create',       g:'Purchasing',l:'Create PO'},
  {k:'purchasing.edit',         g:'Purchasing',l:'Edit PO (items/costs)'},
  {k:'purchasing.receive',      g:'Purchasing',l:'Receive goods'},
  {k:'purchasing.delete',       g:'Purchasing',l:'Delete PO'},
  {k:'purchasing.export',       g:'Purchasing',l:'Export'},
  // Pricing (admin catalog)
  {k:'pricing.access',          g:'Pricing',   l:'Open Pricing section'},
  {k:'pricing.profiles.view',   g:'Pricing',   l:'View price profiles & rules'},
  {k:'pricing.profiles.edit',   g:'Pricing',   l:'Edit price profiles & rules'},
  {k:'pricing.products.view',   g:'Pricing',   l:'View product defaults'},
  {k:'pricing.products.edit',   g:'Pricing',   l:'Edit product defaults'},
  {k:'pricing.categories.view', g:'Pricing',   l:'View charge categories'},
  {k:'pricing.categories.edit', g:'Pricing',   l:'Edit charge categories'},
  // Settings
  {k:'settings.access',         g:'Settings',  l:'Open Settings section'},
  {k:'settings.rawmaterials.view',g:'Settings',l:'View Raw Materials'},
  {k:'settings.rawmaterials.edit',g:'Settings',l:'Edit Raw Materials (sheets/purchases)'},
  {k:'settings.vendors.manage', g:'Settings',  l:'Manage Vendors'},
  {k:'settings.manufacturers.manage',g:'Settings',l:'Manage Manufacturers'},
  {k:'settings.glassfamilies.manage',g:'Settings',l:'Manage Glass Families'},
  {k:'settings.remnantslots.manage',g:'Settings',l:'Manage Remnant Slots'},
  {k:'settings.fpfields.manage',g:'Settings',  l:'Manage FP Field Values'},
  {k:'settings.finalproducts.manage',g:'Settings',l:'Manage Final Products'},
  {k:'settings.processes.manage',g:'Settings', l:'Manage Processes'},
  {k:'settings.extprocesses.manage',g:'Settings',l:'Manage External Processes'},
  {k:'settings.ordertypes.manage',g:'Settings',l:'Manage Order Types'},
  {k:'settings.cancelreasons.manage',g:'Settings',l:'Manage Cancel Reasons'},
  {k:'settings.receivers.manage',g:'Settings', l:'Manage Delivery Receivers'},
  {k:'settings.factories.manage',g:'Settings', l:'Manage Factories'},
  {k:'settings.translations.manage',g:'Settings',l:'Manage Translations'},
  {k:'settings.system.manage',  g:'Settings',  l:'System configuration'},
  {k:'settings.logs.view',      g:'Settings',  l:'View audit logs', s:1},
  {k:'settings.users.manage',   g:'Settings',  l:'Manage users (add/edit, assign roles)', s:1},
  {k:'settings.devices.manage', g:'Settings',  l:'Approve/reset worker-app devices'},
  {k:'settings.roles.manage',   g:'Settings',  l:'Manage Roles & Privileges', s:1},
  // HR / Payroll
  {k:'hr.access',               g:'HR / Payroll', l:'Open HR / Payroll', s:1},
  {k:'hr.attendance.view',      g:'HR / Payroll', l:'View attendance'},
  {k:'hr.attendance.edit',      g:'HR / Payroll', l:'Edit attendance'},
  {k:'hr.overtime.view',        g:'HR / Payroll', l:'View overtime'},
  {k:'hr.overtime.approve',     g:'HR / Payroll', l:'Approve/reject overtime'},
  {k:'hr.leave.view',           g:'HR / Payroll', l:'View leave'},
  {k:'hr.leave.edit',           g:'HR / Payroll', l:'Add/edit leave'},
  {k:'hr.leavetypes.manage',    g:'HR / Payroll', l:'Manage leave types'},
  {k:'hr.payroll.view',         g:'HR / Payroll', l:'View payroll', s:1},
  {k:'hr.payroll.run',          g:'HR / Payroll', l:'Run/finalize payroll', s:1},
  {k:'hr.adjustments.manage',   g:'HR / Payroll', l:'Manage payroll adjustments', s:1},
  {k:'hr.schedule.manage',      g:'HR / Payroll', l:'Manage work schedule'},
  {k:'hr.vacation.manage',      g:'HR / Payroll', l:'Manage vacation accrual'},
  {k:'hr.holidays.manage',      g:'HR / Payroll', l:'Manage holidays'},
  {k:'hr.payslips.view',        g:'HR / Payroll', l:'View payslips', s:1},
  {k:'hr.payslips.print',       g:'HR / Payroll', l:'Print payslips', s:1},
  {k:'hr.worker_records.edit',  g:'HR / Payroll', l:'Edit worker HR records (salary/ID)', s:1},
  // Worker app features
  {k:'workerapp.deliver',       g:'Worker App', l:'Deliver tab'},
  {k:'workerapp.attend',        g:'Worker App', l:'Attend tab (clock in/out)'},
  {k:'workerapp.overtime',      g:'Worker App', l:'View own overtime history'}
];
const ALL_KEYS = CATALOG.map(c=>c.k);
const GROUPS = (function(){ const m={}; CATALOG.forEach(c=>{ (m[c.g]=m[c.g]||[]).push(c); }); return m; })();
const WORKER_DEFAULT = ['workerapp.access','workerapp.deliver','workerapp.attend','workerapp.overtime'];

// ---- schema (idempotent; safe to run every startup) ----
function ensureSchema(){
  db.exec("CREATE TABLE IF NOT EXISTS roles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, description TEXT, is_system INTEGER DEFAULT 0, superadmin INTEGER DEFAULT 0, portal_access INTEGER DEFAULT 1, workerapp_access INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT)");
  db.exec("CREATE TABLE IF NOT EXISTS role_permissions (role_id INTEGER NOT NULL, perm_key TEXT NOT NULL, PRIMARY KEY (role_id, perm_key))");
  var cols = db.prepare("PRAGMA table_info(workers)").all().map(function(c){return c.name;});
  if(cols.indexOf('role_id')<0) db.exec("ALTER TABLE workers ADD COLUMN role_id INTEGER");
}

// ---- seed defaults + map existing users (idempotent: only when no roles exist) ----
function seedRolesIfEmpty(){
  var n = db.prepare("SELECT COUNT(*) c FROM roles").get().c;
  if(n>0) return;
  var now=new Date().toISOString();
  var insRole=db.prepare("INSERT INTO roles(name,description,is_system,superadmin,portal_access,workerapp_access,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)");
  var insPerm=db.prepare("INSERT OR IGNORE INTO role_permissions(role_id,perm_key) VALUES(?,?)");
  var tx=db.transaction(function(){
    var sa=insRole.run('Superadmin','Full unrestricted access. Cannot be edited or deleted.',1,1,1,1,now,now).lastInsertRowid;
    var ad=insRole.run('Admin','Full portal access. Editable.',1,0,1,0,now,now).lastInsertRowid;
    var wk=insRole.run('Worker','Worker app access only. Editable.',1,0,0,1,now,now).lastInsertRowid;
    ALL_KEYS.forEach(function(k){ insPerm.run(ad,k); });        // Admin = everything (preserves current behavior)
    WORKER_DEFAULT.forEach(function(k){ insPerm.run(wk,k); });  // Worker = app features
    // map existing users (superadmin first, then remaining admins, then workers; only where unset)
    db.prepare("UPDATE workers SET role_id=? WHERE (id=1 OR LOWER(email)='admin') AND role_id IS NULL").run(sa);
    db.prepare("UPDATE workers SET role_id=? WHERE role='admin' AND role_id IS NULL").run(ad);
    db.prepare("UPDATE workers SET role_id=? WHERE role='worker' AND role_id IS NULL").run(wk);
  });
  tx();
}

// ---- resolution ----
function resolvePerms(userId){
  var w=db.prepare("SELECT id,role,role_id FROM workers WHERE id=?").get(userId);
  if(!w) return {superadmin:false, keys:new Set(), portal:false, workerapp:false, role:null};
  var role = w.role_id ? db.prepare("SELECT * FROM roles WHERE id=?").get(w.role_id) : null;
  if(role && role.superadmin) return {superadmin:true, keys:new Set(ALL_KEYS), portal:true, workerapp:true, role:role};
  if(role){
    var keys=new Set(db.prepare("SELECT perm_key FROM role_permissions WHERE role_id=?").all(role.id).map(function(x){return x.perm_key;}));
    if(role.portal_access) keys.add('portal.access');
    if(role.workerapp_access) keys.add('workerapp.access');
    return {superadmin:false, keys:keys, portal:!!role.portal_access, workerapp:!!role.workerapp_access, role:role};
  }
  // fallback (no role assigned): preserve legacy behavior so nothing breaks
  if(w.role==='admin') return {superadmin:false, keys:new Set(ALL_KEYS), portal:true, workerapp:false, role:null, legacy:true};
  return {superadmin:false, keys:new Set(WORKER_DEFAULT), portal:false, workerapp:true, role:null, legacy:true};
}

function can(req, key){
  if(!req || !req.user) return false;
  var p=resolvePerms(req.user.id);
  return p.superadmin || p.keys.has(key);
}
function requirePerm(key){
  return function(req,res,next){
    if(!req.user) return res.status(401).json({error:'No token'});
    if(can(req,key)) return next();
    return res.status(403).json({error:'Permission denied', need:key});
  };
}

module.exports = { CATALOG, ALL_KEYS, GROUPS, WORKER_DEFAULT, ensureSchema, seedRolesIfEmpty, resolvePerms, can, requirePerm };
