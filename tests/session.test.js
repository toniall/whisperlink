/*! WhisperLink OSS — session-layer test over a shared half-duplex lossy medium.
 * Author: Antonio Brandao
 * License: MIT
 */
// Protocol simulation: two peers on a shared half-duplex lossy medium (time-scaled).
const path = require('path');
const js = (f) => path.join(__dirname, '../chirp_oss/static/js', f);
globalThis.ChirpRS = require(js('rs.js'));
const M = require(js('modem.js'));
const S = require(js('session.js'));
const SCALE = 0.02; // 50x faster than real time

function medium(loss) {
  const m = { stations: [], busyUntil: 0, active: [] };
  m.station = (name) => {
    const st = { name, onFrame: null, txBusy: false,
      isBusy() { return Date.now() < m.busyUntil; },
      async transmit(bytes, mode) {
        const dur = M.frameDuration(mode, bytes.length) * 1000 * SCALE;
        const start = Date.now();
        const tx = { st, start, end: start + dur, collided: false };
        for (const o of m.active) if (o.end > start) { o.collided = true; tx.collided = true; }
        m.active.push(tx); m.busyUntil = Math.max(m.busyUntil, tx.end);
        await new Promise((r) => setTimeout(r, dur));
        m.active = m.active.filter((x) => x !== tx);
        if (process.env.DEBUG && tx.collided) console.log('  [medium] collision', st.name, m.active.length);
        for (const o of m.stations) if (o !== st && !tx.collided && Math.random() >= loss) setTimeout(() => o.onFrame(Uint8Array.from(bytes), { rsCorrected: 0, quality: 10 }), 1);
        m.collisions = (m.collisions || 0) + (tx.collided ? 1 : 0);
      } };
    m.stations.push(st); return st;
  };
  return m;
}
async function run(loss, extraCheck) {
  const med = medium(loss); const t0 = Date.now();
  const mk = (name) => new S.SessionManager({ link: med.station(name), mode: 'FAST', window: 4, timeScale: SCALE, keepaliveMs: 20000,
    airtime: (mode, n) => M.frameDuration(mode, n), mtuFor: (mode) => M.MODES[mode].mtu });
  const A = mk('A'), B = mk('B');
  if (process.env.DEBUG) for (const [n, X] of [['A', A], ['B', B]]) X.on((e) => { if (['tx', 'rx', 'state', 'log', 'mode', 'awaiting'].includes(e.type)) console.log(((Date.now() - t0) / SCALE / 1000).toFixed(1), n, e.type, e.name || '', e.seg ? `seq=${e.seg.seq} ack=${e.seg.ack} sack=${e.seg.sack} fl=${e.seg.flags}` : '', e.state || e.msg || e.to || '', e.lost != null ? `lost=${e.lost}/${e.n}` : ''); });
  const got = []; const ev = { mode: [], states: [] };
  B.on((e) => { if (e.type === 'message') got.push(e); if (e.type === 'state') ev.states.push('B:' + e.state); });
  A.on((e) => { if (e.type === 'mode') ev.mode.push(e.to); if (e.type === 'state') ev.states.push('A:' + e.state); });
  const sa = await A.connect();
  await waitFor(() => sa.state === 'ESTABLISHED' && [...B.sessions.values()][0]?.state === 'ESTABLISHED', 60000);
  const body = Uint8Array.from({ length: 700 }, (_, i) => (i * 7) & 255);
  await sa.send(1, new TextEncoder().encode('hello over sound'));
  await sa.send(2, body, 'blob.bin');
  // reverse direction
  const sb = [...B.sessions.values()][0]; const gotA = [];
  A.on((e) => { if (e.type === 'message') gotA.push(e); });
  await sb.send(1, new TextEncoder().encode('reply from B'));
  await waitFor(() => got.length === 2 && gotA.length === 1, 1800000);
  sa.close();
  await waitFor(() => sa.state === "CLOSED" && sb.state === "CLOSED", 900000);
  const okBody = Buffer.compare(Buffer.from(got[1].body), Buffer.from(body)) === 0;
  console.log(`loss=${loss} sim=${((Date.now() - t0) / SCALE / 1000).toFixed(0)}s(real-time) msgs ok=${got[0].text === 'hello over sound' && okBody && gotA[0].text === 'reply from B'} retrans=${sa.stats.retrans} nacks=${sa.stats.nacks} modes=${ev.mode.join(',') || '-'} collisions=${med.collisions || 0} final=${sa.state}/${sb.state}`);
  return okBody;
}
function waitFor(fn, ms) { return new Promise((res, rej) => { const t0 = Date.now(); const i = setInterval(() => { if (fn()) { clearInterval(i); res(); } else if (Date.now() - t0 > ms * SCALE + 60000) { clearInterval(i); rej(new Error('timeout')); } }, 5); }); }
(async () => { let ok = true; for (const l of (process.env.LOSS ? [+process.env.LOSS] : [0, 0.15, 0.35])) ok = (await run(l)) && ok; process.exit(ok ? 0 : 1); })().catch((e) => { console.error(e); process.exit(1); });
