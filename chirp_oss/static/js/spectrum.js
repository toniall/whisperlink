/* WhisperLink OSS — live waterfall, sync detector, and tone-energy display.
 * Author: Antonio Brandao
 * License: MIT
 *
 * Default view is the RAW full spectrum (all noise visible); the communication is highlighted on top of it.
 * 1. band-pass: the demodulator band-passes each mode before detection; here the active mode's band is tinted
 *    (and, with Scan all modes, every mode's band edges are drawn).
 * 2. per-bin running noise floor: drives the tone bars / detection; the optional "Clean view" also subtracts it
 *    from the waterfall and zooms to the active band — off by default.
 * 3. pattern markers: a box from the preamble to the frame end, one dot per decided tone per symbol;
 *    green = CRC ok, red = heard but RS/CRC/header failed.
 * 4. tone-energy bars: live energy in each of the 16 tone slots of each band of the focus mode, with the
 *    last decided symbol marked.
 * 5. detection meter: chirp matched-filter score per mode vs its noise baseline and the threshold, with history.
 * + scan: whole spectrum, every mode's band outlined, and a decoded-frame log for every preamble heard.
 */
(function (root) {
  'use strict';
  const M = root.ChirpModem, S = root.ChirpSession;
  const FFTN = 1024, HIST = 300, MODE_COLORS = ['#38bdf8', '#a78bfa', '#fbbf24', '#f472b6', '#34d399', '#fb7185'];

  function create(o) {
    const $ = (s) => document.querySelector(s);
    const modes = o.modes, modeNames = modes.map((m) => m.name);
    const colorOf = (name) => MODE_COLORS[Math.max(0, modeNames.indexOf(name)) % MODE_COLORS.length];
    const fft = new M.FFT(FFTN), hann = Float32Array.from({ length: FFTN }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFTN - 1)));
    const re = new Float64Array(FFTN), im = new Float64Array(FFTN), dbs = new Float32Array(FFTN / 2);
    const nf = new Float32Array(FFTN / 2).fill(-90); let nfN = 0;
    let carry = new Float32Array(0), carryDir = 'rx';
    const marks = [];                      // queued overlays, drawn right after the columns they belong to
    const sync = {}; modeNames.forEach((n) => { sync[n] = { hist: [], base: 0.05, last: 0, detAt: 0 }; });
    let focus = null, lastPattern = null, lastDb = null, sr = 48000, rows = 0, colsSince = 0;
    const css = (v) => getComputedStyle(document.body).getPropertyValue(v).trim();
    let palette = null;
    function buildPalette() {
      const a = (css('--wf') || '56,189,248').split(',').map(Number);
      palette = Array.from({ length: 64 }, (_, i) => { const t = i / 63; let r, g, b;
        if (t < 0.6) { const k = t / 0.6; r = 8 + (a[0] - 8) * k; g = 12 + (a[1] - 12) * k; b = 24 + (a[2] - 24) * k; }
        else { const k = (t - 0.6) / 0.4; r = a[0] + (255 - a[0]) * k; g = a[1] + (255 - a[1]) * k; b = a[2] + (255 - a[2]) * k; }
        return `rgb(${r | 0},${g | 0},${b | 0})`; });
    }
    const scanOn = () => { const e = $('#scanAll'); return !!(e && e.checked); };
    const nfOn = () => { const e = $('#cleanView'); return !!(e && e.checked); };
    function activeMode() { return M.MODES[o.getMode()] || modes[0]; }
    function focusMode() { return (scanOn() && focus && M.MODES[focus]) || activeMode(); }
    function view() {
      if (!nfOn()) return [0, o.maxFreq];
      const b = M.modeBand(activeMode()); return [Math.max(0, b[0] - 400), Math.min(sr / 2, b[1] + 400)];
    }
    function updateLabel() {
      const v = view(), e = $('#wfRange'); if (!e) return;
      e.textContent = `${(v[0] / 1000).toFixed(1)}–${(v[1] / 1000).toFixed(1)} kHz · ${nfOn() ? 'clean view: ' + activeMode().name + ' band, noise floor removed' : 'raw audio, nothing filtered'} · tint = ${activeMode().name} band${scanOn() ? ', lines = other modes' : ''} · amber = our TX · boxes = frames (green ok, red failed), dots = decoded tones`;
    }

    // ---- 1+2: waterfall ----
    function column(dir) {
      for (let i = 0; i < FFTN; i++) im[i] = 0;
      fft.transform(re, im, false);
      for (let i = 0; i < FFTN / 2; i++) dbs[i] = 10 * Math.log10(re[i] * re[i] + im[i] * im[i] + 1e-12);
      if (dir === 'rx') { // floor tracks quiet quickly, rises slowly (≈10 s), so a signal does not raise it
        nfN++; for (let i = 0; i < FFTN / 2; i++) { const d = dbs[i] - nf[i]; nf[i] += nfN < 8 ? d * 0.5 : d < 0 ? d * 0.3 : d * 0.004; }
      }
      lastDb = dbs; const [lo, hi] = view(), sub = nfOn() && nfN > 8;
      if (!palette) buildPalette();
      for (const c of o.waterfalls) {
        const g = c.getContext('2d'), w = c.width, h = c.height; if (!w || !h) continue;
        g.drawImage(c, -2, 0);
        for (let y = 0; y < h; y++) {
          const f = lo + ((h - 1 - y + 0.5) / h) * (hi - lo), bin = Math.min(FFTN / 2 - 1, Math.round((f / sr) * FFTN));
          const v = sub ? (dbs[bin] - nf[bin] - 2) / 34 : (dbs[bin] + 40) / 70;
          g.fillStyle = palette[Math.max(0, Math.min(63, Math.round(v * 63)))]; g.fillRect(w - 2, y, 2, 1);
        }
        // highlight overlay: tint the active mode band; with scan, mark every other mode's band edges
        const am = activeMode(), ab = M.modeBand(am);
        g.globalAlpha = 0.22; g.fillStyle = colorOf(am.name);
        const ty0 = Math.max(0, yOf(ab[1], h)), ty1 = Math.min(h, yOf(ab[0], h)); if (ty1 > ty0) g.fillRect(w - 2, ty0, 2, ty1 - ty0);
        g.globalAlpha = 1; if (ty0 > 0) g.fillRect(w - 2, ty0, 2, 1); if (ty1 < h) g.fillRect(w - 2, ty1 - 1, 2, 1);
        g.globalAlpha = 0.8;
        if (scanOn() && (colsSince & 3) < 2) for (const m of modes) { if (m.name === am.name) continue; const b = M.modeBand(m); g.fillStyle = colorOf(m.name);
          for (const f of b) { const y = yOf(f, h); if (y >= 0 && y < h) g.fillRect(w - 2, y, 2, 1); } }
        g.globalAlpha = 1;
        if (dir === 'tx') { g.fillStyle = 'rgba(255,190,90,.9)'; g.fillRect(w - 2, 0, 2, 3); }
      }
      colsSince++;
    }
    let viewKey = '';
    function onAudio(chunk, dir, sampleRate) {
      sr = sampleRate || sr;
      const vk = view().join('-') + nfOn(); if (vk !== viewKey) { viewKey = vk; refresh(); }
      let data = chunk;
      if (carry.length && carryDir === dir) { data = new Float32Array(carry.length + chunk.length); data.set(carry); data.set(chunk, carry.length); }
      let off = 0;
      for (; off + FFTN <= data.length; off += FFTN) { for (let i = 0; i < FFTN; i++) re[i] = data[off + i] * hann[i]; column(dir); }
      carry = data.slice(off); carryDir = dir;
      if (marks.length) flushMarks();
      dirty = true;
    }
    const yOf = (f, h) => { const [lo, hi] = view(); return h - ((f - lo) / (hi - lo)) * h; };
    // 3: overlays. x of a sample that is `ago` samples old = w - 2*ago/FFTN (2 px per FFT column).
    function flushMarks() {
      const pend = carry.length;
      for (const c of o.waterfalls) {
        const g = c.getContext('2d'), w = c.width, h = c.height; if (!w || !h) continue;
        const px = (ago) => w - (2 * (ago - pend)) / FFTN;
        for (const m of marks) {
          const mode = M.MODES[m.mode]; if (!mode) continue;
          const band = m.band || M.modeBand(mode), [lo, hi] = view();
          if (band[1] < lo || band[0] > hi) continue;
          const y0 = Math.max(0, yOf(band[1], h)), y1 = Math.min(h, yOf(band[0], h));
          g.save(); g.lineWidth = 2 * Math.max(1, devicePixelRatio);
          if (m.type === 'detect') {
            const x = px(m.ago); g.strokeStyle = colorOf(m.mode); g.setLineDash([3, 3]);
            g.beginPath(); g.moveTo(x, y0); g.lineTo(x, y1); g.stroke();
          } else if (m.type === 'pattern') {
            const x0 = px(m.ago), dur = m.dataStart + m.syms.length * m.slotN, x1 = px(m.ago - dur);
            g.strokeStyle = m.ok ? '#39ff7a' : '#ff3b3b';
            g.strokeRect(x0, y0, Math.max(2, x1 - x0), Math.max(2, y1 - y0));
            const ds = Math.max(3, Math.min(6, (2 * m.slotN) / FFTN)) * devicePixelRatio; // one mark per decided tone
            g.fillStyle = m.ok ? '#ffe600' : '#ff8a3b';
            m.syms.forEach((s, k) => { const x = px(m.ago - m.dataStart - (k + 0.5) * m.slotN);
              s.forEach((nib, b) => { const y = yOf(M.toneFreq(mode, b, nib), h); g.fillRect(x - ds / 2, y - 1, ds, 3); }); });
            g.fillStyle = 'rgba(0,0,0,.65)'; g.fillRect(x0, y0, 120 * devicePixelRatio, 13 * devicePixelRatio);
            g.font = `bold ${10 * devicePixelRatio}px system-ui`; g.fillStyle = g.strokeStyle;
            g.fillText(`${m.mode} ${m.ok ? '✓ CRC ok' : '✗ ' + m.reason}`, x0 + 3, y0 + 10 * devicePixelRatio);
          }
          g.restore();
        }
      }
      marks.length = 0;
    }

    // ---- 4+5: bars, meter, graph (throttled to ~12 fps; nothing drawn while the tab is hidden) ----
    let dirty = false, lastDraw = 0;
    function frame(t) {
      if (dirty && t - lastDraw > 80 && !document.hidden) { lastDraw = t; dirty = false; drawBars($('#bars'), false); drawBars($('#toneBars'), true); drawSync(); meterText(); }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    function drawBars(c, big) {
      if (!c || !c.width || !lastDb) return;
      const g = c.getContext('2d'), w = c.width, h = c.height, mode = focusMode(), sub = nfN > 8;
      g.clearRect(0, 0, w, h);
      const n = mode.bands * 16, gap = (mode.bands - 1) * 6 * devicePixelRatio, bw = (w - gap) / n, top = big ? 14 * devicePixelRatio : 0;
      const last = lastPattern && lastPattern.mode === mode.name && lastPattern.syms.length ? lastPattern.syms[lastPattern.syms.length - 1] : null;
      for (let b = 0; b < mode.bands; b++) {
        let best = -1, bi = 0; const vals = [];
        for (let t = 0; t < 16; t++) { const bin = Math.round((M.toneFreq(mode, b, t) / sr) * FFTN); const d = bin < FFTN / 2 ? dbs[bin] - (sub ? nf[bin] : -40) : 0; vals.push(d); if (d > best) { best = d; bi = t; } }
        for (let t = 0; t < 16; t++) {
          const v = Math.max(0, Math.min(1, vals[t] / (sub ? 36 : 70))), x = (b * 16 + t) * bw + b * 6 * devicePixelRatio, bh = v * (h - top);
          g.fillStyle = t === bi && v > 0.25 ? css('--accent') : css('--muted'); g.globalAlpha = 0.35 + 0.65 * v;
          g.fillRect(x + 1, h - bh, Math.max(1, bw - 2), bh);
          if (last && last[b] === t) { g.globalAlpha = 1; g.fillStyle = lastPattern.ok ? css('--ok') : css('--bad'); g.fillRect(x + 1, top, Math.max(1, bw - 2), 3 * devicePixelRatio); }
        }
      }
      g.globalAlpha = 1;
      if (big) { g.fillStyle = css('--muted'); g.font = `${10 * devicePixelRatio}px system-ui`; g.fillText(`${mode.name}: ${mode.bands}×16 tones · bar = energy${sub ? ' above floor' : ''} · top mark = last decided symbol`, 2, 10 * devicePixelRatio); }
      const tt = $('#toneTitle'); if (tt && big) tt.textContent = `${mode.name} ${(M.modeBand(mode)[0] / 1000).toFixed(1)}–${(M.modeBand(mode)[1] / 1000).toFixed(1)} kHz`;
    }
    function drawSync() {
      const c = $('#syncGraph'); if (!c || !c.width) return;
      const g = c.getContext('2d'), w = c.width, h = c.height, thr = o.threshold(), top = 0.6, yv = (v) => h - (Math.min(top, v) / top) * h;
      g.clearRect(0, 0, w, h);
      g.strokeStyle = css('--bad'); g.setLineDash([5, 4]); g.beginPath(); g.moveTo(0, yv(thr)); g.lineTo(w, yv(thr)); g.stroke(); g.setLineDash([]);
      g.fillStyle = css('--muted'); g.font = `${10 * devicePixelRatio}px system-ui`; g.fillText(`threshold ${thr}`, 4, yv(thr) - 3);
      const show = scanOn() ? modeNames : [activeMode().name];
      show.forEach((n, k) => { const s = sync[n], pts = s.hist; if (!pts.length) return;
        g.strokeStyle = colorOf(n); g.lineWidth = 1.5 * devicePixelRatio; g.beginPath();
        pts.forEach((v, i) => { const x = w - (pts.length - 1 - i) * (w / HIST); i ? g.lineTo(x, yv(v)) : g.moveTo(x, yv(v)); }); g.stroke();
        g.globalAlpha = 0.5; g.setLineDash([2, 3]); g.beginPath(); g.moveTo(0, yv(s.base)); g.lineTo(w, yv(s.base)); g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
        g.fillStyle = colorOf(n); g.fillText(n, w - 80 * devicePixelRatio, 12 * devicePixelRatio * (k + 1)); });
    }
    function meterText() {
      const e = $('#syncMeter'); if (!e) return;
      const show = scanOn() ? modeNames : [activeMode().name], thr = o.threshold();
      e.textContent = show.map((n) => { const s = sync[n]; const margin = 20 * Math.log10(Math.max(1e-3, s.last) / Math.max(1e-3, s.base));
        return `${n} ${s.last.toFixed(2)} (noise ${s.base.toFixed(2)}, ${margin >= 0 ? '+' : ''}${margin.toFixed(1)} dB)${Date.now() - s.detAt < 1500 ? ' ●' : ''}`; }).join(' · ') + ` · thr ${thr}`;
      const d = $('#dspInfo'); if (d) { const load = o.cpuLoad(); d.textContent = load == null ? '' : `demodulator ${modes.length} modes · ${(load * 100).toFixed(1)}% of one CPU core`; }
    }

    // ---- events from the demodulator ----
    function onEvent(e) {
      if (e.type === 'sync' && sync[e.mode]) {
        const s = sync[e.mode]; s.last = e.score; s.hist.push(e.score); if (s.hist.length > HIST) s.hist.shift();
        if (e.score < e.threshold) s.base += (e.score - s.base) * 0.02; // noise baseline = slow mean of non-detect scores
        dirty = true;
      } else if (e.type === 'detect') {
        if (sync[e.mode]) sync[e.mode].detAt = Date.now(); marks.push(e);
      } else if (e.type === 'pattern') {
        lastPattern = e; focus = e.mode; marks.push(e);
        if (!e.ok) addRow({ mode: e.mode, band: e.band, snrDb: e.snrDb, ok: false, reason: e.reason, len: e.len });
      } else if (e.type === 'frame') {
        addRow({ mode: e.mode, band: e.band, snrDb: e.snrDb, ok: true, payload: e.payload, rs: e.rsCorrected });
      }
    }

    // ---- scan log ----
    const hex = (b, n) => Array.from(b.slice(0, n), (x) => x.toString(16).padStart(2, '0')).join(' ') + (b.length > n ? ' …' : '');
    const ascii = (b) => Array.from(b, (x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '·')).join('');
    function describe(p) {
      const ext = o.describe && o.describe(p); if (ext) return ext;
      const hd = S.parseHeader(p);
      if (!hd) { const txt = ascii(p); return { kind: 'non-session frame', detail: /^[\x20-\x7e]+$/.test(new TextDecoder().decode(p)) ? `"${txt.slice(0, 48)}"` : hex(p, 16) }; }
      const fl = Object.entries(S.F).filter(([, v]) => hd.flags & v).map(([k]) => k).join('|');
      const body = p.slice(S.HDR);
      const head = `${S.TNAME[hd.type]} sid ${hd.sid.toString(16).padStart(4, '0')} seq ${hd.seq} ack ${hd.ack}${fl ? ' ' + fl : ''}`;
      return { kind: head, detail: body.length ? `${body.length} B: ${hex(body, 12)} | ${ascii(body.slice(0, 32))}` : '(no payload)' };
    }
    function td(t, cls) { const c = document.createElement('td'); c.textContent = t; if (cls) c.className = cls; return c; }
    function addRow(r) {
      const tb = $('#scanLog'); if (!tb) return;
      const tr = document.createElement('tr'), d = r.payload ? describe(r.payload) : null, band = r.band || [0, 0];
      tr.append(td(new Date().toLocaleTimeString()), td(r.mode), td(`${(band[0] / 1000).toFixed(1)}–${(band[1] / 1000).toFixed(1)} kHz`),
        td(r.snrDb == null ? '—' : r.snrDb.toFixed(1) + ' dB'),
        td(r.ok ? `CRC ok${r.rs ? ' (RS fixed ' + r.rs + ')' : ''}` : r.reason === 'header' ? 'header unreadable' : `${r.reason.toUpperCase()} fail${r.len ? ' (' + r.len + ' B)' : ''}`, r.ok ? 'ok' : 'bad'),
        td(d ? d.kind : 'pattern seen, not decodable'), td(d ? d.detail : '—', 'mono'));
      tr.firstChild.style.borderLeft = `3px solid ${colorOf(r.mode)}`;
      tb.prepend(tr); rows++; while (tb.children.length > 120) tb.lastChild.remove();
      const cnt = $('#scanCount'); if (cnt) cnt.textContent = `${rows} frames`;
    }
    function clear() { const tb = $('#scanLog'); if (tb) tb.textContent = ''; rows = 0; const cnt = $('#scanCount'); if (cnt) cnt.textContent = ''; }
    function refresh() { // view changed: clear the waterfalls (old columns used another frequency scale)
      for (const c of o.waterfalls) { const g = c.getContext('2d'); g.clearRect(0, 0, c.width, c.height); }
      palette = null; updateLabel(); dirty = true;
    }
    ['#scanAll', '#cleanView'].forEach((id) => { const e = $(id); if (e) e.addEventListener('change', refresh); });
    const cb = $('#scanClear'); if (cb) cb.addEventListener('click', clear);
    updateLabel();
    return { onAudio, onEvent, refresh, clear, updateLabel, _state: () => ({ sync, nf, rows, colsSince }) };
  }
  root.ChirpSpectrum = { create };
})(typeof window !== 'undefined' ? window : globalThis);
