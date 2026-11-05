/*! WhisperLink OSS — click-to-resend: unACKed segments are retransmitted for real.
 * Author: Antonio Brandao
 * License: MIT
 */
// Click-to-resend: message sent while the peer is deaf stays unACKed; Session.resend() re-queues the real
// segments and they get real ACKs once the peer hears again. Already-ACKed → 'acked'. (time-scaled)
const path = require('path');
const js = (f) => path.join(__dirname, '../chirp_oss/static/js', f);
globalThis.ChirpRS = require(js('rs.js'));
const M = require(js('modem.js')); const S = require(js('session.js'));
const SCALE = 0.02; let deaf = false;
const med = { st: [], busyUntil: 0 };
const station = (name) => { const st = { name, onFrame: null, isBusy: () => Date.now() < med.busyUntil,
  async transmit(bytes, mode) { const d = M.frameDuration(mode, bytes.length) * 1000 * SCALE; med.busyUntil = Date.now() + d; await new Promise((r) => setTimeout(r, d));
    for (const o of med.st) if (o !== st && !(deaf && o.name === 'B')) setTimeout(() => o.onFrame(Uint8Array.from(bytes), { mode }), 1); } }; med.st.push(st); return st; };
const mk = (n) => new S.SessionManager({ link: station(n), mode: 'FAST', window: 3, timeScale: SCALE, keepaliveMs: 0, maxRetries: 50,
  airtime: (m, k) => M.frameDuration(m, k), mtuFor: (m) => M.MODES[m].mtu, modes: ['FAST', 'ROBUST'] });
const wait = (fn, ms, what) => new Promise((res, rej) => { const t = Date.now(); const i = setInterval(() => { if (fn()) { clearInterval(i); res(); } else if (Date.now() - t > ms) { clearInterval(i); rej(new Error('timeout ' + what)); } }, 5); });
(async () => {
  const A = mk('A'), B = mk('B'); const got = []; B.on((e) => e.type === 'message' && got.push(e.text));
  const sa = await A.connect(); await wait(() => sa.state === 'ESTABLISHED' && [...B.sessions.values()][0]?.state === 'ESTABLISHED', 20000, 'est');
  deaf = true;
  const msg = await sa.send(1, new TextEncoder().encode('please ACK me'));
  await wait(() => sa.stats.retrans >= 1, 20000, 'first RTO'); await wait(() => sa.awaiting, 20000, 'retransmit on air done');
  if (msg.doneAt || got.length) throw new Error('should not be ACKed while peer is deaf');
  deaf = false; const before = sa.stats.txFrames;
  const r = sa.resend(msg.id); console.log('resend ->', JSON.stringify(r));
  if (r.status !== 'resending' || r.n < 1) throw new Error('expected resending');
  await wait(() => msg.doneAt && got.length === 1, 20000, 'ACK after resend');
  console.log(`delivered after resend: "${got[0]}" ack in ${((msg.doneAt - msg.started) * 1).toFixed(0)} ms scaled, frames after resend=${sa.stats.txFrames - before}, resends=${msg.resends}`);
  const r2 = sa.resend(msg.id); console.log('resend after ACK ->', JSON.stringify(r2));
  if (r2.status !== 'acked') throw new Error('expected acked');
  console.log('PASS'); process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
