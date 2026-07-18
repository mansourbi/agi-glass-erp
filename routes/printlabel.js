// routes/printlabel.js - standalone label page for headless-browser printing
// Serves the EXACT same label markup+CSS as the portal so headless Edge renders an identical PDF.
const router = require('express').Router();
const db = require('../db');

function cap(t){ return t ? String(t).charAt(0).toUpperCase() + String(t).slice(1) : ''; }
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function getConfig(key){
  try{ const r = db.prepare("SELECT value FROM config WHERE key=?").get(key); return r ? r.value : null; }catch(e){ return null; }
}

router.get('/remnant/:id', (req, res) => {
  try{
    const r = db.prepare("SELECT * FROM remnants WHERE id=? OR uid=?").get(req.params.id, req.params.id);
    if(!r) return res.status(404).send('Remnant not found');

    const typeStr = cap(r.glass_type || 'glass');
    const colorStr = cap(r.color || 'clear');
    const remPat = (r.pattern || '').trim();
    const remPatStr = remPat ? (/^s\d{3}$/i.test(remPat) ? remPat.toUpperCase() : cap(remPat)) : '';

    // QR payload - same shape as portal printRemnantLabel
    let qr = 'REMNANT ID:' + r.uid + '\n';
    qr += 'SIZE:' + r.w + 'x' + r.h + 'mm\n';
    qr += 'THK:' + r.thickness + 'mm\n';
    qr += 'GLASS:' + typeStr + '/' + colorStr + (remPatStr?'/'+remPatStr:'') + '\n';
    if(r.created_at) qr += 'DATE:' + String(r.created_at).slice(0,10) + '\n';
    const ascii = v => v != null && /^[\x00-\x7F]*$/.test(String(v));
    if(r.brand && ascii(r.brand)) qr += 'BRAND:' + r.brand + '\n';
    if(r.origin && ascii(r.origin)) qr += 'ORIGIN:' + r.origin + '\n';
    if(r.raw_sheet_label && ascii(r.raw_sheet_label)) qr += 'SOURCE:' + r.raw_sheet_label + '\n';
    if(r.slot_code) qr += 'SLOT:' + r.slot_code + '\n';
    qr += 'STATUS:' + (r.status || 'available').toUpperCase() + '\n';
    qr += 'AGI GLASS';

    const logo = getConfig('qr_logo') || getConfig('factory_logo');
    const logoHtml = logo
      ? '<div class="lbl-logo-bar"><img class="lbl-logo-img" src="' + logo + '"></div>'
      : '<div class="lbl-logo-bar"><span class="lbl-logo-txt">AGI GLASS</span></div>';

    const slotHtml = r.slot_code
      ? '<div style="font-size:1.4rem;font-weight:800;letter-spacing:.5px;color:#000;margin:3px 0;text-align:center">&#128205; ' + esc(r.slot_code) + '</div>'
      : '';

    const procsLine = [r.brand, r.origin].filter(Boolean).join(' &mdash; ') || '';
    const rawCodeHtml = r.raw_sheet_label ? '<div class="lbl-rawcode">' + esc(r.raw_sheet_label) + '</div>' : '';

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
@page { size: 100mm 50mm; margin: 0; }
html,body{margin:0;padding:0;background:#fff;width:100mm;height:50mm;overflow:hidden}
#label-print-root{width:100mm;height:50mm;overflow:hidden;page-break-after:avoid;break-after:avoid}
#label-print-root .lcard{width:100mm;height:50mm;overflow:hidden;page-break-inside:avoid;break-inside:avoid;page-break-after:avoid;break-after:avoid}
#label-print-root .lbl-inner{display:flex;flex-direction:row;align-items:stretch;width:100mm;height:50mm;padding:0;margin:0;box-sizing:border-box}
#label-print-root .lbl-qr{width:38mm;flex-shrink:0;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding:0;margin:0;box-sizing:border-box}
#label-print-root .lbl-logo-bar{order:0;width:38mm;background:transparent;display:flex;align-items:center;justify-content:center;flex-shrink:0;padding:1mm 0 0 0;margin:0 0 3mm 0}
#label-print-root .lbl-logo-img{width:10mm!important;height:10mm!important;max-width:10mm!important;max-height:10mm!important;object-fit:contain;display:block}
#label-print-root .lbl-logo-txt{font-family:'Cairo','DM Mono',Courier,monospace;font-size:9pt;font-weight:700;color:#111;letter-spacing:0.5mm}
#label-print-root .lbl-qr-wrap{order:1;flex:1;width:38mm;display:flex;align-items:center;justify-content:center;padding:0 0 1.5mm 0;margin:0}
#label-print-root .lbl-qr canvas,#label-print-root .lbl-qr img{display:block;width:32mm!important;height:32mm!important}
#label-print-root .lbl-sep{width:0.3mm;background:#ccc;flex-shrink:0;margin:0}
#label-print-root .lbl-info{flex:1;display:flex;flex-direction:column;justify-content:center;overflow:hidden;min-width:0;gap:0.2mm;line-height:1.1;padding:1mm 2mm;box-sizing:border-box;width:0}
#label-print-root .lbl-uid{font-family:'Cairo','DM Mono',Courier,monospace;font-size:11.5pt;font-weight:700;background:#111;color:#fff;padding:0.8mm 1.5mm;border-radius:1mm;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;text-align:center}
#label-print-root .lbl-size{font-family:'Cairo','DM Mono',Courier,monospace;font-size:13pt;font-weight:700;color:#111;text-align:center;display:block}
#label-print-root .lbl-glass{font-family:'Cairo','DM Mono',Courier,monospace;font-size:10.5pt;font-weight:600;color:#111;text-align:center;display:block}
#label-print-root .lbl-rawcode{font-family:'Cairo','DM Mono',Courier,monospace;font-size:8.5pt;background:#f0f0f0;border:0.2mm solid #ddd;border-radius:0.5mm;padding:0.3mm 1mm;color:#555;display:block;text-align:center}
#label-print-root .lbl-divider{border:none;border-top:0.2mm solid #eee;margin:0}
#label-print-root .lbl-procs{font-family:'Cairo','DM Sans',Arial,sans-serif;font-size:10pt;font-weight:600;color:#111;text-align:center;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
</style>
<script src="/qrcode.min.js"></script>
</head><body>
<div id="label-print-root">
  <div class="lcard lcard-piece"><div class="lbl-inner">
    <div class="lbl-qr">
      ${logoHtml}
      <div class="lbl-qr-wrap"><div id="qr"></div></div>
    </div>
    <div class="lbl-sep"></div>
    <div class="lbl-info">
      <div class="lbl-uid">${esc(r.uid)} <span style="font-size:.55em;background:#ffd700;color:#000;border-radius:2px;padding:0 3px;margin-left:4px">REM</span></div>
      <div class="lbl-size">&#9632; ${r.w} &times; ${r.h} mm</div>
      <div class="lbl-glass">${r.thickness}mm ${typeStr} &bull; ${colorStr}${remPatStr?' &bull; '+remPatStr:''}</div>
      ${slotHtml}
      <hr class="lbl-divider">
      <div class="lbl-procs">${procsLine || '&mdash;'}</div>
      ${rawCodeHtml}
    </div>
  </div></div>
</div>
<script>
  var QRTXT = ${JSON.stringify(qr)};
  function doQR(level){ try{ new QRCode(document.getElementById('qr'), {text:QRTXT, width:152, height:152, colorDark:'#000', colorLight:'#fff', correctLevel:level}); return true; }catch(e){ return false; } }
  var ok = doQR(QRCode.CorrectLevel.M);
  if(!ok) ok = doQR(QRCode.CorrectLevel.L);
  // signal ready for headless capture
  document.title = 'READY';
</script>
</body></html>`;

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  }catch(e){ res.status(500).send('error: ' + e.message); }
});


// serve a browser-rendered finished label (stored in print_jobs.tspl) wrapped in the same 100x50mm CSS shell
const LABEL_CSS = `
@page { size: 100mm 50mm; margin: 0; }
html,body{margin:0;padding:0;background:#fff;width:100mm;height:50mm;overflow:hidden}
#label-print-root{width:100mm;height:50mm;overflow:hidden}
#label-print-root .lcard{width:100mm;height:50mm;overflow:hidden;padding:2mm;box-sizing:border-box}
#label-print-root .lbl-inner{display:flex;flex-direction:row;align-items:stretch;width:100mm;height:50mm;padding:0;margin:0;box-sizing:border-box}
#label-print-root .lbl-qr{width:38mm;flex-shrink:0;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding:0;margin:0;box-sizing:border-box}
#label-print-root .lbl-logo-bar{order:0;width:38mm;background:transparent;display:flex;align-items:center;justify-content:center;flex-shrink:0;padding:1mm 0 0 0;margin:0 0 3mm 0}
#label-print-root .lbl-logo-img{width:10mm!important;height:10mm!important;max-width:10mm!important;max-height:10mm!important;object-fit:contain;display:block}
#label-print-root .lbl-logo-txt{font-family:'Cairo','DM Mono',Courier,monospace;font-size:9pt;font-weight:700;color:#111;letter-spacing:0.5mm}
#label-print-root .lbl-qr-wrap{order:1;flex:1;width:38mm;display:flex;align-items:center;justify-content:center;padding:0 0 1.5mm 0;margin:0}
#label-print-root .lbl-qr canvas,#label-print-root .lbl-qr img{display:block;width:32mm!important;height:32mm!important}
#label-print-root .lbl-sep{width:0.3mm;background:#ccc;flex-shrink:0;margin:0}
#label-print-root .lbl-info{flex:1;display:flex;flex-direction:column;justify-content:center;overflow:hidden;min-width:0;gap:0.2mm;line-height:1.1;padding:1mm 2mm;box-sizing:border-box;width:0}
#label-print-root .lbl-uid{font-family:'Cairo','DM Mono',Courier,monospace;font-size:11.5pt;font-weight:700;background:#111;color:#fff;padding:0.8mm 1.5mm;border-radius:1mm;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;text-align:center}
#label-print-root .lbl-size{font-family:'Cairo','DM Mono',Courier,monospace;font-size:13pt;font-weight:700;color:#111;text-align:center;display:block}
#label-print-root .lbl-glass{font-family:'Cairo','DM Mono',Courier,monospace;font-size:10.5pt;font-weight:600;color:#111;text-align:center;display:block}
#label-print-root .lbl-rawcode{font-family:'Cairo','DM Mono',Courier,monospace;font-size:8.5pt;background:#f0f0f0;border:0.2mm solid #ddd;border-radius:0.5mm;padding:0.3mm 1mm;color:#555;display:block;text-align:center}
#label-print-root .lbl-divider{border:none;border-top:0.2mm solid #eee;margin:0}
#label-print-root .lbl-procs{font-family:'Cairo','DM Sans',Arial,sans-serif;font-size:10pt;font-weight:600;color:#111;text-align:center;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
#label-print-root .lbl-ext{font-weight:700}
#label-print-root .lbl-desc{font-family:'Cairo','DM Sans',Arial,sans-serif;font-size:10pt;font-weight:600;color:#111;text-align:center;overflow:hidden}
`;

router.get('/job/:id', (req,res)=>{
  try{
    const j = db.prepare("SELECT tspl FROM print_jobs WHERE id=?").get(req.params.id);
    if(!j) return res.status(404).send('job not found');
    const inner = j.tspl || '';
    const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' + LABEL_CSS + '</style></head><body><div id="label-print-root">' + inner + '</div></body></html>';
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  }catch(e){ res.status(500).send('err: '+e.message); }
});

module.exports = router;
