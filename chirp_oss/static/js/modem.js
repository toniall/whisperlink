/*! WhisperLink OSS — WebAudio MFSK modem (chirp sync + training + RS + CRC-32).
 * Author: Antonio Brandao
 * License: MIT
 *
 * Frame on air:
 *   [linear up-chirp preamble][gap][training symbols][header symbols][body symbols]
 * Each symbol carries one nibble per band (16-ary FSK per band, `bands` bands in parallel).
 * Header  = magic|mode, len, flags, crc8  + RS(6)          (fixed 10 bytes)
 * Body    = payload(len) + CRC-32(4)       + RS(nsym)
 */
(function (root) {
  'use strict';
  const RS = root.ChirpRS || (typeof require !== 'undefined' ? require('./rs.js') : null);

  // ---- Mode table. Audible only in the open-source edition. ----
  const MODES = {
    FAST:   { id: 0, name: 'FAST',   f0: 1500, df: 93.75, bands: 4, slot: 0.034, chirp: [1300, 7700], chirpDur: 0.12, nsym: 8,  train: 4, mtu: 64 },
    ROBUST: { id: 1, name: 'ROBUST', f0: 900,  df: 125,   bands: 2, slot: 0.058, chirp: [700, 5100],  chirpDur: 0.20, nsym: 16, train: 4, mtu: 32 },
  };
  const TONES = 16, HDR_LEN = 4, HDR_NSYM = 6, GAP = 0.02, TAIL = 0.03, MAGIC = 0xA;
  const modeById = (id) => Object.values(MODES).find((m) => m.id === id);

  // Deterministic training pattern (7-bit LFSR, x^7+x^6+1) — doubles as a sync verifier.
  function trainingNibbles(mode) {
    let s = 0x5B ^ (mode.id * 0x13);
    const out = [];
    for (let k = 0; k < mode.train * mode.bands; k++) {
      let n = 0;
      for (let b = 0; b < 4; b++) { const bit = ((s >> 6) ^ (s >> 5)) & 1; s = ((s << 1) | bit) & 0x7f; n = (n << 1) | bit; }
      out.push(n);
    }
    return out;
  }

  function toneFreq(mode, band, nibble) { return mode.f0 + (band * TONES + nibble) * mode.df; }
  function bytesToNibbles(bytes) { const n = []; for (const b of bytes) { n.push(b >> 4, b & 15); } return n; }
  function nibblesToBytes(n) { const out = new Uint8Array(n.length >> 1); for (let i = 0; i < out.length; i++) out[i] = (n[2 * i] << 4) | n[2 * i + 1]; return out; }

  function bodySymbols(mode, len) { return Math.ceil(((len + 4 + mode.nsym) * 2) / mode.bands); }
  function headerSymbols(mode) { return Math.ceil(((HDR_LEN + HDR_NSYM) * 2) / mode.bands); }
  function frameDuration(mode, len) {
    if (typeof mode === 'string') mode = MODES[mode];
    return mode.chirpDur + GAP + (mode.train + headerSymbols(mode) + bodySymbols(mode, len)) * mode.slot + TAIL;
  }
  function maxPayload(mode) { return 255 - 4 - mode.nsym; }

  function chirpTemplate(mode, sr) {
    const n = Math.round(mode.chirpDur * sr), [f1, f2] = mode.chirp, T = mode.chirpDur;
    const out = new Float32Array(n), taper = Math.round(n * 0.06);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      let a = Math.sin(2 * Math.PI * (f1 * t + ((f2 - f1) * t * t) / (2 * T)));
      if (i < taper) a *= 0.5 - 0.5 * Math.cos((Math.PI * i) / taper);
      else if (i > n - taper) a *= 0.5 - 0.5 * Math.cos((Math.PI * (n - i)) / taper);
      out[i] = a;
    }
    return out;
  }

  // ---------------- Modulator ----------------
  function encodeFrame(modeName, payload, sr, opts = {}) {
    const mode = typeof modeName === 'string' ? MODES[modeName] : modeName;
    if (!mode) throw new Error('unknown mode ' + modeName);
    payload = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    if (payload.length > maxPayload(mode)) throw new Error('payload too large for mode');
    const vol = opts.volume == null ? 0.8 : opts.volume;
    const hdr = new Uint8Array([(MAGIC << 4) | mode.id, payload.length, opts.flags || 0, 0]);
    hdr[3] = RS.crc8(hdr.subarray(0, 3));
    const body = new Uint8Array(payload.length + 4);
    body.set(payload);
    const c = RS.crc32(payload);
    body[payload.length] = c >>> 24; body[payload.length + 1] = (c >>> 16) & 255; body[payload.length + 2] = (c >>> 8) & 255; body[payload.length + 3] = c & 255;
    const nib = trainingNibbles(mode).concat(bytesToNibbles(RS.encode(hdr, HDR_NSYM)), bytesToNibbles(RS.encode(body, mode.nsym)));
    const nSyms = Math.ceil(nib.length / mode.bands);
    while (nib.length < nSyms * mode.bands) nib.push(0);
    // pad header/body boundaries are already symbol-aligned for 2/4 bands with even nibble counts
    const total = Math.round(frameDuration(mode, payload.length) * sr);
    const out = new Float32Array(total);
    const chirp = chirpTemplate(mode, sr);
    for (let i = 0; i < chirp.length; i++) out[i] = chirp[i] * vol;
    const dataStart = Math.round((mode.chirpDur + GAP) * sr);
    const slotN = mode.slot * sr, ramp = Math.round(0.002 * sr), amp = vol / mode.bands;
    const phase = new Float64Array(mode.bands);
    for (let s = 0; s < nSyms; s++) {
      const a0 = Math.round(dataStart + s * slotN), a1 = Math.round(dataStart + (s + 1) * slotN);
      for (let b = 0; b < mode.bands; b++) {
        const w = (2 * Math.PI * toneFreq(mode, b, nib[s * mode.bands + b])) / sr;
        let ph = phase[b];
        for (let i = a0; i < a1 && i < total; i++) {
          const k = i - a0, m = a1 - i;
          let g = amp;
          if (k < ramp) g *= 0.5 - 0.5 * Math.cos((Math.PI * k) / ramp);
          else if (m < ramp) g *= 0.5 - 0.5 * Math.cos((Math.PI * m) / ramp);
          out[i] += g * Math.sin(ph);
          ph += w;
        }
        phase[b] = ph % (2 * Math.PI);
      }
    }
    return out;
  }

  // ---------------- FFT (radix-2, in place) ----------------
  class FFT {
    constructor(n) {
      this.n = n; this.rev = new Uint32Array(n);
      const bits = Math.log2(n);
      for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); this.rev[i] = r; }
      this.cos = new Float64Array(n / 2); this.sin = new Float64Array(n / 2);
      for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos((2 * Math.PI * i) / n); this.sin[i] = Math.sin((2 * Math.PI * i) / n); }
    }
    transform(re, im, inverse) {
      const n = this.n, rev = this.rev;
      for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
      const sgn = inverse ? 1 : -1;
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1, step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let j = 0, k = 0; j < half; j++, k += step) {
            const c = this.cos[k], s = sgn * this.sin[k];
            const a = i + j, b = a + half;
            const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c;
            re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          }
        }
      }
      if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    }
  }

  // Hann-windowed Goertzel energy
  function goertzel(buf, off, len, freq, sr, win) {
    const w = (2 * Math.PI * freq) / sr, cw = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < len; i++) { const s0 = buf[off + i] * win[i] + cw * s1 - s2; s2 = s1; s1 = s0; }
    return s1 * s1 + s2 * s2 - cw * s1 * s2;
  }

  // ---------------- Band-pass (RBJ biquads; 2×HP + 2×LP = 4th-order Butterworth skirts) ----------------
  // Each mode's detector + symbol decisions run on audio band-limited to that mode's band (+margin). The chirp
  // correlator normalises by window energy, so out-of-band hum/speech/HVAC used to lower the sync score; filtering
  // removes it before detection (measured in tests/scan.test.js).
  function biquad(type, f, q, sr) {
    const w = (2 * Math.PI * f) / sr, c = Math.cos(w), s = Math.sin(w), a = s / (2 * q), a0 = 1 + a;
    const b = type === 'lp' ? [(1 - c) / 2, 1 - c, (1 - c) / 2] : [(1 + c) / 2, -(1 + c), (1 + c) / 2];
    return { b0: b[0] / a0, b1: b[1] / a0, b2: b[2] / a0, a1: (-2 * c) / a0, a2: (1 - a) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
  }
  function modeBand(mode) {
    if (typeof mode === 'string') mode = MODES[mode];
    const top = mode.f0 + (mode.bands * TONES - 1) * mode.df;
    return [Math.min(mode.chirp[0], mode.f0), Math.max(mode.chirp[1], top)];
  }
  class BandPass {
    constructor(lo, hi, sr) {
      this.st = []; const qs = [0.5412, 1.3066];
      if (lo > 30) for (const q of qs) this.st.push(biquad('hp', lo, q, sr));
      if (hi < 0.45 * sr) for (const q of qs) this.st.push(biquad('lp', hi, q, sr));
      this.lo = lo; this.hi = hi;
    }
    process(inp, out) {
      const st = this.st, n = st.length;
      for (let i = 0; i < inp.length; i++) {
        let x = inp[i];
        for (let k = 0; k < n; k++) { const b = st[k]; const y = b.b0 * x + b.b1 * b.x1 + b.b2 * b.x2 - b.a1 * b.y1 - b.a2 * b.y2; b.x2 = b.x1; b.x1 = x; b.y2 = b.y1; b.y1 = y; x = y; }
        out[i] = x;
      }
    }
  }

  // ---------------- Streaming demodulator ----------------
  // All modes in `modes` are detected in parallel (each on its own band-passed copy of the input), so a listener
  // identifies the mode from the preamble it actually hears. Events (for UI/scan): detect, sync, header, reject,
  // pattern (decided tone per symbol, also on CRC/RS failure). Frame/pattern carry a noise-floor SNR estimate.
  class Demodulator {
    constructor(opts) {
      this.sr = opts.sampleRate;
      this.modes = (opts.modes || Object.keys(MODES)).map((m) => (typeof m === 'string' ? MODES[m] : m));
      this.onFrame = opts.onFrame || (() => {});
      this.onEvent = opts.onEvent || (() => {});
      this.threshold = opts.threshold || 0.16;
      this.bandpass = opts.bandpass !== false; this.margin = opts.margin == null ? 300 : opts.margin;
      this.noiseFloor = opts.noiseFloor !== false; // per-tone floor subtraction in symbol decisions
      this.cap = Math.round(this.sr * (opts.bufferSeconds || 30)); // longest frame (255 B ROBUST) is ~17 s
      this.raw = this.bandpass ? null : new Float32Array(this.cap);
      this.bufStart = 0; this.bufLen = 0;
      this.pending = []; this.busyUntil = 0; this.lastRms = 0;
      this.stats = { detections: 0, frames: 0, crcFail: 0, headerFail: 0, rsCorrected: 0, cpuMs: 0, samples: 0 };
      this.detBy = {};
      this.det = this.modes.map((mode) => {
        const band = modeBand(mode);
        let tpl = chirpTemplate(mode, this.sr); const L = tpl.length;
        // matched filter must see the same band-pass phase response as the signal → filter the template too
        if (this.bandpass) { const f = new Float32Array(L); new BandPass(band[0] - this.margin, band[1] + this.margin, this.sr).process(tpl, f); tpl = f; }
        let N = 1; while (N < 2 * L) N <<= 1;
        const fft = new FFT(N), tre = new Float64Array(N), tim = new Float64Array(N);
        let norm = 0;
        for (let i = 0; i < L; i++) { tre[i] = tpl[i]; norm += tpl[i] * tpl[i]; }
        fft.transform(tre, tim, false);
        const d = { mode, L, N, fft, tre, tim, norm: Math.sqrt(norm), scanPos: 0, cand: null, re: new Float64Array(N), im: new Float64Array(N), e: new Float64Array(N + 1),
          band, bp: this.bandpass ? new BandPass(band[0] - this.margin, band[1] + this.margin, this.sr) : null,
          buf: this.bandpass ? new Float32Array(this.cap) : this.raw,
          nf: Array.from({ length: mode.bands }, () => new Float64Array(TONES)), nfInit: 0 };
        this.detBy[mode.name] = d; return d;
      });
      this.wins = {};
    }
    get now() { return this.bufStart + this.bufLen; }
    reset(skipTo) { const t = skipTo == null ? this.now : skipTo; for (const d of this.det) { d.scanPos = Math.max(d.scanPos, t); d.cand = null; } this.pending = []; this.busyUntil = Math.max(this.busyUntil, t); }
    isBusy() { return this.pending.length > 0 || this.busyUntil > this.now; }

    push(chunk) {
      const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
      let sq = 0; for (let i = 0; i < chunk.length; i++) sq += chunk[i] * chunk[i];
      this.lastRms = Math.sqrt(sq / Math.max(1, chunk.length));
      if (this.bufLen + chunk.length > this.cap) {
        let keep = this.now - Math.round(this.sr * 6);
        for (const d of this.det) keep = Math.min(keep, d.scanPos);
        for (const p of this.pending) keep = Math.min(keep, p.pos - Math.round(0.01 * this.sr));
        keep = Math.max(keep, this.now + chunk.length - this.cap);
        const drop = Math.max(0, keep - this.bufStart);
        const bufs = new Set(this.det.map((d) => d.buf));
        for (const b of bufs) b.copyWithin(0, drop, this.bufLen);
        this.bufStart += drop; this.bufLen -= drop;
        for (const d of this.det) if (d.scanPos < this.bufStart) d.scanPos = this.bufStart;
      }
      if (this.raw) this.raw.set(chunk, this.bufLen);
      else for (const d of this.det) d.bp.process(chunk, d.buf.subarray(this.bufLen, this.bufLen + chunk.length));
      this.bufLen += chunk.length;
      for (const d of this.det) this._scan(d);
      if (this.noiseFloor && (this.tick = (this.tick || 0) + 1) % 2 === 0 && !this.isBusy()) for (const d of this.det) this._updateFloor(d);
      this._processPending();
      this.stats.cpuMs += (typeof performance !== 'undefined' ? performance : Date).now() - t0; this.stats.samples += chunk.length;
    }
    /** Fraction of one core used so far (processing time / audio time). */
    cpuLoad() { return this.stats.samples ? this.stats.cpuMs / ((this.stats.samples / this.sr) * 1000) : 0; }

    _scan(d) {
      const { N, L, fft, re, im, e } = d, buf = d.buf;
      const hop = N - L + 1;
      while (d.scanPos + N <= this.now) {
        const off = d.scanPos - this.bufStart;
        e[0] = 0;
        for (let i = 0; i < N; i++) { const v = buf[off + i]; re[i] = v; im[i] = 0; e[i + 1] = e[i] + v * v; }
        fft.transform(re, im, false);
        for (let i = 0; i < N; i++) { const a = re[i], b = im[i], c = d.tre[i], s = -d.tim[i]; re[i] = a * c - b * s; im[i] = a * s + b * c; }
        fft.transform(re, im, true);
        let blockMax = 0;
        for (let lag = 0; lag < hop; lag++) {
          const en = e[lag + L] - e[lag];
          if (en < L * 1e-8) continue;
          const score = re[lag] / (d.norm * Math.sqrt(en));
          if (score > blockMax) blockMax = score;
          if (score > this.threshold) {
            const pos = d.scanPos + lag;
            if (d.cand && pos - d.cand.pos < L / 2) { if (score > d.cand.score) { d.cand.pos = pos; d.cand.score = score; } }
            else { if (d.cand) this._addCand(d); d.cand = { pos, score, mode: d.mode }; }
          }
        }
        this.onEvent({ type: 'sync', mode: d.mode.name, score: blockMax, threshold: this.threshold, ago: this.now - d.scanPos });
        d.scanPos += hop;
        if (d.cand && d.scanPos > d.cand.pos + L / 2) this._addCand(d);
      }
    }
    _addCand(d) {
      const c = d.cand; d.cand = null;
      if (c.pos < this.busyUntil) return;
      this.stats.detections++;
      this.pending.push(c); this.pending.sort((a, b) => a.pos - b.pos);
      this.onEvent({ type: 'detect', mode: c.mode.name, score: c.score, pos: c.pos, ago: this.now - c.pos, band: d.band });
    }

    /** Running per-tone noise floor (idle audio only): fast release downwards, slow attack upwards. */
    _updateFloor(d) {
      const mode = d.mode, slotN = Math.round(mode.slot * this.sr), len = Math.round(0.7 * slotN), win = this._win(len);
      const a = this.now - len - 1; if (a - this.bufStart < 0) return;
      const off = a - this.bufStart;
      for (let b = 0; b < mode.bands; b++) {
        const nf = d.nf[b];
        for (let t = 0; t < TONES; t++) {
          const v = goertzel(d.buf, off, len, toneFreq(mode, b, t), this.sr, win);
          nf[t] = d.nfInit < 3 ? (d.nfInit ? Math.min(nf[t], v) : v) : v < nf[t] ? nf[t] + 0.5 * (v - nf[t]) : nf[t] + 0.03 * (v - nf[t]);
        }
      }
      d.nfInit++;
    }
    _win(len) {
      if (!this.wins[len]) { const w = new Float32Array(len); for (let i = 0; i < len; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (len - 1)); this.wins[len] = w; }
      return this.wins[len];
    }
    // per band: decided nibble, confidence (best/second), tone energies, and a noise-floor estimate
    // (median of the 15 non-winning tones) → signal = best − floor.
    _symbol(mode, start) {
      const d = this.detBy[mode.name], slotN = mode.slot * this.sr, buf = d.buf, useNf = this.noiseFloor && d.nfInit >= 3;
      const a = Math.round(start + 0.18 * slotN), len = Math.round(0.7 * slotN), win = this._win(len);
      const off = a - this.bufStart, res = [];
      for (let b = 0; b < mode.bands; b++) {
        let best = -1, bi = 0, second = 0, sum = 0; const en = new Float64Array(TONES), raw = new Float64Array(TONES);
        for (let t = 0; t < TONES; t++) {
          let v = goertzel(buf, off, len, toneFreq(mode, b, t), this.sr, win); raw[t] = v;
          if (useNf) v = Math.max(0, v - d.nf[b][t]); // steady whines / hum lines removed before decisions
          en[t] = v; sum += v;
          if (v > best) { second = best; best = v; bi = t; } else if (v > second) second = v;
        }
        const others = Array.from(raw).filter((_, i) => i !== bi).sort((x, y) => x - y);
        const floor = Math.max(others[7], 1e-12); // raw median of the non-winning tones = local noise floor
        res.push({ nib: bi, conf: best / (second + 1e-12), en, sum, floor, sig: Math.max(0, best - floor) });
      }
      return res;
    }
    _symStart(mode, pos, k, adj) { return pos + adj + Math.round((mode.chirpDur + GAP) * this.sr) + k * mode.slot * this.sr; }
    _pattern(c, syms, extra) {
      const mode = c.mode;
      this.onEvent(Object.assign({ type: 'pattern', mode: mode.name, band: this.detBy[mode.name].band, pos: c.pos + (c.adj || 0), ago: this.now - (c.pos + (c.adj || 0)),
        dataStart: Math.round((mode.chirpDur + GAP) * this.sr), slotN: mode.slot * this.sr, chirpN: Math.round(mode.chirpDur * this.sr),
        train: mode.train, hdrSyms: headerSymbols(mode), syms: syms.map((s) => s.map((x) => x.nib)), lastEnergies: syms.length ? syms[syms.length - 1].map((x) => Array.from(x.en)) : null }, extra));
    }
    /** Per-tone noise floor over a frame: for each band/tone, median energy over the symbols where that tone did
     *  NOT win (so a data tone repeated many times does not erase itself). Coloured noise (hum harmonics, speech,
     *  a fan line) lifts specific tones; subtracting their floor before the arg-max whitens it. */
    _redecide(mode, syms) {
      if (!this.noiseFloor || syms.length < 4) return syms;
      const floors = [];
      for (let b = 0; b < mode.bands; b++) {
        const fl = new Float64Array(TONES);
        for (let t = 0; t < TONES; t++) {
          const v = []; for (const sy of syms) if (sy[b].nib !== t) v.push(sy[b].en[t]);
          if (v.length >= 3) { v.sort((x, y) => x - y); fl[t] = v[v.length >> 1]; }
        }
        floors.push(fl);
      }
      return syms.map((sy) => sy.map((x, b) => {
        let best = -Infinity, bi = 0, second = -Infinity; const fl = floors[b];
        for (let t = 0; t < TONES; t++) { const v = x.en[t] - fl[t]; if (v > best) { second = best; best = v; bi = t; } else if (v > second) second = v; }
        return { nib: bi, conf: Math.max(1, best / Math.max(1e-12, second)), en: x.en, sum: x.sum, floor: x.floor, sig: Math.max(0, best) };
      }));
    }
    static snrOf(syms) { let s = 0, n = 0; for (const sy of syms) for (const b of sy) { s += b.sig; n += b.floor; } return n > 0 ? Math.min(60, 10 * Math.log10(Math.max(1e-6, s / n))) : null; }

    _processPending() {
      while (this.pending.length) {
        const c = this.pending[0], mode = c.mode, sr = this.sr;
        if (c.pos < this.busyUntil) { this.pending.shift(); continue; }
        const maxAdj = Math.round(0.006 * sr);
        const hSyms = headerSymbols(mode);
        const needHdr = this._symStart(mode, c.pos, mode.train + hSyms, maxAdj) + 1;
        if (needHdr > this.now) return; // wait for more audio
        if (c.adj == null) {
          // fine timing on training symbols (PN-style verification)
          const tn = trainingNibbles(mode);
          let bestAdj = 0, bestScore = -1;
          for (let adj = -maxAdj; adj <= maxAdj; adj += Math.max(1, Math.round(sr * 0.0005))) {
            let sc = 0;
            for (let k = 0; k < mode.train; k++) {
              const sy = this._symbol(mode, this._symStart(mode, c.pos, k, adj));
              for (let b = 0; b < mode.bands; b++) sc += sy[b].en[tn[k * mode.bands + b]] / (sy[b].sum + 1e-12);
            }
            sc /= mode.train * mode.bands;
            if (sc > bestScore) { bestScore = sc; bestAdj = adj; }
          }
          c.trainScore = bestScore;
          if (bestScore < 0.35) { this.pending.shift(); this.onEvent({ type: 'reject', mode: mode.name, reason: 'training', score: bestScore, ago: this.now - c.pos }); continue; }
          c.adj = bestAdj;
          c.syms = [];
          for (let k = 0; k < mode.train + hSyms; k++) c.syms.push(this._symbol(mode, this._symStart(mode, c.pos, k, c.adj)));
          c.syms = this._redecide(mode, c.syms);
          const nib = [];
          for (let k = mode.train; k < mode.train + hSyms; k++) for (const s of c.syms[k]) nib.push(s.nib);
          const dec = RS.decode(nibblesToBytes(nib.slice(0, (HDR_LEN + HDR_NSYM) * 2)), HDR_NSYM);
          if (!dec || (dec.data[0] >> 4) !== MAGIC || (dec.data[0] & 15) !== mode.id || RS.crc8(dec.data.subarray(0, 3)) !== dec.data[3]) {
            this.stats.headerFail++; this.pending.shift();
            const snrDb = Demodulator.snrOf(c.syms.slice(mode.train));
            this.onEvent({ type: 'reject', mode: mode.name, reason: 'header', snrDb, ago: this.now - c.pos, score: c.score });
            this._pattern(c, c.syms, { ok: false, reason: 'header', snrDb, score: c.score });
            continue;
          }
          c.len = dec.data[1]; c.flags = dec.data[2];
          this.onEvent({ type: 'header', mode: mode.name, len: c.len, trainScore: bestScore, airtime: frameDuration(mode, c.len), ago: this.now - c.pos });
        }
        const bSyms = bodySymbols(mode, c.len), first = mode.train + hSyms;
        const end = this._symStart(mode, c.pos, first + bSyms, c.adj);
        if (end + 1 > this.now) return;
        const nib = []; let conf = 0; let body = [];
        for (let k = 0; k < bSyms; k++) body.push(this._symbol(mode, this._symStart(mode, c.pos, first + k, c.adj)));
        if (this.noiseFloor) { const all = this._redecide(mode, c.syms.concat(body)); body = all.slice(c.syms.length); }
        for (const sy of body) for (const s of sy) { nib.push(s.nib); conf += Math.min(s.conf, 50); }
        const nbytes = c.len + 4 + mode.nsym;
        const dec = RS.decode(nibblesToBytes(nib.slice(0, nbytes * 2)), mode.nsym);
        this.pending.shift();
        this.busyUntil = Math.round(end);
        for (const d of this.det) { if (d.cand && d.cand.pos < this.busyUntil) d.cand = null; }
        const snrDb = Demodulator.snrOf(body);
        const allSyms = c.syms.concat(body);
        if (!dec) { this.stats.crcFail++; this.onEvent({ type: 'reject', mode: mode.name, reason: 'rs', len: c.len, snrDb, ago: this.now - c.pos, score: c.score }); this._pattern(c, allSyms, { ok: false, reason: 'rs', len: c.len, snrDb, score: c.score }); continue; }
        const pl = dec.data.subarray(0, c.len), cr = dec.data.subarray(c.len);
        const crc = ((cr[0] << 24) | (cr[1] << 16) | (cr[2] << 8) | cr[3]) >>> 0;
        if (crc !== RS.crc32(pl)) { this.stats.crcFail++; this.onEvent({ type: 'reject', mode: mode.name, reason: 'crc', len: c.len, snrDb, ago: this.now - c.pos, score: c.score }); this._pattern(c, allSyms, { ok: false, reason: 'crc', len: c.len, snrDb, score: c.score }); continue; }
        this.stats.frames++; this.stats.rsCorrected += dec.corrected;
        this._pattern(c, allSyms, { ok: true, len: c.len, snrDb, score: c.score, rsCorrected: dec.corrected });
        this.onFrame({ mode: mode.name, payload: Uint8Array.from(pl), flags: c.flags, rsCorrected: dec.corrected, quality: conf / (bSyms * mode.bands), score: c.score, trainScore: c.trainScore, snrDb, band: this.detBy[mode.name].band });
      }
    }
  }

  const api = { MODES, encodeFrame, Demodulator, BandPass, modeBand, frameDuration, maxPayload, chirpTemplate, toneFreq, FFT, modeById, TONES };
  root.ChirpModem = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
