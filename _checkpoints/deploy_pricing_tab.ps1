# ============================================================================
#  BLOCK F-2 (native) v2  -  Inject the Pricing tab into the portal.
#  Writes public\pricing-ui.js and adds ONE <script> line to glassfab.html
#  (in-place insert before </body>; backed up first; idempotent).
#  v2 fix: nav label uses data-i18n so the portal's translation pass does not
#  duplicate it. No service restart needed (static files).
# ============================================================================
$ts  = Get-Date -Format 'yyyyMMdd-HHmmss'
$pub = 'C:\agi-server\public'
$bk  = 'C:\agi-server\_public_backups'
New-Item -ItemType Directory -Force -Path $bk | Out-Null

$uijs = @'
/* pricing-ui.js  -  Block F-2 (native): injects a "Pricing" tab into the AGI
 * portal. Self-contained, defensive: if anything is missing it no-ops rather
 * than breaking the portal. Styled to the portal's dark theme. */
(function(){
  if (window.__pricingUI) return; window.__pricingUI = true;
  var API='/api/pricing_admin';
  function tok(){ try{ return (window.AGI&&AGI.getToken)?AGI.getToken():localStorage.getItem('agi_token'); }catch(e){ return localStorage.getItem('agi_token'); } }
  var META={condition_types:[],action_types:[],bases:[]}, PROFILES=[], CATS=[], loaded=false;

  /* ---- styles (scoped .pp-*) using portal CSS vars ---- */
  var css = `
  #pg-pricing{padding:18px 20px 80px}
  .pp-head{display:flex;align-items:center;gap:14px;margin:2px 0 16px;flex-wrap:wrap}
  .pp-head h2{font-family:'Bebas Neue','Cairo',sans-serif;letter-spacing:2px;color:var(--a);margin:0;font-size:1.5rem;font-weight:400}
  .pp-head p{margin:0;color:var(--muted,#7c93a8);font-size:.82rem}
  .pp-sub{display:flex;gap:2px;margin:0 0 16px;border-bottom:1px solid var(--border,#1b3a5a)}
  .pp-st{background:none;border:0;color:var(--muted,#7c93a8);font-family:'Cairo',sans-serif;font-weight:700;font-size:.8rem;
    letter-spacing:.5px;padding:9px 15px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
  .pp-st.on{color:var(--tx,#cfe3f2);border-bottom-color:var(--a,#00ccff)}
  .pp-st:hover{color:var(--tx,#cfe3f2)}
  .pp-pane{display:none} .pp-pane.on{display:block}
  .pp-card{background:var(--panel,#111f2e);border:1px solid var(--border,#1b3a5a);border-radius:10px;overflow:hidden}
  .pp-tbl{width:100%;border-collapse:collapse;font-size:.85rem}
  .pp-tbl th{font-size:.66rem;letter-spacing:.08em;text-transform:uppercase;color:var(--muted,#7c93a8);font-weight:700;
    text-align:left;padding:10px 13px;border-bottom:1px solid var(--border,#1b3a5a);background:var(--panel2,#162438)}
  .pp-tbl td{padding:9px 13px;border-bottom:1px solid rgba(27,58,90,.5);vertical-align:middle;color:var(--tx,#cfe3f2)}
  .pp-tbl tr:last-child td{border-bottom:0}
  .pp-tbl tr.r:hover{background:rgba(0,204,255,.04)}
  .pp-name{font-weight:700;color:#dff0fb}
  .pp-mut{color:var(--muted,#7c93a8);font-size:.78rem}
  .pp-pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:.68rem;font-weight:700;background:rgba(0,204,255,.12);color:var(--a,#00ccff)}
  .pp-pill.g{background:rgba(124,147,168,.16);color:var(--muted,#7c93a8)}
  .pp-pill.am{background:rgba(255,210,63,.14);color:var(--a4,#ffd23f)}
  .pp-inp{width:80px;padding:5px 8px;border:1px solid var(--border,#1b3a5a);border-radius:6px;background:var(--surf,#0d1825);
    color:var(--tx,#cfe3f2);text-align:right;font-family:'DM Mono',monospace;font-size:.82rem}
  .pp-inp:focus{outline:none;border-color:var(--a,#00ccff);box-shadow:0 0 0 3px rgba(0,204,255,.15)}
  .pp-inp.dirty{border-color:var(--a4,#ffd23f)}
  .pp-sel{padding:5px 8px;border:1px solid var(--border,#1b3a5a);border-radius:6px;background:var(--surf,#0d1825);color:var(--tx,#cfe3f2);
    font-family:'Cairo',sans-serif;font-size:.82rem;max-width:240px}
  .pp-sel:focus{outline:none;border-color:var(--a,#00ccff)}
  .pp-btn{border:1px solid var(--border,#1b3a5a);background:var(--surf,#0d1825);color:var(--tx,#cfe3f2);font-family:'Cairo',sans-serif;
    font-weight:700;font-size:.78rem;padding:7px 13px;border-radius:7px;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
  .pp-btn:hover{border-color:var(--a,#00ccff);color:var(--a,#00ccff)}
  .pp-btn.pri{background:var(--a,#00ccff);border-color:var(--a,#00ccff);color:#04121c}
  .pp-btn.pri:hover{background:#00b3e6;color:#04121c}
  .pp-btn.sm{padding:4px 9px;font-size:.74rem}
  .pp-btn.gh{border-color:transparent;background:none;color:var(--muted,#7c93a8);padding:4px 8px}
  .pp-btn.gh:hover{color:var(--a,#00ccff)}
  .pp-btn.dn:hover{color:var(--a2,#ff6935)}
  .pp-act{display:flex;gap:3px;justify-content:flex-end}
  .pp-rules{background:rgba(0,0,0,.18)}
  .pp-rules .in{padding:13px 16px}
  .pp-rules h4{margin:0 0 9px;font-size:.68rem;letter-spacing:.06em;text-transform:uppercase;color:var(--muted,#7c93a8)}
  .pp-rr{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:6px 0;border-bottom:1px dashed rgba(27,58,90,.6)}
  .pp-rr:last-child{border-bottom:0}
  .pp-rr .kw{font-weight:700;color:var(--muted,#7c93a8);font-size:.72rem}
  .pp-rr b{color:#dff0fb}
  .pp-mini{width:86px;padding:5px 7px;border:1px solid var(--border,#1b3a5a);border-radius:6px;background:var(--surf,#0d1825);color:var(--tx,#cfe3f2);font-family:'DM Mono',monospace;font-size:.8rem}
  .pp-empty{padding:34px;text-align:center;color:var(--muted,#7c93a8)}
  /* modal */
  .pp-mbg{position:fixed;inset:0;background:rgba(2,8,14,.66);display:none;align-items:flex-start;justify-content:center;z-index:9000;padding:60px 16px;overflow:auto}
  .pp-mbg.on{display:flex}
  .pp-mdl{background:var(--panel,#111f2e);border:1px solid var(--border2,#234965);border-radius:12px;width:100%;max-width:440px;box-shadow:0 24px 70px rgba(0,0,0,.6)}
  .pp-mdl h3{margin:0;padding:16px 19px;font-family:'Bebas Neue','Cairo',sans-serif;letter-spacing:1.5px;color:var(--a,#00ccff);font-size:1.15rem;font-weight:400;border-bottom:1px solid var(--border,#1b3a5a)}
  .pp-mb{padding:17px 19px;display:grid;gap:12px}
  .pp-f{display:grid;gap:5px}
  .pp-f label{font-size:.72rem;font-weight:700;color:var(--muted,#7c93a8);letter-spacing:.03em}
  .pp-f input,.pp-f select{padding:9px 11px;border:1px solid var(--border,#1b3a5a);border-radius:8px;background:var(--surf,#0d1825);color:var(--tx,#cfe3f2);font-family:'Cairo',sans-serif;width:100%}
  .pp-f input:focus,.pp-f select:focus{outline:none;border-color:var(--a,#00ccff);box-shadow:0 0 0 3px rgba(0,204,255,.15)}
  .pp-f .hint{font-size:.7rem;color:var(--muted,#7c93a8)}
  .pp-r2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .pp-mf{padding:13px 19px;border-top:1px solid var(--border,#1b3a5a);display:flex;justify-content:flex-end;gap:8px}
  `;
  function injectStyle(){ if(document.getElementById('pp-style'))return; var s=document.createElement('style'); s.id='pp-style'; s.textContent=css; document.head.appendChild(s); }

  function injectNav(){
    var tabs=document.querySelector('.nav-tabs'); if(!tabs||document.getElementById('nt-pricing'))return;
    var b=document.createElement('button'); b.className='nt'; b.id='nt-pricing';
    b.setAttribute('onclick',"SP('pricing')"); b.innerHTML='&#128209; <span data-i18n="Pricing">Pricing</span>';
    var settings=document.getElementById('nt-settings');
    if(settings&&settings.parentNode===tabs) tabs.insertBefore(b,settings); else tabs.appendChild(b);
  }
  function injectPanel(){
    if(document.getElementById('pg-pricing'))return;
    var anchor=document.getElementById('pg-dash'); if(!anchor||!anchor.parentNode)return;
    var pg=document.createElement('div'); pg.className='pg'; pg.id='pg-pricing';
    pg.innerHTML=
      '<div class="pp-head"><div><h2>PRICING</h2><p>Reusable price profiles, their rules, product defaults, and manual charge categories.</p></div>'+
      '<div style="flex:1"></div></div>'+
      '<div class="pp-sub">'+
        '<button class="pp-st on" data-pp="profiles">Price profiles</button>'+
        '<button class="pp-st" data-pp="products">Product defaults</button>'+
        '<button class="pp-st" data-pp="cats">Charge categories</button></div>'+
      '<div class="pp-pane on" id="pp-profiles"><div class="pp-head" style="margin:0 0 12px"><div style="flex:1"></div>'+
        '<button class="pp-btn pri" id="pp-newprof">+ New profile</button></div>'+
        '<div class="pp-card"><table class="pp-tbl"><thead><tr><th>Name</th><th>Basis</th><th style="text-align:right">Base rate</th>'+
        '<th style="text-align:right">Min / piece</th><th>Rules</th><th>Used by</th><th></th></tr></thead>'+
        '<tbody id="pp-profrows"><tr><td colspan="7" class="pp-empty">Loading...</td></tr></tbody></table></div></div>'+
      '<div class="pp-pane" id="pp-products"><div class="pp-card"><table class="pp-tbl"><thead><tr><th>Product</th><th>FP id</th>'+
        '<th>Default profile</th></tr></thead><tbody id="pp-prodrows"><tr><td colspan="3" class="pp-empty">Loading...</td></tr></tbody></table></div></div>'+
      '<div class="pp-pane" id="pp-cats"><div class="pp-head" style="margin:0 0 12px"><div style="flex:1"></div>'+
        '<button class="pp-btn pri" id="pp-newcat">+ New category</button></div>'+
        '<div class="pp-card"><table class="pp-tbl"><thead><tr><th>Label</th><th>Code</th><th>Description</th><th></th></tr></thead>'+
        '<tbody id="pp-catrows"><tr><td colspan="4" class="pp-empty">Loading...</td></tr></tbody></table></div></div>';
    anchor.parentNode.appendChild(pg);
    // sub-tab switching
    pg.querySelectorAll('.pp-st').forEach(function(b){ b.onclick=function(){
      pg.querySelectorAll('.pp-st').forEach(function(t){t.classList.toggle('on',t===b);});
      pg.querySelectorAll('.pp-pane').forEach(function(p){p.classList.toggle('on',p.id==='pp-'+b.dataset.pp);});
    };});
    document.getElementById('pp-newprof').onclick=function(){openProfile();};
    document.getElementById('pp-newcat').onclick=function(){openCat();};
    injectModals();
  }
  function wrapSP(){
    if(typeof window.SP!=='function'||window.SP.__pp)return;
    var _SP=window.SP;
    window.SP=async function(id){ try{ await _SP.apply(this,arguments);}catch(e){} if(id==='pricing') renderPricing(); };
    window.SP.__pp=true;
  }

  /* ---- modals ---- */
  function injectModals(){
    if(document.getElementById('pp-pmodal'))return;
    var w=document.createElement('div'); w.innerHTML=
     '<div class="pp-mbg" id="pp-pmodal"><div class="pp-mdl"><h3 id="pp-pmt">New profile</h3><div class="pp-mb">'+
      '<div class="pp-f"><label>Name</label><input id="pp-pm-name" placeholder="e.g. 6mm Mir 1cm 5-2"><span class="hint">Your own label - name it however you like.</span></div>'+
      '<div class="pp-r2"><div class="pp-f"><label>Basis</label><select id="pp-pm-basis"><option value="per_sqm">Per m2</option><option value="per_linear_meter">Per linear meter</option></select></div>'+
      '<div class="pp-f"><label>Base rate (JD)</label><input id="pp-pm-rate" type="number" step="0.01" placeholder="0"></div></div>'+
      '<div class="pp-f"><label>Minimum per piece (JD)</label><input id="pp-pm-min" type="number" step="0.01" placeholder="0"><span class="hint">Charged when a piece is too small to reach this on rate alone.</span></div>'+
      '</div><div class="pp-mf"><button class="pp-btn" id="pp-pm-x">Cancel</button><button class="pp-btn pri" id="pp-pm-s">Create profile</button></div></div></div>'+
     '<div class="pp-mbg" id="pp-cmodal"><div class="pp-mdl"><h3 id="pp-cmt">New category</h3><div class="pp-mb">'+
      '<div class="pp-f"><label>Label</label><input id="pp-cm-label" placeholder="e.g. Unique Cut-out"></div>'+
      '<div class="pp-f"><label>Code (optional)</label><input id="pp-cm-code" placeholder="e.g. UNIQUE_CUTOUT"></div>'+
      '<div class="pp-f"><label>Description</label><input id="pp-cm-desc" placeholder="When to use this charge"></div>'+
      '</div><div class="pp-mf"><button class="pp-btn" id="pp-cm-x">Cancel</button><button class="pp-btn pri" id="pp-cm-s">Create category</button></div></div></div>';
    document.body.appendChild(w);
    document.getElementById('pp-pm-x').onclick=closeProfile;
    document.getElementById('pp-pm-s').onclick=saveProfile;
    document.getElementById('pp-cm-x').onclick=closeCat;
    document.getElementById('pp-cm-s').onclick=saveCat;
    document.querySelectorAll('.pp-mbg').forEach(function(m){m.addEventListener('click',function(e){if(e.target===m)m.classList.remove('on');});});
  }

  /* ---- api + helpers ---- */
  async function api(method,path,body){
    var r=await fetch(API+path,{method:method,headers:{'Authorization':'Bearer '+tok(),'Content-Type':'application/json','Accept':'application/json'},body:body?JSON.stringify(body):undefined});
    if(r.status===401) throw new Error('Session expired - sign in again.');
    var j=await r.json().catch(function(){return{};});
    if(!r.ok) throw new Error(j.error||('HTTP '+r.status));
    return j;
  }
  function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
  function toast(m,e){ if(window.showToast){showToast(m,e?'err':'ok');return;} console.log(m); }

  /* ---- render ---- */
  async function renderPricing(){
    injectStyle(); injectNav(); injectPanel(); wrapSP();
    if(loaded) return; loaded=true;
    try{ META=await api('GET','/meta'); }catch(e){ toast(e.message,true); loaded=false; return; }
    await loadProfiles(); await loadProducts(); await loadCats();
  }
  async function loadProfiles(){
    try{ PROFILES=await api('GET','/profiles'); }catch(e){ toast(e.message,true); return; }
    var tb=document.getElementById('pp-profrows'); if(!tb)return;
    if(!PROFILES.length){ tb.innerHTML='<tr><td colspan="7" class="pp-empty">No profiles yet.</td></tr>'; return; }
    tb.innerHTML='';
    PROFILES.forEach(function(p){
      var tr=document.createElement('tr'); tr.className='r';
      tr.innerHTML='<td><span class="pp-name">'+esc(p.name)+'</span>'+(p.active?'':' <span class="pp-pill am">inactive</span>')+'</td>'+
        '<td><span class="pp-pill g">'+(p.basis==='per_linear_meter'?'per LM':'per m2')+'</span></td>'+
        '<td style="text-align:right"><input class="pp-inp" value="'+p.base_rate+'" data-f="base_rate" data-id="'+p.id+'"></td>'+
        '<td style="text-align:right"><input class="pp-inp" value="'+p.min_per_piece+'" data-f="min_per_piece" data-id="'+p.id+'"></td>'+
        '<td><a href="#" style="color:var(--a)" data-rules="'+p.id+'">'+p.rule_count+' rule'+(p.rule_count==1?'':'s')+' &#9662;</a></td>'+
        '<td>'+(p.default_count?'<span class="pp-pill">'+p.default_count+' product'+(p.default_count==1?'':'s')+'</span>':'<span class="pp-mut">-</span>')+'</td>'+
        '<td><div class="pp-act"><button class="pp-btn gh sm" data-edit="'+p.id+'">Edit</button>'+
        '<button class="pp-btn gh sm dn" data-del="'+p.id+'" data-defs="'+p.default_count+'">Delete</button></div></td>';
      tb.appendChild(tr);
    });
    tb.querySelectorAll('.pp-inp').forEach(function(inp){
      inp.addEventListener('input',function(){inp.classList.add('dirty');});
      inp.addEventListener('blur',function(){saveCell(inp);});
      inp.addEventListener('keydown',function(e){if(e.key==='Enter')inp.blur();});
    });
    tb.querySelectorAll('[data-rules]').forEach(function(a){a.onclick=function(e){e.preventDefault();toggleRules(+a.dataset.rules,a);};});
    tb.querySelectorAll('[data-edit]').forEach(function(b){b.onclick=function(){openProfile(+b.dataset.edit);};});
    tb.querySelectorAll('[data-del]').forEach(function(b){b.onclick=function(){delProfile(+b.dataset.del,+b.dataset.defs);};});
  }
  async function saveCell(inp){
    if(!inp.classList.contains('dirty'))return;
    try{ var b={}; b[inp.dataset.f]=inp.value; await api('PUT','/profiles/'+inp.dataset.id,b); inp.classList.remove('dirty'); toast('Saved'); }
    catch(e){ toast(e.message,true); }
  }
  var PMID=null;
  function openProfile(id){ PMID=id||null; var p=id?PROFILES.find(function(x){return x.id===id;}):null;
    document.getElementById('pp-pmt').textContent=p?'Edit profile':'New profile';
    document.getElementById('pp-pm-s').textContent=p?'Save changes':'Create profile';
    document.getElementById('pp-pm-name').value=p?p.name:''; document.getElementById('pp-pm-basis').value=p?p.basis:'per_sqm';
    document.getElementById('pp-pm-rate').value=p?p.base_rate:''; document.getElementById('pp-pm-min').value=p?p.min_per_piece:'';
    document.getElementById('pp-pmodal').classList.add('on'); document.getElementById('pp-pm-name').focus(); }
  function closeProfile(){document.getElementById('pp-pmodal').classList.remove('on');}
  async function saveProfile(){
    var b={name:document.getElementById('pp-pm-name').value.trim(),basis:document.getElementById('pp-pm-basis').value,
      base_rate:document.getElementById('pp-pm-rate').value||0,min_per_piece:document.getElementById('pp-pm-min').value||0};
    if(!b.name){toast('Name is required',true);return;}
    try{ await api(PMID?'PUT':'POST',PMID?'/profiles/'+PMID:'/profiles',b); closeProfile(); toast(PMID?'Profile saved':'Profile created'); loadProfiles(); }
    catch(e){ toast(e.message,true); }
  }
  async function delProfile(id,defs){
    var q=''; if(defs){ if(!confirm('This profile is the default on '+defs+' product(s). Delete and clear those defaults?'))return; q='?force=1'; }
    else if(!confirm('Delete this profile and its rules?'))return;
    try{ await api('DELETE','/profiles/'+id+q); toast('Profile deleted'); loadProfiles(); loadProducts(); }catch(e){ toast(e.message,true); }
  }

  /* ---- rules ---- */
  async function toggleRules(pid,link){
    var tr=link.closest('tr'); var nx=tr.nextElementSibling;
    if(nx&&nx.classList.contains('pp-rules')){nx.remove();return;}
    var p; try{ p=await api('GET','/profiles/'+pid); }catch(e){ toast(e.message,true); return; }
    var condOpts=META.condition_types.map(function(c){return '<option value="'+c+'">'+c.replace('_gt','')+' &gt;</option>';}).join('');
    var actOpts=META.action_types.map(function(a){return '<option value="'+a+'">'+a.replace('_',' ')+'</option>';}).join('');
    var dr=document.createElement('tr'); dr.className='pp-rules';
    var html='<td colspan="7"><div class="in"><h4>Rules - applied on top of base; all matching rules stack</h4><div id="pp-rl-'+pid+'">';
    if(!p.rules.length) html+='<div class="pp-mut" style="padding:3px 0">No rules. Add one below - e.g. area &gt; 5 &rarr; +20%.</div>';
    p.rules.forEach(function(r){html+=ruleRow(r);});
    html+='</div><div class="pp-rr" style="margin-top:8px"><span class="kw">IF</span>'+
      '<select class="pp-sel" id="pp-nc-'+pid+'">'+condOpts+'</select><input class="pp-mini" id="pp-nv-'+pid+'" placeholder="value">'+
      '<span class="kw">THEN</span><select class="pp-sel" id="pp-na-'+pid+'">'+actOpts+'</select>'+
      '<input class="pp-mini" id="pp-nav-'+pid+'" placeholder="amount"><button class="pp-btn pri sm" data-addrule="'+pid+'">Add rule</button>'+
      '</div></div></td>';
    dr.innerHTML=html; tr.after(dr);
    dr.querySelector('[data-addrule]').onclick=function(){addRule(pid);};
    dr.querySelectorAll('[data-delrule]').forEach(function(b){b.onclick=function(){delRule(+b.dataset.delrule,b);};});
  }
  function ruleRow(r){
    return '<div class="pp-rr" data-rule="'+r.id+'"><span class="kw">IF</span><b>'+r.condition_type.replace('_gt','')+' &gt; '+r.condition_value+'</b>'+
      '<span class="kw">THEN</span><b>'+r.action_type.replace('_',' ')+' '+r.action_value+(r.action_type==='pct_uplift'?'%':'')+'</b>'+
      (r.notes?'<span class="pp-mut">- '+esc(r.notes)+'</span>':'')+'<span style="flex:1"></span>'+
      '<button class="pp-btn gh sm dn" data-delrule="'+r.id+'">Remove</button></div>';
  }
  async function addRule(pid){
    var b={condition_type:document.getElementById('pp-nc-'+pid).value,condition_value:document.getElementById('pp-nv-'+pid).value||0,
      action_type:document.getElementById('pp-na-'+pid).value,action_value:document.getElementById('pp-nav-'+pid).value||0};
    try{ var r=await api('POST','/profiles/'+pid+'/rules',b); var cont=document.getElementById('pp-rl-'+pid);
      var m=cont.querySelector('.pp-mut'); if(m)m.remove();
      cont.insertAdjacentHTML('beforeend',ruleRow(r));
      var nr=cont.lastElementChild.querySelector('[data-delrule]'); if(nr)nr.onclick=function(){delRule(r.id,nr);};
      document.getElementById('pp-nv-'+pid).value=''; document.getElementById('pp-nav-'+pid).value='';
      toast('Rule added'); loadProfiles(); }
    catch(e){ toast(e.message,true); }
  }
  async function delRule(id,btn){ try{ await api('DELETE','/rules/'+id); btn.closest('.pp-rr').remove(); toast('Rule removed'); loadProfiles(); }catch(e){ toast(e.message,true); } }

  /* ---- products ---- */
  async function loadProducts(){
    var rows; try{ rows=await api('GET','/products'); }catch(e){ toast(e.message,true); return; }
    var opts='<option value="">- none -</option>'+PROFILES.map(function(p){return '<option value="'+p.id+'">'+esc(p.name)+'</option>';}).join('');
    var tb=document.getElementById('pp-prodrows'); if(!tb)return; tb.innerHTML='';
    rows.forEach(function(r){
      var tr=document.createElement('tr'); tr.className='r';
      tr.innerHTML='<td><span class="pp-name" dir="auto">'+(esc(r.label)||'<span class=pp-mut>(no label)</span>')+'</span></td>'+
        '<td class="pp-mut">'+(r.legacy_fp_id==null?'-':r.legacy_fp_id)+'</td>'+
        '<td><select class="pp-sel" data-pid="'+r.product_id+'">'+opts+'</select></td>';
      var sel=tr.querySelector('select'); sel.value=r.default_profile_id||'';
      sel.onchange=function(){setDefault(r.product_id,sel.value);};
      tb.appendChild(tr);
    });
  }
  async function setDefault(pid,profileId){ try{ await api('PUT','/products/'+pid+'/default',{profile_id:profileId||null}); toast('Default set'); loadProfiles(); }catch(e){ toast(e.message,true); } }

  /* ---- categories ---- */
  async function loadCats(){
    try{ CATS=await api('GET','/categories'); }catch(e){ toast(e.message,true); return; }
    var tb=document.getElementById('pp-catrows'); if(!tb)return;
    if(!CATS.length){ tb.innerHTML='<tr><td colspan="4" class="pp-empty">No categories yet.</td></tr>'; return; }
    tb.innerHTML='';
    CATS.forEach(function(c){
      var tr=document.createElement('tr'); tr.className='r';
      tr.innerHTML='<td class="pp-name">'+esc(c.label)+'</td><td class="pp-mut">'+(esc(c.code)||'-')+'</td>'+
        '<td class="pp-mut">'+(esc(c.description)||'-')+'</td>'+
        '<td><div class="pp-act"><button class="pp-btn gh sm" data-cedit="'+c.id+'">Edit</button>'+
        '<button class="pp-btn gh sm dn" data-cdel="'+c.id+'">Delete</button></div></td>';
      tb.appendChild(tr);
    });
    tb.querySelectorAll('[data-cedit]').forEach(function(b){b.onclick=function(){openCat(+b.dataset.cedit);};});
    tb.querySelectorAll('[data-cdel]').forEach(function(b){b.onclick=function(){delCat(+b.dataset.cdel);};});
  }
  var CMID=null;
  function openCat(id){ CMID=id||null; var c=id?CATS.find(function(x){return x.id===id;}):null;
    document.getElementById('pp-cmt').textContent=c?'Edit category':'New category';
    document.getElementById('pp-cm-s').textContent=c?'Save changes':'Create category';
    document.getElementById('pp-cm-label').value=c?c.label:''; document.getElementById('pp-cm-code').value=c?(c.code||''):'';
    document.getElementById('pp-cm-desc').value=c?(c.description||''):'';
    document.getElementById('pp-cmodal').classList.add('on'); document.getElementById('pp-cm-label').focus(); }
  function closeCat(){document.getElementById('pp-cmodal').classList.remove('on');}
  async function saveCat(){
    var b={label:document.getElementById('pp-cm-label').value.trim(),code:document.getElementById('pp-cm-code').value.trim(),description:document.getElementById('pp-cm-desc').value.trim()};
    if(!b.label){toast('Label is required',true);return;}
    try{ await api(CMID?'PUT':'POST',CMID?'/categories/'+CMID:'/categories',b); closeCat(); toast(CMID?'Category saved':'Category created'); loadCats(); }
    catch(e){ toast(e.message,true); }
  }
  async function delCat(id){ if(!confirm('Delete this category?'))return; try{ await api('DELETE','/categories/'+id); toast('Category deleted'); loadCats(); }catch(e){ toast(e.message,true); } }

  /* ---- boot: inject as soon as the portal nav exists ---- */
  function init(){ try{ injectStyle(); injectNav(); injectPanel(); wrapSP(); }catch(e){ console.warn('pricing-ui init',e); } }
  if(document.readyState!=='loading') init(); else document.addEventListener('DOMContentLoaded',init);
  var tries=0; var iv=setInterval(function(){ init();
    if(document.getElementById('nt-pricing')&&document.getElementById('pg-pricing')&&window.SP&&window.SP.__pp){ clearInterval(iv); }
    if(++tries>60) clearInterval(iv);
  },500);
})();

