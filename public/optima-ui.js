/* optima-ui.js — Optima Export UI, Phase 2 foundations.
 *
 * Injected module (the pattern used by pricing-ui.js): one <script> line in
 * glassfab.html rather than edits inside a 26k-line file. Self-contained and
 * defensive — if an anchor is missing it no-ops rather than breaking the portal.
 *
 * Adds:
 *   1. Settings -> Optima : the ERP-thickness -> Edit-Way material code map.
 *   2. Customer modal     : the Optima Name field.
 *
 * Spec: C:\AGI\docs\optima-export-spec.md  (§6 data model, §7 user flow)
 * Decision 11: no allowance anywhere in this flow. Do not add a compensation
 * field here — the operator enters it per side in Edit-Way.
 */
(function () {
  if (window.__optimaUI) return; window.__optimaUI = true;

  var API = '/api/optima';
  // Codes verified to exist in this Edit-Way installation (spec §2). Kept in step
  // with EDITWAY_CODES in routes/optima.js — an unknown code leaves Edit-Way's
  // material prompt blank and any manual pick is accepted silently.
  var EDITWAY_CODES = ['3', '4', '5', '6', '8', '10', '12', '15', '19'];

  function tok() {
    try { return (window.AGI && AGI.getToken) ? AGI.getToken() : localStorage.getItem('agi_token'); }
    catch (e) { return localStorage.getItem('agi_token'); }
  }
  function api(path, opts) {
    opts = opts || {};
    return fetch(API + path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok() },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }
  function lang() { try { if (window.applyLang) applyLang(); } catch (e) {} }

  // OM(id) does: el.style.display=''  then  classList.add('on'), so that
  // .mbg.on{display:flex} can beat the inline display:none in the markup.
  // CM(id) only removes the class and leaves style.display as ''. So
  // style.display CANNOT distinguish open from closed — the class is the truth.
  function isCustModalOpen() {
    var m = document.getElementById('m-cust');
    return !!(m && m.classList.contains('on'));
  }
  // The portal declares `let customers = []`, and top-level `let` is NOT a window
  // property, so window.customers is undefined. Read customers from the API.
  var CUST_CACHE = null;
  function loadCustomers() {
    return api('/customers').then(function (rows) { CUST_CACHE = rows || []; return CUST_CACHE; });
  }
  function showFieldError(msg) {
    var err = document.getElementById('c-optima-err');
    if (err) { err.textContent = msg || ''; err.classList.toggle('ox-ok', false); }
    if (msg) toast(msg);
  }
  function confirmSafe(msg) { try { return window._confirm ? window._confirm(msg) : confirm(msg); } catch (e) { return false; } }
  function toast(m) { try { if (window.showToast) showToast(m); else console.log(m); } catch (e) {} }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  /* ───────────────────────── styles (scoped .ox-*) ───────────────────────── */
  var css = ''
    + '.ox-wrap{max-width:900px}'
    + '.ox-note{font-size:.72rem;color:var(--mu);line-height:1.6;margin:0 0 14px}'
    + '.ox-tbl{width:100%;border-collapse:collapse;font-size:.82rem}'
    + '.ox-tbl th{font-size:.64rem;letter-spacing:.07em;text-transform:uppercase;color:var(--mu);font-weight:700;'
    + 'text-align:left;padding:9px 12px;border-bottom:1px solid var(--border);background:var(--surf)}'
    + '.ox-tbl td{padding:8px 12px;border-bottom:1px solid rgba(27,58,90,.5);vertical-align:middle}'
    + '.ox-tbl tr:last-child td{border-bottom:0}'
    + '.ox-th{font-family:"DM Mono",monospace;font-weight:700;color:var(--a)}'
    + '.ox-sel,.ox-num{padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--surf);'
    + 'color:var(--tx);font-size:.8rem;font-family:"DM Mono",monospace}'
    + '.ox-num{width:90px;text-align:right}'
    + '.ox-sel:focus,.ox-num:focus{outline:none;border-color:var(--a)}'
    + '.ox-remap{display:inline-block;margin-left:8px;padding:2px 7px;border-radius:999px;font-size:.62rem;font-weight:700;'
    + 'background:rgba(255,210,63,.14);color:var(--a4)}'
    + '.ox-err{color:var(--a2);font-size:.7rem;margin-top:4px;min-height:1em}'
    + '.ox-ok{color:var(--a3)}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  /* ─────────────────── 1. Settings -> Optima material map ────────────────── */

  function injectSettingsTab() {
    if (document.getElementById('stab-optima')) return true;      // already injected
    var pg = document.getElementById('pg-settings');
    if (!pg) return false;
    var bar = pg.querySelector('.rtabs');
    if (!bar) return false;

    var btn = document.createElement('button');
    btn.className = 'rtab';
    btn.setAttribute('onclick', "showSettingsTab('optima')");
    btn.innerHTML = '&#9636; <span data-i18n="Optima">Optima</span>';
    bar.appendChild(btn);

    // class "stab" matters: showSettingsTab hides by that class, and a panel
    // injected without it stays visible under every other tab (landmines §11).
    var pane = document.createElement('div');
    pane.className = 'stab';
    pane.id = 'stab-optima';
    pane.style.display = 'none';
    pane.innerHTML = '<div class="card ox-wrap"><div class="ch">'
      + '<span class="ct" style="color:var(--a4)">&#9636; <span data-i18n="Optima Material Map">Optima Material Map</span></span>'
      + '</div><div class="cb" id="ox-map-body"></div></div>';
    pg.appendChild(pane);
    return true;
  }

  function codeOptions(sel) {
    return EDITWAY_CODES.map(function (c) {
      return '<option value="' + c + '"' + (String(sel) === c ? ' selected' : '') + '>' + c + '</option>';
    }).join('');
  }

  function renderMap() {
    var body = document.getElementById('ox-map-body');
    if (!body) return;
    body.innerHTML = '<div class="ox-note" data-i18n="Loading">Loading…</div>';
    api('/material-map').then(function (rows) {
      var html = '<p class="ox-note">'
        + '<span data-i18n="ERP thickness to Edit-Way material code">ERP thickness to Edit-Way material code</span>. '
        + '<span data-i18n="A thickness with no row cannot be batched">A thickness with no row cannot be batched</span>.'
        + '</p><table class="ox-tbl"><thead><tr>'
        + '<th data-i18n="Thickness">Thickness</th>'
        + '<th data-i18n="Edit-Way Code">Edit-Way Code</th>'
        + '<th data-i18n="Active">Active</th>'
        + '<th data-i18n="Notes">Notes</th>'
        + '<th></th></tr></thead><tbody>';

      (rows || []).forEach(function (r) {
        var remap = String(r.thickness) !== String(r.editway_code);
        html += '<tr>'
          + '<td class="ox-th">' + esc(r.thickness) + ' mm'
          + (remap ? '<span class="ox-remap" title="Cut on a different Edit-Way material setting">&#8594; ' + esc(r.editway_code) + '</span>' : '')
          + '</td>'
          + '<td><select class="ox-sel" data-t="' + esc(r.thickness) + '">' + codeOptions(r.editway_code) + '</select></td>'
          + '<td><input type="checkbox" class="ox-act" data-t="' + esc(r.thickness) + '"' + (+r.active ? ' checked' : '') + ' style="width:16px;height:16px;padding:0"></td>'
          + '<td style="font-size:.72rem;color:var(--mu)">' + esc(r.notes || '') + '</td>'
          + '<td style="text-align:right">'
          + '<button class="btn ba bsm ox-save" data-t="' + esc(r.thickness) + '" style="font-size:.62rem" data-i18n="Save">Save</button> '
          + '<button class="btn bd bsm ox-del" data-t="' + esc(r.thickness) + '" style="font-size:.62rem" data-i18n="Delete">Delete</button>'
          + '</td></tr>';
      });
      if (!(rows || []).length) {
        html += '<tr><td colspan="5" style="color:var(--mu);padding:14px" data-i18n="No material map rows">No material map rows</td></tr>';
      }
      html += '</tbody></table>'
        + '<div style="display:flex;gap:8px;align-items:flex-end;margin-top:14px;flex-wrap:wrap">'
        + '<div><label class="lbl" data-i18n="Thickness">Thickness</label>'
        + '<input type="number" step="0.5" min="0.5" class="ox-num" id="ox-new-t" placeholder="5.5"></div>'
        + '<div><label class="lbl" data-i18n="Edit-Way Code">Edit-Way Code</label>'
        + '<select class="ox-sel" id="ox-new-c">' + codeOptions('6') + '</select></div>'
        + '<button class="btn bp bsm" id="ox-add" data-i18n="Add">Add</button>'
        + '</div><div class="ox-err" id="ox-map-err"></div>';

      body.innerHTML = html;
      lang();
      wireMap();
    }).catch(function (e) {
      body.innerHTML = '<div class="ox-err">' + esc(e.message) + '</div>';
    });
  }

  function saveRow(thickness, code, active, notes) {
    var err = document.getElementById('ox-map-err');
    if (err) { err.textContent = ''; err.classList.remove('ox-ok'); }
    return api('/material-map', { method: 'POST', body: { thickness: thickness, editway_code: code, active: active, notes: notes } })
      .then(function () { toast('Material map saved'); renderMap(); })
      .catch(function (e) { if (err) err.textContent = e.message; });
  }

  function wireMap() {
    var body = document.getElementById('ox-map-body');
    if (!body) return;
    body.querySelectorAll('.ox-save').forEach(function (b) {
      b.addEventListener('click', function () {
        var t = b.getAttribute('data-t');
        var sel = body.querySelector('.ox-sel[data-t="' + t + '"]');
        var act = body.querySelector('.ox-act[data-t="' + t + '"]');
        saveRow(t, sel ? sel.value : '', act && act.checked ? 1 : 0, '');
      });
    });
    body.querySelectorAll('.ox-del').forEach(function (b) {
      b.addEventListener('click', function () {
        var t = b.getAttribute('data-t');
        if (!confirmSafe('Remove ' + t + 'mm from the Optima material map?\n\n' + t + 'mm glass will no longer be exportable to Optima until a code is set again.')) return;
        api('/material-map/' + encodeURIComponent(t), { method: 'DELETE' })
          .then(function () { toast(t + 'mm removed'); renderMap(); })
          .catch(function (e) { var el = document.getElementById('ox-map-err'); if (el) el.textContent = e.message; });
      });
    });
    var add = document.getElementById('ox-add');
    if (add) add.addEventListener('click', function () {
      var t = document.getElementById('ox-new-t'), c = document.getElementById('ox-new-c');
      if (!t || !t.value) { var el = document.getElementById('ox-map-err'); if (el) el.textContent = 'Enter a thickness'; return; }
      saveRow(Number(t.value), c.value, 1, '');
    });
  }

  // showSettingsTab hides every .stab then shows #stab-<id>; wrap it so our tab
  // renders on demand. A new tab needs its own dispatch entry or it renders empty.
  function hookSettingsTab() {
    if (typeof window.showSettingsTab !== 'function' || window.showSettingsTab.__ox) return false;
    var orig = window.showSettingsTab;
    var wrapped = function (id) {
      var r = orig.apply(this, arguments);
      try {
        if (id === 'optima') {
          var pane = document.getElementById('stab-optima');
          if (pane) pane.style.display = '';
          renderMap();
        }
      } catch (e) { console.warn('[optima-ui] settings tab', e); }
      return r;
    };
    wrapped.__ox = true;
    window.showSettingsTab = wrapped;
    return true;
  }

  /* ──────────────────── 2. Customer modal: Optima Name ───────────────────── */

  function injectCustomerField() {
    if (document.getElementById('c-optima-name')) return true;   // already injected
    var addr = document.getElementById('c-addr');
    if (!addr) return false;                                     // modal not in the DOM yet
    var addrFg = addr.closest ? addr.closest('.fg') : null;
    if (!addrFg || !addrFg.parentNode) return false;

    var row = document.createElement('div');
    row.className = 'frow';
    row.style.gridTemplateColumns = '1fr 1fr';
    row.style.marginBottom = '10px';
    row.innerHTML = '<div class="fg">'
      + '<label class="lbl"><span data-i18n="Optima Name">Optima Name</span> '
      + '<span style="font-size:.58rem;color:var(--mu)" data-i18n="Used for the Optima export only">Used for the Optima export only</span></label>'
      + '<input type="text" id="c-optima-name" maxlength="12" style="text-transform:uppercase" placeholder="REF">'
      + '<div class="ox-err" id="c-optima-err"></div>'
      + '<div style="font-size:.58rem;color:var(--mu)" data-i18n="ASCII only, max 12 characters, no spaces">ASCII only, max 12 characters, no spaces</div>'
      + '</div><div class="fg"></div>';
    addrFg.parentNode.insertBefore(row, addrFg);

    var inp = document.getElementById('c-optima-name');
    inp.addEventListener('input', function () {
      var v = inp.value.toUpperCase();
      if (v !== inp.value) inp.value = v;
      showFieldError(v && !/^[A-Z0-9-]{1,12}$/.test(v)
        ? 'Optima name: only A-Z, 0-9 and hyphen, no spaces' : '');
    });
    // The modal has no <form>, so Enter is otherwise a complete no-op: no request,
    // nothing in the console. Make it save, like clicking the button.
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        try { if (typeof window.saveCust === 'function') window.saveCust(); } catch (er) {}
      }
    });
    lang();
    return true;
  }

  // Reset on open AND always write on restore — never conditionally, or values
  // leak between records (landmines §11, hit twice in other modals).
  function hookOpenCustomer() {
    if (typeof window.openCustModal !== 'function' || window.openCustModal.__ox) return false;
    var orig = window.openCustModal;
    var wrapped = function (id) {
      var r = orig.apply(this, arguments);
      try {
        injectCustomerField();
        var inp = document.getElementById('c-optima-name');
        showFieldError('');
        if (inp) {
          // Reset on open, unconditionally, before the async fill — a field left
          // holding the previous record's value is how values leak between records.
          inp.value = '';
          inp.placeholder = '';
          if (id) {
            var fill = function (rows) {
              if (!isCustModalOpen()) return;                  // modal closed meanwhile
              var c = (rows || []).find(function (x) { return x.id === id; });
              inp.value = (c && c.optima_name) || '';          // always write
              // The suggestion is customers.code, shown as a PLACEHOLDER so it is
              // never saved unless confirmed (decision 4).
              inp.placeholder = (c && (c.suggested_optima_name || c.code)) || '';
            };
            if (CUST_CACHE) fill(CUST_CACHE);
            loadCustomers().then(fill).catch(function (e) {
              showFieldError('Could not load the current Optima name: ' + e.message);
            });
          }
        }
      } catch (e) { console.warn('[optima-ui] customer modal', e); }
      return r;
    };
    wrapped.__ox = true;
    window.openCustModal = wrapped;
    return true;
  }

  // apiSaveCustomer is the single funnel for customer writes. Only contribute the
  // field when the customer modal is actually open, so no other caller picks up a
  // stale DOM value. An absent key means "preserve" on the server.
  function hookSaveCustomer() {
    if (typeof window.apiSaveCustomer !== 'function' || window.apiSaveCustomer.__ox) return false;
    var orig = window.apiSaveCustomer;
    var wrapped = function (data, id) {
      try {
        var inp = document.getElementById('c-optima-name');
        if (isCustModalOpen() && inp && data && typeof data === 'object') {
          data.optima_name = inp.value.trim().toUpperCase();   // '' clears it
          CUST_CACHE = null;                                   // refetch next open
        }
      } catch (e) { console.warn('[optima-ui] save hook', e); }
      return orig.call(this, data, id);
    };
    wrapped.__ox = true;
    window.apiSaveCustomer = wrapped;
    return true;
  }

  // Wrap saveCust so an invalid Optima name BLOCKS with a visible message instead
  // of being dropped. Also surface the portal's own silent early-return: saveCust
  // bails with nothing but a red border if Code, Name or Phone is empty — no
  // request, no alert, no console output.
  function hookSaveCust() {
    if (typeof window.saveCust !== 'function' || window.saveCust.__ox) return false;
    var orig = window.saveCust;
    var wrapped = function () {
      try {
        if (isCustModalOpen()) {
          var inp = document.getElementById('c-optima-name');
          if (inp) {
            var v = inp.value.trim().toUpperCase();
            if (v && !/^[A-Z0-9-]{1,12}$/.test(v)) {
              inp.classList.add('err');
              showFieldError('Cannot save: Optima name "' + v + '" must be 1-12 characters, A-Z, 0-9 or hyphen only (no spaces).');
              inp.focus();
              return;                                          // block, loudly
            }
            // Clear any previous message explicitly. Typing fires the input
            // handler, but a value set any other way does not — and a stale
            // "Cannot save" next to a field that just saved is its own bug.
            inp.classList.remove('err');
            showFieldError('');
          }
          // Mirror the portal's required-field check for MESSAGING only; the
          // original still does the actual blocking, so there is one gate.
          var missing = ['c-code', 'c-name', 'c-phone'].filter(function (fid) {
            var el = document.getElementById(fid);
            return el && !el.value.trim();
          });
          if (missing.length) {
            var names = { 'c-code': 'Customer Code', 'c-name': 'Full Name', 'c-phone': 'Phone' };
            showFieldError('Cannot save: ' + missing.map(function (m) { return names[m]; }).join(', ') + ' required.');
          }
        }
      } catch (e) { console.warn('[optima-ui] saveCust hook', e); }
      return orig.apply(this, arguments);
    };
    wrapped.__ox = true;
    window.saveCust = wrapped;
    return true;
  }

  /* ─────────────────────────────── bootstrap ─────────────────────────────── */
  // The portal builds its globals asynchronously, so poll briefly rather than
  // racing INIT. Everything is guarded and idempotent.
  var tries = 0;
  var done = { tab: false, hook: false, field: false, apiSave: false, saveCust: false, openCust: false };
  var timer = setInterval(function () {
    tries++;
    try {
      if (!done.tab)      done.tab      = injectSettingsTab();
      if (!done.hook)     done.hook     = hookSettingsTab();
      if (!done.field)    done.field    = injectCustomerField();
      if (!done.apiSave)  done.apiSave  = hookSaveCustomer();
      if (!done.saveCust) done.saveCust = hookSaveCust();
      if (!done.openCust) done.openCust = hookOpenCustomer();
    } catch (e) { console.warn('[optima-ui] bootstrap', e); }
    var all = done.tab && done.hook && done.field && done.apiSave && done.saveCust && done.openCust;
    if (all || tries > 60) {
      clearInterval(timer);
      // Every hook is named so a half-applied module is visible, not guessed at.
      console.log('[optima-ui] ' + (all ? 'ready' : 'INCOMPLETE') + ' ' + JSON.stringify(done) + ' tries=' + tries);
      if (!all) console.warn('[optima-ui] some hooks did not apply — the Optima Name field may not save');
    }
  }, 250);
})();
