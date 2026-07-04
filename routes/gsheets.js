// routes/gsheets.js — Google Sheets Sync for AGI Glass Tracking
const router  = require('express').Router();
const db      = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { google } = require('googleapis');

// Auth: admin for normal requests; bypass entirely for the internal cron
// (which stays inside the loopback interface via 127.0.0.1).
router.use(function(req, res, next){
  if (req.headers['x-internal-cron'] === '1') return next();
  return requireAuth(req, res, next);
});

const CREDENTIALS = {
  type: "service_account",
  project_id: "agi-glass-erp",
  private_key_id: "451be766439574f8efad980bc89b7e9d0584f6b6",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDCqxNmzE0yrPX/\namkynefUL/T9iuHFQeKgHY4qjlPefh95NDufRsUy4rfute+P1gSZ5xn3IKBVqong\nmqkww85ovTSNdyrjSv6x/oxe8+5AdVhWGfYf3alj0NPqn95hBGaYUaF44my2EkTY\nzKSaea3TKarbBfzrHguVqTjakas95iTkgUAWivVtqB1DAv42wZgSgTGH3hLfRPLN\n5IsU7ghuLEML+YnfK/Mpf5wrXi86b6wufSr/jROmyKW0yTWQOR1PMZmH/ovqz2zo\ntdqR29ZFZ296Es8Y5qaJ3+Pew8avzdJCFiBRvqrayxmven5WRCJD33qwv0k8g/ys\nC8DVpEgFAgMBAAECggEACTKdFY/Um+7ZJqrH8qjMUdW8PRiJR1EwHIGY/IDCDLKn\n2QmzQXjOC3Pz3dcBzSl/CSiGrQsBGFsY7aBRGyk9QOyjpYV6ZMff1dghmMDswmXo\n+RR78RB/luRAhwbrsmjLUioVN4l3OnkNgLLWmifioyYGWRfk1dUTFgyrT4Rvc1qt\nqbMj70/7RkvujEft1AJlIbUM/zLpJ3jra3H5hm5faxbb30xZzpJhEXz5IlN1KKZa\ny0Hniuh9wlYpmizT3viJHqPkLnP2Bz8FF+XYZxEsGdQJl4fd/Cs+qoakTSzqBfgr\no4ZKh3UCk2VCZV0YmIy2Si/Q/gP9BbIzxRAM0ItlNwKBgQD6t4S4RfqS0VsZ7k4X\nm19OTzTDdTxzsZnWSxEMP1PSjErc6ej9B37xalK3NMEI9xVebpZZFQGjEY1FcIK7\n4rG2hgfsh197EzIoyu7nAKOvESzkA7ov4Bofa8uzWYzPkEQ91V9qygFU8Rkr4GRf\nZdxwvCIzeGO/9wfrgnaF3nCltwKBgQDGxTSdG26lots5oU5Vrz+i1e0sM8qOvGYg\n/JKEIiAnn80QeEZx5ax1NkOJdbewZwaErV3DVvgEqpF8bjz2x76Jnkug0iWT8jCl\nTm+U3xeQ0er6R/guc5o7/F0fTEadmM3cC6kFqYI4kkfqstAEQ8GdXbtxz6cOR1OE\nrWvnSq9gIwKBgQCDPnxghml0X9nDykbg/rm2YaoqQ33AxpDUZ/llouT7S+uIl34a\nrsjaEaF5PElsqwNpqpRTz7ZKqc59MjeNqU8EUEdnnznxUIwqZIkJLgGBjIkmV3ko\nxLSIDELXASLAKTI/+Cl52oM19vwJRu7kLYtnDGUO8o+tFuDzfRkUXOw1IwKBgD9M\n+Fd8L/2R4qz0wOSqveJWrIRiLgTM3N1uch6gW4si6gRvuUd2dDiTwmhZU9laxgmk\nyHJ4FN4vj8uHs+SHcheTkNQzeIIoI/PRCdnoPjIBmAqCtvfcGuc1lFZuTSLNUenc\n0MQb2nu3oi2NKo/hIBzEh/hTwAjdECz1qaJr93PvAoGBAIM82P0y1ug8j0LjR1f7\nnyAx3eAPSkBd3qqXHhkzwf7JIFiT5NnPzRkB4vXv8OVAtRw9i+ZjXg7sj826Zdgv\n20QekDdkKzzgMvlI37FejPWI1zfb1mXHEvDmv6U+R6uAUn0LzPRY1hko6L5YfViC\nuxwT1UudcZkUEbThQdZHKM8y\n-----END PRIVATE KEY-----\n",
  client_email: "agi-glass-sheets@agi-glass-erp.iam.gserviceaccount.com",
  client_id: "101853166138212503499",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token"
};

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