'@
$uiPath = Join-Path $pub 'pricing-ui.js'
if (Test-Path $uiPath) { Copy-Item $uiPath (Join-Path $bk "pricing-ui.js.$ts.bak") }
Set-Content -Path $uiPath -Value $uijs -Encoding ascii
& node --check $uiPath
if ($LASTEXITCODE -ne 0) { Write-Host 'ABORT: pricing-ui.js failed syntax check.'; exit 1 }
Write-Host ('Wrote ' + $uiPath + '  (' + (Get-Item $uiPath).Length + ' bytes, syntax OK)')

$gf = Join-Path $pub 'glassfab.html'
Copy-Item $gf (Join-Path $bk "glassfab.html.$ts.bak")
$content = [System.IO.File]::ReadAllText($gf)
if ($content -match 'pricing-ui\.js') {
  Write-Host 'glassfab.html already includes pricing-ui.js (idempotent skip)'
} else {
  $tag = '<script src="/pricing-ui.js"></script>'
  $idx = $content.LastIndexOf('</body>')
  if ($idx -lt 0) { Write-Host 'ABORT: no </body> found.'; exit 1 }
  $content = $content.Substring(0,$idx) + $tag + "`r`n" + $content.Substring($idx)
  [System.IO.File]::WriteAllText($gf, $content, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host 'Inserted script tag into glassfab.html'
}
Write-Host ''
Write-Host 'Done. Hard-refresh the portal (Ctrl+F5).'
