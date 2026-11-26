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
      let d; try { d = JSON.parse(chain[n].payload); } catch (e) { return "FAIL: heat " + (n + 1) + " payload is not valid JSON"; }
      if (!d || d.prev !== prev) return "FAIL: chain broken at heat " + (n + 1);
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

  // ---- chain export / verify helpers (format: JSON array of {payload, hash}) ----
  function exportChain(chain) { return JSON.stringify(chain.map(c => ({ payload: c.payload, hash: c.hash })), null, 2); }
  function parseChainJson(text) {
    if (!String(text).trim()) return { error: "Paste the receipt chain JSON first." };
    let a; try { a = JSON.parse(text); } catch (e) { return { error: "Not valid JSON: " + e.message }; }
    if (!Array.isArray(a) || !a.length) return { error: "Expected a non-empty JSON array of {payload, hash}." };
    for (let i = 0; i < a.length; i++)
      if (!a[i] || typeof a[i].payload !== "string" || typeof a[i].hash !== "string") return { error: "Item " + (i + 1) + " must be an object with string fields payload and hash." };
    return { chain: a.map(c => ({ payload: c.payload, hash: c.hash })) };
  }
  // Per-heat result plus the overall verdict from verifyChain (the verdict is authoritative).
  function verifyChainDetail(chain, anchor) {
    anchor = String(anchor || "").trim().toLowerCase();
    let prev = ZERO; const heats = [];
    chain.forEach((c, n) => {
      const reasons = []; let d = null;
      try { d = JSON.parse(c.payload); } catch (e) { reasons.push("payload is not valid JSON"); }
      if (d && d.prev !== prev) reasons.push("link to previous heat is broken");
      if (sha256(c.payload) !== String(c.hash).toLowerCase()) reasons.push("payload does not match its hash");
      let kwh = null; if (d && Array.isArray(d.kw)) kwh = d.kw.reduce((a, b) => a + b, 0) / 60.0;
      heats.push({ n: n + 1, id: d && d.id != null ? String(d.id) : "?", start: d && d.start, end: d && d.end, tonnes: d && d.tonnes, kwh,
        ok: !reasons.length, reason: reasons.join("; "), hash: c.hash }); prev = String(c.hash).toLowerCase();
    });
    const lc = chain.map(c => ({ payload: c.payload, hash: String(c.hash).toLowerCase() }));
    const verdict = verifyChain(lc, anchor), head = lc.length ? lc[lc.length - 1].hash : "";
    return { verdict, ok: verdict === "OK", heats, head, anchorMatches: head === anchor };
  }

  // ---- CSV helpers ----
  function parseClock(s) { // H:MM, H:MM:SS, optional AM/PM, optional leading date (spreadsheet cells)
    const m = /^(?:\d{4}-\d{2}-\d{2}[T ]|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\s+)?(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?$/i.exec(String(s).trim());
    if (!m) return NaN; let h = +m[1]; const mi = +m[2], ap = m[3] && m[3].toLowerCase();
    if (ap) { if (h < 1 || h > 12) return NaN; h = (h % 12) + (ap === "pm" ? 12 : 0); }
    if (h > 23 || mi > 59) return NaN; return h * 60 + mi;
  }
  function detectDelimiter(line) { // pasted spreadsheet cells are tab-separated; European CSV uses semicolons
    const c = ch => line.split(ch).length - 1, t = c("\t"), sc = c(";"), co = c(",");
    return t > 0 && t >= sc ? "\t" : sc > co ? ";" : ",";
  }
  function splitCsvLine(line, delim) { // handles "quoted, fields" and "" escapes; no multi-line fields
    delim = delim || ","; const out = []; let cur = "", q = false;
    for (let i = 0; i < line.length; i++) { const c = line[i];
      if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true; else if (c === delim) { out.push(cur); cur = ""; } else cur += c; }
    out.push(cur); return out.map(s => s.trim());
  }
  function readCsv(text) {
    const lines = String(text).replace(/^﻿/, "").replace(/\r/g, "").split("\n").filter(l => l.trim());
    if (!lines.length) return { head: [], raw: [], table: [], rows: [], delim: "," };
    const delim = detectDelimiter(lines[0]), raw = splitCsvLine(lines[0], delim), head = raw.map(s => s.toLowerCase());
    const table = lines.slice(1).map(l => splitCsvLine(l, delim).map(v => delim === ";" && /^-?\d+,\d+$/.test(v) ? v.replace(",", ".") : v));
    return { head, raw, table, delim, rows: table.map(c => { const o = {}; head.forEach((k, i) => o[k] = (c[i] || "").trim()); return o; }) };
  }
  function parseCsv(text) { return readCsv(text).rows; }
  const num = s => { if (s === undefined || s === null) return NaN; s = String(s).trim(); if (s === "") return NaN;
    if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, ""); return Number(s); };

  // ---- header alias matching ("Wt (kg)", "Heat No.", "kWh (meter)" ...) ----
  const ALIAS = { heat: ["heat", "heatno", "no", "heatnumber", "heatnum"], grade: ["grade"],
    start: ["start", "starttime", "chargingtime", "charging"], tap: ["tap", "taptime", "tapping", "tappingtime"],
    kwh: ["kwh", "kwhmeter", "energy", "meterkwh", "energykwh"], remarks: ["remarks", "remark", "note", "notes"],
    meter_before: ["meterbefore", "meterbeforekwh"], meter_after: ["meterafter", "meterafterkwh"], hold_min: ["holdmin", "holdminutes"] };
  const WEIGHT_ALIAS = { weightkg: "kg", wtkg: "kg", chargekg: "kg", metalkg: "kg", wt: null, weight: null, charge: null, metal: null,
    tonnes: "t", tonne: "t", tons: "t", weightt: "t", weighttonnes: "t", wtt: "t", charget: "t", chargetonnes: "t", metalt: "t" };
  function headerKey(h) { // -> {key, unit}: lower-case, units pulled out of (brackets), punctuation stripped
    let s = String(h).replace(/^﻿/, "").toLowerCase().trim(), unit = null;
    s = s.replace(/[(\[]([^)\]]*)[)\]]/g, (m, inner) => { const u = inner.replace(/[^a-z]/g, "");
      if (u === "kg" || u === "kgs") unit = "kg"; else if (["t", "tonnes", "tonne", "tons", "ton", "mt"].indexOf(u) >= 0) unit = "t"; return " "; });
    return { key: s.replace(/[^a-z0-9]+/g, ""), unit };
  }
  function autoMap(raw) { // -> { field: {idx, unit} } ; first matching header wins per field
    const map = {};
    raw.forEach((h, idx) => { const { key, unit } = headerKey(h);
      for (const f in ALIAS) if (!map[f] && ALIAS[f].indexOf(key) >= 0) { map[f] = { idx, unit: null }; return; }
      if (!map.weight && Object.prototype.hasOwnProperty.call(WEIGHT_ALIAS, key)) map.weight = { idx, unit: unit || WEIGHT_ALIAS[key] || null }; });
    return map;
  }
  const REQUIRED = ["weight", "start", "tap", "kwh"];
  // opts.map: { field: "raw header name" | "" } overrides; opts.weightUnit: "kg" | "t".
  function parseHeatLog(text, opts) {
    opts = opts || {}; const rc = readCsv(text), out = [], skipped = [], errors = [], warnings = [];
    if (!rc.raw.length) return { rows: [], skipped, errors: ["Empty input."], warnings, headers: [], mapping: {}, unmapped: [], needsMapping: false };
    const map = autoMap(rc.raw);
    Object.keys(opts.map || {}).forEach(f => { const v = opts.map[f]; const idx = v ? rc.raw.indexOf(v) : -1;
      if (idx >= 0) map[f] = { idx, unit: f === "weight" ? headerKey(v).unit : null }; else delete map[f]; });
    const mapping = {}; Object.keys(map).forEach(f => mapping[f] = rc.raw[map[f].idx]);
    const haveKwh = map.kwh || (map.meter_before && map.meter_after);
    const unmapped = REQUIRED.filter(f => f === "kwh" ? !haveKwh : !map[f]);
    const base = { headers: rc.raw, mapping, unmapped, weightUnit: opts.weightUnit || (map.weight && map.weight.unit) || "kg", delimiter: rc.delim };
    if (unmapped.length) return Object.assign({ rows: [], skipped, errors, warnings, needsMapping: true }, base);
    const wu = base.weightUnit, cell = (c, f) => (map[f] ? (c[map[f].idx] || "").trim() : "");
    let day = 0, prevStart = null, crossings = 0, negMeter = 0;
    rc.table.forEach((c, n) => {
      const line = n + 2, s = parseClock(cell(c, "start")), t = parseClock(cell(c, "tap")), w = num(cell(c, "weight"));
      let kwh = num(cell(c, "kwh")), fromMeters = false;
      if (!(kwh > 0) && isNaN(kwh) && map.meter_before && map.meter_after) { const b = num(cell(c, "meter_before")), a = num(cell(c, "meter_after"));
        if (!isNaN(a) && !isNaN(b)) { kwh = a - b; fromMeters = true; if (kwh < 0) { negMeter++; warnings.push("Line " + line + ": meter_after is lower than meter_before (" + kwh.toFixed(1) + " kWh); row skipped. Meter rollover or swapped columns?"); } } }
      const tonnes = wu === "t" ? w : w / 1000;
      const why = isNaN(s) ? "bad start time" : isNaN(t) ? "bad tap time" : !(tonnes > 0) ? "missing or non-positive weight" : !(kwh > 0) ? (fromMeters && kwh < 0 ? "negative kWh from meters" : "missing or non-positive kwh") : null;
      if (why) { skipped.push({ line, reason: why }); return; }
      let start = day * 1440 + s;
      while (prevStart !== null && start < prevStart) { day++; start += 1440; crossings++; }
      const tap = start - s + t + (t < s ? 1440 : 0), remarks = cell(c, "remarks"), hm = cell(c, "hold_min");
      out.push({ line, heat: cell(c, "heat") || String(out.length + 1), grade: cell(c, "grade"), tonnes, kwh, perT: kwh / tonnes, start, tap, remarks,
        flagged: /hold|long/i.test(remarks), hold: hm ? +hm : null, fromMeters });
      prevStart = start;
    });
    if (crossings || out.some(o => o.tap >= 1440)) warnings.push("Run crosses midnight: times were read as a continuous multi-day run.");
    if (out.some(o => o.fromMeters)) warnings.push(out.filter(o => o.fromMeters).length + " row(s) used kWh = meter_after − meter_before.");
    if (map.weight && !map.weight.unit && !opts.weightUnit) warnings.push("Weight column has no unit in its header; read as kilograms. Choose tonnes in the column mapping if that is wrong.");
    return Object.assign({ rows: out, skipped, errors, warnings, needsMapping: false }, base);
  }
  function logStats(rows, ef) {
    const agg = a => { const t = a.reduce((x, r) => x + r.tonnes, 0), k = a.reduce((x, r) => x + r.kwh, 0); return { n: a.length, tonnes: t, kwh: k, kwh_t: t ? k / t : NaN, kg_t: t ? k / t * ef : NaN }; };
    const fl = rows.filter(r => r.flagged), rest = rows.filter(r => !r.flagged), all = agg(rows), pt = rows.map(r => r.perT);
    return { all, min: Math.min.apply(null, pt), max: Math.max.apply(null, pt), flagged: agg(fl), rest: agg(rest),
      diff: fl.length && rest.length ? agg(fl).kwh_t - agg(rest).kwh_t : null };
  }

  // ---- meter series: tolerant import of analyzer exports (1-, 5- or 10-minute samples). No clipping of kW values. ----
  function parseTimestamp(s, o) { // -> {iso, t} | null. t = minutes: absolute (UTC-style, deterministic) when a date is present, else minutes since midnight.
    s = String(s).trim(); o = o || {}; let ap = null;
    const am = /\s*([ap])\.?m\.?$/i.exec(s); if (am) { ap = am[1].toLowerCase(); s = s.slice(0, am.index).trim(); }
    const hr = h => { if (ap) { if (h < 1 || h > 12) return -1; return (h % 12) + (ap === "p" ? 12 : 0); } return h; };
    const mk = (y, mo, d, h, mi, sec) => { h = hr(h); if (h < 0 || h > 23 || mi > 59 || sec > 59 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
      const ms = Date.UTC(y, mo - 1, d, h, mi, sec); if (new Date(ms).getUTCDate() !== d) return null; return { iso: true, t: ms / 60000 }; };
    let m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:[T ,]+)(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s);
    if (m) return mk(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0));
    m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2}|\d{4})(?:[T ,]+)(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/.exec(s);
    if (m) { const a = +m[1], b = +m[2], y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; return o.monthFirst ? mk(y, a, b, +m[4], +m[5], +(m[6] || 0)) : mk(y, b, a, +m[4], +m[5], +(m[6] || 0)); }
    m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s); if (!m) return null;
    const h = hr(+m[1]); if (h < 0 || h > 23 || +m[2] > 59 || +(m[3] || 0) > 59) return null;
    return { iso: false, t: h * 60 + (+m[2]) + (+(m[3] || 0)) / 60 };
  }
  // header recognition for series columns. unit: "kw" | "w" | null (unknown)
  const S_TS = ["timestamp", "timestamps", "time", "datetime", "dateandtime", "datetimestamp"];
  const S_TOTAL = { kw: "kw", totalkw: "kw", ptotal: null, ptotalkw: "kw", activepowertotal: null, activepowertotalkw: "kw", powertotal: null, powertotalkw: "kw",
    totalpower: null, totalpowerkw: "kw", totalactivepower: null, totalactivepowerkw: "kw", activepower: null, activepowerkw: "kw", power: null, powerkw: "kw", pkw: "kw",
    totalw: "w", ptotalw: "w", w: "w", totalpowerw: "w", powerw: "w", activepowerw: "w", activepowertotalw: "w", totalactivepowerw: "w" };
  const S_KVA = { totalkva: "kva", kva: "kva", kvatotal: "kva", stotal: null, apparentpower: null, totalapparentpower: null, apparentpowerkva: "kva", totalva: "va", va: "va" };
  const S_PF = ["powerfactor", "pf", "totalpf", "pftotal", "cosphi", "totalpowerfactor", "powerfactortotal"];
  function seriesHeader(h) { // -> {key, bu}: bracketed unit pulled out ("P total (W)" -> ptotal, bu "w")
    let s = String(h).replace(/^﻿/, "").toLowerCase().trim(), bu = null;
    s = s.replace(/[(\[]([^)\]]*)[)\]]/g, (m, inner) => { const u = inner.replace(/[^a-z]/g, ""); if (["kw", "w", "mw", "kva", "va"].indexOf(u) >= 0) bu = u; return " "; });
    return { key: s.replace(/[^a-z0-9]+/g, ""), bu };
  }
  function phaseOf(key) { let m = /^(?:l|pl|activepowerl|powerl)([123])(kw|w)$/.exec(key) || /^(?:p|pl)([123])(kw|w)?$/.exec(key) || /^(?:kwl|kw)([123])()$/.exec(key); return m ? { n: +m[1], unit: m[2] || null } : null; }
  function seriesCols(raw) { // auto-detect -> { ts, total:{idx,unit}, phases:[{n,idx,unit}], kva:{idx,unit}, pf }
    const c = { ts: -1, total: null, phases: [], kva: null, pf: -1 };
    raw.forEach((h, idx) => { const { key, bu } = seriesHeader(h), unitOf = imp => (bu === "w" || bu === "mw") ? "w" : bu === "kw" ? "kw" : imp;
      if (c.ts < 0 && S_TS.indexOf(key) >= 0) { c.ts = idx; return; }
      if (Object.prototype.hasOwnProperty.call(S_TOTAL, key)) { const rk = key.indexOf("total") >= 0 ? 0 : 1;
        if (!c.total || rk < c.total.rank) c.total = { idx, unit: unitOf(S_TOTAL[key]), rank: rk }; return; }
      const ph = phaseOf(key); if (ph) { if (!c.phases.some(p => p.n === ph.n)) c.phases.push({ n: ph.n, idx, unit: unitOf(ph.unit) }); return; }
      if (!c.kva && Object.prototype.hasOwnProperty.call(S_KVA, key)) { c.kva = { idx, unit: bu === "va" ? "va" : bu === "kva" ? "kva" : S_KVA[key] }; return; }
      if (c.pf < 0 && S_PF.indexOf(key) >= 0) c.pf = idx; });
    c.phases.sort((a, b) => a.n - b.n); return c;
  }
  const SER_FIELDS = ["ts", "kw", "l1", "l2", "l3", "kva", "pf"]; // keys of opts.map for series
  // opts: { nameplate, map: {ts,kw,l1,l2,l3,kva,pf -> raw header name | ""}, unit: "auto"|"kw"|"w", now: Date }
  function parseSeries(text, opts) {
    opts = opts || {}; const warnings = [], errors = [];
    const res = { p: new Float64Array(0), t0: 0, step: NaN, n: 0, skipped: 0, missing: 0, max: 0, duplicates: 0, gaps: [], warnings, errors, needsMapping: false, unmapped: [], headers: [], mapping: {}, delimiter: ",", preamble: 0, wattsConverted: false };
    const lines = String(text).replace(/^﻿/, "").replace(/\r/g, "").split("\n").filter(l => l.trim());
    if (!lines.length) { errors.push("Empty input."); return res; }
    // (2) find the real header row: first row with a timestamp-like and a power-like header
    let hi = -1; for (let i = 0; i < Math.min(lines.length, 300); i++) { const c = seriesCols(splitCsvLine(lines[i], detectDelimiter(lines[i]))); if (c.ts >= 0 && (c.total || c.phases.length)) { hi = i; break; } }
    if (hi < 0) { hi = 0; for (let i = 0; i + 1 < Math.min(lines.length, 300); i++) { const a = splitCsvLine(lines[i], detectDelimiter(lines[i])), b = splitCsvLine(lines[i + 1], detectDelimiter(lines[i + 1])); if (a.length >= 2 && a.length === b.length) { hi = i; break; } } }
    const delim = detectDelimiter(lines[hi]), raw = splitCsvLine(lines[hi], delim); res.headers = raw; res.delimiter = delim; res.preamble = hi; res.sig = raw.join("");
    if (hi > 0) warnings.push("Skipped " + hi + " preamble line(s) before the header row.");
    const cols = seriesCols(raw), mp = opts.map || {}, setIdx = f => { const v = mp[f]; return v ? raw.indexOf(v) : -1; };
    Object.keys(mp).forEach(f => { const idx = setIdx(f), has = idx >= 0;
      if (f === "ts") cols.ts = has ? idx : -1; else if (f === "kw") cols.total = has ? { idx, unit: (seriesHeader(raw[idx]).bu === "w" || seriesHeader(raw[idx]).bu === "mw") ? "w" : seriesHeader(raw[idx]).bu === "kw" ? "kw" : null, rank: 0 } : null;
      else if (/^l[123]$/.test(f)) { const n = +f[1]; cols.phases = cols.phases.filter(p => p.n !== n); if (has) cols.phases.push({ n, idx, unit: (seriesHeader(raw[idx]).bu === "w") ? "w" : seriesHeader(raw[idx]).bu === "kw" ? "kw" : null }); cols.phases.sort((a, b) => a.n - b.n); }
      else if (f === "kva") cols.kva = has ? { idx, unit: seriesHeader(raw[idx]).bu === "va" ? "va" : "kva" } : null; else if (f === "pf") cols.pf = has ? idx : -1; });
    const mapping = {}; if (cols.ts >= 0) mapping.ts = raw[cols.ts]; if (cols.total) mapping.kw = raw[cols.total.idx]; cols.phases.forEach(p => mapping["l" + p.n] = raw[p.idx]); if (cols.kva) mapping.kva = raw[cols.kva.idx]; if (cols.pf >= 0) mapping.pf = raw[cols.pf];
    res.mapping = mapping;
    if (cols.ts < 0) res.unmapped.push("ts"); if (!cols.total && !cols.phases.length) res.unmapped.push("kw");
    if (res.unmapped.length) { res.needsMapping = true; return res; }
    // rows
    const dec = c => delim === ";" && /^-?\d+,\d+$/.test(c) ? c.replace(",", ".") : c, cell = (c, i) => i >= 0 && i < c.length ? dec(c[i].trim()) : "";
    const data = lines.slice(hi + 1).map(l => splitCsvLine(l, delim));
    if (delim === ";" && data.some(c => c.some(v => /^-?\d+,\d+$/.test(v)))) warnings.push("Semicolon-separated file: decimal commas were read as decimal points.");
    let dayFirstEv = false, monthFirstEv = false;
    data.forEach(c => { const m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-]\d{2,4}/.exec(cell(c, cols.ts)); if (m) { if (+m[1] > 12) dayFirstEv = true; if (+m[2] > 12) monthFirstEv = true; } });
    const monthFirst = monthFirstEv && !dayFirstEv; if (monthFirst) warnings.push("Dates look like mm/dd/yyyy (a second field above 12), so they were read month-first.");
    // power values (raw units)
    const recs = []; let badRows = 0;
    data.forEach(c => { const tsText = cell(c, cols.ts); if (!tsText) { badRows++; return; }
      const ph = cols.phases.map(p => num(cell(c, p.idx))), tot = cols.total ? num(cell(c, cols.total.idx)) : NaN, haveTot = isFinite(tot);
      const sum = ph.length && ph.every(isFinite) ? ph.reduce((a, b) => a + b, 0) : NaN;
      recs.push({ ts: tsText, tot: haveTot ? tot : NaN, sum, ph, kva: cols.kva ? num(cell(c, cols.kva.idx)) : NaN, pf: cols.pf >= 0 ? num(cell(c, cols.pf)) : NaN, kw: haveTot ? tot : sum }); });
    if (!cols.total && cols.phases.length) warnings.push("No total power column: summed " + cols.phases.length + " per-phase column(s) (" + cols.phases.map(p => raw[p.idx]).join(", ") + ")." + (cols.phases.length < 3 ? " Fewer than 3 phases found, so the sum may be low." : ""));
    // (1) watts -> kW
    const vals = recs.map(r => r.kw).filter(isFinite), med = vals.length ? median(vals) : 0, hdrUnit = cols.total ? cols.total.unit : (cols.phases.some(p => p.unit === "w") ? "w" : cols.phases.every(p => p.unit === "kw") ? "kw" : null);
    const mode = opts.unit === "w" || opts.unit === "kw" ? opts.unit : "auto"; let conv = false, why = "";
    if (mode === "w") { conv = true; why = "you chose watts"; } else if (mode === "kw") conv = false;
    else if (hdrUnit === "w") { conv = true; why = "the header says W, not kW"; }
    else if (hdrUnit === "kw") { if (med > 5000 && opts.nameplate && opts.nameplate < 1000) warnings.push("Median reading is " + Math.round(med) + " but the header says kW, and the nameplate is only " + opts.nameplate + " kW. If the values are watts, choose W in the column mapping."); }
    else if (med > 5000 && opts.nameplate && opts.nameplate < 1000) { conv = true; why = "median " + Math.round(med) + " is far above a " + opts.nameplate + " kW nameplate"; }
    if (conv) { res.wattsConverted = true; warnings.push("Power values treated as watts (" + why + "); divided by 1000 to give kW.");
      recs.forEach(r => { r.kw /= 1000; r.tot /= 1000; r.sum /= 1000; }); }
    const kvaVals = recs.map(r => r.kva).filter(isFinite);
    if (cols.kva && kvaVals.length && (cols.kva.unit === "va" || (conv && median(kvaVals) > 5000))) recs.forEach(r => { r.kva /= 1000; });
    // timestamps -> series points
    const pts = [], seen = new Set(); let day = 0, prevClock = null, prevT = null, skipped = badRows, dups = 0, anyDated = false;
    recs.forEach(r => { const ts = parseTimestamp(r.ts, { monthFirst });
      if (!ts || !(r.kw >= 0) || !isFinite(r.kw)) { skipped++; return; }
      let t = ts.t; if (ts.iso) anyDated = true;
      if (!ts.iso) { if (prevClock !== null && t < prevClock) day++; prevClock = t; t += day * 1440; }
      if (seen.has(t)) { dups++; return; } if (prevT !== null && t < prevT) { skipped++; return; }
      seen.add(t); prevT = t; pts.push({ t, kw: r.kw, r, iso: ts.iso }); });
    res.skipped = skipped; res.duplicates = dups;
    if (skipped) warnings.push(skipped + " row(s) skipped (bad timestamp, negative or non-numeric kW, or not increasing).");
    if (dups) warnings.push(dups + " duplicate timestamp(s); the first reading for each was kept.");
    if (pts.length < 10) { errors.push("Fewer than 10 usable rows."); return res; }
    const diffs = []; for (let i = 1; i < pts.length; i++) diffs.push(pts[i].t - pts[i - 1].t);
    const step = median(diffs); res.step = step;
    if (step < 0.99) { errors.push("Samples are closer than 1 minute; resample to 1-minute data first."); return res; }
    if (step > 10.01) { errors.push("Sampling interval is about " + step.toFixed(1) + " min; need 1-minute data (5- and 10-minute are accepted with reduced accuracy)."); return res; }
    if (step > 1.01) warnings.push("Sampling interval is " + step.toFixed(0) + " minutes, not 1. Each reading is held for the interval; heat edges, energy and holding-power estimates are less accurate than with 1-minute data.");
    const t0 = Math.round(pts[0].t), len = Math.round(pts[pts.length - 1].t) - t0 + Math.max(1, Math.round(step));
    const p = new Float64Array(len), seenM = new Uint8Array(len); let max = 0;
    pts.forEach((pt, i) => { const m = Math.round(pt.t) - t0, nx = i + 1 < pts.length ? Math.round(pts[i + 1].t) - t0 : m + Math.round(step), hold = Math.max(1, Math.min(nx - m, Math.round(step)));
      for (let k = 0; k < hold && m + k < len; k++) { p[m + k] = pt.kw; seenM[m + k] = 1; } if (pt.kw > max) max = pt.kw;
      if (i + 1 < pts.length && nx - m - hold > 0.5) res.gaps.push({ at: Math.round(pt.t) + hold, minutes: nx - m - hold }); });
    let missing = 0; for (let i = 0; i < len; i++) if (!seenM[i]) missing++;
    const clk = m => { m = ((Math.round(m) % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"); };
    if (missing) warnings.push(missing + " minute(s) have no reading, in " + res.gaps.length + " gap(s) (first at " + clk(res.gaps[0].at) + "); they are treated as 0 kW.");
    // (4) physical sanity checks: warnings only
    const bad = { sum: [], kva: [], pf: [], pfm: [] };
    pts.forEach(pt => { const r = pt.r, tol = x => Math.max(0.01 * Math.abs(x), 0.01);
      if (isFinite(r.tot) && isFinite(r.sum) && r.ph.length >= 2 && Math.abs(r.tot - r.sum) > tol(Math.max(Math.abs(r.tot), Math.abs(r.sum)))) bad.sum.push(pt);
      if (isFinite(r.kva) && isFinite(r.kw) && r.kva < r.kw - tol(r.kw)) bad.kva.push(pt);
      if (isFinite(r.pf) && (r.pf < 0 || r.pf > 1)) bad.pf.push(pt);
      else if (isFinite(r.pf) && isFinite(r.kva) && r.kva > 0 && isFinite(r.kw) && Math.abs(r.pf - r.kw / r.kva) > 0.02) bad.pfm.push(pt); });
    const first = a => " (first at " + (a[0].iso ? new Date(a[0].t * 60000).toISOString().slice(0, 16).replace("T", " ") : clk(a[0].t)) + ")";
    if (bad.sum.length) warnings.push("Total kW differs from the sum of the per-phase kW by more than 1% in " + bad.sum.length + " row(s)" + first(bad.sum) + ". Check which column is the total.");
    if (bad.kva.length) warnings.push("kVA is below kW in " + bad.kva.length + " row(s)" + first(bad.kva) + ", which is physically impossible. Check the columns or units.");
    if (bad.pf.length) warnings.push("Power factor is outside 0 to 1 in " + bad.pf.length + " row(s)" + first(bad.pf) + ". (A percentage, or a signed value?)");
    if (bad.pfm.length) warnings.push("Power factor differs from kW/kVA by more than 0.02 in " + bad.pfm.length + " row(s)" + first(bad.pfm) + ".");
    if (opts.nameplate && max > 1.5 * opts.nameplate) warnings.push("Peak " + max.toFixed(0) + " kW is above 1.5x the furnace nameplate; check units (kW, not W). Values are not clipped.");
    if (anyDated) { const now = opts.now ? new Date(opts.now) : new Date(), nowMin = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes()) / 60000;
      const fut = pts.filter(pt => pt.iso && pt.t > nowMin + 1); if (fut.length) warnings.push("Timestamps are in the future: check the instrument clock (" + fut.length + " row(s), latest " + new Date(fut[fut.length - 1].t * 60000).toISOString().slice(0, 16).replace("T", " ") + ")."); }
    res.p = p; res.t0 = ((t0 % 1440) + 1440) % 1440; res.n = pts.length; res.missing = missing; res.max = max; return res;
  }
  const defaultMeltThreshold = nameplateKw => (nameplateKw < 1000 ? 100 : 200);
  // Describe detectClean output: absolute minutes (t0 = clock of sample 0), melt window, melt kWh, holding kW.
  function describeDetected(p, det, meltThr, t0) {
    return det.map(([s, e, kwh], k) => {
      let f = -1, l = -1; for (let i = s; i < e; i++) if (p[i] > meltThr) { if (f < 0) f = i; l = i; }
      let meltKwh = 0; if (f >= 0) for (let i = f; i <= l; i++) meltKwh += p[i]; meltKwh /= 60.0;
      const hp = f >= 0 && e - (l + 1) >= 5 ? Array.prototype.slice.call(p, l + 1, e) : [];
      return { idx: k, s, e, start: t0 + s, end: t0 + e, kwhDet: kwh, meltKwh, holdKw: hp.length ? median(hp) : null };
    });
  }
  // Greedy by time: each detected heat takes the log row with the largest time overlap; each log row used once.
  function matchLog(desc, logRows, dayOffset) {
    const off = (dayOffset || 0) * 1440, used = new Set();
    return desc.map(d => { let best = -1, bo = 0;
      logRows.forEach((r, i) => { if (used.has(i)) return; const ov = Math.min(d.end, r.tap + off) - Math.max(d.start, r.start + off); if (ov > bo) { bo = ov; best = i; } });
      if (best >= 0) used.add(best); return best; });
  }
  function seriesReceipts(p, heats, ef) { // heats: [{id,start,end,s,e,tonnes}] -> {chain, rows}
    const hs = heats.map(h => ({ id: h.id, start: h.start, end: h.end, tonnes: h.tonnes, kw: Array.from(p.slice(h.s, h.e), v => +v.toFixed(1)) }));
    const chain = buildChain(hs); let prev = ZERO;
    const rows = hs.map((h, n) => { const r = receiptFromReadings(h, prev, { ef }, null); prev = chain[n].hash; return Object.assign({ id: h.id, start: h.start, end: h.end, tonnes: h.tonnes }, r); });
    return { chain, rows };
  }
  function compareLog(rows, logRows, matchIdx) { // meter kWh vs log kWh per heat
    const pairs = []; rows.forEach((r, i) => { const j = matchIdx[i]; if (j == null || j < 0) return; const L = logRows[j];
      pairs.push({ id: r.id, meter: r.kwh, log: L.kwh, pct: 100 * (r.kwh - L.kwh) / L.kwh }); });
    return { pairs, mad: pairs.length ? pairs.reduce((a, x) => a + Math.abs(x.pct), 0) / pairs.length : NaN };
  }

  // ---- printable pilot report (self-contained HTML string: inline CSS, no external requests) ----
  function reportHtml(d) {
    const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const f0 = x => Math.round(x), f1 = x => Number(x).toFixed(1), clock = m => { m = Math.round(m); return String(Math.floor(m / 60) % 24).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0") + (m >= 1440 ? " +" + Math.floor(m / 1440) + "d" : ""); };
    const S = d.stats, ef = d.ef, tile = (v, l) => '<div class="t"><b>' + v + "</b><span>" + l + "</span></div>";
    let h = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>HeatLedger pilot report ' + esc(d.date) + "</title><style>" +
      "@page{size:A4;margin:14mm}*{box-sizing:border-box}body{font:11pt/1.4 system-ui,Segoe UI,Roboto,Arial,sans-serif;color:#111;background:#fff;margin:0;padding:18px;max-width:190mm}" +
      "h1{font-size:20pt;margin:0 0 2px}h2{font-size:13pt;margin:16px 0 6px;border-bottom:1px solid #999;padding-bottom:2px}.m{color:#444;font-size:10pt}" +
      ".g{display:flex;flex-wrap:wrap;gap:8px}.t{border:1px solid #999;border-radius:6px;padding:6px 10px;min-width:42mm}.t b{display:block;font-size:14pt}.t span{font-size:9pt;color:#444}" +
      "table{width:100%;border-collapse:collapse;font-size:8.5pt}th,td{border-bottom:1px solid #bbb;padding:3px 4px;text-align:right}th:first-child,td:first-child{text-align:left}th{background:#eee}" +
      ".h{font-family:ui-monospace,Consolas,monospace;font-size:8pt;word-break:break-all}.box{border:1.5px solid #333;border-radius:6px;padding:8px 12px;margin-top:14px;break-inside:avoid}" +
      ".w{border:1px solid #a60;background:#fff4e5;padding:4px 8px;margin:6px 0;font-size:10pt}tr{break-inside:avoid}.bar{margin-bottom:12px}button{font:inherit;padding:8px 16px;margin-right:8px;cursor:pointer}" +
      "@media print{.noprint{display:none}body{padding:0;max-width:none}}</style></head><body>" +
      '<div class="bar noprint"><button onclick="window.print()">Print / Save as PDF</button><button onclick="window.close()">Close</button> <span class="m">Generated in your browser; nothing was uploaded.</span></div>' +
      "<h1>HeatLedger pilot report</h1><div class=m>Date: " + esc(d.date) + "</div>" +
      '<div class="m"><b>Data source:</b> ' + esc(d.source) + "</div>" +
      "<h2>Summary</h2><div class=g>" + tile(S.all.n, "heats") + tile(S.all.tonnes.toFixed(2) + " t", "metal") + tile(f0(S.all.kwh) + " kWh", "energy") +
      tile(f0(S.all.kwh_t) + " kWh/t", "weighted average (range " + f0(S.min) + "–" + f0(S.max) + ")") + tile(f0(S.all.kwh_t * ef) + " kgCO₂e/t", "at " + esc(ef) + " tCO₂/MWh") + "</div>" +
      '<div class="m" style="margin-top:6px">Emission factor: ' + esc(ef) + " tCO₂/MWh. Source: " + esc(d.efSource) + ". Energy is as recorded in the data source; no meter was audited.</div>" +
      "<h2>Per-heat receipts</h2><table><tr><th>Heat</th>" + (d.hasGrade ? "<th>Grade</th>" : "") + "<th>Window</th><th>t</th><th>kWh</th><th>kWh/t</th><th>kgCO₂e/t</th>" + (d.hasRemarks ? "<th>Remarks</th>" : "") + "<th>Hash (first 12)</th></tr>" +
      d.rows.map(r => "<tr><td>" + esc(r.heat) + "</td>" + (d.hasGrade ? "<td>" + esc(r.grade) + "</td>" : "") + "<td>" + clock(r.start) + "–" + clock(r.tap) + "</td><td>" + r.tonnes.toFixed(3) + "</td><td>" + f0(r.kwh) + "</td><td>" + f0(r.perT) + "</td><td>" + f0(r.perT * ef) + "</td>" +
        (d.hasRemarks ? "<td>" + esc(r.remarks) + (r.flagged ? " ⚑" : "") + "</td>" : "") + '<td class="h">' + esc(r.hash) + "</td></tr>").join("") + "</table>";
    if (S.flagged.n) h += '<h2>Flagged heats (remarks contain "hold" or "long") — observational</h2><div class=g>' + tile(S.flagged.n + " heats", "flagged") + tile(f0(S.flagged.kwh_t) + " kWh/t", "flagged average") +
      (S.rest.n ? tile(f0(S.rest.kwh_t) + " kWh/t", "other " + S.rest.n + " heats") + tile((S.diff >= 0 ? "+" : "") + f0(S.diff) + " kWh/t", "flagged minus rest") : "") +
      '</div><div class="m">Observational only: groups of heats compared as they happened, not a controlled test. Flagged heats may differ in grade, size or start-up condition.</div>';
    if (d.calibration) { const c = d.calibration, fin = v => v != null && isFinite(v);
      h += "<h2>Calibration from the meter series</h2>" + (c.n < 20 ? '<div class="w">Only ' + c.n + " heat(s) used; 20 or more are needed for reliable estimates.</div>" : "") + "<div class=g>" +
        tile(fin(c.hold_kw_est) ? f1(c.hold_kw_est) + " kW" : "n/a", "estimated holding power (" + c.nHold + " heats with a hold phase)") + tile(fin(c.fixed_est) ? f1(c.fixed_est) + " kWh" : "n/a", "fixed energy per heat") +
        tile(fin(c.kwh_per_t_melt_est) ? f1(c.kwh_per_t_melt_est) + " kWh/t" : "n/a", "melt energy") + tile(c.n, "heats used") + "</div>" +
        '<div class="m">Series: ' + esc(d.seriesInfo || "") + "</div>"; }
    if (d.comparison) { const C = d.comparison;
      h += "<h2>Meter series vs heat log (kWh per heat)</h2><div class=g>" + tile(C.pairs.length, "heats compared") + tile(C.mad.toFixed(1) + "%", "mean absolute difference") + "</div><table><tr><th>Heat</th><th>Meter kWh</th><th>Log kWh</th><th>Difference</th></tr>" +
        C.pairs.map(p => "<tr><td>" + esc(p.id) + "</td><td>" + f1(p.meter) + "</td><td>" + f1(p.log) + "</td><td>" + (p.pct >= 0 ? "+" : "") + p.pct.toFixed(1) + "%</td></tr>").join("") + "</table>"; }
    h += "<h2>Anchor</h2><div class=m>Head hash of the receipt chain built from the heat log (post this outside the plant to fix the record in time):</div><div class=h>" + esc(d.anchor) + "</div>";
    if (d.seriesAnchor) h += '<div class="m" style="margin-top:6px">Head hash of the meter-series receipt chain:</div><div class="h">' + esc(d.seriesAnchor) + "</div>";
    h += '<div class="box"><b>Limits</b><ul style="margin:4px 0 0 18px;padding:0"><li>Hashes from a heat log prove the log was not changed afterwards; they do not prove the figures were correct.</li>' +
      "<li>Sample size: " + S.all.n + " heat(s)" + (S.all.n < 20 ? " (small; averages and comparisons are noisy)" : "") + ". Flagged-heat comparisons are observational.</li>" +
      "<li>Energy figures are as supplied (" + esc(d.source) + "); the emission factor is a grid average, not a plant-specific measurement.</li>" +
      "<li>Planner and break-even results elsewhere in HeatLedger Studio come from a synthetic model with assumed parameters and are not part of this report.</li></ul></div></body></html>";
    return h;
  }

  return { BASE, pyround, pyFloat, multMinute, avgm, meltMin, makeRng, makeDay, baselinePlan, planDP, evaluate, study, summarize,
    powerSeries, detectClean, matchHeats, calibrate, sha256, buildChain, verifyChain, rechainFrom, payload, receiptFromReadings, parseClock, parseCsv, ZERO,
    exportChain, parseChainJson, verifyChainDetail, splitCsvLine, readCsv, detectDelimiter, headerKey, autoMap, parseHeatLog, logStats, parseTimestamp, parseSeries, seriesCols, defaultMeltThreshold,
    describeDetected, matchLog, seriesReceipts, compareLog, median, reportHtml };
});
