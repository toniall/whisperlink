/*! WhisperLink OSS — offline FAST/ROBUST encode/decode test with noise and echo.
 * Author: Antonio Brandao
 * License: MIT
 */
// Offline modem test: encode frames, add delay + noise + echo, stream into demodulator.
const path = require('path');
const DIR = '../chirp_oss/static/js';
globalThis.ChirpRS = require(path.join(__dirname, DIR, 'rs.js'));
const M = require(path.join(__dirname, DIR, 'modem.js'));
const sr = +(process.env.SR || 48000);
function gauss() { return Math.sqrt(-2 * Math.log(Math.random() + 1e-12)) * Math.cos(2 * Math.PI * Math.random()); }
let fails = 0;
for (const modeName of Object.keys(M.MODES)) for (const noise of [0.02, 0.1, 0.25]) {
  const frames = [];
  for (let i = 0; i < 4; i++) frames.push(Uint8Array.from({ length: 5 + ((Math.random() * (M.MODES[modeName].mtu + 10)) | 0) }, () => (Math.random() * 256) | 0));
  const parts = []; let total = 0;
  for (const f of frames) { const gap = new Float32Array(Math.round(sr * (0.3 + Math.random()))); const s = M.encodeFrame(modeName, f, sr, { volume: 0.5 }); parts.push(gap, s); total += gap.length + s.length; }
  const sig = new Float32Array(total + sr); let o = 0; for (const p of parts) { sig.set(p, o); o += p.length; }
  const echoD = Math.round(sr * 0.007);
  for (let i = sig.length - 1; i >= echoD; i--) sig[i] += 0.3 * sig[i - echoD];
  for (let i = 0; i < sig.length; i++) sig[i] = sig[i] * 0.6 + noise * gauss();
  const got = [];
  const dem = new M.Demodulator({ sampleRate: sr, onFrame: (f) => got.push(f) });
  const t0 = Date.now();
  for (let i = 0; i < sig.length; i += 2048) dem.push(sig.subarray(i, i + 2048));
  const ok = frames.filter((f, i) => got[i] && Buffer.compare(Buffer.from(got[i].payload), Buffer.from(f)) === 0).length;
  const audioSec = sig.length / sr;
  console.log(`${modeName} noise=${noise} decoded ${ok}/${frames.length} rsFix=${dem.stats.rsCorrected} det=${dem.stats.detections} cpu=${((Date.now() - t0) / 1000 / audioSec * 100).toFixed(1)}% airtime(64B)=${M.frameDuration(modeName, 64).toFixed(2)}s`);
  if (noise <= 0.1 && ok !== frames.length) fails++;
}
process.exit(fails ? 1 : 0);