function getAuth() {
  return new google.auth.GoogleAuth({ credentials: CREDENTIALS, scopes: SCOPES });
}

const PROC_LABELS = {
  cutting:'Cutting', arrising:'Arrising', flat_polish:'Flat Polish',
  round_polish:'Round Polish', bevel:'Bevel', drilling:'Drilling',
  tempering:'Tempering', laminating:'Laminating', paint:'Paint',
  sand_blast:'Sand Blast', poly:'Poly', igu:'IGU'
};

function buildCustomerData(customerId) {
  // Exclude cancelled orders from the customer-facing tracking sheet — they
  // don't represent live work and just create noise in the sheet.
  const orders = db.prepare(`
    SELECT o.* FROM orders o
    WHERE o.customer_id = ?
      AND COALESCE(o.status,'pending') != 'cancelled'
    ORDER BY
      CASE WHEN o.status='done' THEN 0 ELSE 1 END ASC,
      o.date DESC, o.id DESC
  `).all(customerId);
  if (!orders.length) return null;

  const finalProducts = db.prepare('SELECT id, label FROM final_products').all();
  const fpMap = {};
  finalProducts.forEach(function(fp){ fpMap[fp.id]=fp.label; });

  const allItems = db.prepare(`
    SELECT oi.* FROM order_items oi
    JOIN orders o ON o.id=oi.order_id WHERE o.customer_id=?
  `).all(customerId);

  const scanLog = db.prepare(`
    SELECT sl.* FROM scan_log sl
    JOIN label_items li ON li.uid=sl.piece_uid
    JOIN orders o ON o.id=li.order_id WHERE o.customer_id=?
  `).all(customerId);

  const procSet = new Set();
  allItems.forEach(i => { try { JSON.parse(i.processes||'[]').forEach(p=>procSet.add(p)); } catch(e){} });
  const procList = [...procSet].sort();

  const headers = [
    'Order Date','Order Ref','Ext Ref','Final Product','Notes','Total Pieces','Status',
    ...procList.map(p=>PROC_LABELS[p]||p),
    'Delivered','Last Synced'
  ];

  const rows = [headers];
  const now = new Date().toLocaleString('en-GB');

  for (const o of orders) {
    // Skip fully delivered orders (delivered >= totalPieces, handles over-delivery bug too)
    const oItemsCheck = db.prepare('SELECT SUM(qty) AS t FROM order_items WHERE order_id=?').get(o.id);
    const totalCheck = oItemsCheck ? oItemsCheck.t || 0 : 0;
    const deliveredCheck = db.prepare(`
      SELECT COUNT(*) AS c FROM delivery_items di
      JOIN deliveries d ON d.id=di.delivery_id
      WHERE di.order_id=? AND d.status='finalised'
    `).get(o.id)?.c || 0;
    if (totalCheck > 0 && deliveredCheck >= totalCheck) continue;
    const oItems = allItems.filter(i=>i.order_id===o.id);
    const procCells = procList.map(pid=>{
      const its = oItems.filter(i=>{ try{return JSON.parse(i.processes||'[]').includes(pid);}catch{return false;} });
      if(!its.length) return '—';
      const total = its.reduce((a,i)=>a+(i.qty||0),0);
      const uids = new Set(its.flatMap(i=>{ try{return JSON.parse(i.piece_uids||i.pieceUIDs||'[]');}catch{return [];} }));
      const done = scanLog.filter(s=>uids.has(s.piece_uid)&&s.process===pid&&s.action==='done').length;
      return done+'/'+total;
    });
    const totalPieces = oItems.reduce((a,i)=>a+(i.qty||0),0);
    const delivered = db.prepare(`
      SELECT COUNT(*) AS c FROM delivery_items di
      JOIN deliveries d ON d.id=di.delivery_id
      WHERE di.order_id=? AND d.status='finalised'
    `).get(o.id)?.c||0;
    const statusLabel = o.status==='done'?'Done':o.status==='cancelled'?'Cancelled':'Pending';
    const fpId = o.final_product_id||o.finalProductId||null;
    const fpLabel = fpId&&fpMap[fpId] ? fpMap[fpId] : '—';
    rows.push([
      (o.date||'').slice(0,10), o.num||'', o.ext_ref||o.extref||'', fpLabel, o.notes||'', totalPieces, statusLabel,
      ...procCells, delivered+'/'+totalPieces, now
    ]);
  }
  return rows;
}

