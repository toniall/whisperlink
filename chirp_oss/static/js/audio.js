/*! WhisperLink OSS — speaker/mic acoustic link and in-page simulated peer.
 * Author: Antonio Brandao
 * License: MIT
 */
(function (root) {
  'use strict';
  const M = root.ChirpModem;

  /** Real acoustic link: speaker TX, microphone RX. Half-duplex: own transmissions are ignored. */
  class AudioLink {
    constructor(opts = {}) {
      this.modes = opts.modes; this.volume = opts.volume || 0.7; this.onFrame = null; this.onAudio = opts.onAudio || (() => {});
      this.onEvent = opts.onEvent || (() => {}); this.txing = false; this.ctx = null; this.demod = null; this.micOn = false;
      this.workletUrl = opts.workletUrl; this.stats = { detects: 0, decoded: 0, rejected: {}, tx: 0, lastDetect: 0 };
    }
    _newCtx(sampleRate) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('This browser has no Web Audio API');
      this.ctx = sampleRate ? new AC({ latencyHint: 'interactive', sampleRate }) : new AC({ latencyHint: 'interactive' });
      this.demod = new M.Demodulator({ sampleRate: this.ctx.sampleRate, modes: this.modes,
        onFrame: (f) => { this.stats.decoded++; this.onEvent(frameEvent(f)); this._frame(f); },
        onEvent: (e) => {
          if (e.type === 'detect') { this.stats.detects++; this.stats.lastDetect = Date.now(); }
          if (e.type === 'reject') this.stats.rejected[e.reason] = (this.stats.rejected[e.reason] || 0) + 1;
          this.onEvent(e);
        } });
      this.ctx.onstatechange = () => this.onEvent({ type: 'ctx', state: this.ctx.state });
    }
    ensureCtx() {
      if (!this.ctx) this._newCtx();
      if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
      return this.ctx;
    }
    /** Resume the AudioContext (must be called from a click). Resolves to the final state. */
    async resume() {
      const ctx = this.ensureCtx();
      if (ctx.state !== 'running') { try { await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 1500))]); } catch (_) { /* reported below */ } }
      return ctx.state;
    }
    get sampleRate() { return this.ctx ? this.ctx.sampleRate : 48000; }
    // Seconds between "buffer finished on the render clock" and "its echo has left our mic".
    get echoTail() {
      const c = this.ctx; const out = c ? (c.outputLatency || 0) + (c.baseLatency || 0) : 0;
      return Math.min(0.6, 0.12 + out + 0.08);
    }
    async startMic() {
      if (this.micOn) return; // idempotent: a 2nd capture node would feed every block twice and break RX timing
      if (!window.isSecureContext || !navigator.mediaDevices) throw new Error('Microphone needs HTTPS or localhost (secure context).');
      this.ensureCtx();
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
      let src;
      try { src = this.ctx.createMediaStreamSource(this.stream); }
      catch (e) { // Firefox: mic rate must match the context rate
        const sr = this.stream.getAudioTracks()[0].getSettings().sampleRate;
        if (!sr) throw e;
        try { this.ctx.close(); } catch (_) { /* ignore */ }
        this._newCtx(sr); await this.resume(); src = this.ctx.createMediaStreamSource(this.stream);
      }
      const ctx = this.ctx;
      const sink = ctx.createGain(); sink.gain.value = 0; sink.connect(ctx.destination);
      const handle = (data) => {
        if (this.txing && !this.selfTest) { this.onAudio(data, 'tx'); return; }
        this.demod.push(data); this.onAudio(data, 'rx');
      };
      if (ctx.audioWorklet && this.workletUrl && typeof AudioWorkletNode !== 'undefined') {
        await ctx.audioWorklet.addModule(this.workletUrl);
        this.node = new AudioWorkletNode(ctx, 'chirp-capture');
        this.node.port.onmessage = (e) => handle(e.data);
      } else {
        this.node = ctx.createScriptProcessor(2048, 1, 1);
        this.node.onaudioprocess = (e) => handle(new Float32Array(e.inputBuffer.getChannelData(0)));
      }
      this.src = src; this.sink = sink;
      src.connect(this.node); this.node.connect(sink); this.micOn = true;
      const tr = this.stream.getAudioTracks()[0];
      if (tr) {
        tr.onended = () => { this.micOn = false; this.onEvent({ type: 'mic', state: 'ended' }); };
        tr.onmute = () => this.onEvent({ type: 'mic', state: 'muted' });
        tr.onunmute = () => this.onEvent({ type: 'mic', state: 'unmuted' });
      }
      if (ctx.state !== 'running') await this.resume();
    }
    stopMic() {
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      try { if (this.src) this.src.disconnect(); if (this.node) this.node.disconnect(); if (this.sink) this.sink.disconnect(); } catch (_) { /* ignore */ }
      if (this.node && this.node.port) this.node.port.onmessage = null;
      this.stream = this.node = this.src = this.sink = null; this.micOn = false;
    }
    isBusy() { return this.txing || (this.demod && this.demod.isBusy()); }
    level() { return this.demod ? this.demod.lastRms : 0; }
    _frame(f) { if (this.onFrame) this.onFrame(f.payload, f); }
    transmit(bytes, mode, opts = {}) {
      const ctx = this.ensureCtx();
      const samples = M.encodeFrame(mode, bytes, ctx.sampleRate, { volume: this.volume });
      const buf = ctx.createBuffer(1, samples.length, ctx.sampleRate); buf.copyToChannel(samples, 0);
      const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination);
      this.txing = true; this.selfTest = !!opts.selfTest; this.stats.tx++;
      if (!this.micOn) this._feedSpectrum(samples);
      const durMs = (samples.length / ctx.sampleRate) * 1000;
      return new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return; done = true; clearTimeout(guard);
          // drop any echo of our own frame (speaker+mic latency); resume listening after the tail
          setTimeout(() => { if (!this.selfTest && this.demod) this.demod.reset(); this.txing = false; resolve(); }, this.echoTail * 1000);
        };
        src.onended = finish;
        // never hang the session if the context is suspended / onended is lost
        const guard = setTimeout(() => { if (ctx.state !== 'running') this.onEvent({ type: 'ctx', state: ctx.state, stalled: true }); finish(); }, durMs + 2500);
        if (ctx.state !== 'running') ctx.resume().catch(() => {});
        src.start();
      });
    }
    _feedSpectrum(samples) { // show our TX on the spectrum even without a microphone
      const step = 2048, t0 = performance.now(), sr = this.sampleRate;
      let i = 0; const tick = () => { while (i < samples.length && (i / sr) * 1000 <= performance.now() - t0) { this.onAudio(samples.subarray(i, i + step), 'tx'); i += step; } if (i < samples.length) requestAnimationFrame(tick); };
      tick();
    }
  }

  /** Spectrum/scan log event for a CRC-valid frame (any mode the demodulator listens to). */
  function frameEvent(f) { return { type: 'frame', mode: f.mode, payload: f.payload, snrDb: f.snrDb, band: f.band, rsCorrected: f.rsCorrected, score: f.score }; }

  /** Simulated medium for single-device demos: real modem encode/decode + AWGN + random drops. */
  class SimMedium {
    constructor(opts = {}) { this.sr = 48000; this.snrDb = opts.snrDb == null ? 18 : opts.snrDb; this.drop = opts.drop || 0; this.busyUntil = 0; this.stations = []; this.modes = opts.modes; }
    station(name, onAudio, onEvent) {
      const med = this;
      const st = {
        name, onFrame: null, onAudio: onAudio || (() => {}), onEvent: onEvent || (() => {}),
        demod: null, txing: false,
        isBusy() { return performance.now() < med.busyUntil || this.txing; },
        level() { return 0; },
        transmit(bytes, mode) {
          const s = M.encodeFrame(mode, bytes, med.sr, { volume: 0.5 });
          const dur = (s.length / med.sr) * 1000;
          med.busyUntil = Math.max(med.busyUntil, performance.now() + dur);
          this.txing = true;
          const sigma = 0.5 / Math.sqrt(2) / Math.pow(10, med.snrDb / 20) / 2;
          const dropped = Math.random() < med.drop;
          const noisy = new Float32Array(s.length + 4096);
          for (let i = 0; i < noisy.length; i++) { const g = Math.sqrt(-2 * Math.log(Math.random() + 1e-12)) * Math.cos(6.283185 * Math.random()); noisy[i] = (dropped ? 0.02 : 1) * (s[i] || 0) + sigma * g; }
          return new Promise((resolve) => {
            const t0 = performance.now(); let i = 0;
            const tick = () => {
              const due = Math.min(noisy.length, Math.floor(((performance.now() - t0) / 1000) * med.sr));
              while (i < due) {
                const chunk = noisy.subarray(i, Math.min(due, i + 2048)); i += chunk.length;
                this.onAudio(chunk, 'tx');
                for (const o of med.stations) if (o !== this) { o.demod.push(chunk); o.onAudio(chunk, 'rx'); }
              }
              if (i < noisy.length) setTimeout(tick, 20); else { this.txing = false; resolve(); }
            };
            tick();
          });
        },
      };
      st.demod = new M.Demodulator({ sampleRate: med.sr, modes: med.modes, onEvent: (e) => st.onEvent(e), onFrame: (f) => { st.onEvent(frameEvent(f)); if (st.onFrame) st.onFrame(f.payload, f); } });
      this.stations.push(st); return st;
    }
  }

  /** Offline loopback: modem only, no session. Returns per-mode results. */
  function loopbackTest(modes, snrDb = 12) {
    const sr = 48000, res = [];
    for (const m of modes) {
      const payload = new TextEncoder().encode('WhisperLink loopback ' + m + ' ' + Date.now());
      const s = M.encodeFrame(m, payload, sr, { volume: 0.5 });
      const sigma = 0.5 / Math.sqrt(2) / Math.pow(10, snrDb / 20) / 2;
      const x = new Float32Array(s.length + sr); const off = 3000;
      for (let i = 0; i < x.length; i++) { const g = Math.sqrt(-2 * Math.log(Math.random() + 1e-12)) * Math.cos(6.283185 * Math.random()); x[i] = (s[i - off] || 0) + sigma * g; }
      let got = null; const d = new M.Demodulator({ sampleRate: sr, modes: [m], onFrame: (f) => { got = f; } });
      const t0 = performance.now(); for (let i = 0; i < x.length; i += 2048) d.push(x.subarray(i, i + 2048));
      const ok = !!got && new TextDecoder().decode(got.payload) === new TextDecoder().decode(payload);
      res.push({ mode: m, ok, rsCorrected: got ? got.rsCorrected : null, ms: Math.round(performance.now() - t0), airtime: M.frameDuration(m, payload.length) });
    }
    return res;
  }

  root.ChirpAudio = { AudioLink, SimMedium, loopbackTest };
})(typeof self !== 'undefined' ? self : globalThis);
