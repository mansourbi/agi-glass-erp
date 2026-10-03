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

  // Resolve via AGI.getToken(), never by reading the key directly (modules.md §15),
  // and fall back through AGI's guarded storage rather than raw localStorage, which
  // throws when Edge Tracking Prevention blocks it (Phase 2.5).
  function tok() {
    try {
      if (window.AGI && AGI.getToken) {
        var t = AGI.getToken();
        if (t) return t;
        if (AGI.safeGet) return AGI.safeGet('agi_token');
      }
    } catch (e) {}
    return null;
  }
  // Spec §4: every write goes through AGI.api(), never a hand-built Bearer header.
  // That buys the 401 path, the guarded storage and the error shape for free, and
  // keeps this file out of the 103-call-site problem recorded in landmines.md §13.
  function api(path, opts) {
    opts = opts || {};
    var o = { method: opts.method || 'GET' };
    if (opts.body) o.body = JSON.stringify(opts.body);
    if (window.AGI && AGI.api) return AGI.api(API + path, o);
    // Fallback only for a page where agi-api.js somehow did not load.
    return fetch(API + path, {
      method: o.method,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok() },
      body: o.body
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

  /* ──────────────────── 3. Cutting -> Optima Batches view ────────────────── */
  // Lives inside #pg-cutting beside cut-view-files and cut-view-ws rather than as a
  // new top-level page: batches ARE cutting, and a new page would need its own SP()
  // dispatch entry or it renders empty (landmines.md §11).

  var BATCH = { groups: [], selected: null, detail: null };

  function injectBatchView() {
    if (document.getElementById('cut-view-batches')) return true;
    var pg = document.getElementById('pg-cutting');
    var files = document.getElementById('cut-view-files');
    if (!pg || !files) return false;

    var v = document.createElement('div');
    v.id = 'cut-view-batches';
    v.style.display = 'none';
    v.innerHTML = '<div class="ph">'
      + '<div><div class="pt" data-i18n="Optima Cutting Batches">Optima Cutting Batches</div>'
      + '<div class="ps" data-i18n="Send pieces to the Yinrui line via Edit-Way">Send pieces to the Yinrui line via Edit-Way</div></div>'
      + '<div class="acts no-print">'
      + '<button class="btn bg" id="ox-back-files">&#8592; <span data-i18n="All Files">All Files</span></button> '
      + '<button class="btn bp" id="ox-new-batch">+ <span data-i18n="New Batch">New Batch</span></button>'
      + '</div></div><div id="ox-batch-body"></div>';
    pg.appendChild(v);

    // Entry point from the files view, so the two paths sit side by side.
    var acts = files.querySelector('.acts');
    if (acts && !document.getElementById('ox-open-batches')) {
      var b = document.createElement('button');
      b.className = 'btn bs'; b.id = 'ox-open-batches';
      b.innerHTML = '&#9636; <span data-i18n="Optima Batches">Optima Batches</span>';
      b.addEventListener('click', function () { showCutView('batches'); });
      acts.appendChild(b);
    }
    document.getElementById('ox-back-files').addEventListener('click', function () { showCutView('files'); });
    document.getElementById('ox-new-batch').addEventListener('click', function () { renderNewBatch(); });
    lang();
    return true;
  }

  // showCutView only knows 'files' and 'ws'; wrap it for 'batches'.
  function hookCutView() {
    if (typeof window.showCutView !== 'function' || window.showCutView.__ox) return false;
    var orig = window.showCutView;
    var wrapped = function (view) {
      try {
        if (view === 'batches') {
          injectBatchView();
          var f = document.getElementById('cut-view-files'), w = document.getElementById('cut-view-ws'),
              b = document.getElementById('cut-view-batches');
          if (f) f.style.display = 'none';
          if (w) w.style.display = 'none';
          if (b) b.style.display = '';
          renderBatchList();
          return;
        }
        var bb = document.getElementById('cut-view-batches');
        if (bb) bb.style.display = 'none';
      } catch (e) { console.warn('[optima-ui] cut view', e); }
      return orig.apply(this, arguments);
    };
    wrapped.__ox = true;
    window.showCutView = wrapped;
    return true;
  }

  function statusPill(s, kind) {
    var col = { created: 'var(--a)', cut: 'var(--a3)', cancelled: 'var(--a2)',
                pending: 'var(--mu)', delivered: 'var(--a3)', failed: 'var(--a2)' }[s] || 'var(--mu)';
    return '<span class="bge" style="background:rgba(255,255,255,.06);color:' + col + ';border:1px solid ' + col
      + ';font-size:.6rem;padding:2px 6px;border-radius:3px">' + esc(kind === 'd' ? 'delivery: ' + s : s) + '</span>';
  }

  function renderBatchList() {
    var el = document.getElementById('ox-batch-body');
    if (!el) return;
    el.innerHTML = '<div class="ox-note" data-i18n="Loading">Loading…</div>';
    api('/batches').then(function (rows) {
      if (!rows.length) {
        el.innerHTML = '<div class="empty" style="padding:40px 20px"><div class="empty-t" '
          + 'data-i18n="No batches yet. Press New Batch to send pieces to Optima.">'
          + 'No batches yet. Press New Batch to send pieces to Optima.</div></div>';
        lang(); return;
      }
      var h = '<div class="card ox-wrap" style="max-width:none"><div class="cb" style="padding:0">'
        + '<table class="ox-tbl"><thead><tr>'
        + '<th data-i18n="Batch">Batch</th><th data-i18n="Glass">Glass</th>'
        + '<th data-i18n="Orders">Orders</th><th data-i18n="Pieces">Pieces</th>'
        + '<th data-i18n="Status">Status</th><th data-i18n="Delivery">Delivery</th>'
        + '<th data-i18n="Created">Created</th><th></th></tr></thead><tbody>';
      rows.forEach(function (b) {
        h += '<tr><td class="ox-th">' + esc(b.batch_no) + '</td>'
          + '<td>' + esc(b.thickness) + 'mm ' + esc(b.color || '') + ' ' + esc(b.family || '')
          + (String(b.thickness) !== String(b.material_code) ? '<span class="ox-remap">&#8594; ' + esc(b.material_code) + '</span>' : '')
          + '</td>'
          + '<td style="font-size:.72rem">' + esc((b.order_nums || []).join(', ')) + '</td>'
          + '<td>' + esc(b.piece_count) + '</td>'
          + '<td>' + statusPill(b.status) + '</td>'
          + '<td>' + statusPill(b.delivery_status, 'd') + '</td>'
          + '<td style="font-size:.68rem;color:var(--mu)">' + esc(String(b.created_at || '').slice(0, 16)) + '</td>'
          + '<td style="text-align:right"><button class="btn bg bsm ox-open" data-id="' + b.id + '" style="font-size:.62rem" data-i18n="Open">Open</button></td></tr>';
      });
      el.innerHTML = h + '</tbody></table></div></div>';
      el.querySelectorAll('.ox-open').forEach(function (btn) {
        btn.addEventListener('click', function () { renderBatchDetail(btn.getAttribute('data-id')); });
      });
      lang();
    }).catch(function (e) { el.innerHTML = '<div class="ox-err">' + esc(e.message) + '</div>'; });
  }

  function renderNewBatch(preselectOrderId) {
    var el = document.getElementById('ox-batch-body');
    if (!el) return;
    el.innerHTML = '<div class="ox-note" data-i18n="Loading">Loading…</div>';
    api('/eligible').then(function (d) {
      BATCH.groups = d.groups || [];
      if (!BATCH.groups.length) {
        el.innerHTML = '<div class="empty" style="padding:40px 20px"><div class="empty-t" '
          + 'data-i18n="No pieces are waiting for Optima.">No pieces are waiting for Optima.</div>'
          + '<div class="ox-note" style="margin-top:10px">'
          + '<span data-i18n="Batches apply to orders newer than">Batches apply to orders newer than</span> #'
          + esc(d.min_order_id) + '. '
          + '<span data-i18n="A piece already in an ERP optimization stays on that path.">A piece already in an ERP optimization stays on that path.</span>'
          + '</div></div>';
        lang(); return;
      }
      // If we arrived from an order's Cut button, open that order's glass directly.
      if (preselectOrderId) {
        var hit = BATCH.groups.find(function (g) {
          return g.orders.some(function (o) { return +o.order_id === +preselectOrderId; });
        });
        if (hit) return renderGlassPick(hit, preselectOrderId);
      }
      var h = '<div class="card ox-wrap" style="max-width:none"><div class="ch">'
        + '<span class="ct" style="color:var(--a4)" data-i18n="1. Choose the glass">1. Choose the glass</span></div>'
        + '<div class="cb" style="padding:0"><table class="ox-tbl"><thead><tr>'
        + '<th data-i18n="Glass">Glass</th><th data-i18n="Edit-Way Code">Edit-Way Code</th>'
        + '<th data-i18n="Pieces">Pieces</th><th data-i18n="Ready">Ready</th>'
        + '<th data-i18n="Orders">Orders</th><th></th></tr></thead><tbody>';
      BATCH.groups.forEach(function (g, i) {
        var remap = String(g.thickness) !== String(g.material_code);
        h += '<tr><td class="ox-th">' + esc(g.thickness) + 'mm ' + esc(g.color || '') + ' '
          + esc((g.pattern || g.family) || '') + '</td>'
          + '<td>' + (g.material_code ? esc(g.material_code) + (remap ? '<span class="ox-remap">remap</span>' : '')
                      : '<span style="color:var(--a2)" data-i18n="not set up">not set up</span>') + '</td>'
          + '<td>' + g.pieces + '</td>'
          + '<td style="color:' + (g.ready ? 'var(--a3)' : 'var(--a2)') + '">' + g.ready + '</td>'
          + '<td style="font-size:.72rem">' + esc(g.orders.map(function (o) { return o.order_num; }).join(', ')) + '</td>'
          + '<td style="text-align:right"><button class="btn ba bsm ox-pick" data-i="' + i + '" style="font-size:.62rem" data-i18n="Choose">Choose</button></td></tr>';
      });
      el.innerHTML = h + '</tbody></table></div></div>';
      el.querySelectorAll('.ox-pick').forEach(function (b) {
        b.addEventListener('click', function () { renderGlassPick(BATCH.groups[+b.getAttribute('data-i')]); });
      });
      lang();
    }).catch(function (e) { el.innerHTML = '<div class="ox-err">' + esc(e.message) + '</div>'; });
  }

  function renderGlassPick(g, preselectOrderId) {
    BATCH.selected = g;
    var el = document.getElementById('ox-batch-body');
    var remap = String(g.thickness) !== String(g.material_code);
    var h = '<div class="card ox-wrap" style="max-width:none"><div class="ch">'
      + '<span class="ct" style="color:var(--a4)" data-i18n="2. Tick the orders">2. Tick the orders</span>'
      + '<button class="btn bg bsm" id="ox-pick-back" style="font-size:.62rem" data-i18n="Change glass">Change glass</button>'
      + '</div><div class="cb">'
      + '<p class="ox-note"><strong style="color:var(--a)">' + esc(g.thickness) + 'mm ' + esc(g.color || '') + ' '
      + esc((g.pattern || g.family) || '') + '</strong>'
      + (g.material_code ? ' &bull; <span data-i18n="Edit-Way Code">Edit-Way Code</span> <strong>' + esc(g.material_code) + '</strong>' : '')
      + (remap ? ' <span class="ox-remap" data-i18n="cut on a different material setting">cut on a different material setting</span>' : '')
      + '</p><table class="ox-tbl"><thead><tr><th></th>'
      + '<th data-i18n="Order">Order</th><th data-i18n="Customer">Customer</th>'
      + '<th data-i18n="Pieces">Pieces</th><th data-i18n="Optima Name">Optima Name</th>'
      + '<th data-i18n="Status">Status</th></tr></thead><tbody>';
    g.orders.forEach(function (o) {
      var blocked = o.blockers.length > 0;
      h += '<tr style="' + (blocked ? 'opacity:.55' : '') + '">'
        + '<td><input type="checkbox" class="ox-ord" value="' + o.order_id + '"' + (blocked ? ' disabled' : '')
        + ((!blocked && (!preselectOrderId || +preselectOrderId === +o.order_id)) ? ' checked' : '')
        + ' style="width:16px;height:16px;padding:0"></td>'
        + '<td class="ox-th">' + esc(o.order_num) + '</td>'
        + '<td style="font-size:.72rem">' + esc(o.cust_code) + '</td>'
        + '<td>' + o.pieces.length + '<div style="font-size:.6rem;color:var(--mu)">'
        + esc(o.pieces.slice(0, 4).map(function (p) { return p.w + '×' + p.h; }).join(', '))
        + (o.pieces.length > 4 ? ' +' + (o.pieces.length - 4) : '') + '</div></td>'
        + '<td style="font-size:.72rem">' + (o.optima_name ? esc(o.optima_name)
            : '<span style="color:var(--a2)" data-i18n="missing">missing</span>') + '</td>'
        + '<td style="font-size:.66rem">' + (blocked
            ? '<span style="color:var(--a2)">' + o.blockers.map(esc).join('<br>') + '</span>'
            : '<span style="color:var(--a3)" data-i18n="Ready">Ready</span>') + '</td></tr>';
    });
    h += '</tbody></table>'
      + '<div style="display:flex;gap:10px;align-items:center;margin-top:14px">'
      + '<button class="btn bp" id="ox-create" data-i18n="Create batch">Create batch</button>'
      + '<span class="ox-note" style="margin:0" data-i18n="Labels print from the batch once created.">Labels print from the batch once created.</span>'
      + '</div><div class="ox-err" id="ox-create-err"></div></div></div>';
    el.innerHTML = h;
    document.getElementById('ox-pick-back').addEventListener('click', function () { renderNewBatch(); });
    document.getElementById('ox-create').addEventListener('click', createBatch);
    lang();
  }

  function createBatch() {
    var ids = [].slice.call(document.querySelectorAll('.ox-ord:checked')).map(function (c) { return +c.value; });
    var err = document.getElementById('ox-create-err');
    if (err) err.textContent = '';
    if (!ids.length) { if (err) err.textContent = 'Tick at least one order.'; return; }
    var btn = document.getElementById('ox-create');
    if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }
    api('/batches', { method: 'POST', body: { glass_key: BATCH.selected.glass_key, order_ids: ids } })
      .then(function (b) {
        toast('Batch ' + b.batch_no + ' created');
        // Generate the file and attempt delivery straight away, then show the
        // detail. A delivery failure is expected sometimes and must not block.
        return api('/batches/' + b.id + '/file', { method: 'POST' })
          .catch(function () { return null; })
          .then(function () { return api('/batches/' + b.id + '/deliver', { method: 'POST' }).catch(function () { return null; }); })
          .then(function () { renderBatchDetail(b.id); });
      })
      .catch(function (e) {
        if (btn) { btn.disabled = false; btn.textContent = 'Create batch'; }
        if (err) err.textContent = e.message;
        toast(e.message);
      });
  }

  function renderBatchDetail(id) {
    var el = document.getElementById('ox-batch-body');
    if (!el) return;
    el.innerHTML = '<div class="ox-note" data-i18n="Loading">Loading…</div>';
    api('/batches/' + id).then(function (b) {
      BATCH.detail = b;
      var remap = String(b.thickness) !== String(b.material_code);
      var h = '<div class="card ox-wrap" style="max-width:none"><div class="ch">'
        + '<span class="ct" style="color:var(--a4)">&#9636; ' + esc(b.batch_no) + '</span>'
        + '<button class="btn bg bsm" id="ox-det-back" style="font-size:.62rem" data-i18n="All batches">All batches</button>'
        + '</div><div class="cb">'
        + '<p class="ox-note"><strong style="color:var(--a)">' + esc(b.thickness) + 'mm ' + esc(b.color || '') + ' '
        + esc((b.pattern || b.family) || '') + ' ' + esc(b.manufacturer_code || '') + '</strong>'
        + ' &bull; <span data-i18n="Edit-Way Code">Edit-Way Code</span> <strong>' + esc(b.material_code) + '</strong>'
        + (remap ? ' <span class="ox-remap" data-i18n="remap">remap</span>' : '')
        + ' &bull; ' + statusPill(b.status) + ' ' + statusPill(b.delivery_status, 'd')
        + (b.delivery_tries ? ' <span style="font-size:.62rem;color:var(--mu)">' + b.delivery_tries + ' attempt(s)</span>' : '')
        + '</p>'
        + (b.file_name ? '<p class="ox-note" style="font-family:\'DM Mono\',monospace;font-size:.66rem">' + esc(b.file_name) + '</p>' : '')
        + (b.delivery_error ? '<div class="ox-err">' + esc(b.delivery_error) + '</div>' : '')
        + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0">'
        + '<button class="btn bs bsm" id="ox-labels" data-i18n="Print labels">Print labels</button>'
        + '<button class="btn bg bsm" id="ox-download" data-i18n="Download file">Download file</button>'
        + (b.delivery_status !== 'delivered'
            ? '<button class="btn ba bsm" id="ox-retry" data-i18n="Retry delivery">Retry delivery</button>' : '')
        + (b.status === 'created'
            ? '<button class="btn bd bsm" id="ox-cancel" data-i18n="Cancel batch">Cancel batch</button>' : '')
        + '</div>';
      (b.orders || []).forEach(function (o) {
        h += '<div style="margin-top:12px"><div style="font-family:\'DM Mono\',monospace;color:var(--a);font-size:.76rem;margin-bottom:4px">'
          + esc(o.order_num) + ' <span style="color:var(--mu);font-size:.66rem">' + o.pieces.length + ' pcs</span></div>'
          + '<table class="ox-tbl"><thead><tr><th data-i18n="Piece">Piece</th>'
          + '<th data-i18n="Size">Size</th><th data-i18n="Processes">Processes</th>'
          + '<th>NOTE1</th><th>NOTE2</th></tr></thead><tbody>';
        o.pieces.forEach(function (p) {
          h += '<tr><td class="ox-th">' + esc(p.piece_uid) + '</td>'
            + '<td>' + esc(p.w) + ' × ' + esc(p.h) + ' mm</td>'
            + '<td style="font-size:.68rem">' + esc((p.processes || []).join(', ')) + '</td>'
            + '<td style="font-size:.66rem;color:var(--mu)">' + esc(p.note1 || '') + '</td>'
            + '<td style="font-size:.66rem;color:var(--mu)">' + esc(p.note2 || '') + '</td></tr>';
        });
        h += '</tbody></table></div>';
      });
      el.innerHTML = h + '</div></div>';
      document.getElementById('ox-det-back').addEventListener('click', renderBatchList);
      document.getElementById('ox-download').addEventListener('click', function () {
        // Sizes are finished sizes; the operator enters the allowance in Edit-Way.
        window.open(API + '/batches/' + b.id + '/download', '_blank');
      });
      var rt = document.getElementById('ox-retry');
      if (rt) rt.addEventListener('click', function () {
        rt.disabled = true; rt.textContent = 'Delivering…';
        api('/batches/' + b.id + '/deliver', { method: 'POST' }).then(function (r) {
          toast(r.ok ? 'Delivered' : ('Delivery failed: ' + r.error));
          renderBatchDetail(b.id);
        }).catch(function (e) { toast(e.message); renderBatchDetail(b.id); });
      });
      var cx = document.getElementById('ox-cancel');
      if (cx) cx.addEventListener('click', function () {
        if (!confirmSafe('Cancel batch ' + b.batch_no + '?\n\nIts pieces become available again. Labels already printed stay valid.')) return;
        api('/batches/' + b.id + '/cancel', { method: 'POST' }).then(function (r) {
          if (r.warn_delivered) alert(r.warn_delivered);
          toast('Batch cancelled');
          renderBatchList();
        }).catch(function (e) { toast(e.message); });
      });
      document.getElementById('ox-labels').addEventListener('click', function () { printBatchLabels(b); });
      lang();
    }).catch(function (e) { el.innerHTML = '<div class="ox-err">' + esc(e.message) + '</div>'; });
  }

  // Labels use the SHARED builder lifted out of renderCutLabels, so a batch label
  // is the same card as an optimizer label by construction, not by imitation.
  function printBatchLabels(b) {
    if (!window.AGI_Labels || !window.AGI_Labels.makeLabel) {
      toast('Label builder not available — hard refresh the page'); return;
    }
    var url = '/api/labels?batchId=' + b.id;
    var p = (window.AGI && AGI.api) ? AGI.api(url) : fetch(url, {
      headers: { 'Authorization': 'Bearer ' + tok() } }).then(function (r) { return r.json(); });
    p.then(function (items) {
      if (!items || !items.length) { toast('No labels found for this batch'); return; }
      var host = document.getElementById('ox-labels-host');
      if (!host) {
        host = document.createElement('div');
        host.id = 'ox-labels-host';
        host.className = 'lbl-grid';
        host.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:10px;margin-top:16px';
        document.getElementById('ox-batch-body').appendChild(host);
      }
      host.innerHTML = '';
      // Grouped by order, as the print station needs them.
      var byOrder = {};
      items.forEach(function (it) { (byOrder[it.orderNum || it.order_num || '?'] = byOrder[it.orderNum || it.order_num || '?'] || []).push(it); });
      Object.keys(byOrder).sort().forEach(function (on) {
        var hdr = document.createElement('div');
        hdr.style.cssText = 'grid-column:1/-1;font-family:\'DM Mono\',monospace;color:var(--a);font-size:.74rem;margin-top:6px';
        hdr.textContent = on + '  (' + byOrder[on].length + ')';
        host.appendChild(hdr);
        byOrder[on].forEach(function (it) {
          var card = window.AGI_Labels.makeLabel(it, true);
          if (card) host.appendChild(card);
        });
      });
      toast(items.length + ' label(s) rendered — use the browser print dialog');
      host.scrollIntoView({ behavior: 'smooth' });
    }).catch(function (e) { toast('Labels: ' + e.message); });
  }

  // The Cut button offers both paths rather than assuming the ERP optimizer.
  function hookSendToCutting() {
    if (typeof window.sendToCutting !== 'function' || window.sendToCutting.__ox) return false;
    var orig = window.sendToCutting;
    var wrapped = function (orderId) {
      try {
        var go = confirmSafe('Send this order to Optima (Yinrui line)?\n\n'
          + 'OK  = Optima cutting batch\n'
          + 'Cancel = optimize in the ERP as before');
        if (go) {
          SP('cutting');
          showCutView('batches');
          renderNewBatch(orderId);
          return;
        }
      } catch (e) { console.warn('[optima-ui] sendToCutting', e); }
      return orig.apply(this, arguments);
    };
    wrapped.__ox = true;
    window.sendToCutting = wrapped;
    return true;
  }

  /* ─────────────────────────────── bootstrap ─────────────────────────────── */
  // The portal builds its globals asynchronously, so poll briefly rather than
  // racing INIT. Everything is guarded and idempotent.
  var tries = 0;
  var done = { tab: false, hook: false, field: false, apiSave: false, saveCust: false, openCust: false,
               batchView: false, cutView: false, sendCut: false };
  var timer = setInterval(function () {
    tries++;
    try {
      if (!done.tab)       done.tab       = injectSettingsTab();
      if (!done.hook)      done.hook      = hookSettingsTab();
      if (!done.field)     done.field     = injectCustomerField();
      if (!done.apiSave)   done.apiSave   = hookSaveCustomer();
      if (!done.saveCust)  done.saveCust  = hookSaveCust();
      if (!done.openCust)  done.openCust  = hookOpenCustomer();
      if (!done.batchView) done.batchView = injectBatchView();
      if (!done.cutView)   done.cutView   = hookCutView();
      if (!done.sendCut)   done.sendCut   = hookSendToCutting();
    } catch (e) { console.warn('[optima-ui] bootstrap', e); }
    var all = done.tab && done.hook && done.field && done.apiSave && done.saveCust && done.openCust
           && done.batchView && done.cutView && done.sendCut;
    if (all || tries > 60) {
      clearInterval(timer);
      // Every hook is named so a half-applied module is visible, not guessed at.
      console.log('[optima-ui] ' + (all ? 'ready' : 'INCOMPLETE') + ' ' + JSON.stringify(done) + ' tries=' + tries);
      if (!all) console.warn('[optima-ui] some hooks did not apply — the Optima Name field may not save');
    }
  }, 250);
})();