async function writeToSheet(sheets, spreadsheetId, rows) {
  const ss = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = ss.data.sheets[0];
  const sheetId = sheet.properties.sheetId;
  const sheetTitle = sheet.properties.title;
  const TAB_NAME = 'Order View';

  // Rename tab to "Order View" if needed
  if (sheetTitle !== TAB_NAME) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, resource: { requests: [{
      updateSheetProperties: {
        properties: { sheetId, title: TAB_NAME },
        fields: 'title'
      }
    }]}});
  }

  // Delete all existing conditional format rules to prevent stacking on re-sync
  const existingSS = await sheets.spreadsheets.get({ spreadsheetId });
  const existingSheet = existingSS.data.sheets.find(s=>s.properties.sheetId===sheetId);
  const existingRules = (existingSheet && existingSheet.conditionalFormats) || [];
  if (existingRules.length) {
    const deleteRequests = existingRules.map((_,i)=>({ deleteConditionalFormatRule:{ sheetId, index:0 } }));
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, resource:{ requests:deleteRequests } });
  }

  await sheets.spreadsheets.values.clear({ spreadsheetId, range: TAB_NAME+'!A:Q' });
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: TAB_NAME+'!A1',
    valueInputOption: 'RAW', resource: { values: rows }
  });

  const headers = rows[0];
  const statusColIdx   = headers.indexOf('Status');
  const deliveredColIdx = headers.indexOf('Delivered');
  const procStartIdx   = statusColIdx + 1;
  const procEndIdx     = deliveredColIdx;
  const totalCols      = headers.length;
  const totalRows      = rows.length;

  // Column letter helper (0-based index to A, B, ... Z, AA...)
  function colLetter(idx) {
    let s = '';
    idx++;
    while (idx > 0) { s = String.fromCharCode(64 + (idx % 26 || 26)) + s; idx = Math.floor((idx - 1) / 26); }
    return s;
  }
  const procCol = colLetter(procStartIdx); // first process column letter for formula anchoring

  const requests = [];

  // 0. Clear ALL existing formatting on populated range + reset borders
  const clearRows = Math.max(totalRows + 5, 50);
  requests.push({ repeatCell: {
    range: { sheetId, startRowIndex:0, endRowIndex:clearRows, startColumnIndex:1, endColumnIndex:totalCols+2 },
    cell: { userEnteredFormat: {} },
    fields: 'userEnteredFormat'
  }});
  requests.push({ updateBorders: {
    range: { sheetId, startRowIndex:0, endRowIndex:clearRows, startColumnIndex:1, endColumnIndex:totalCols+2 },
    top:    { style:'NONE' }, bottom: { style:'NONE' },
    left:   { style:'NONE' }, right:  { style:'NONE' },
    innerHorizontal: { style:'NONE' }, innerVertical: { style:'NONE' }
  }});

  // 1. Header: dark blue, white bold, centered
  requests.push({ repeatCell: {
    range: { sheetId, startRowIndex:0, endRowIndex:1 },
    cell: { userEnteredFormat: {
      backgroundColor: { red:0.1, green:0.2, blue:0.35 },
      textFormat: { bold:true, foregroundColor:{ red:1, green:1, blue:1 } },
      horizontalAlignment: 'CENTER',
      verticalAlignment: 'MIDDLE'
    }},
    fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)'
  }});

  // 2. Center + middle align all data cells
  requests.push({ repeatCell: {
    range: { sheetId, startRowIndex:1, endRowIndex:totalRows },
    cell: { userEnteredFormat: {
      horizontalAlignment: 'CENTER',
      verticalAlignment: 'MIDDLE'
    }},
    fields: 'userEnteredFormat(horizontalAlignment,verticalAlignment)'
  }});

  // 3. Freeze header
  requests.push({ updateSheetProperties: {
    properties: { sheetId, gridProperties:{ frozenRowCount:1 } },
    fields: 'gridProperties.frozenRowCount'
  }});

  // 4. Auto-resize columns
  requests.push({ autoResizeDimensions: {
    dimensions: { sheetId, dimension:'COLUMNS', startIndex:0, endIndex:totalCols }
  }});

  // 5. Status: Done=green, Pending=orange
  if (statusColIdx >= 0) {
    const stRange = [{ sheetId, startRowIndex:1, endRowIndex:totalRows, startColumnIndex:statusColIdx, endColumnIndex:statusColIdx+1 }];
    requests.push({ addConditionalFormatRule: { rule: { ranges:stRange,
      booleanRule: { condition:{ type:'TEXT_EQ', values:[{ userEnteredValue:'Done' }] },
        format:{ backgroundColor:{ red:0.72, green:0.88, blue:0.72 } } } }, index:0 }});
    requests.push({ addConditionalFormatRule: { rule: { ranges:stRange,
      booleanRule: { condition:{ type:'TEXT_EQ', values:[{ userEnteredValue:'Pending' }] },
        format:{ backgroundColor:{ red:1.0, green:0.85, blue:0.6 } } } }, index:1 }});
  }

  // 6. Process columns: green=done, red=0/n, amber=partial
  if (procStartIdx > 0 && procEndIdx > procStartIdx) {
    const procRange = [{ sheetId, startRowIndex:1, endRowIndex:totalRows, startColumnIndex:procStartIdx, endColumnIndex:procEndIdx }];
    requests.push({ addConditionalFormatRule: { rule: { ranges:procRange,
      booleanRule: { condition:{ type:'CUSTOM_FORMULA', values:[{ userEnteredValue:'=AND(LEFT('+procCol+'2,FIND("/",'+procCol+'2)-1)=MID('+procCol+'2,FIND("/",'+procCol+'2)+1,100),'+procCol+'2<>"—",'+procCol+'2<>"")' }] },
        format:{ backgroundColor:{ red:0.72, green:0.88, blue:0.72 } } } }, index:2 }});
    requests.push({ addConditionalFormatRule: { rule: { ranges:procRange,
      booleanRule: { condition:{ type:'CUSTOM_FORMULA', values:[{ userEnteredValue:'=AND(LEFT('+procCol+'2,2)="0/",'+procCol+'2<>"—")' }] },
        format:{ backgroundColor:{ red:1.0, green:0.8, blue:0.8 } } } }, index:3 }});
    requests.push({ addConditionalFormatRule: { rule: { ranges:procRange,
      booleanRule: { condition:{ type:'CUSTOM_FORMULA', values:[{ userEnteredValue:'=AND('+procCol+'2<>"—",'+procCol+'2<>"",LEFT('+procCol+'2,2)<>"0/",LEFT('+procCol+'2,FIND("/",'+procCol+'2)-1)<>MID('+procCol+'2,FIND("/",'+procCol+'2)+1,100))' }] },
        format:{ backgroundColor:{ red:1.0, green:0.93, blue:0.6 } } } }, index:4 }});
  }

  // 7. Delivered column: green=all, red=none, amber=partial
  if (deliveredColIdx >= 0) {
    const delCol = colLetter(deliveredColIdx);
    const delRange = [{ sheetId, startRowIndex:1, endRowIndex:totalRows, startColumnIndex:deliveredColIdx, endColumnIndex:deliveredColIdx+1 }];
    requests.push({ addConditionalFormatRule: { rule: { ranges:delRange,
      booleanRule: { condition:{ type:'CUSTOM_FORMULA', values:[{ userEnteredValue:'=AND(LEFT('+delCol+'2,FIND("/",'+delCol+'2)-1)=MID('+delCol+'2,FIND("/",'+delCol+'2)+1,100),'+delCol+'2<>"—")' }] },
        format:{ backgroundColor:{ red:0.72, green:0.88, blue:0.72 } } } }, index:5 }});
    requests.push({ addConditionalFormatRule: { rule: { ranges:delRange,
      booleanRule: { condition:{ type:'CUSTOM_FORMULA', values:[{ userEnteredValue:'=AND(LEFT('+delCol+'2,2)="0/",'+delCol+'2<>"—")' }] },
        format:{ backgroundColor:{ red:1.0, green:0.8, blue:0.8 } } } }, index:6 }});
    requests.push({ addConditionalFormatRule: { rule: { ranges:delRange,
      booleanRule: { condition:{ type:'CUSTOM_FORMULA', values:[{ userEnteredValue:'=AND('+delCol+'2<>"—",'+delCol+'2<>"",LEFT('+delCol+'2,2)<>"0/",LEFT('+delCol+'2,FIND("/",'+delCol+'2)-1)<>MID('+delCol+'2,FIND("/",'+delCol+'2)+1,100))' }] },
        format:{ backgroundColor:{ red:1.0, green:0.93, blue:0.6 } } } }, index:7 }});
  }

  // 8. Bottom border between date groups (skip column A — startColumnIndex:1)
  for (let i = 1; i < totalRows - 1; i++) {
    if (rows[i][0] !== rows[i+1][0]) {
      requests.push({ updateBorders: {
        range: { sheetId, startRowIndex:i, endRowIndex:i+1, startColumnIndex:1, endColumnIndex:totalCols },
        bottom: { style:'SOLID_MEDIUM', color:{ red:0.4, green:0.4, blue:0.4 } }
      }});
    }
  }

  await sheets.spreadsheets.batchUpdate({ spreadsheetId, resource:{ requests } });
}

