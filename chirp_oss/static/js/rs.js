/*! WhisperLink OSS — Reed-Solomon GF(256) and CRC helpers.
 * Author: Antonio Brandao
 * License: MIT
 */
(function (root) {
  'use strict';
  // GF(2^8) with primitive polynomial 0x11d, generator alpha = 2, fcr = 0
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function init() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x; LOG[x] = i;
      x <<= 1; if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const mul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];
  const div = (a, b) => { if (b === 0) throw new Error('div0'); return a === 0 ? 0 : EXP[(LOG[a] + 255 - LOG[b]) % 255]; };
  const pow = (a, n) => EXP[((LOG[a] * n) % 255 + 255) % 255];
  const inv = (a) => EXP[255 - LOG[a]];

  function polyMul(p, q) {
    const r = new Uint8Array(p.length + q.length - 1);
    for (let j = 0; j < q.length; j++) for (let i = 0; i < p.length; i++) r[i + j] ^= mul(p[i], q[j]);
    return r;
  }
  function polyEval(p, x) { // p[0] is highest degree
    let y = p[0];
    for (let i = 1; i < p.length; i++) y = mul(y, x) ^ p[i];
    return y;
  }
  const genCache = {};
  function generator(nsym) {
    if (genCache[nsym]) return genCache[nsym];
    let g = new Uint8Array([1]);
    for (let i = 0; i < nsym; i++) g = polyMul(g, new Uint8Array([1, pow(2, i)]));
    return (genCache[nsym] = g);
  }

  /** Systematic encode: returns msg || parity (nsym bytes). msg.length + nsym <= 255 */
  function encode(msg, nsym) {
    if (msg.length + nsym > 255) throw new Error('RS block too long');
    const gen = generator(nsym);
    const out = new Uint8Array(msg.length + nsym);
    out.set(msg);
    for (let i = 0; i < msg.length; i++) {
      const coef = out[i];
      if (coef !== 0) for (let j = 1; j < gen.length; j++) out[i + j] ^= mul(gen[j], coef);
    }
    out.set(msg);
    return out;
  }

  function syndromes(cw, nsym) {
    const s = new Uint8Array(nsym);
    let any = false;
    for (let i = 0; i < nsym; i++) { s[i] = polyEval(cw, pow(2, i)); if (s[i]) any = true; }
    return any ? s : null;
  }

  /** Decode codeword (msg||parity). Returns {data, corrected} or null if uncorrectable. */
  function decode(cwIn, nsym) {
    const cw = Uint8Array.from(cwIn);
    const n = cw.length;
    const synd = syndromes(cw, nsym);
    if (!synd) return { data: cw.slice(0, n - nsym), corrected: 0 };
    // Berlekamp–Massey (polys stored lowest-degree first here)
    let C = [1], B = [1], L = 0, m = 1, b = 1;
    for (let r = 0; r < nsym; r++) {
      let d = synd[r];
      for (let i = 1; i <= L; i++) d ^= mul(C[i] || 0, synd[r - i]);
      if (d === 0) { m++; continue; }
      const T = C.slice();
      const coef = div(d, b);
      const need = B.length + m;
      while (C.length < need) C.push(0);
      for (let i = 0; i < B.length; i++) C[i + m] ^= mul(coef, B[i]);
      if (2 * L <= r) { L = r + 1 - L; B = T; b = d; m = 1; } else m++;
    }
    while (C.length > 1 && C[C.length - 1] === 0) C.pop();
    if (L * 2 > nsym || C.length - 1 !== L) return null;
    // Chien search: position i (from end) is error if C(alpha^-i) == 0
    const errPos = [];
    for (let i = 0; i < n; i++) {
      const xinv = EXP[(255 - i) % 255];
      let v = 0;
      for (let j = C.length - 1; j >= 0; j--) v = mul(v, xinv) ^ C[j];
      if (v === 0) errPos.push(i); // i = power (distance from last byte)
    }
    if (errPos.length !== L) return null;
    // Forney: Omega = S(x)*C(x) mod x^nsym (lowest-first)
    const Om = new Array(nsym).fill(0);
    for (let i = 0; i < nsym; i++) for (let j = 0; j < C.length && i + j < nsym; j++) Om[i + j] ^= mul(synd[i], C[j]);
    // C'(x) formal derivative
    for (const p of errPos) {
      const X = EXP[p % 255], Xinv = inv(X);
      let num = 0;
      for (let i = Om.length - 1; i >= 0; i--) num = mul(num, Xinv) ^ Om[i];
      let den = 0;
      for (let j = 1; j < C.length; j += 2) den ^= mul(C[j], pow(Xinv, j - 1));
      if (den === 0) return null;
      // fcr = 0 => magnitude = X * num / den
      const mag = mul(X, div(num, den));
      cw[n - 1 - p] ^= mag;
    }
    if (syndromes(cw, nsym)) return null;
    return { data: cw.slice(0, n - nsym), corrected: errPos.length };
  }

  // CRC-32 (IEEE) and CRC-8 (poly 0x07)
  const CRC_T = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC_T[i] = c >>> 0; }
  function crc32(bytes) { let c = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i++) c = CRC_T[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function crc8(bytes) { let c = 0; for (let i = 0; i < bytes.length; i++) { c ^= bytes[i]; for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff; } return c; }

  const api = { encode, decode, crc32, crc8, gf: { mul, div, pow, inv } };
  root.ChirpRS = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
