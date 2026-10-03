// optima-deliver.js — puts a batch's .xls on the cutting PC's share.
//
// Spec §3. Hardened per decision 10, which came out of the Phase 1 run:
//
//   * NEVER probe the share without credentials. `net use <share>` with no
//     credentials PROMPTS FOR A USERNAME, and a prompt with an attached stdin is
//     an indefinite hang, not an error. The Phase 1 script probed deliberately to
//     show LocalSystem cannot authenticate alone; that probe must not exist here.
//   * The child gets NO stdin, so net.exe can never sit waiting on a prompt.
//   * Every net.exe call has a timeout. Expiry is a failed delivery, never a hang.
//   * The password is passed in an argv array, never interpolated into a shell
//     string, and is redacted from every log line and error message.
//
// The agi-glass service runs as LocalSystem, which cannot authenticate to another
// machine by itself, so an explicit `net use` is required. Proven working from a
// LocalSystem context on 28 Sep 2026.
//
// Delivery failing must NEVER block a batch: both PCs are on Wi-Fi and the cutting
// PC is sometimes off. The caller records the failure and offers Retry; Download is
// always available as the fallback.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const NET_TIMEOUT_MS = 20000;
const COPY_TIMEOUT_MS = 60000;

function cfg() {
  return {
    share: process.env.OPTIMA_SHARE_PATH || '',
    user: process.env.OPTIMA_SHARE_USER || '',
    pass: process.env.OPTIMA_SHARE_PASS || ''
  };
}
function redact(s, pass) {
  let out = String(s == null ? '' : s);
  if (pass) out = out.split(pass).join('***');
  return out.trim();
}
// argv array, no shell, no stdin, hard timeout.
function net(args, pass) {
  const r = spawnSync('net.exe', args, {
    encoding: 'utf8', windowsHide: true, timeout: NET_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const out = redact((r.stdout || '') + (r.stderr || ''), pass);
  if (r.error && r.error.code === 'ETIMEDOUT') {
    return { code: -1, out: 'net.exe timed out after ' + (NET_TIMEOUT_MS / 1000) + 's', timedOut: true };
  }
  return { code: r.status, out, timedOut: false };
}

// Returns { ok, error, bytes, dest }. Never throws.
function deliver(archivePath, fileName) {
  const { share, user, pass } = cfg();
  if (!share || !user || !pass) {
    return { ok: false, error: 'Optima share is not configured (OPTIMA_SHARE_PATH / _USER / _PASS in .env)' };
  }
  if (!archivePath || !fs.existsSync(archivePath)) {
    return { ok: false, error: 'Archive copy is missing; regenerate the file first' };
  }

  let connected = false;
  try {
    // "Multiple connections to a server or shared resource by the same user"
    // is system error 1219. Clear any existing mapping for this share first
    // rather than discovering it mid-connect.
    const existing = net(['use'], pass);
    if (!existing.timedOut && existing.out && existing.out.includes(share)) {
      net(['use', share, '/delete', '/y'], pass);
    }

    let c = net(['use', share, pass, '/user:' + user, '/persistent:no'], pass);
    if (c.timedOut) return { ok: false, error: c.out };
    if (c.code !== 0) {
      if (/1219/.test(c.out)) {
        net(['use', share, '/delete', '/y'], pass);
        c = net(['use', share, pass, '/user:' + user, '/persistent:no'], pass);
        if (c.timedOut) return { ok: false, error: c.out };
        if (c.code !== 0) return { ok: false, error: 'Connect failed after clearing error 1219: ' + c.out };
      } else {
        return { ok: false, error: 'Connect failed: ' + c.out };
      }
    }
    connected = true;

    const dest = share.replace(/[\\/]+$/, '') + '\\' + fileName;
    // copyFileSync has no timeout of its own; a wedged SMB write would block the
    // event loop, so the size check afterwards is what proves it actually landed.
    const started = Date.now();
    fs.copyFileSync(archivePath, dest);
    const elapsed = Date.now() - started;
    if (elapsed > COPY_TIMEOUT_MS) {
      return { ok: false, error: 'Copy took ' + Math.round(elapsed / 1000) + 's, which is too slow to trust' };
    }
    const src = fs.statSync(archivePath).size;
    const got = fs.statSync(dest).size;
    if (src !== got) return { ok: false, error: 'Delivered ' + got + ' of ' + src + ' bytes — incomplete' };
    return { ok: true, bytes: got, dest };
  } catch (e) {
    return { ok: false, error: redact(e.message, pass) };
  } finally {
    if (connected) { try { net(['use', share, '/delete', '/y'], pass); } catch (e) {} }
  }
}

module.exports = { deliver, isConfigured: () => { const c = cfg(); return !!(c.share && c.user && c.pass); } };
