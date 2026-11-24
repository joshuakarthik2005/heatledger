/* HeatLedger Studio engine. SYNTHETIC reference model; port of heatledger_sim.py.
   Works in the browser (window.HeatLedgerEngine) and in Node (module.exports). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HeatLedgerEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const BASE = { cap: 3.0, e_melt: 506.0, fixed: 60.0, hold_kw: 100.0, p_melt: 1500.0, tariff: 7.0,
    lead: 240, late_pen: 500.0, grid: 10, ef: 0.710, tap: 10, buf_lo: 10, buf_hi: 50 };

  // ---- number helpers (match Python) ----
  function pyround(x) { // round half to even, integer result
    const f = Math.floor(x), d = x - f;
    if (d < 0.5) return f; if (d > 0.5) return f + 1;
    return f % 2 === 0 ? f : f + 1;
  }
  const rnd = (x, n) => Number(x.toFixed(n));
  function pyFloat(x) { return Number.isInteger(x) ? x.toFixed(1) : String(x); }

  // ---- tariff ----
  function multMinute(m) {
    const h = (((m % 1440) + 1440) % 1440) / 60;
    if (h >= 22 || h < 6) return 0.90;
    if (h >= 18 && h < 22) return 1.20;
    return 1.0;
  }
  const PM = new Float64Array(4321);
  for (let m = 0; m < 4320; m++) PM[m + 1] = PM[m] + multMinute(m);
  function avgm(a, b) {
    a = pyround(a); b = pyround(b);
    if (b <= a) return multMinute(a);
    return (PM[b] - PM[a]) / (b - a);
  }
  const meltMin = (m, cfg) => 60.0 * m * cfg.e_melt / cfg.p_melt;

  // ---- RNG (JS-only; Python numpy streams cannot be reproduced, so parity is tested on fixed inputs) ----
  function makeRng(seed) {
    let a = seed >>> 0, spare = null;
    const u = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    return { u, uniform: (lo, hi) => lo + (hi - lo) * u(), int: (lo, hi) => lo + Math.floor(u() * (hi - lo)),
      normal: (mu, sd) => { if (spare !== null) { const s = spare; spare = null; return mu + sd * s; }
        let x = 0, y = 0, r = 0; do { x = 2 * u() - 1; y = 2 * u() - 1; r = x * x + y * y; } while (r >= 1 || r === 0);
        const f = Math.sqrt(-2 * Math.log(r) / r); spare = y * f; return mu + sd * x * f; } };
  }

  function makeDay(rng) {
    const n = rng.int(7, 11);
    const q = []; for (let i = 0; i < n; i++) q.push(rnd(rng.uniform(1.0, 1.6), 2));
    const d = []; for (let i = 0; i < n; i++) d.push(pyround(rng.uniform(480, 1080) / 5) * 5);
    d.sort((x, y) => x - y);
    for (let k = 1; k < n; k++) d[k] = Math.max(d[k], d[k - 1] + 40);
    return { q, d, noise: rng.uniform(0, 40) };
  }

  // ---- policies ----
  function baselinePlan(q, d, rng, cfg) {
    const n = q.length, heats = []; let i = 0, prevEnd = 0;
    while (i < n) {
      const target = rng.uniform(0.85, 1.0) * cfg.cap; let j = i, m = q[i];
      while (j + 1 < n && m + q[j + 1] <= target) { j++; m += q[j]; }
      const mm = meltMin(m, cfg), buffer = rng.uniform(cfg.buf_lo, cfg.buf_hi);
      const s = Math.max(d[i] - mm - buffer, prevEnd), ready = s + mm;
      heats.push([i, j, s]); prevEnd = Math.max(ready, d[j]) + cfg.tap; i = j + 1;
    }
    return heats;
  }

  function planDP(q, d, cfg) {
    const n = q.length, CAP = cfg.cap, G = cfg.grid, memo = new Map();
    function f(i, tfree) {
      if (i === n) return [0.0, []];
      const key = i * 100000 + tfree; if (memo.has(key)) return memo.get(key);
      let best = [1e18, []], m = 0.0;
      for (let j = i; j < n; j++) {
        m += q[j]; if (m > CAP + 1e-9) break;
        const fd = d[i], ld = d[j], mm = meltMin(m, cfg);
        const lo = Math.max(tfree, fd - mm - cfg.lead), hi = fd - mm + 60;
        const s0 = Math.ceil(lo / G) * G, sEnd = Math.trunc(Math.max(hi, s0));
        for (let s = s0; s <= sEnd; s += G) {
          const ready = s + mm, late = Math.max(0.0, ready - fd), holdMin = Math.max(0.0, ld - ready);
          const meltKwh = m * cfg.e_melt + cfg.fixed, holdKwh = cfg.hold_kw * holdMin / 60.0;
          const cost = cfg.tariff * (meltKwh * avgm(s, ready) + holdKwh * avgm(ready, ld)) + cfg.late_pen * late;
          const end = Math.max(ready, ld) + cfg.tap;
          const sub = f(j + 1, Math.ceil(end / G) * G), tot = cost + sub[0];
          if (tot < best[0]) best = [tot, [[i, j, s]].concat(sub[1])];
        }
      }
      memo.set(key, best); return best;
    }
    return f(0, 0)[1];
  }

  // ---- ground-truth accounting ----
  function evaluate(heats, q, d, noise, cfg) {
    const recs = []; let kwh = 0, cost = 0, holdH = 0, late = 0, fill = 0;
    for (const [i, j, s] of heats) {
      let m = 0; for (let k = i; k <= j; k++) m += q[k];
      const mm = meltMin(m, cfg), ready = s + mm, fd = d[i], ld = d[j], holdMin = Math.max(0.0, ld - ready);
      const meltKwh = m * (cfg.e_melt + noise) + cfg.fixed, holdKwh = cfg.hold_kw * holdMin / 60.0;
      const c = cfg.tariff * (meltKwh * avgm(s, ready) + holdKwh * avgm(ready, ld));
      recs.push({ i, j, tonnes: m, start: s, ready, first_due: fd, last_due: ld, kwh: meltKwh + holdKwh, cost: c, hold_min: holdMin });
      kwh += meltKwh + holdKwh; cost += c; holdH += holdMin / 60; late += Math.max(0.0, ready - fd); fill += m / cfg.cap;
    }
    return { kwh, cost, hold_h: holdH, late, heats: heats.length, fill: fill / heats.length, recs };
  }

  function study(days, seed, cfg, planCfg) {
    const rng = makeRng(seed), out = [];
    for (let day = 0; day < days; day++) {
      if (day % 7 === 6) continue;
      const { q, d, noise } = makeDay(rng);
      const brng = makeRng(Math.floor(rng.u() * 2147483648));
      const b = evaluate(baselinePlan(q, d, brng, cfg), q, d, noise, cfg);
      const p = evaluate(planDP(q, d, planCfg || cfg), q, d, noise, cfg);
      out.push({ day, q, d, noise, b, p, t: q.reduce((x, y) => x + y, 0) });
    }
    return out;
  }
  function summarize(out, cfg) {
    const t = out.reduce((x, o) => x + o.t, 0), r = {};
    for (const k of ["b", "p"]) {
      const kwh = out.reduce((x, o) => x + o[k].kwh, 0), cost = out.reduce((x, o) => x + o[k].cost, 0);
      const mean = f => out.reduce((x, o) => x + f(o[k]), 0) / out.length;
      r[k] = { kwh_t: kwh / t, rs_t: cost / t, kg_t: kwh / t * cfg.ef, heats_day: mean(h => h.heats),
        hold_h_day: mean(h => h.hold_h), late_min_day: mean(h => h.late), fill: mean(h => h.fill) };
    }
    r.save_kwh_t = r.b.kwh_t - r.p.kwh_t; r.save_rs_t = r.b.rs_t - r.p.rs_t; r.save_kg_t = r.b.kg_t - r.p.kg_t;
    r.save_pct = 100 * r.save_kwh_t / r.b.kwh_t; r.tonnes = t; r.days = out.length; return r;
  }

  // ---- 1-minute power series and heat detection ----
  function powerSeries(recs, cfg, rng) {
    const p = new Float64Array(1440); for (let i = 0; i < 1440; i++) p[i] = Math.abs(rng.normal(0, 8));
    const na = rng.int(2, 6);
    for (let k = 0; k < na; k++) { const s0 = rng.int(0, 1380), L = rng.int(10, 60), add = rng.uniform(20, 60);
      for (let i = s0; i < Math.min(1440, s0 + L); i++) p[i] += add; }
    for (const h of recs) {
      const s0 = Math.max(pyround(h.start), 0), r = Math.min(pyround(h.ready), 1440), l = Math.min(pyround(h.last_due), 1440);
      const meltKwh = h.kwh - cfg.hold_kw * h.hold_min / 60.0;
      if (r > s0) {
        const n = r - s0, shape = new Array(n).fill(1), ramp = Math.min(8, Math.floor(n / 3));
        for (let i = 0; i < ramp; i++) shape[i] = 0.25 + (1.0 - 0.25) * i / (ramp - 1 || 1);
        let sum = 0; for (let i = 0; i < n; i++) { shape[i] *= (1 + rng.normal(0, 0.05)); sum += shape[i]; }
        for (let i = 0; i < n; i++) p[s0 + i] = shape[i] * meltKwh * 60.0 / sum;
      }
      if (l > r) { let c = 0; for (let i = r; i < l; i++) { c += rng.normal(0, 3); p[i] = Math.max(20, cfg.hold_kw + c); } }
    }
    return p;
  }
  function median(a) { const s = Array.from(a).sort((x, y) => x - y), n = s.length;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; }

  function detectClean(p, holdEst, meltThr, minMelt, gap) {
    holdEst = holdEst === undefined ? 100.0 : holdEst; meltThr = meltThr === undefined ? 200.0 : meltThr;
    minMelt = minMelt === undefined ? 5 : minMelt; gap = gap === undefined ? 3 : gap;
    const n = p.length, melt = []; for (let i = 0; i < n; i++) if (p[i] > meltThr) melt.push(i);
    if (!melt.length) return [];
    const groups = []; let st = melt[0], prev = melt[0];
    for (let k = 1; k < melt.length; k++) { const m = melt[k]; if (m - prev > 6) { groups.push([st, prev]); st = m; } prev = m; }
    groups.push([st, prev]);
    const out = [];
    groups.forEach(([ms, me], k) => {
      if (me - ms + 1 < minMelt) return;
      const pre = Array.prototype.slice.call(p, Math.max(ms - 25, 0), Math.max(ms - 3, 0)); let aux = 0.0;
      if (pre.length >= 5 && !pre.some(v => v > 0.8 * holdEst)) aux = Math.max(0.0, median(pre) - 5.4);
      const c = i => Math.max(p[i] - aux, 0), thr = 0.5 * holdEst, nxt = k + 1 < groups.length ? groups[k + 1][0] : n;
      let e = me + 1, low = 0;
      while (e < Math.min(n, nxt - 1)) { if (c(e) > thr) low = 0; else { low++; if (low > gap) break; } e++; }
      e -= low; let s = 0; for (let i = ms; i < e; i++) s += c(i);
      out.push([ms, e, s / 60.0]);
    });
    return out;
  }
  function matchHeats(recs, det) {
    const pairs = [], used = new Set();
    for (const h of recs) {
      const hs = h.start, he = Math.max(h.ready, h.last_due); let best = null;
      det.forEach(([s0, e], k) => { const ov = Math.min(e, he) - Math.max(s0, hs); if (ov > 0 && (best === null || ov > best[0])) best = [ov, k]; });
      if (best) { used.add(best[1]); pairs.push([h, det[best[1]]]); }
    }
    return { pairs, falsePositives: det.length - used.size };
  }
  // Estimate holding power and per-heat overhead from detected heats (tonnes known from charge log)
  function calibrate(heats) { // heats: [{tonnes, meltKwh, holdKw|null}]
    const X = heats.map(h => h.tonnes), Y = heats.map(h => h.meltKwh), n = X.length;
    const mx = X.reduce((a, b) => a + b, 0) / n, my = Y.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0; for (let i = 0; i < n; i++) { sxy += (X[i] - mx) * (Y[i] - my); sxx += (X[i] - mx) ** 2; }
    const slope = sxx ? sxy / sxx : NaN, icpt = my - slope * mx, holds = heats.map(h => h.holdKw).filter(v => v != null);
    return { n, kwh_per_t_melt_est: slope, fixed_est: icpt, hold_kw_est: holds.length ? median(holds) : null };
  }

  // ---- SHA-256 (pure JS, sync; works on http/file origins where crypto.subtle is unavailable) ----
  const K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  function utf8(s) { if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s);
    return Uint8Array.from(Buffer.from(s, "utf8")); }
  function sha256(str) {
    const msg = utf8(str), l = msg.length, nb = (((l + 9 + 63) >> 6) << 6), buf = new Uint8Array(nb);
    buf.set(msg); buf[l] = 0x80; const dv = new DataView(buf.buffer);
    dv.setUint32(nb - 8, Math.floor(l / 0x20000000)); dv.setUint32(nb - 4, (l << 3) >>> 0);
    const H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]), w = new Uint32Array(64);
    const rr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let o = 0; o < nb; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
      for (let i = 16; i < 64; i++) { const s0 = rr(w[i-15],7) ^ rr(w[i-15],18) ^ (w[i-15] >>> 3), s1 = rr(w[i-2],17) ^ rr(w[i-2],19) ^ (w[i-2] >>> 10);
        w[i] = (w[i-16] + s0 + w[i-7] + s1) >>> 0; }
      let [a,b,c,d,e,f,g,h] = H;
      for (let i = 0; i < 64; i++) {
        const S1 = rr(e,6) ^ rr(e,11) ^ rr(e,25), ch = (e & f) ^ (~e & g), t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
        const S0 = rr(a,2) ^ rr(a,13) ^ rr(a,22), mj = (a & b) ^ (a & c) ^ (b & c), t2 = (S0 + mj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0]+=a; H[1]+=b; H[2]+=c; H[3]+=d; H[4]+=e; H[5]+=f; H[6]+=g; H[7]+=h;
    }
    return Array.from(H, x => x.toString(16).padStart(8, "0")).join("");
  }

  // ---- hash-chained receipts (payload string matches Python json.dumps(separators=(",",":"))) ----
  const ZERO = "0".repeat(64);
  function payload(h, prev) {
    return '{"id":"' + h.id + '","start":' + h.start + ',"end":' + h.end + ',"tonnes":' + pyFloat(h.tonnes) +
      ',"kw":[' + h.kw.map(pyFloat).join(",") + '],"prev":"' + prev + '"}';
  }
  function buildChain(heats) { // heats: [{id,start,end,tonnes,kw:[...1-dp readings]}]
    let prev = ZERO; return heats.map(h => { const pl = payload(h, prev), hash = sha256(pl); prev = hash; return { payload: pl, hash }; });
  }
  function verifyChain(chain, anchor) {
    let prev = ZERO;
    for (let n = 0; n < chain.length; n++) {
      const d = JSON.parse(chain[n].payload);
      if (d.prev !== prev) return "FAIL: chain broken at heat " + (n + 1);
      if (sha256(chain[n].payload) !== chain[n].hash) return "FAIL: heat " + (n + 1) + " payload altered";
      prev = chain[n].hash;
    }
    return prev === anchor ? "OK" : "FAIL: head hash does not match the externally anchored value";
  }
  function rechainFrom(chain, from, edit) { // attacker edits heat `from` then recomputes every later hash
    const out = chain.slice(0, from); let prev = from ? chain[from - 1].hash : ZERO;
    for (let n = from; n < chain.length; n++) {
      const d = JSON.parse(chain[n].payload); d.prev = prev; if (n === from) edit(d);
      const pl = payload({ id: d.id, start: d.start, end: d.end, tonnes: d.tonnes, kw: d.kw }, prev);
      prev = sha256(pl); out.push({ payload: pl, hash: prev });
    }
    return out;
  }
  function receiptFromReadings(h, prevHash, cfg, cost) {
    const kwh = h.kw.reduce((a, b) => a + b, 0) / 60.0, hash = sha256(payload(h, prevHash));
    return { kwh: rnd(kwh, 1), kwh_per_t: rnd(kwh / h.tonnes, 1), kgco2e_per_t: rnd(kwh / h.tonnes * cfg.ef, 1),
      rs_per_t: cost == null ? null : Math.round(cost / h.tonnes), hash: hash.slice(0, 12), prev_hash: prevHash.slice(0, 12), full: hash };
  }

  // ---- CSV helpers for "Your data" ----
  function parseClock(s) { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim()); return m ? (+m[1]) * 60 + (+m[2]) : NaN; }
  function parseCsv(text) {
    const lines = text.replace(/\r/g, "").split("\n").filter(l => l.trim()); if (!lines.length) return [];
    const head = lines[0].split(",").map(s => s.trim().toLowerCase());
    return lines.slice(1).map(l => { const c = l.split(","), o = {}; head.forEach((k, i) => o[k] = (c[i] || "").trim()); return o; });
  }

  return { BASE, pyround, pyFloat, multMinute, avgm, meltMin, makeRng, makeDay, baselinePlan, planDP, evaluate, study, summarize,
    powerSeries, detectClean, matchHeats, calibrate, sha256, buildChain, verifyChain, rechainFrom, payload, receiptFromReadings, parseClock, parseCsv, ZERO };
});
