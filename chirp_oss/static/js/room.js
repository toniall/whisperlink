/*! WhisperLink OSS — room UI (tabs, chat, files, session, spectrum).
 * Author: Antonio Brandao
 * License: MIT
 */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const M = window.ChirpModem, S = window.ChirpSession, A = window.ChirpAudio, EXT = window.ChirpProExt || null;
  const rootEl = $('#room'); if (!rootEl) return;
  const MODES = rootEl.dataset.modes.split(','), MAXF = +rootEl.dataset.maxfreq || 9000;
  const te = new TextEncoder();
  const st = { mgr: null, link: null, audio: null, active: null, sim: null, peerMgr: null, snr: [], acks: [], msgs: new Map(), files: new Map(), micOn: false };
  const isSim = () => $('#simulate').checked;
  const silentMode = (m) => !!(M.MODES[m] && M.MODES[m].f0 > 12000); // unused here: open modes stay below 12 kHz

  // ---------- helpers ----------
  const fmtBytes = (n) => n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB';
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const now = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  function toast(msg, kind = 'info') { const t = document.createElement('div'); t.className = 'toast ' + kind; t.textContent = msg; $('#toasts').appendChild(t); setTimeout(() => t.classList.add('out'), 3500); setTimeout(() => t.remove(), 4200); }
  function log(msg, level = 'info') {
    const box = $('#log'); const row = document.createElement('div'); row.className = 'logrow ' + level;
    row.innerHTML = `<time>${now()}</time><span>${esc(msg)}</span>`; box.prepend(row);
    while (box.children.length > 300) box.lastChild.remove();
  }
  function chip(id, text, kind) { const c = $('#' + id); if (!c) return; c.querySelector('b').textContent = text; c.dataset.kind = kind || ''; }
  function setRate() {
    const m = M.MODES[$('#mode').value]; const air = M.frameDuration(m, m.mtu + S.HDR + (EXT ? EXT.overhead : 0));
    $('#rate').textContent = `${Math.round((m.mtu * 8) / air)} b/s payload · ${air.toFixed(2)} s/frame`;
  }

  // ---------- tabs ----------
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => {
    $$('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
    $$('.tabpane').forEach((p) => p.classList.toggle('on', p.id === 'tab-' + b.dataset.tab));
    if (b.dataset.tab === 'spectrum') resizeCanvases();
  }));

  // ---------- spectrum / graphs ----------
  const wfs = $$('canvas.waterfall');
  function resizeCanvases() { let changed = false; $$('canvas').forEach((c) => { const r = c.getBoundingClientRect(); if (r.width && (c.width !== Math.round(r.width * devicePixelRatio))) { c.width = Math.round(r.width * devicePixelRatio); c.height = Math.round(r.height * devicePixelRatio); changed = true; } }); drawGraphs(); if (changed && SPEC) SPEC.refresh(); }
  window.addEventListener('resize', resizeCanvases);
  const curDemod = () => (st.link && st.link.demod) || (st.audio && st.audio.demod) || null;
  const SPEC = window.ChirpSpectrum ? window.ChirpSpectrum.create({
    modes: MODES.map((n) => M.MODES[n]), maxFreq: MAXF, waterfalls: wfs,
    getMode: () => (st.active && st.active.mode) || $('#mode').value,
    threshold: () => { const d = curDemod(); return d ? d.threshold : 0.16; },
    cpuLoad: () => { const d = curDemod(); return d && d.cpuLoad ? d.cpuLoad() : null; },
    describe: (p) => (EXT && EXT.describeFrame ? EXT.describeFrame(p) : null),
  }) : null;
  function onAudio(chunk, dir) {
    if (SPEC) SPEC.onAudio(chunk, dir, st.link && st.link.sampleRate ? st.link.sampleRate : 48000);
    const lvl = st.link && st.link.level ? st.link.level() : 0;
    $('#meter i').style.width = Math.min(100, Math.sqrt(lvl) * 220) + '%';
  }
  function drawGraphs() {
    const draw = (id, fn) => { const c = $('#' + id); if (!c || !c.width) return; const g = c.getContext('2d'); g.clearRect(0, 0, c.width, c.height); fn(g, c.width, c.height); };
    const css = (v) => getComputedStyle(document.body).getPropertyValue(v).trim();
    draw('snrGraph', (g, w, h) => {
      g.strokeStyle = css('--line'); g.lineWidth = 1; for (let y = 0; y <= 50; y += 10) { const yy = h - (y / 50) * h; g.beginPath(); g.moveTo(0, yy); g.lineTo(w, yy); g.stroke(); g.fillStyle = css('--muted'); g.font = `${10 * devicePixelRatio}px system-ui`; g.fillText(y + ' dB', 4, yy - 3); }
      const pts = st.snr.slice(-60); if (!pts.length) return;
      g.strokeStyle = css('--accent'); g.lineWidth = 2 * devicePixelRatio; g.beginPath();
      pts.forEach((p, i) => { const x = (i / Math.max(1, pts.length - 1)) * w, y = h - (Math.max(0, Math.min(50, p.db)) / 50) * h; i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke();
      pts.forEach((p, i) => { const x = (i / Math.max(1, pts.length - 1)) * w, y = h - (Math.max(0, Math.min(50, p.db)) / 50) * h; g.fillStyle = p.fix ? css('--warn') : css('--accent'); g.beginPath(); g.arc(x, y, 3 * devicePixelRatio, 0, 7); g.fill(); });
    });
    draw('ackGraph', (g, w, h) => {
      const pts = st.acks.slice(-40); const bw = w / 40;
      pts.forEach((p, i) => { const ok = p.n - p.lost; const unit = (h - 14) / 4; g.fillStyle = css('--ok'); g.fillRect(i * bw + 2, h - ok * unit, bw - 4, ok * unit); g.fillStyle = css('--bad'); g.fillRect(i * bw + 2, h - p.n * unit, bw - 4, p.lost * unit); });
      if (!pts.length) { g.fillStyle = css('--muted'); g.font = `${12 * devicePixelRatio}px system-ui`; g.fillText('ACK history appears after the first burst', 10, h / 2); }
    });
  }

  // ---------- link + session manager ----------
  function makeManager(link, opts = {}) {
    const mgr = new S.SessionManager(Object.assign({
      link, mode: $('#mode').value, window: +$('#window').value, autoAccept: $('#listen').checked, autoFallback: $('#fallback').checked,
      airtime: (mode, n) => M.frameDuration(mode, n), mtuFor: (mode) => M.MODES[mode].mtu, modes: MODES,
      SessionClass: EXT ? EXT.SessionClass : S.Session, overhead: EXT ? EXT.overhead : 0, sessionOpts: EXT ? EXT.sessionOpts({ simulated: isSim() }) : {},
    }, opts));
    return mgr;
  }
  let simToasted = false;
  function updateSimBanner() {
    const on = $('#simulate').checked, b = $('#simBanner'); if (!b) return;
    if (on) { b.className = 'banner bad slim'; b.innerHTML = '<b>Simulated mode:</b> NO speaker audio is played and peers are NOT linked over the air — this is a silent in-browser software demo. Uncheck “Simulated peer” to use the acoustic link.'; if (!simToasted) { simToasted = true; toast('Simulated: no speaker audio', 'warn'); } }
    else { b.className = 'banner ok slim'; b.innerHTML = '<b>Acoustic mode:</b> Connect plays tones through your speaker; the peer device needs its mic on, in the same room.'; }
  }
  function buildLink() {
    updateSimBanner();
    if (st.mgr) for (const s of st.mgr.sessions.values()) s.clearTimers();
    if (st.peerMgr) for (const s of st.peerMgr.sessions.values()) s.clearTimers();
    const simulate = isSim();
    if (simulate) {
      st.sim = new A.SimMedium({ modes: MODES, snrDb: +$('#simSnr').value, drop: +$('#simDrop').value / 100 });
      st.link = st.sim.station('you', onAudio, onLinkEvent); st.link.sampleRate = 48000;
      const peerLink = st.sim.station('virtual-peer');
      st.peerMgr = makeManager(peerLink, { autoAccept: true, sessionOpts: EXT ? EXT.sessionOpts({ virtual: true }) : {} });
      if (EXT && EXT.attachVirtualPeer) EXT.attachVirtualPeer(st.peerMgr);
      st.peerMgr.on((e) => {
        if (e.type === 'message') {
          const reply = e.kind === 1 ? `echo: “${e.text.slice(0, 80)}” (${e.body.length} B received)` : `got your file ${e.name} (${fmtBytes(e.body.length)}), CRC ok`;
          e.session.send(1, te.encode(reply)).catch(() => {});
        }
      });
      log('Simulated peer ready — modem runs for real with AWGN noise and random frame drops.', 'ok');
    } else {
      st.peerMgr = null;
      // Keep ONE AudioLink for the page: rebuilding it would silently drop a running microphone.
      if (!st.audio) st.audio = new A.AudioLink({ modes: MODES, volume: +$('#volume').value / 100, onAudio, workletUrl: rootEl.dataset.worklet, onEvent: onLinkEvent });
      st.link = st.audio;
    }
    st.mgr = makeManager(st.link, EXT && EXT.onRawFrame ? { onRawFrame: (b, m) => EXT.onRawFrame(b, m) } : {});
    st.mgr.on(onEvent);
    st.active = null; renderSessions(); renderGrid(); linkChip();
  }
  function linkChip() {
    const sim = isSim(), mic = !!(st.audio && st.audio.micOn); st.micOn = mic;
    chip('chipLink', sim ? 'Simulated' : (mic ? 'Mic live' : 'Mic OFF'), sim ? 'info' : (mic ? 'ok' : 'bad'));
  }
  let rejectLogAt = 0;
  function onLinkEvent(e) {
    if (SPEC) SPEC.onEvent(e);
    if (e.type === 'reject' && e.reason !== 'training') {
      if (Date.now() - rejectLogAt > 1500) { rejectLogAt = Date.now(); log(`RX ${e.mode}: heard a frame but could not decode it (${e.reason}) — echo/reverb or clipping. Try lower volume, closer devices, or ROBUST.`, 'warn'); }
    }
    if (e.type === 'header') log(`RX ${e.mode}: header ok, ${e.len} B incoming (${e.airtime.toFixed(1)} s)`, 'debug');
    if (e.type === 'ctx' && e.state !== 'running') { log(`Audio engine is ${e.state} — click anywhere on the page / press Connect to re-enable sound`, 'warn'); if (e.stalled) toast('Audio is blocked (' + e.state + '). Click the page, then retry.', 'bad'); }
    if (e.type === 'mic') { log('Microphone ' + e.state, e.state === 'unmuted' ? 'ok' : 'warn'); if (e.state !== 'unmuted') toast('Microphone ' + e.state + ' — RX stopped', 'bad'); linkChip(); }
  }
  /** Start the mic (idempotent). Returns true when RX is live. Must run from a click for the first start. */
  async function ensureMic() {
    if (isSim()) return true;
    if (st.audio.micOn) return true;
    try {
      await st.audio.startMic();
      $('#micBtn').textContent = '🎙 Mic on (click to stop)'; $('#micBtn').classList.add('live');
      log(`Microphone live @ ${st.audio.sampleRate} Hz (AGC/NS/AEC off) · audio ${st.audio.ctx.state}`, 'ok'); resizeCanvases();
      if (!$('#listen').checked) { $('#listen').checked = true; if (st.mgr) st.mgr.autoAccept = true; toast('Listen & auto-accept turned on', 'info'); }
      linkChip(); return true;
    } catch (e) {
      const msg = e && e.name === 'NotAllowedError' ? 'Microphone permission denied — allow it in the address bar, then retry' : (e.message || String(e));
      toast(msg, 'bad'); log('Mic error: ' + msg, 'error'); linkChip(); return false;
    }
  }
  function heardSummary() {
    const L = st.audio; if (!L) return '';
    const rj = Object.entries(L.stats.rejected).filter(([k]) => k !== 'training').map(([k, v]) => `${v}×${k}`).join(', ');
    return `this device decoded ${L.stats.decoded} frame(s)${rj ? ', failed to decode ' + rj : ''}`;
  }

  function onEvent(e) {
    const s = e.session;
    switch (e.type) {
      case 'session': if (!st.active || st.active.state === 'CLOSED') st.active = s; renderSessions(); break;
      case 'session-removed': renderSessions(); break;
      case 'state':
        log(`Session ${hex(e.sid)} → ${e.state}${e.reason ? ' (' + e.reason + ')' : ''}`, e.state === 'CLOSED' ? 'warn' : 'ok');
        if (e.state === 'ESTABLISHED') { toast('Session established', 'ok'); if (EXT) EXT.onEstablished(s, { log, toast }); }
        if (e.state === 'CLOSED' && e.reason && e.reason !== 'closed' && e.reason !== 'SYN not addressed to us') {
          let hint = '';
          if (e.reason === 'no SYN-ACK') hint = isSim() ? '' : (st.audio && !st.audio.micOn ? ' — your mic is OFF, so a reply could not be heard' : ' — peer never answered (' + heardSummary() + '). On the other device: Start mic, keep “Listen” on, raise volume, move closer.');
          if (e.reason === 'no ACK for SYN-ACK') hint = ' — initiator did not confirm (' + heardSummary() + ')';
          if (e.reason === 'peer reset') hint = ' — the other device rejected the connection (see its log)';
          toast('Session closed: ' + e.reason + hint, 'bad'); if (hint) log('Connect failed: ' + e.reason + hint, 'error');
        }
        if (e.state === 'CLOSED') onSessionClosed(s, e.reason);
        renderSessions(); break;
      case 'tx': log(`TX ${e.name} seq=${e.seg.seq} ack=${e.seg.ack}${e.seg.sack ? ' sack=' + e.seg.sack.toString(2).padStart(8, '0') : ''} ${flagStr(e.seg.flags)} · ${e.bytes} B · ${e.mode}`, 'tx'); chip('chipTx', 'Transmitting', 'warn'); setTimeout(() => chip('chipTx', 'Idle', ''), M.frameDuration(e.mode, e.bytes) * 1000); break;
      case 'rx': {
        log(`RX ${e.name} seq=${e.seg.seq} ack=${e.seg.ack}${e.seg.sack ? ' sack=' + e.seg.sack.toString(2).padStart(8, '0') : ''} ${flagStr(e.seg.flags)}${e.meta && e.meta.rsCorrected ? ' · RS fixed ' + e.meta.rsCorrected : ''}`, 'rx');
        if (e.meta && (e.meta.snrDb != null || e.meta.quality)) { const db = e.meta.snrDb != null ? e.meta.snrDb : 10 * Math.log10(e.meta.quality); st.snr.push({ db, fix: e.meta.rsCorrected }); chip('chipSnr', db.toFixed(1) + ' dB', db > 15 ? 'ok' : db > 9 ? 'warn' : 'bad'); drawGraphs(); }
        break;
      }
      case 'awaiting':
        chip('chipAck', e.on ? `Waiting ACK (${e.n})` : (e.lost ? `NACK ${e.lost}/${e.n}` : 'ACK ✓'), e.on ? 'warn' : e.lost ? 'bad' : 'ok');
        if (!e.on && e.n) { st.acks.push({ n: e.n, lost: e.lost }); drawGraphs(); }
        break;
      case 'mode': log(`Mode ${e.from} → ${e.to} (${e.reason})${silentMode(e.from) !== silentMode(e.to) ? ' — audible/near-ultrasonic change' : ''}`, 'warn'); toast(`Switched to ${e.to}: ${e.reason}`, 'warn'); break;
      case 'segs': if (s === st.active) renderGrid(); break;
      case 'progress': onProgress(e); break;
      case 'delivered': markDelivered(e.msg); break;
      case 'message': onMessage(e); break;
      case 'log': log(e.msg, e.level); break;
      case 'heard': lastHeard = Date.now(); break;
    }
    if (EXT && EXT.onEvent) EXT.onEvent(e);
    if (s === st.active) renderStatus();
  }
  let lastHeard = 0;
  const hex = (n) => n.toString(16).padStart(4, '0');
  const who = (s) => (s && s.peerName ? s.peerName + ' · ' : '') + hex(s.sid);
  const flagStr = (f) => Object.entries(S.F).filter(([, v]) => f & v).map(([k]) => k).join('|');

  function renderStatus() {
    const s = st.active;
    chip('chipSession', s ? s.state.replace('_', ' ') : 'No session', !s ? '' : s.state === 'ESTABLISHED' ? 'ok' : s.state === 'CLOSED' ? 'bad' : 'warn');
    chip('chipMode', s ? s.mode : $('#mode').value, s && s.mode !== s.preferredMode ? 'warn' : 'info');
    chip('chipWin', s ? `win ${s.window}` : `win ${$('#window').value}`, 'info');
    if (s) $('#stats').innerHTML = [['Session', hex(s.sid)], ['Peer', s.peerName || (EXT ? '—' : 'anonymous (OSS)')], ['Role', s.role], ['TX frames', s.stats.txFrames], ['RX frames', s.stats.rxFrames], ['Retransmits', s.stats.retrans], ['NACKed', s.stats.nacks], ['Bytes ACKed', fmtBytes(s.stats.bytesAcked)], ['Handshake', s.stats.rttMs ? (s.stats.rttMs / 1000).toFixed(1) + ' s' : '—'], ['snd.una / nxt', `${s.sndUna} / ${s.sndNxt}`], ['rcv.nxt', s.rcvNxt]].map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join('');
    const ready = s && s.state === 'ESTABLISHED';
    $$('[data-need=session]').forEach((b) => (b.disabled = !ready));
    if (EXT) EXT.renderKeys(s);
  }
  function renderSessions() {
    const list = $('#sessions'); const ss = st.mgr ? [...st.mgr.sessions.values()] : [];
    list.innerHTML = ss.length ? ss.map((s) => `<button class="sess ${s === st.active ? 'on' : ''}" data-sid="${s.sid}"><span class="dot ${s.state === 'ESTABLISHED' ? 'ok' : s.state === 'CLOSED' ? 'bad' : 'warn'}"></span>${esc(who(s))} <small>${s.role} · ${s.state} · ${s.mode}</small></button>`).join('') : '<p class="muted">No sessions yet. Turn the mic on on BOTH devices, then press <b>Connect</b> on one of them.</p>';
    $$('.sess', list).forEach((b) => b.addEventListener('click', () => { st.active = st.mgr.sessions.get(+b.dataset.sid); renderSessions(); renderGrid(); renderStatus(); }));
    renderStatus();
  }
  function renderGrid() {
    const g = $('#ackgrid'); const s = st.active;
    if (!s) { g.innerHTML = '<p class="muted">Segments of the active session appear here.</p>'; return; }
    const segs = s.order.map((q) => s.segs.get(q)).filter(Boolean).slice(0, 64);
    g.innerHTML = segs.length ? segs.map((x) => `<span class="seg ${x.state}" title="seq ${x.seq} · ${x.state} · tx×${x.tx}">${x.seq % 1000}</span>`).join('') : '<p class="muted">All segments acknowledged ✓</p>';
  }

  // ---------- chat ----------
  function bubble(kind, html, meta, id) {
    const box = $('#chat'); const el = document.createElement('div'); el.className = 'bubble ' + kind; if (id) el.id = id;
    el.innerHTML = `<div class="b">${html}</div><div class="m">${meta}</div>`; box.appendChild(el); box.scrollTop = box.scrollHeight;
    $('#chatEmpty') && $('#chatEmpty').remove(); return el;
  }
  // ---- outgoing message tracking + click-to-resend (msg.id restarts per manager, so use a page-unique uid) ----
  let uidSeq = 1;
  const outByUid = new Map(); // uid -> { s, msg, el }
  const tickOf = (msg) => (msg && msg.uid ? $(`.tick[data-uid="${msg.uid}"]`) : null);
  function trackOut(s, msg, el) {
    const uid = uidSeq++; msg.uid = uid; el.dataset.uid = uid; el.classList.add('pending');
    el.querySelector('.m').insertAdjacentHTML('afterbegin', `<button type="button" class="resend" data-uid="${uid}" title="No ACK yet — click to resend">↻</button>`);
    el.querySelector('.tick').dataset.uid = uid;
    outByUid.set(uid, { s, msg, el });
  }
  function setResendable(entry, on, why) {
    entry.el.classList.toggle('pending', on); entry.el.classList.toggle('unacked', on && !!why);
    entry.el.title = on ? 'Not ACKed yet — click to resend' : '';
    if (why) { const t = tickOf(entry.msg); if (t) t.textContent = why; }
  }
  async function resend(uid) {
    const entry = outByUid.get(uid); if (!entry) return;
    const { s, msg } = entry;
    if (msg.doneAt) { toast('Already ACKed ✓✓ — nothing to resend', 'info'); return setResendable(entry, false); }
    if (entry.busy) return; entry.busy = true;
    try {
      const r = s.resend ? s.resend(msg.id) : { status: 'closed' };
      if (r.status === 'resending') {
        entry.resent = true; const t = tickOf(msg); if (t) t.textContent = `resending ${r.n} seg…`;
        toast(`Resending… (${r.n} unacked segment${r.n > 1 ? 's' : ''})`, 'info'); log(`Resend requested for message #${msg.id} on ${hex(s.sid)}: ${r.n} segment(s) re-queued`, 'warn');
        return;
      }
      if (r.status === 'acked') { toast('Already ACKed ✓✓', 'info'); return setResendable(entry, false); }
      // original session is gone: send the same content again on the current established session (new seqs, real ACKs)
      const cur = st.active;
      if (!cur || cur.state !== 'ESTABLISHED') { toast('Session closed — press Connect, then click ↻ again to resend', 'warn'); log(`Resend #${msg.id}: no established session`, 'warn'); return; }
      const nm = await cur.send(msg.kind, msg.body, msg.name);
      nm.uid = msg.uid; msg.superseded = true; entry.s = cur; entry.msg = nm; entry.resent = true;
      const t = tickOf(nm); if (t) t.textContent = `resending on ${hex(cur.sid)} · ${nm.seqs.length} seg…`;
      setResendable(entry, true);
      toast(`Resending… on session ${who(cur)}`, 'info'); log(`Resend: message re-sent on session ${hex(cur.sid)} (${nm.seqs.length} segment(s))`, 'warn');
    } catch (e) { toast('Resend failed: ' + e.message, 'bad'); log('Resend failed: ' + e.message, 'error'); }
    finally { entry.busy = false; }
  }
  $('#chat').addEventListener('click', (ev) => {
    const b = ev.target.closest('.bubble.out'); if (!b || !b.dataset.uid || ev.target.closest('a')) return;
    if (!b.classList.contains('pending') && !ev.target.closest('.resend')) return;
    resend(+b.dataset.uid);
  });
  function onSessionClosed(s, reason) {
    for (const entry of outByUid.values()) {
      if (entry.s !== s || entry.msg.doneAt) continue;
      setResendable(entry, true, `not ACKed (${reason || 'session closed'}) — click ↻ to resend`);
      if (entry.resent) { entry.resent = false; toast('Resend failed: session closed before ACK — reconnect and click ↻', 'bad'); }
    }
  }
  async function sendText() {
    const input = $('#msg'), text = input.value.trim(); if (!text || !st.active) return;
    try {
      const s = st.active, msg = await s.send(1, te.encode(text));
      const el = bubble('out', esc(text), `<span class="tick">queued · ${msg.seqs.length} seg</span> · ${now()}`);
      trackOut(s, msg, el);
      input.value = '';
    } catch (e) { toast(e.message, 'bad'); }
  }
  function onProgress(e) {
    if (e.dir === 'tx') {
      const t = tickOf(e.msg); if (t) t.textContent = e.done === e.total ? 'ACKed ✓✓' : `sending ${e.done}/${e.total} ACKed`;
      const f = st.files.get(e.msg.id); if (f) ring(f.el, e.done / e.total, `${e.done}/${e.total}`);
    } else {
      let r = $('#rxProgress'); r.hidden = false; ring(r, Math.min(1, e.done / e.total), Math.round((100 * e.done) / e.total) + '%'); $('#rxName').textContent = e.name || 'incoming…';
      if (e.done >= e.total) setTimeout(() => (r.hidden = true), 1500);
    }
  }
  function markDelivered(msg) {
    const t = tickOf(msg); if (t) { t.textContent = `ACKed ✓✓ in ${((msg.doneAt - msg.started) / 1000).toFixed(1)} s${msg.resends ? ' (after ' + msg.resends + ' resend' + (msg.resends > 1 ? 's' : '') + ')' : ''}`; t.classList.add('ok'); }
    const entry = msg.uid && outByUid.get(msg.uid);
    if (entry && entry.msg === msg) { setResendable(entry, false); if (entry.resent) { entry.resent = false; toast('Resent message ACKed ✓✓', 'ok'); log(`Resent message #${msg.id} ACKed`, 'ok'); } }
    const f = st.files.get(msg.id); if (f) { ring(f.el, 1, '✓'); f.el.classList.add('done'); }
  }
  function onMessage(e) {
    if (e.kind === 1) bubble('in', esc(e.text), `${esc(who(e.session))} · ${now()}`);
    else {
      const url = URL.createObjectURL(new Blob([e.body]));
      const li = document.createElement('div'); li.className = 'file in done';
      li.innerHTML = `${ringSvg()}<div><b>${esc(e.name)}</b><small>${fmtBytes(e.body.length)} · received ${now()}</small></div><a class="btn sm" download="${esc(e.name)}" href="${url}">Save</a>`;
      ring(li, 1, '✓'); $('#files').prepend(li);
      bubble('in', `📎 <a download="${esc(e.name)}" href="${url}">${esc(e.name)}</a> (${fmtBytes(e.body.length)})`, `${esc(who(e.session))} · ${now()}`);
      toast('File received: ' + e.name, 'ok');
    }
  }
  // ---------- files ----------
  const ringSvg = () => `<svg class="ring" viewBox="0 0 44 44"><circle cx="22" cy="22" r="18"/><circle class="p" cx="22" cy="22" r="18"/><text x="22" y="26">0%</text></svg>`;
  function ring(el, frac, label) { const p = el.querySelector('.p'); const c = 2 * Math.PI * 18; p.style.strokeDasharray = c; p.style.strokeDashoffset = c * (1 - frac); el.querySelector('text').textContent = label; }
  async function sendFile(file) {
    if (!st.active || st.active.state !== 'ESTABLISHED') return toast('Connect a session first', 'warn');
    const limit = +rootEl.dataset.maxfile;
    if (file.size > limit) return toast(`File too large for an acoustic link (max ${fmtBytes(limit)})`, 'bad');
    const body = new Uint8Array(await file.arrayBuffer());
    const msg = await st.active.send(2, body, file.name);
    msg.fileKey = msg.id;
    const m = M.MODES[st.active.mode]; const eta = (msg.seqs.length * M.frameDuration(m, m.mtu + S.HDR)) * 1.25;
    const li = document.createElement('div'); li.className = 'file out';
    li.innerHTML = `${ringSvg()}<div><b>${esc(file.name)}</b><small>${fmtBytes(file.size)} · ${msg.seqs.length} segments · ETA ~${Math.ceil(eta)} s</small></div>`;
    $('#files').prepend(li); ring(li, 0, `0/${msg.seqs.length}`); st.files.set(msg.id, { el: li });
    trackOut(st.active, msg, bubble('out', `📎 ${esc(file.name)} (${fmtBytes(file.size)})`, `<span class="tick">queued</span> · ${now()}`));
  }

  // ---------- wiring ----------
  // Audible FAST is ALWAYS the default. A near-ultrasonic mode (Pro) is only used when the user picks it explicitly,
  // and auto-fallback never crosses between the audible and near-ultrasonic families (see session.js fallbackFor).
  const MODE_LABEL = (m) => { const c = M.MODES[m] && M.MODES[m].chirp; const band = c ? `${(c[0] / 1000).toFixed(0)}–${(c[1] / 1000).toFixed(0)} kHz` : '';
    return m + (silentMode(m) ? ` (quiet ${band}, explicit${c && c[1] <= 16500 ? ', longer range' : ''})` : m === 'ROBUST' ? ' (audible, slow)' : ' (audible)'); };
  $('#mode').setAttribute('autocomplete', 'off');
  $('#mode').innerHTML = MODES.map((m) => `<option value="${m}"${m === 'FAST' ? ' selected' : ''}>${MODE_LABEL(m)}</option>`).join('');
  $('#mode').value = MODES.includes('FAST') ? 'FAST' : MODES[0];
  $('#mode').addEventListener('change', () => {
    const m = $('#mode').value;
    if (silentMode(m)) { toast(`${m} chosen: ${MODE_LABEL(m)}. Quiet but not guaranteed silent; both devices' speaker+mic must reach this band. No automatic switch to audible.`, 'warn'); log(`Mode ${m} selected explicitly — it will NOT fall back to an audible mode; pick FAST/ROBUST if the link fails.`, 'warn'); }
  });
  $('#mode').addEventListener('change', () => { setRate(); if (st.mgr) st.mgr.mode = $('#mode').value; if (st.active) { st.active.mode = st.active.preferredMode = $('#mode').value; } renderStatus(); });
  $('#window').addEventListener('change', () => { if (st.mgr) st.mgr.window = +$('#window').value; if (st.active) st.active.window = +$('#window').value; renderStatus(); });
  $('#listen').addEventListener('change', () => { if (st.mgr) st.mgr.autoAccept = $('#listen').checked; });
  $('#fallback').addEventListener('change', () => { if (st.mgr) st.mgr.autoFallback = $('#fallback').checked; });
  $('#volume').addEventListener('input', () => { if (st.audio) st.audio.volume = +$('#volume').value / 100; $('#volv').textContent = $('#volume').value + '%'; });
  $('#listen').addEventListener('change', () => { if (!$('#listen').checked && !isSim()) toast('Listen is off: this device will ignore incoming Connect requests', 'warn'); });
  $('#simulate').addEventListener('change', () => { $('#simOpts').hidden = !$('#simulate').checked; buildLink(); });
  ['#simSnr', '#simDrop'].forEach((id) => $(id).addEventListener('input', () => { $(id + 'v').textContent = $(id).value + (id === '#simSnr' ? ' dB' : '%'); if (st.sim) { st.sim.snrDb = +$('#simSnr').value; st.sim.drop = +$('#simDrop').value / 100; } }));
  $('#micBtn').addEventListener('click', async () => {
    if (isSim()) { $('#simulate').checked = false; $('#simOpts').hidden = true; buildLink(); }
    if (st.audio && st.audio.micOn) { // toggle off
      st.audio.stopMic(); $('#micBtn').textContent = '🎙 Start mic'; $('#micBtn').classList.remove('live'); log('Microphone stopped — this device can no longer hear the peer', 'warn'); linkChip(); return;
    }
    await ensureMic();
  });
  let connecting = false;
  $('#connect').addEventListener('click', async () => {
    if (connecting) return; connecting = true;
    try {
      updateSimBanner();
      const busy = st.mgr && [...st.mgr.sessions.values()].find((x) => ['SYN_SENT', 'SYN_RCVD'].includes(x.state));
      if (busy) return toast('A handshake is already in progress (' + hex(busy.sid) + ')', 'warn');
      if (!isSim()) {
        // 1) audio must be running (resume inside this click), 2) mic must be on to hear the SYN-ACK
        const state = await st.audio.resume();
        if (state !== 'running') { toast('Browser blocked audio output (' + state + '). Click the page and press Connect again.', 'bad'); log('AudioContext ' + state + ' — Connect aborted', 'error'); return; }
        if (!st.audio.micOn) { toast('Mic was off — starting it so this device can hear the reply', 'warn'); if (!(await ensureMic())) return; }
        log(`Connect: playing SYN at ${$('#volume').value}% volume (${$('#mode').value}). The other device needs its mic on + Listen.`, 'info');
      }
      let copts = {};
      if (EXT) { copts = await EXT.beforeConnect({ toast, log, simulated: isSim() }); if (!copts) return; if (copts === true) copts = {}; }
      st.mgr.mode = $('#mode').value; st.mgr.autoFallback = $('#fallback').checked;
      const p = st.mgr.connect(copts);
      st.active = [...st.mgr.sessions.values()].pop(); renderSessions();
      const s = await p; st.active = s; renderSessions();
    } catch (e) { toast('Connect failed: ' + e.message, 'bad'); log('Connect failed: ' + e.message, 'error'); }
    finally { connecting = false; }
  });
  $('#fin').addEventListener('click', () => st.active && st.active.close());
  $('#rst').addEventListener('click', () => st.active && st.active.abort('user reset'));
  $('#send').addEventListener('click', sendText);
  $('#msg').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); } });
  $('#fileIn').addEventListener('change', (e) => { [...e.target.files].forEach(sendFile); e.target.value = ''; });
  const dz = $('#drop');
  ['dragenter', 'dragover'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add('hover'); }));
  ['dragleave', 'drop'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove('hover'); }));
  dz.addEventListener('drop', (e) => [...e.dataTransfer.files].forEach(sendFile));
  $('#loopback').addEventListener('click', () => {
    let r; try { r = A.loopbackTest(MODES, 10); } catch (e) { log('Loopback crashed: ' + e.message, 'error'); return toast('Loopback error: ' + e.message, 'bad'); }
    r.forEach((x) => log(`Loopback ${x.mode}: ${x.ok ? 'PASS' : 'FAIL'} · RS fixed ${x.rsCorrected ?? '-'} · decode ${x.ms} ms · airtime ${x.airtime.toFixed(2)} s`, x.ok ? 'ok' : 'error'));
    toast(r.every((x) => x.ok) ? 'Digital loopback passed for ' + MODES.join(', ') : 'Loopback failure — see log', r.every((x) => x.ok) ? 'ok' : 'bad');
  });
  $('#acoustic').addEventListener('click', async () => {
    if (isSim()) { $('#simulate').checked = false; $('#simOpts').hidden = true; buildLink(); }
    const L = st.audio;
    if ((await L.resume()) !== 'running') return toast('Audio output blocked by the browser — click the page and retry', 'bad');
    if (!(await ensureMic())) return;
    const mode = $('#mode').value; let heard = false; const prev = L.onFrame;
    const before = { detects: L.stats.detects, decoded: L.stats.decoded, rej: Object.assign({}, L.stats.rejected) }; let peak = 0;
    const lvl = setInterval(() => { peak = Math.max(peak, L.level()); }, 50);
    L.onFrame = (b, f) => { if (new TextDecoder().decode(b).startsWith('CHIRP-SELFTEST')) heard = true; else prev && prev(b, f); };
    log(`Acoustic self-test (${mode}): playing a test frame and listening with this device's own mic…`);
    try { await L.transmit(te.encode('CHIRP-SELFTEST ' + mode), mode, { selfTest: true }); }
    catch (e) { clearInterval(lvl); L.selfTest = false; L.onFrame = prev; return toast('Self-test TX failed: ' + e.message, 'bad'); }
    setTimeout(() => {
      clearInterval(lvl); L.selfTest = false; L.onFrame = prev;
      let why = 'PASS — speaker→mic path decodes';
      if (!heard) {
        const det = L.stats.detects - before.detects;
        const rj = Object.entries(L.stats.rejected).map(([k, v]) => [k, v - (before.rej[k] || 0)]).filter(([, v]) => v > 0).map(([k, v]) => `${v}×${k}`).join(', ');
        if (peak < 0.003) why = `FAIL — the mic heard silence (peak ${peak.toFixed(4)}). Mic muted / wrong input device / speaker volume at 0.`;
        else if (!det) why = `FAIL — sound reached the mic (peak ${peak.toFixed(3)}) but no sync chirp was detected. OS echo-cancellation or a headset may be filtering it; use the laptop speaker+mic.`;
        else if (peak > 0.95) why = `FAIL — mic is clipping (peak ${peak.toFixed(2)}). Lower the volume.`;
        else why = `FAIL — chirp detected but frame corrupted (${rj || 'no header'}). Echo/reverb: lower volume, try ROBUST, move away from walls.`;
      }
      log(`Acoustic self-test ${mode}: ${why}`, heard ? 'ok' : 'warn'); toast(heard ? 'Self-test passed' : 'Self-test: ' + why, heard ? 'ok' : 'warn');
    }, 1500);
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && st.mgr && [...st.mgr.sessions.values()].some((x) => x.state !== 'CLOSED')) log('Tab hidden — browsers throttle background timers; keep this page visible while linked.', 'warn'); });
  // Resume audio on any click (iOS/Chrome suspend the context after inactivity)
  document.addEventListener('click', () => { if (st.audio && st.audio.ctx && st.audio.ctx.state !== 'running') st.audio.ctx.resume().catch(() => {}); }, true);

  if (!window.isSecureContext) $('#secureWarn').hidden = false;
  if (EXT) EXT.init({ $, $$, st, log, toast, buildLink, renderStatus, renderSessions, setRate, ensureMic, isSim });
  setRate(); buildLink(); resizeCanvases(); renderStatus();
  setInterval(() => { if (st.mgr && st.active) renderStatus(); }, 1000);
})();