// ── POST /api/gsheets/sync ────────────────────────────────────────────────
router.post('/sync', function(req,res,next){ if(req.headers['x-internal-cron']==='1') return next(); requireAdmin(req,res,next); }, async (req, res) => {
  try {
    const auth   = getAuth();
    const sheets = google.sheets({ version:'v4', auth });
    const customers = db.prepare(
      'SELECT * FROM customers WHERE sheet_id IS NOT NULL AND LENGTH(sheet_id) > 0 ORDER BY name'
    ).all();

    if (!customers.length) {
      return res.json({ ok:true, synced:[], message:'No customers have a Google Sheet ID configured.' });
    }

    const results=[], errors=[];
    for (const customer of customers) {
      try {
        const rows = buildCustomerData(customer.id);
        if (!rows) { results.push({ customer:customer.name, rows:0, skipped:true }); continue; }
        await writeToSheet(sheets, customer.sheet_id, rows);
        const url = 'https://docs.google.com/spreadsheets/d/'+customer.sheet_id;
        db.prepare('UPDATE customers SET sheet_url=? WHERE id=?').run(url, customer.id);
        results.push({ customer:customer.name, rows:rows.length-1, url });
      } catch(e) {
        errors.push({ customer:customer.name, error:e.message });
      }
    }
    res.json({ ok:true, synced:results, errors });
  } catch(e) {
    console.error('[gsheets sync]', e.message);
    res.status(500).json({ error:e.message });
  }
});

