/*! WhisperLink OSS — multi-mode scan: identify FAST vs ROBUST in one noisy stream.
 * Author: Antonio Brandao
 * License: MIT
 */
// Full-spectrum scan test: frames of EVERY mode the edition supports, in one stream, buried in
// white noise + 60 Hz mains hum (with harmonics) + low-band "speech/HVAC" noise (150–900 Hz).
// One Demodulator listens to all modes in parallel; we check it identifies the right mode and decodes
// the payload, and compare band-pass ON vs OFF (sync score in dB + decode count). Also reports CPU.
//   node scan.test.js            (OSS: FAST, ROBUST)
const path = require('path');
const DIR = '../chirp_oss/static/js';
globalThis.ChirpRS = require(path.join(__dirname, DIR, 'rs.js'));
const M = require(path.join(__dirname, DIR, 'modem.js'));
const sr = +(process.env.SR || 48000), MODES = Object.keys(M.MODES);
let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

function buildStream(level) {
  const frames = []; let t = Math.round(0.7 * sr); const parts = [];
  for (let rep = 0; rep < 2; rep++) for (const m of MODES) {
    const payload = Uint8Array.from({ length: 24 + ((rnd() * 20) | 0) }, () => (rnd() * 256) | 0);
    const s = M.encodeFrame(m, payload, sr, { volume: 0.5 });
    frames.push({ mode: m, payload, start: t }); parts.push({ s, start: t }); t += s.length + Math.round(0.8 * sr);
  }
  const x = new Float32Array(t + sr);
  for (const p of parts) x.set(p.s, p.start);
  const bp = new M.BandPass(150, 900, sr), w = new Float32Array(x.length), lowN = new Float32Array(x.length);
  for (let i = 0; i < w.length; i++) w[i] = gauss();
  bp.process(w, lowN);
  let lowRms = 0; for (let i = 0; i < lowN.length; i++) lowRms += lowN[i] * lowN[i]; lowRms = Math.sqrt(lowRms / lowN.length);
  for (let i = 0; i < x.length; i++) {
    const tt = i / sr;
    const hum = level.hum * (Math.sin(2 * Math.PI * 60 * tt) + 0.5 * Math.sin(2 * Math.PI * 120 * tt + 1) + 0.3 * Math.sin(2 * Math.PI * 180 * tt + 2));
    let wh = 0; for (const [f, a] of level.whine || []) wh += a * Math.sin(2 * Math.PI * f * tt);
    x[i] += hum + wh + level.low * (lowN[i] / lowRms) + level.white * gauss();
  }
  return { x, frames };
}
function run(x, frames, bandpass, noiseFloor = true) {
  const got = [], syncPeak = frames.map(() => 0);
  const d = new M.Demodulator({ sampleRate: sr, modes: MODES, bandpass, noiseFloor, onFrame: (f) => got.push(f),
    onEvent: (e) => { if (e.type === 'sync') { const at = d.now - e.ago; frames.forEach((f, i) => { if (f.mode === e.mode && f.start >= at - 2 * sr && f.start <= at + 2 * sr) syncPeak[i] = Math.max(syncPeak[i], e.score); }); } } });
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < x.length; i += 2048) d.push(x.subarray(i, i + 2048));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const ok = frames.map((f) => got.some((g) => g.mode === f.mode && Buffer.compare(Buffer.from(g.payload), Buffer.from(f.payload)) === 0));
  return { ok, syncPeak, got, cpu: ms / ((x.length / sr) * 1000), snr: got.map((g) => g.snrDb) };
}
const levels = (process.env.LEVELS ? JSON.parse(process.env.LEVELS) : [
  { name: 'white 0.02 only', white: 0.02, hum: 0.0, low: 0.0 },
  { name: 'hum 0.5 + low 0.5 + white 0.05', white: 0.05, hum: 0.5, low: 0.5 },
  { name: 'hum 1 + low 1 + white 0.1', white: 0.1, hum: 1.0, low: 1.0 },
  { name: 'hum 2 + low 2 + white 0.1', white: 0.1, hum: 2.0, low: 2.0 },
  { name: 'hum 4 + white 0.03 (strong mains hum)', white: 0.03, hum: 4, low: 0 },
  // steady in-band whines (fan/charger/monitor lines) sitting exactly on data-tone frequencies of each mode
  { name: 'one in-band whine per mode on a tone freq (1.5x tone amp)', white: 0.03, hum: 0, low: 0, whine: whines(1.5) },
  { name: 'one in-band whine per mode on a tone freq (3x tone amp)', white: 0.03, hum: 0, low: 0, whine: whines(3) },
]);
function whines(k) { return MODES.map((m) => { const md = M.MODES[m]; return [M.toneFreq(md, 0, 5), (k * 0.5) / md.bands]; }); } // tone amp = volume/bands
let fail = 0;
for (const lv of levels) {
  const { x, frames } = buildStream(lv);
  const on = run(x, frames, true), off = run(x, frames, false, false), bpOnly = run(x, frames, true, false);
  const db = (a, b) => (a > 0 && b > 0 ? (20 * Math.log10(a / b)).toFixed(1) : 'n/a');
  const perMode = {};
  frames.forEach((f, i) => { (perMode[f.mode] = perMode[f.mode] || []).push(db(on.syncPeak[i], off.syncPeak[i])); });
  const wrongMode = on.got.filter((g) => !frames.some((f) => f.mode === g.mode && Buffer.compare(Buffer.from(g.payload), Buffer.from(f.payload)) === 0)).length;
  console.log(`[${lv.name}] decoded BP+NF ${on.ok.filter(Boolean).length}/${frames.length} · BP only ${bpOnly.ok.filter(Boolean).length}/${frames.length} · neither (old) ${off.ok.filter(Boolean).length}/${frames.length} · mis-identified ${wrongMode}\n   sync-score gain BP-on vs off (dB): ${Object.entries(perMode).map(([m, v]) => m + ' ' + v.join('/')).join(' · ')}\n   frame SNR est (BP-on): ${on.snr.map((s) => (s == null ? '-' : s.toFixed(1))).join(', ')} dB · CPU BP+NF ${(on.cpu * 100).toFixed(1)}% / old ${(off.cpu * 100).toFixed(1)}% of one core`);
  if (lv.white <= 0.02 && on.ok.some((v) => !v)) fail++;
  if (wrongMode) fail++;
  if (on.ok.filter(Boolean).length < off.ok.filter(Boolean).length) fail++;
}
console.log(fail ? 'FAIL' : 'PASS'); process.exit(fail ? 1 : 0);
