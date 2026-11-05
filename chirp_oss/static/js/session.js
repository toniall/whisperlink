/*! WhisperLink OSS — TCP-like ACK/SACK session over a half-duplex acoustic link.
 * Author: Antonio Brandao
 * License: MIT
 *
 * Segment header (10 bytes, big-endian):
 *   0 type(4b)|ver(4b)  1 flags  2-3 sid  4-5 seq  6-7 ack (next expected)  8 SACK bitmap  9 wnd/caps
 * Types: SYN SYN-ACK ACK DATA FIN RST KA.  Flags: TURN LAST FIRST NACK ROBUST-REQ.
 * Half-duplex: a station transmits a burst (<= window frames), the last frame carries TURN,
 * then the peer owns the channel and answers with an ACK (cumulative + selective bitmap).
 */
(function (root) {
  'use strict';
  const T = { SYN: 1, SYNACK: 2, ACK: 3, DATA: 4, FIN: 5, RST: 6, KA: 7 };
  const TNAME = Object.fromEntries(Object.entries(T).map(([k, v]) => [v, k.replace('SYNACK', 'SYN-ACK')]));
  const F = { TURN: 1, LAST: 2, FIRST: 4, NACK: 8, ROBUST: 16 };
  const VER = 1, HDR = 10;
  const sdiff = (a, b) => ((((a - b) & 0xffff) + 0x8000) & 0xffff) - 0x8000;
  const rnd16 = () => (Math.random() * 65536) | 0;
  const te = new TextEncoder(), td = new TextDecoder();

  function packHeader(s) {
    const h = new Uint8Array(HDR);
    h[0] = (s.type << 4) | VER; h[1] = s.flags & 255;
    h[2] = s.sid >> 8; h[3] = s.sid & 255; h[4] = s.seq >> 8; h[5] = s.seq & 255;
    h[6] = s.ack >> 8; h[7] = s.ack & 255; h[8] = s.sack & 255; h[9] = s.wnd & 255;
    return h;
  }
  function parseHeader(b) {
    if (!b || b.length < HDR || (b[0] & 15) !== VER) return null;
    const type = b[0] >> 4; if (!TNAME[type]) return null;
    return { type, flags: b[1], sid: (b[2] << 8) | b[3], seq: (b[4] << 8) | b[5], ack: (b[6] << 8) | b[7], sack: b[8], wnd: b[9] };
  }
  function concat(...arrs) { const n = arrs.reduce((a, x) => a + x.length, 0), o = new Uint8Array(n); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; }

  // App message envelope: kind(1) total(4) nameLen(1) name  + body
  function packMessage(kind, body, name = '', extraFlags = 0) {
    const nm = te.encode(name).slice(0, 64);
    const h = new Uint8Array(6 + nm.length);
    h[0] = kind | extraFlags; const n = body.length; h[1] = n >>> 24; h[2] = (n >>> 16) & 255; h[3] = (n >>> 8) & 255; h[4] = n & 255; h[5] = nm.length; h.set(nm, 6);
    return concat(h, body);
  }
  function parseMessageHead(b) {
    if (b.length < 6) return null;
    const total = ((b[1] << 24) | (b[2] << 16) | (b[3] << 8) | b[4]) >>> 0;
    if (b.length < 6 + b[5]) return null;
    return { kind: b[0] & 0x0f, mflags: b[0] & 0xf0, total, name: td.decode(b.subarray(6, 6 + b[5])), headLen: 6 + b[5] };
  }

  const STATES = ['CLOSED', 'SYN_SENT', 'SYN_RCVD', 'ESTABLISHED', 'FIN_WAIT', 'LAST_ACK', 'TIME_WAIT'];

  class Session {
    constructor(mgr, sid, role) {
      this.mgr = mgr; this.sid = sid; this.role = role; this.state = 'CLOSED';
      this.window = mgr.window; this.mode = mgr.mode; this.preferredMode = mgr.mode;
      this.iss = rnd16(); this.sndUna = this.iss; this.sndNxt = (this.iss + 1) & 0xffff; // seq for next new segment
      this.rcvNxt = 0; this.ooo = new Map(); this.segs = new Map(); this.order = [];
      this.awaiting = false; this.ackOwed = false; this.retries = 0; this.timers = {};
      this.lastRx = this.lastTx = Date.now(); this.cleanBursts = 0; this.consecTimeouts = 0;
      this.rxMsg = null; this.txMsgs = []; this.peerWnd = mgr.window; this.robustReq = false; this.badFrames = 0;
      this.stats = { txFrames: 0, rxFrames: 0, retrans: 0, nacks: 0, bytesAcked: 0, rttMs: 0 };
      this.closing = false; this.finSeq = null;
    }
    // ---- hooks overridable by extensions ----
    async encodeSegment(seg) { return concat(packHeader(seg), seg.data || new Uint8Array(0)); }
    async decodeSegment(bytes, hdr) { return Object.assign({}, hdr, { data: bytes.subarray(HDR) }); }
    async handshakePayload(/* type */) { return new Uint8Array(0); }
    async onHandshakePayload(/* type, data */) { return true; }
    async transformOutgoing(msgBytes) { return msgBytes; }
    async transformIncoming(msgBytes) { return msgBytes; }
    get mtu() { return this.mgr.mtuFor(this.mode); }

    emit(type, extra = {}) { this.mgr.emit(Object.assign({ type, sid: this.sid, session: this }, extra)); }
    setState(s, reason) { if (this.state === s) return; this.state = s; this.emit('state', { state: s, reason }); }
    timer(name, ms, fn) { clearTimeout(this.timers[name]); if (ms == null) return; this.timers[name] = setTimeout(fn, ms * this.mgr.timeScale); }
    clearTimers() { for (const k in this.timers) clearTimeout(this.timers[k]); }
    airtime(len) { return this.mgr.airtime(this.mode, len + HDR + this.mgr.overhead) * 1000; }
    rto() {
      const maxLen = Math.max(this.mtu, ...(this.lastBurst || []).map((x) => x.data.length));
      return (this.airtime(maxLen) * 1.3 + this.airtime(0) * 1.2 + 2500) * Math.pow(1.5, Math.min(this.retries, 4)); }

    sackBits() { let b = 0; for (let i = 0; i < 8; i++) if (this.ooo.has((this.rcvNxt + 1 + i) & 0xffff)) b |= 1 << i; return b; }
    async sendSeg(type, flags, seq, data, extra = {}) {
      const seg = Object.assign({ type, flags, sid: this.sid, seq, ack: this.rcvNxt, sack: this.sackBits(), wnd: this.window, data }, extra);
      if (this.robustReq) seg.flags |= F.ROBUST;
      if (seg.sack && type !== T.SYN) seg.flags |= F.NACK;
      const bytes = await this.encodeSegment(seg);
      this.stats.txFrames++; this.lastTx = Date.now();
      this.emit('tx', { seg, bytes: bytes.length, mode: this.mode, name: TNAME[type] });
      await this.mgr.transmit(bytes, this.mode);
      return seg;
    }

    // ---------- connection management ----------
    async connect() {
      this.setState('SYN_SENT');
      this.handshakeStart = Date.now();
      const synPayload = await this.handshakePayload(T.SYN);
      if (this.state !== 'SYN_SENT') return; // aborted while building the handshake
      const doSyn = async () => {
        if (this.state !== 'SYN_SENT') return;
        if (this.retries >= this.mgr.synRetries) return this.fail('no SYN-ACK');
        if (this.retries > 0) {
          // Retransmit only when the channel is quiet: the peer's SYN-ACK may be on the air right now,
          // and a half-duplex station that talks over it never hears it (mic is muted while we TX).
          await this.mgr.whenIdle();
          if (this.state !== 'SYN_SENT') return;
          this.emit('log', { level: 'warn', msg: `no SYN-ACK yet — retransmitting SYN (${this.retries + 1}/${this.mgr.synRetries})` });
          this.handshakeFallback();
        }
        this.retries++;
        await this.sendSeg(T.SYN, F.TURN, this.iss, synPayload, { ack: 0 });
        this.timer('rto', this.hsRto(synPayload.length), doSyn);
      };
      await doSyn();
    }
    // RTO while handshaking: peer turnaround + its reply (same size as ours) + decode slack, with backoff.
    hsRto(payloadLen) { return (this.airtime(Math.max(payloadLen, 16) - this.mgr.overhead) * 1.25 + 3000) * Math.pow(1.3, Math.min(this.retries, 4)); }
    // After 2 unanswered handshake frames, drop to the robust mode (echoey rooms break FAST first).
    handshakeFallback() {
      const fb = this.mgr.fallbackFor(this.mode);
      if (this.retries >= 2 && this.mgr.autoFallback && fb) {
        const from = this.mode; this.mode = this.preferredMode = fb;
        this.emit('mode', { from, to: this.mode, reason: 'handshake not answered' });
      }
    }
    adoptMode(meta) {
      // Reply in the mode the peer was actually heard in — it is the one that survives this room.
      if (meta && meta.mode && meta.mode !== this.mode && this.mgr.hasMode(meta.mode)) {
        const from = this.mode; this.mode = this.preferredMode = meta.mode;
        this.emit('mode', { from, to: this.mode, reason: 'peer used ' + meta.mode });
      }
    }
    async rejectSyn(meta) {
      // A responder that refuses a SYN is still CLOSED, so abort() would stay silent and the initiator would
      // only see "no SYN-ACK". Tell it explicitly with an RST in the mode it used.
      this.adoptMode(meta);
      await this.mgr.whenIdle();
      try { await this.sendSeg(T.RST, 0, this.iss, new Uint8Array(0)); } catch (_) { /* ignore */ }
    }
    async onSyn(seg, meta) {
      if (this.rejected) { if (!this.rstBusy) { this.rstBusy = true; await this.rejectSyn(meta); this.rstBusy = false; } return; }
      if (this.state === 'CLOSED' && !this.synSeen) {
        this.synSeen = true;
        this.rcvNxt = (seg.seq + 1) & 0xffff; this.peerWnd = seg.wnd;
        const ok = await this.onHandshakePayload(T.SYN, seg.data);
        if (ok === 'ignore') return this.terminate('SYN not addressed to us');
        if (!ok) { this.rejected = true; this.rstBusy = true; await this.rejectSyn(meta); this.rstBusy = false; return this.terminate('handshake rejected'); }
        this.adoptMode(meta);
        this.handshakeStart = Date.now();
        this.synAckPayload = await this.handshakePayload(T.SYNACK);
        this.setState('SYN_RCVD');
        this.emit('log', { level: 'ok', msg: `SYN heard (${this.mode}) — answering with SYN-ACK` });
      }
      if (this.state !== 'SYN_RCVD') return;
      if (this.synAckBusy) return; // a SYN-ACK is already queued/on air; the RTO handles repeats
      this.retries = 0;
      const doSynAck = async () => {
        if (this.state !== 'SYN_RCVD') return;
        if (this.retries >= this.mgr.synRetries) return this.fail('no ACK for SYN-ACK');
        this.synAckBusy = true;
        try {
          await this.mgr.whenIdle();
          if (this.state !== 'SYN_RCVD') return;
          this.handshakeFallback();
          this.retries++;
          await this.sendSeg(T.SYNACK, F.TURN, this.iss, this.synAckPayload);
        } finally { this.synAckBusy = false; }
        this.timer('rto', this.hsRto(this.synAckPayload.length), doSynAck);
      };
      this.timer('rto', null); await doSynAck();
    }
    established() {
      this.retries = 0; this.timer('rto', null); this.sndUna = (this.iss + 1) & 0xffff;
      this.setState('ESTABLISHED');
      if (this.handshakeStart) this.stats.rttMs = Date.now() - this.handshakeStart;
      this.armKeepalive();
    }
    fail(reason) { this.emit('log', { level: 'error', msg: 'session failed: ' + reason }); this.abort(reason); }
    async abort(reason = 'reset') {
      if (this.state !== 'CLOSED' && this.state !== 'TIME_WAIT') { try { await this.sendSeg(T.RST, 0, this.sndNxt, new Uint8Array(0)); } catch (e) { /* ignore */ } }
      this.terminate(reason);
    }
    terminate(reason) {
      this.clearTimers(); this.setState('CLOSED', reason);
      for (const s of this.segs.values()) if (s.state !== 'acked') s.state = 'failed';
      this.emit('segs'); this.mgr.forget(this, 30000);
    }
    close() {
      if (this.state !== 'ESTABLISHED') return this.abort('closed before established');
      this.closing = true; this.queueFin(); this.kick();
    }
    queueFin() {
      if (this.finSeq != null) return;
      this.finSeq = this.sndNxt;
      this.addSeg({ seq: this.sndNxt, type: T.FIN, flags: 0, data: new Uint8Array(0) });
      this.sndNxt = (this.sndNxt + 1) & 0xffff;
      if (this.state === 'ESTABLISHED') this.setState(this.role === 'responder' && this.peerFin ? 'LAST_ACK' : 'FIN_WAIT');
    }
    armKeepalive() {
      const ka = this.mgr.keepaliveMs; if (!ka) return;
      this.timer('ka', ka, () => {
        if (this.state !== 'ESTABLISHED') return;
        const idle = Date.now() - Math.max(this.lastRx, this.lastTx);
        if (idle > this.mgr.keepaliveMs * this.mgr.timeScale * 0.9 && !this.awaiting && this.unsent().length === 0 && this.role === 'initiator') {
          this.kaPending = true; this.kick();
        }
        if (!this.awaiting && Date.now() - this.lastRx > this.mgr.keepaliveMs * this.mgr.timeScale * 4 + this.rto() * this.mgr.timeScale) return this.fail('peer silent (keepalive)');
        this.armKeepalive();
      });
    }

    // ---------- sending application data ----------
    async send(kind, body, name = '') {
      if (this.state !== 'ESTABLISHED') throw new Error('session not established');
      const env = await this.transformOutgoing(packMessage(kind, body, name));
      const mtu = this.mtu, seqs = [];
      for (let off = 0; off < env.length || off === 0; off += mtu) {
        const chunk = env.subarray(off, Math.min(env.length, off + mtu));
        let flags = 0; if (off === 0) flags |= F.FIRST; if (off + mtu >= env.length) flags |= F.LAST;
        const seq = this.sndNxt; this.sndNxt = (this.sndNxt + 1) & 0xffff;
        this.addSeg({ seq, type: T.DATA, flags, data: chunk }); seqs.push(seq);
        if (off + mtu >= env.length) break;
      }
      const msg = { id: this.mgr.nextMsgId++, kind, name, body, size: body.length, wire: env.length, seqs, acked: 0, started: Date.now() };
      this.txMsgs.push(msg);
      this.emit('progress', { msg, dir: 'tx', done: 0, total: seqs.length });
      this.kick();
      return msg;
    }
    /**
     * User-requested retransmit of a message that is not fully ACKed (real retransmission, no fake ACKs):
     * every segment of the message the peer has not cumulatively ACKed or SACKed is re-marked NACK and goes out in
     * the next burst; a pending ACK wait for it is cut short, and the RTO backoff/retry budget is reset.
     * Returns { status: 'acked' | 'unknown' | 'closed' | 'resending', n }.
     */
    resend(msgId) {
      const msg = this.txMsgs.find((m) => m.id === msgId);
      if (!msg) return { status: this.order.length || this.txMsgs.length ? 'unknown' : 'acked', n: 0 };
      if (msg.doneAt) return { status: 'acked', n: 0 };
      if (!['ESTABLISHED', 'FIN_WAIT', 'LAST_ACK'].includes(this.state)) return { status: 'closed', n: 0 };
      let n = 0;
      for (const q of msg.seqs) {
        const sg = this.segs.get(q);
        if (sg && (sg.state === 'inflight' || sg.state === 'nack' || sg.state === 'queued' || sg.state === 'failed')) { if (sg.state !== 'queued') sg.state = 'nack'; n++; }
      }
      if (!n) return { status: 'acked', n: 0 };
      if (this.awaiting && (this.lastBurst || []).some((x) => msg.seqs.includes(x.seq))) {
        this.awaiting = false; this.timer('rto', null); this.emit('awaiting', { on: false, lost: 0, n: 0 });
      }
      this.retries = 0; this.consecTimeouts = 0; msg.resends = (msg.resends || 0) + 1;
      this.emit('log', { level: 'warn', msg: `user resend: message #${msg.id}, ${n} unacked segment(s)` });
      this.emit('segs'); this.kick();
      return { status: 'resending', n };
    }
    addSeg(s) { s.state = 'queued'; s.tx = 0; this.segs.set(s.seq, s); this.order.push(s.seq); this.emit('segs'); }
    inWindow(seq) { return sdiff(seq, this.sndUna) < Math.min(this.window, this.peerWnd || this.window); }
    unsent() { return this.order.map((q) => this.segs.get(q)).filter((s) => s && (s.state === 'queued' || s.state === 'nack')); }

    kick() { if (!this.kickPending) { this.kickPending = true; setTimeout(() => { this.kickPending = false; this.pump(); }, 0); } }
    async pump() {
      if (this.pumping) return; this.pumping = true;
      try {
        if (!['ESTABLISHED', 'FIN_WAIT', 'LAST_ACK', 'TIME_WAIT'].includes(this.state) || this.awaiting) return;
        const ready = this.unsent().filter((s) => this.inWindow(s.seq));
        if (!ready.length && !this.ackOwed && !this.kaPending) return;
        await this.mgr.whenIdle();
        if (this.awaiting) return;
        const burst = ready.slice(0, this.window);
        this.ackOwed = false; this.robustReqSent = this.robustReq;
        if (!burst.length) {
          if (this.kaPending) { this.kaPending = false; await this.sendSeg(T.KA, F.TURN, this.sndNxt, new Uint8Array(0)); this.waitAck([]); }
          else await this.sendSeg(T.ACK, F.TURN, this.sndNxt, new Uint8Array(0));
          return;
        }
        this.kaPending = false;
        for (let i = 0; i < burst.length; i++) {
          const s = burst[i];
          if (s.tx > 0) this.stats.retrans++;
          s.state = 'inflight'; s.tx++; s.sentAt = Date.now(); this.emit('segs');
          await this.sendSeg(s.type, s.flags | (i === burst.length - 1 ? F.TURN : 0), s.seq, s.data);
        }
        this.waitAck(burst);
      } finally { this.pumping = false; }
    }
    waitAck(burst) {
      this.awaiting = true; this.lastBurst = burst; this.emit('awaiting', { on: true, n: burst.length });
      this.timer('rto', this.rto(), () => this.onRto());
    }
    async onRto() {
      if (!this.awaiting) return;
      this.retries++; this.consecTimeouts++;
      this.emit('log', { level: 'warn', msg: `RTO #${this.retries} — no ACK from peer` });
      if (this.retries > this.mgr.maxRetries) return this.fail('retransmission limit');
      if (this.consecTimeouts >= 2) this.congestion('timeouts');
      this.awaiting = false;
      // probe: resend oldest outstanding segment with TURN (peer replies with full SACK state)
      const oldest = this.order.map((q) => this.segs.get(q)).find((s) => s && s.state === 'inflight');
      if (oldest) { oldest.state = 'nack'; this.emit('segs'); this.forceSingle = true; }
      else this.kaPending = true;
      await this.pumpSingle();
    }
    async pumpSingle() {
      const s = this.unsent()[0];
      if (!s) { return this.pump(); }
      await this.mgr.whenIdle();
      s.state = 'inflight'; s.tx++; this.stats.retrans++; this.emit('segs');
      await this.sendSeg(s.type, s.flags | F.TURN, s.seq, s.data);
      this.waitAck([s]);
    }

    congestion(why) {
      this.window = Math.max(2, Math.min(this.window, 2)); this.cleanBursts = 0;
      const fb = this.mgr.fallbackFor(this.mode);
      if (this.mgr.autoFallback && fb) {
        const from = this.mode; this.mode = fb;
        this.emit('mode', { from, to: this.mode, reason: why });
      }
    }

    // ---------- receiving ----------
    async onSegment(seg, meta) {
      this.lastRx = Date.now(); this.stats.rxFrames++;
      this.emit('rx', { seg, name: TNAME[seg.type], meta });
      if (meta && (meta.rsCorrected > 2 || (meta.quality && meta.quality < 3))) this.badFrames++; else this.badFrames = Math.max(0, this.badFrames - 1);
      this.robustReq = this.mgr.autoFallback && this.badFrames >= 3 && !!this.mgr.fallbackFor(this.mode);
      if (seg.type === T.RST) return this.terminate('peer reset');
      if (seg.type === T.SYN) return this.onSyn(seg, meta);
      if (seg.type === T.SYNACK) {
        if (this.state === 'SYN_SENT') {
          this.rcvNxt = (seg.seq + 1) & 0xffff; this.peerWnd = seg.wnd;
          this.timer('rto', null);
          const ok = await this.onHandshakePayload(T.SYNACK, seg.data);
          if (ok === 'ignore') return this.terminate('SYN-ACK ignored');
          if (!ok) return this.abort('handshake rejected');
          this.adoptMode(meta);
          this.established();
          this.finalAckPayload = await this.handshakePayload(T.ACK);
        }
        if (this.state === 'ESTABLISHED' || this.state === 'FIN_WAIT') {
          await this.mgr.whenIdle();
          await this.sendSeg(T.ACK, F.TURN, this.sndNxt, this.finalAckPayload || new Uint8Array(0));
          this.kick();
        }
        return;
      }
      if (this.state === 'SYN_RCVD') {
        if (seg.ack !== ((this.iss + 1) & 0xffff)) return;
        if (seg.type === T.ACK && !(await this.onHandshakePayload(T.ACK, seg.data))) return this.abort('handshake rejected');
        if (this.state !== 'SYN_RCVD') return;
        this.established();
        if (seg.type === T.ACK) { if (seg.flags & F.TURN) this.kick(); return; }
      }
      if (this.state === 'CLOSED') return;
      if (this.state === 'TIME_WAIT') { if (seg.type === T.FIN) { this.rcvNxt = (seg.seq + 1) & 0xffff; await this.mgr.whenIdle(); await this.sendSeg(T.ACK, F.TURN, this.sndNxt, new Uint8Array(0)); } return; }

      this.processAck(seg);
      if (seg.flags & F.ROBUST) this.congestion('peer requested ROBUST');
      if (seg.type === T.DATA || seg.type === T.FIN) {
        const d = sdiff(seg.seq, this.rcvNxt);
        if (d >= 0 && d < 16 && !this.ooo.has(seg.seq)) this.ooo.set(seg.seq, seg);
        await this.deliver();
        // ack scheduling: owe an ACK when peer yields turn, or after a quiet period
        this.timer('ack', this.airtime(Math.max(seg.data.length, this.mtu)) * 1.2 + 900, () => { this.ackOwed = true; this.kick(); });
      }
      if (seg.type === T.KA) this.ackOwed = true;
      if (seg.flags & F.TURN) {
        this.timer('ack', null);
        if (seg.type === T.DATA || seg.type === T.FIN || seg.type === T.KA) this.ackOwed = true;
        this.kick();
      }
      this.emit('segs');
    }
    processAck(seg) {
      const ack = seg.ack;
      if (sdiff(ack, this.sndUna) < 0 || sdiff(ack, this.sndNxt) > 0) return;
      let progressed = sdiff(ack, this.sndUna) > 0;
      for (const q of this.order) {
        const s = this.segs.get(q); if (!s || s.state === 'acked') continue;
        if (sdiff(q, ack) < 0) { s.state = 'acked'; s.ackedAt = Date.now(); this.stats.bytesAcked += s.data.length; }
        else {
          const i = sdiff(q, ack) - 1;
          if (i >= 0 && i < 8 && (seg.sack >> i) & 1) s.state = 'sacked';
        }
      }
      this.sndUna = ack;
      if (seg.flags & F.TURN && this.awaiting) {
        // peer yielded: anything from our last burst still unacknowledged is a NACK
        let lost = 0;
        for (const s of this.lastBurst || []) if (s.state === 'inflight') { s.state = 'nack'; lost++; this.stats.nacks++; }
        const n = (this.lastBurst || []).length;
        this.awaiting = false; this.timer('rto', null); this.retries = 0; this.consecTimeouts = 0;
        this.emit('awaiting', { on: false, lost, n });
        if (n && lost / n >= 0.5) { this.emit('log', { level: 'warn', msg: `NACK spike: ${lost}/${n} lost` }); this.congestion('NACK spike'); }
        else if (n) {
          this.cleanBursts++;
          if (this.cleanBursts >= 4 && this.mode !== this.preferredMode && !(seg.flags & F.ROBUST)) {
            const from = this.mode; this.mode = this.preferredMode; this.cleanBursts = 0; this.emit('mode', { from, to: this.mode, reason: 'link recovered' });
          }
          if (this.cleanBursts >= 2 && this.window < this.mgr.window) this.window++;
        }
        if (!this.unsent().length && this.lastBurst && !this.lastBurst.length) this.kaPending = false;
        progressed = true;
      }
      if (progressed) {
        // purge fully-acked segments, update message progress
        for (const m of this.txMsgs) {
          const done = m.seqs.filter((q) => { const s = this.segs.get(q); return !s || s.state === 'acked'; }).length;
          if (done !== m.acked) { m.acked = done; this.emit('progress', { msg: m, dir: 'tx', done, total: m.seqs.length }); }
          if (done === m.seqs.length && !m.doneAt) { m.doneAt = Date.now(); this.emit('delivered', { msg: m }); }
        }
        this.txMsgs = this.txMsgs.filter((m) => !m.doneAt);
        while (this.order.length && this.segs.get(this.order[0]).state === 'acked') { this.segs.delete(this.order[0]); this.order.shift(); }
        if (this.finSeq != null && !this.segs.has(this.finSeq) && sdiff(ack, this.finSeq) > 0) {
          if (this.peerFin) { this.setState('TIME_WAIT'); this.timer('tw', 4000, () => this.terminate('closed')); }
          else this.setState('FIN_WAIT');
        }
        this.kick();
      }
    }
    async deliver() {
      while (this.ooo.has(this.rcvNxt)) {
        const seg = this.ooo.get(this.rcvNxt); this.ooo.delete(this.rcvNxt);
        this.rcvNxt = (this.rcvNxt + 1) & 0xffff;
        if (seg.type === T.FIN) {
          this.peerFin = true; this.emit('log', { level: 'info', msg: 'peer closed (FIN)' });
          if (this.finSeq == null) { this.queueFin(); this.setState('LAST_ACK'); }
          else if (!this.segs.has(this.finSeq)) { this.setState('TIME_WAIT'); this.timer('tw', 4000, () => this.terminate('closed')); }
          continue;
        }
        if (seg.flags & F.FIRST) this.rxMsg = { parts: [], len: 0, head: null };
        if (!this.rxMsg) continue;
        this.rxMsg.parts.push(seg.data); this.rxMsg.len += seg.data.length;
        if (!this.rxMsg.head) this.rxMsg.head = parseMessageHead(concat(...this.rxMsg.parts));
        if (this.rxMsg.head) this.emit('progress', { dir: 'rx', done: this.rxMsg.len, total: this.rxMsg.head.total + this.rxMsg.head.headLen, name: this.rxMsg.head.name });
        if (seg.flags & F.LAST) {
          try {
            const env = await this.transformIncoming(concat(...this.rxMsg.parts));
            const h = parseMessageHead(env);
            const body = env.subarray(h.headLen, h.headLen + h.total);
            this.emit('message', { kind: h.kind, name: h.name, body: Uint8Array.from(body), text: h.kind === 1 ? td.decode(body) : null });
          } catch (e) { this.emit('log', { level: 'error', msg: 'message decode failed: ' + e.message }); }
          this.rxMsg = null;
        }
      }
    }
  }

  class SessionManager {
    constructor(opts) {
      this.link = opts.link; this.mode = opts.mode || 'FAST'; this.window = Math.max(2, Math.min(4, opts.window || 3));
      this.autoAccept = opts.autoAccept !== false; this.autoFallback = opts.autoFallback !== false; this.fallbackMode = opts.fallbackMode || 'ROBUST';
      this.keepaliveMs = opts.keepaliveMs == null ? 20000 : opts.keepaliveMs; this.maxRetries = opts.maxRetries || 7;
      this.timeScale = opts.timeScale || 1; this.SessionClass = opts.SessionClass || Session; this.overhead = opts.overhead || 0;
      this.airtime = opts.airtime; this.mtuFor = opts.mtuFor; this.listeners = []; this.sessions = new Map(); this.nextMsgId = 1;
      this.sessionOpts = opts.sessionOpts || {};
      this.fallbackMap = opts.fallbackMap || null;
      this.synRetries = opts.synRetries || 7; this.modes = opts.modes || null;
      this.onRawFrame = opts.onRawFrame || null; // (bytes, meta) => true if consumed (non-session frames)
      this.recentTx = []; // fingerprints of our own frames, to drop acoustic self-echo
      this.heard = { frames: 0, last: 0 };
      if (opts.onEvent) this.listeners.push(opts.onEvent);
      this.link.onFrame = (bytes, meta) => this.onFrame(bytes, meta);
    }
    hasMode(m) { return !this.modes || this.modes.includes(m); }
    /** Auto-fallback stays inside the same "family": audible FAST → audible ROBUST. A near-ultrasonic mode never
     *  silently turns into an audible one (or vice versa) — the user must pick that explicitly. */
    fallbackFor(mode) { const fb = (this.fallbackMap || { FAST: this.fallbackMode })[mode]; return fb && fb !== mode && this.hasMode(fb) ? fb : null; }
    static frameKey(b) { let h = 0x811c9dc5; for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 16777619) >>> 0; } return h + ':' + b.length; }
    on(fn) { this.listeners.push(fn); }
    emit(ev) { for (const l of this.listeners) { try { l(ev); } catch (e) { console.error(e); } } }
    async whenIdle() {
      // listen-before-talk with small turnaround + jitter
      await new Promise((r) => setTimeout(r, (250 + Math.random() * 150) * this.timeScale));
      let guard = 0;
      while (this.link.isBusy() && guard++ < 600) await new Promise((r) => setTimeout(r, 100 * this.timeScale));
    }
    async transmit(bytes, mode) {
      // serialize transmissions across sessions (single speaker)
      const prev = this.txChain || Promise.resolve();
      const now = Date.now(); this.recentTx = this.recentTx.filter((x) => now - x.t < 30000); this.recentTx.push({ k: SessionManager.frameKey(bytes), t: now });
      const p = prev.then(() => this.link.transmit(bytes, mode));
      this.txChain = p.catch(() => {});
      return p;
    }
    newSession(sid, role) { const s = new this.SessionClass(this, sid, role, this.sessionOpts); this.sessions.set(sid, s); this.emit({ type: 'session', session: s, sid }); return s; }
    async connect(opts = {}) { let sid; do { sid = rnd16(); } while (this.sessions.has(sid)); const s = this.newSession(sid, 'initiator'); s.connectOpts = opts; await s.connect(); return s; }
    forget(s, ms) { setTimeout(() => { if (this.sessions.get(s.sid) === s && s.state === 'CLOSED') { this.sessions.delete(s.sid); this.emit({ type: 'session-removed', sid: s.sid }); } }, ms * this.timeScale); }
    async onFrame(bytes, meta = {}) {
      const key = SessionManager.frameKey(bytes);
      if (this.recentTx.some((x) => x.k === key)) { this.emit({ type: 'log', level: 'debug', msg: 'own echo ignored' }); return; }
      this.heard.frames++; this.heard.last = Date.now();
      this.emit({ type: 'heard', meta, bytes: bytes.length });
      if (this.onRawFrame) { try { if (await this.onRawFrame(bytes, meta)) return; } catch (e) { this.emit({ type: 'log', level: 'warn', msg: 'frame handler: ' + e.message }); return; } }
      const hdr = parseHeader(bytes);
      if (!hdr) { this.emit({ type: 'log', level: 'debug', msg: 'non-session frame ignored' }); return; }
      let s = this.sessions.get(hdr.sid);
      if (!s) {
        if (hdr.type !== T.SYN) { this.emit({ type: 'log', level: 'debug', msg: `frame for unknown session ${hdr.sid.toString(16)}` }); return; }
        if (!this.autoAccept) { this.emit({ type: 'log', level: 'warn', msg: 'SYN heard but ignored — “Listen & auto-accept” is off on this device' }); return; }
        s = this.newSession(hdr.sid, 'responder');
      }
      let seg;
      try { seg = await s.decodeSegment(bytes, hdr); } catch (e) { seg = null; this.emit({ type: 'log', level: 'warn', msg: 'segment rejected: ' + e.message }); }
      if (!seg) return;
      await s.onSegment(seg, meta);
    }
  }

  const api = { T, F, TNAME, HDR, Session, SessionManager, packHeader, parseHeader, packMessage, parseMessageHead, concat, sdiff };
  root.ChirpSession = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