// ── PATCH /api/gsheets/viewers/:customerId ────────────────────────────────
router.patch('/viewers/:customerId', requireAdmin, (req, res) => {
  try {
    const { emails } = req.body;
    if (!Array.isArray(emails)) return res.status(400).json({ error:'emails must be array' });
    const clean = emails.map(e=>e.trim().toLowerCase()).filter(e=>e.includes('@'));
    db.prepare('UPDATE customers SET sheet_viewers=? WHERE id=?').run(JSON.stringify(clean), +req.params.customerId);
    res.json({ ok:true, emails:clean });
  } catch(e) { res.status(500).json({ error:e.message }); }
});


// ── Deliveries Sheet Builder ──────────────────────────────────────────────
function buildDeliveriesData(customerId) {
  let items;
  try { items = db.prepare(`
    SELECT
      d.serial        AS delivery_code,
      d.finalised_at  AS delivery_date,
      d.factory_name,
      d.external_process_name,
      d.receiver_name,
      di.order_num,
      di.piece_uid,
      di.w, di.h,
      di.glass_type, di.color, di.thickness,
      di.processes,
      o.extref,
      fp.label AS final_product_name
    FROM delivery_items di
    JOIN deliveries d ON d.id = di.delivery_id
    LEFT JOIN orders o ON o.id = di.order_id
    LEFT JOIN final_products fp ON fp.id = o.final_product_id
    WHERE d.status = 'finalised' AND d.customer_id = ?
    ORDER BY d.finalised_at DESC, d.serial DESC, di.order_num ASC, di.piece_uid ASC
  `).all(customerId); }
  catch(e) {
    console.error('[buildDeliveriesData]', e.message);
    // Fallback: without final_product join
    items = db.prepare(`
      SELECT d.serial AS delivery_code, d.finalised_at AS delivery_date,
        d.factory_name, d.external_process_name, d.receiver_name,
        di.order_num, di.piece_uid, di.w, di.h,
        di.glass_type, di.color, di.thickness, di.processes,
        o.extref, NULL AS final_product_name
      FROM delivery_items di
      JOIN deliveries d ON d.id = di.delivery_id
      LEFT JOIN orders o ON o.id = di.order_id
      WHERE d.status = 'finalised' AND d.customer_id = ?
      ORDER BY d.finalised_at DESC, d.serial DESC, di.order_num ASC, di.piece_uid ASC
    `).all(customerId);
  }

  if (!items.length) return null;

  const headers = [
    'Date of Delivery', 'Delivery Code', 'Factory', 'Final Product', 'External Process',
    'Order Ref', 'Ext Ref', 'Piece Ref', 'W (mm)', 'H (mm)', 'SQM', 'Lin M', 'Qty', 'Processes', 'Receiver'
  ];

  const rows = [headers];
  const now = new Date().toLocaleString('en-GB');

  for (const it of items) {
    const date = it.delivery_date ? it.delivery_date.slice(0,16).replace('T',' ') : '';
    let procs = [];
    try { procs = JSON.parse(it.processes||'[]').map(p=>PROC_LABELS[p]||p); } catch(e){}
    const sqm = +((( (it.w||0) * (it.h||0) ) / 1000000).toFixed(4));
    const linM = +((Math.max(it.w||0, it.h||0)) / 1000).toFixed(3);
    rows.push([
      date,
      it.delivery_code || '',
      it.factory_name || '',
      it.final_product_name || '',
      it.external_process_name || '',
      it.order_num || '',
      it.extref || '',
      it.piece_uid || '',
      it.w || 0,
      it.h || 0,
      sqm,
      linM,
      1,
      procs.join(', '),
      it.receiver_name || ''
    ]);
  }
  return rows;
}

