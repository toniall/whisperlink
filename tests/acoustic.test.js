/*! WhisperLink OSS — acoustic-room simulation of two stations sharing one medium.
 * Author: Antonio Brandao
 * License: MIT
 */
// Real-time acoustic simulation: two stations share one "room". Each mic hears BOTH speakers
// (own speaker loud, peer attenuated) through output+input latency, plus noise. The link logic
// mirrors AudioLink (drop mic while TX, tail guard, demod reset) so handshake timing bugs show up.
// Usage: node acoustic.test.js   (env: MODE, REVERB, OUT_LAT, IN_LAT, PEER_GAIN, NOISE, DEBUG)
const path = require('path');
const dir = '../chirp_oss/static/js';
const js = (f) => path.join(__dirname, dir, f);
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.ChirpRS = require(js('rs.js'));
const M = require(js('modem.js')); globalThis.ChirpModem = M;
const S = require(js('session.js')); globalThis.ChirpSession = S;
const MODE = process.env.MODE || 'FAST';
const SR = 48000, CH = 2048, OUT_LAT = +(process.env.OUT_LAT || 0.15), IN_LAT = +(process.env.IN_LAT || 0.05);
const PEER_GAIN = +(process.env.PEER_GAIN || 0.25), NOISE = +(process.env.NOISE || 0.01);
// Optional room reverb: REVERB=<rt60 seconds> adds a sparse exponentially-decaying echo train.
const RT60 = +(process.env.REVERB || 0);
const TAPS = RT60 ? Array.from({ length: 24 }, (_, i) => { const d = 0.003 + Math.random() * RT60 * 0.6; return { d: Math.round(d * SR), g: (Math.random() < 0.5 ? -1 : 1) * 0.5 * Math.pow(10, (-3 * d) / RT60) }; }) : [];

function room() {
  const r = { t: 0, plays: [], stations: [] };
  r.station = (name, opts = {}) => {
    const st = { name, txing: false, onFrame: null, events: [], micOn: true,
      level: () => 0, isBusy() { return this.txing || this.demod.isBusy(); } };
    st.demod = new M.Demodulator({ sampleRate: SR, modes: [MODE, 'ROBUST'].filter((x, i, a) => a.indexOf(x) === i),
      onFrame: (f) => st.onFrame && st.onFrame(f.payload, f), onEvent: (e) => st.events.push(e) });
    st.transmit = (bytes, mode) => {
      const s = M.encodeFrame(mode, bytes, SR, { volume: 0.7 });
      st.txing = true;
      const start = r.t + 256; // scheduled on render clock
      const play = { st, s, start, ended: start + s.length };
      r.plays.push(play);
      return new Promise((resolve) => { play.onended = () => setTimeout(() => { st.demod.reset(); st.txing = false; resolve(); }, opts.tailMs != null ? opts.tailMs : 120); });
    };
    st.handle = (chunk) => { if (st.txing) return; st.demod.push(chunk); };
    r.stations.push(st); return st;
  };
  r.tick = () => {
    const t0 = r.t; r.t += CH;
    for (const p of r.plays) if (!p.done && r.t >= p.ended) { p.done = true; p.onended(); }
    for (const st of r.stations) {
      const out = new Float32Array(CH);
      for (let i = 0; i < CH; i++) out[i] = NOISE * (Math.random() * 2 - 1);
      for (const p of r.plays) {
        const g = p.st === st ? 1 : PEER_GAIN;
        const lat = Math.round((OUT_LAT + IN_LAT) * SR);
        for (let i = 0; i < CH; i++) { const k = t0 + i - lat - p.start; if (k >= 0 && k < p.s.length) out[i] += g * p.s[k]; for (const tp of TAPS) { const kk = k - tp.d; if (kk >= 0 && kk < p.s.length) out[i] += g * tp.g * p.s[kk]; } }
      }
      st.handle(out);
    }
    r.plays = r.plays.filter((p) => t0 - Math.round((OUT_LAT + IN_LAT) * SR) - p.ended < SR * (1 + RT60));
  };
  r.timer = setInterval(r.tick, (CH / SR) * 1000);
  return r;
}

async function main() {
  const r = room();
  const mk = (name, extra = {}) => new S.SessionManager(Object.assign({ link: r.station(name), mode: MODE, window: 3,
    airtime: (mode, n) => M.frameDuration(mode, n), mtuFor: (mode) => M.MODES[mode].mtu,
    SessionClass: S.Session, overhead: 0 }, extra));
  const A = mk('A'), B = mk('B');
  const t0 = Date.now(), log = [];
  for (const [n, X] of [['A', A], ['B', B]]) X.on((e) => { if (['tx', 'rx', 'state', 'log'].includes(e.type)) log.push(`${((Date.now() - t0) / 1000).toFixed(1)} ${n} ${e.type} ${e.name || ''} ${e.state || e.msg || ''} ${e.reason || ''}`); });
  const sa = await A.connect({});
  try { await waitFor(() => sa.state === 'ESTABLISHED' && [...B.sessions.values()].some((s) => s.state === 'ESTABLISHED' && s.sid === sa.sid), 45000, 'ESTABLISHED'); }
  catch (e) { console.log(log.join('\n')); for (const [n, X] of [['A', A], ['B', B]]) { const c = {}; for (const ev of X.link.events) if (ev.type !== 'detect') c[ev.type + ':' + (ev.reason || '')] = (c[ev.type + ':' + (ev.reason || '')] || 0) + 1; console.log(n, 'demod events', JSON.stringify(c), JSON.stringify(X.link.demod.stats)); } throw e; }
  const sb = [...B.sessions.values()].find((s) => s.state === 'ESTABLISHED' && s.sid === sa.sid);
  console.log(`ESTABLISHED in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const got = []; B.on((e) => e.type === 'message' && got.push(e.text));
  await sa.send(1, new TextEncoder().encode('hello Bob'));
  try { await waitFor(() => got.length === 1, 45000, 'message'); } catch (e) { console.log(log.join('\n')); throw e; }
  console.log(`message ok: "${got[0]}"`);
  clearInterval(r.timer); for (const s of [sa, sb]) s.clearTimers();
  process.exit(got[0] === 'hello Bob' ? 0 : 1);
}
function waitFor(fn, ms, what) { return new Promise((res, rej) => { const t = Date.now(); const i = setInterval(() => { if (fn()) { clearInterval(i); res(); } else if (Date.now() - t > ms) { clearInterval(i); rej(new Error('timeout waiting for ' + what)); } }, 20); }); }
main().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