async function writeDeliveriesToSheet(sheets, spreadsheetId, rows) {
  // Get or create "Deliveries" tab
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  let sheetId = null;
  for (const s of meta.data.sheets) {
    if (s.properties.title === 'Deliveries') { sheetId = s.properties.sheetId; break; }
  }
  if (sheetId === null) {
    const addRes = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: { requests: [{ addSheet: { properties: { title: 'Deliveries' } } }] }
    });
    sheetId = addRes.data.replies[0].addSheet.properties.sheetId;
  }

  const totalCols = rows[0].length;
  const totalRows = rows.length;

  // Column letter helper
  function colLetter(idx) {
    let s = ''; idx++;
    while (idx > 0) { s = String.fromCharCode(64 + (idx % 26 || 26)) + s; idx = Math.floor((idx-1)/26); }
    return s;
  }
  const endCol = colLetter(totalCols - 1);
  const clearRows = Math.max(totalRows + 10, 200);

  // Clear and write data
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: 'Deliveries!A:P' });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `Deliveries!A1:${endCol}${totalRows}`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: rows }
  });

  const requests = [];

  // 1. Remove ALL existing formatting and borders
  requests.push({ repeatCell: {
    range: { sheetId, startRowIndex:0, endRowIndex:clearRows, startColumnIndex:0, endColumnIndex:totalCols },
    cell: { userEnteredFormat: {} },
    fields: 'userEnteredFormat'
  }});
  requests.push({ updateBorders: {
    range: { sheetId, startRowIndex:0, endRowIndex:clearRows, startColumnIndex:0, endColumnIndex:totalCols },
    top:{ style:'NONE' }, bottom:{ style:'NONE' }, left:{ style:'NONE' }, right:{ style:'NONE' },
    innerHorizontal:{ style:'NONE' }, innerVertical:{ style:'NONE' }
  }});

  // 2. Remove existing banding
  const existingMeta = await sheets.spreadsheets.get({ spreadsheetId, ranges:['Deliveries'], includeGridData:false });
  const existingSheet = existingMeta.data.sheets.find(s=>s.properties.sheetId===sheetId);
  if (existingSheet && existingSheet.bandedRanges) {
    for (const br of existingSheet.bandedRanges) {
      requests.push({ deleteBanding: { bandedRangeId: br.bandedRangeId } });
    }
  }

  // 3. Header row — dark navy, white bold, centered
  requests.push({ repeatCell: {
    range: { sheetId, startRowIndex:0, endRowIndex:1 },
    cell: { userEnteredFormat: {
      backgroundColor: { red:0.1, green:0.2, blue:0.35 },
      textFormat: { bold:true, foregroundColor:{ red:1, green:1, blue:1 }, fontSize:10 },
      horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE'
    }},
    fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)'
  }});

  // 4. Data rows — center aligned, light font
  requests.push({ repeatCell: {
    range: { sheetId, startRowIndex:1, endRowIndex:totalRows },
    cell: { userEnteredFormat: {
      horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE',
      textFormat: { fontSize:9 }
    }},
    fields: 'userEnteredFormat(horizontalAlignment,verticalAlignment,textFormat)'
  }});

  // 5. Freeze header row
  requests.push({ updateSheetProperties: {
    properties: { sheetId, gridProperties: { frozenRowCount:1 } },
    fields: 'gridProperties.frozenRowCount'
  }});

  // 6. Auto-resize columns
  requests.push({ autoResizeDimensions: {
    dimensions: { sheetId, dimension:'COLUMNS', startIndex:0, endIndex:totalCols }
  }});

  // 7. Thin border around every data cell (light grey)
  requests.push({ updateBorders: {
    range: { sheetId, startRowIndex:1, endRowIndex:totalRows, startColumnIndex:0, endColumnIndex:totalCols },
    innerHorizontal: { style:'SOLID', color:{ red:0.85, green:0.88, blue:0.92 }, width:1 },
    innerVertical:   { style:'SOLID', color:{ red:0.85, green:0.88, blue:0.92 }, width:1 },
    top:    { style:'SOLID', color:{ red:0.85, green:0.88, blue:0.92 }, width:1 },
    bottom: { style:'SOLID', color:{ red:0.85, green:0.88, blue:0.92 }, width:1 },
    left:   { style:'SOLID', color:{ red:0.85, green:0.88, blue:0.92 }, width:1 },
    right:  { style:'SOLID', color:{ red:0.85, green:0.88, blue:0.92 }, width:1 }
  }});

  // 8. Medium border below each delivery order group (col index 1 = Delivery Code)
  // and thick border below each date group (col index 0 = Date)
  // rows[0] = headers, rows[1..] = data
  for (let i = 1; i < totalRows - 1; i++) {
    const currDate     = rows[i][0].slice(0,10);
    const nextDate     = rows[i+1][0].slice(0,10);
    const currDelivery = rows[i][1];
    const nextDelivery = rows[i+1][1];

    if (currDate !== nextDate) {
      // Thick border — new date group (skip col A)
      requests.push({ updateBorders: {
        range: { sheetId, startRowIndex:i, endRowIndex:i+1, startColumnIndex:1, endColumnIndex:totalCols },
        bottom: { style:'SOLID_THICK', color:{ red:0.1, green:0.2, blue:0.35 }, width:2 }
      }});
    } else if (currDelivery !== nextDelivery) {
      // Medium border — new delivery within same date (skip col A)
      requests.push({ updateBorders: {
        range: { sheetId, startRowIndex:i, endRowIndex:i+1, startColumnIndex:1, endColumnIndex:totalCols },
        bottom: { style:'SOLID_MEDIUM', color:{ red:0.4, green:0.5, blue:0.65 }, width:1 }
      }});
    }
  }

  // 9. Color by date group — each date gets a slightly different tint
  // Date palettes: alternating between warm-white and cool-blue families
  const datePalettes = [
    { red:1.0,  green:1.0,  blue:1.0  },  // white
    { red:0.84, green:0.91, blue:0.98 },  // blue
    { red:0.88, green:0.97, blue:0.88 },  // green
    { red:1.0,  green:0.94, blue:0.82 },  // amber
    { red:0.92, green:0.86, blue:0.98 },  // purple
    { red:0.85, green:0.97, blue:0.95 },  // teal
  ];
  let dateIdx = -1;
  let currentDate = null;
  let i = 1;
  while (i < totalRows) {
    const rowDate = rows[i][0].slice(0,10);
    if (rowDate !== currentDate) { currentDate = rowDate; dateIdx++; }
    const delivCode = rows[i][1];
    let j = i;
    while (j < totalRows && rows[j][1] === delivCode) j++;
    const bg = datePalettes[dateIdx % datePalettes.length];
    requests.push({ repeatCell: {
      range: { sheetId, startRowIndex:i, endRowIndex:j, startColumnIndex:0, endColumnIndex:totalCols },
      cell: { userEnteredFormat: { backgroundColor: bg }},
      fields: 'userEnteredFormat(backgroundColor)'
    }});
    i = j;
  }

  await sheets.spreadsheets.batchUpdate({ spreadsheetId, resource: { requests } });
}

// ── POST /api/gsheets/sync-deliveries ────────────────────────────────────
router.post('/sync-deliveries',
  function(req,res,next){ if(req.headers['x-internal-cron']==='1') return next(); requireAdmin(req,res,next); },
  async (req, res) => {
    try {
      const auth   = getAuth();
      const sheets = google.sheets({ version:'v4', auth });
      const customers = db.prepare(
        'SELECT * FROM customers WHERE sheet_id IS NOT NULL AND LENGTH(sheet_id) > 0 ORDER BY name'
      ).all();

      if (!customers.length) {
        return res.json({ ok:true, synced:[], message:'No customers have a Google Sheet ID configured.' });
      }

      const results=[], errors=[];
      for (const customer of customers) {
        try {
          const rows = buildDeliveriesData(customer.id);
          if (!rows) { results.push({ customer: customer.name, rows: 0, skipped: true }); continue; }
          await writeDeliveriesToSheet(sheets, customer.sheet_id, rows);
          results.push({ customer: customer.name, rows: rows.length-1 });
        } catch(e) {
          errors.push({ customer: customer.name, error: e.message });
        }
      }
      res.json({ ok:true, synced:results, errors });
    } catch(e) {
      console.error('[gsheets deliveries sync]', e.message);
      res.status(500).json({ error: e.message });
    }
  }
);

module.exports = router;
