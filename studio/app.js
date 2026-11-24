(function () {
  "use strict"; const E = window.HeatLedgerEngine, $ = id => document.getElementById(id), BASE = E.BASE;
  const clock = m => { m = Math.round(m); return String(Math.floor(m / 60) % 24).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"); };
  const f1 = x => x.toFixed(1), tile = (v, l) => '<div class="tile"><b>' + v + "</b><span>" + l + "</span></div>";
  // tabs
  document.querySelectorAll("#tabs button").forEach(b => b.onclick = () => {
    document.querySelectorAll("#tabs button").forEach(x => x.classList.toggle("on", x === b));
    document.querySelectorAll("main section").forEach(s => s.classList.toggle("on", s.id === b.dataset.t)); });

  // ---------- Tab 1 ----------
  const H01 = { readings: [498.7,709.5,965.6,1134.3,1405.1,1752.3,1773.6,1903.7,1777.9,1993.3,1808.3,1861.7,2034.3,2002.1,1979.6,1869.2,1935.6,1943.9,2037.8,2040.2,1861.1,1780.5,1923.1,101.3,98.0], start: 480, end: 505, tonnes: 1.16 };
  const cum = [0]; H01.readings.forEach(v => cum.push(cum[cum.length - 1] + v / 60));
  function drawLive(t) {
    const c = $("live"), x = c.getContext("2d"), W = c.width, H = c.height, rd = H01.readings, N = rd.length, mx = Math.max.apply(null, rd) * 1.1;
    x.clearRect(0, 0, W, H); x.fillStyle = "#14211c"; x.fillRect(0, 0, W, H);
    const px0 = 50, py0 = 20, pw = W - 80, ph = H - 80, X = m => px0 + pw * m / N, Y = v => py0 + ph - ph * v / mx;
    x.strokeStyle = "#2f443a"; x.lineWidth = 2; x.beginPath(); x.moveTo(px0, py0 + ph); x.lineTo(px0 + pw, py0 + ph); x.stroke();
    x.strokeStyle = "#a9b8b0"; x.setLineDash([5, 4]); x.beginPath(); x.moveTo(X(N), py0); x.lineTo(X(N), py0 + ph); x.stroke(); x.setLineDash([]);
    x.fillStyle = "#a9b8b0"; x.font = "14px sans-serif"; x.fillText("08:00", px0, py0 + ph + 20); x.fillText("pour due 08:25", X(N) - 110, py0 + 14); x.fillText("kW", 8, py0 + 12);
    const i = Math.min(Math.floor(t), N - 1), f = t >= N ? 1 : t - i, pw_ = rd[i] * (1 - f) + rd[Math.min(i + 1, N - 1)] * f;
    x.strokeStyle = "#f08a4b"; x.lineWidth = 4; x.beginPath(); for (let k = 0; k <= i; k++) { k ? x.lineTo(X(k), Y(rd[k])) : x.moveTo(X(k), Y(rd[k])); } x.lineTo(X(Math.min(t, N)), Y(pw_)); x.stroke();
    x.fillStyle = "#f08a4b"; x.beginPath(); x.arc(X(Math.min(t, N)), Y(pw_), 6, 0, 7); x.fill();
    const e = t >= N ? cum[N] : cum[i] + rd[i] / 60 * f; x.fillStyle = "#5fd3a6"; x.font = "bold 18px monospace";
    x.fillText(f1(e) + " kWh so far" + (t >= N ? " · " + f1(cum[N] / H01.tonnes) + " kWh/t" : ""), px0, H - 14);
  }
  let raf; function replay() { cancelAnimationFrame(raf); const t0 = performance.now(); (function s(now) { const t = Math.min((now - t0) / 11000 * H01.readings.length, H01.readings.length); drawLive(t); if (t < H01.readings.length) raf = requestAnimationFrame(s); })(t0); }
  $("replay").onclick = replay; drawLive(H01.readings.length);
  const h01 = { id: "H01", start: H01.start, end: H01.end, tonnes: H01.tonnes, kw: H01.readings };
  const r01 = E.receiptFromReadings(h01, E.ZERO, BASE, 3937 * 1.16);
  $("h01").innerHTML = '<table><tr><td>Tonnes</td><td>1.16</td></tr><tr><td>Energy kWh</td><td>' + r01.kwh + '</td></tr><tr><td>kWh/t</td><td>' + r01.kwh_per_t + '</td></tr><tr><td>kgCO₂e/t (0.710)</td><td>' + r01.kgco2e_per_t + '</td></tr><tr><td>Hash</td><td class="hash">' + r01.hash + "</td></tr></table>";

  let chain = null, anchor = null, meta = null;
  function genDay() {
    const cfg = BASE, rng = E.makeRng(+$("seed1").value || 1), { q, d, noise } = E.makeDay(rng);
    const ev = E.evaluate(E.planDP(q, d, cfg), q, d, noise, cfg), series = E.powerSeries(ev.recs, cfg, rng);
    const det = E.detectClean(series, cfg.hold_kw), m = E.matchHeats(ev.recs, det), heats = [], rows = [];
    m.pairs.sort((a, b) => a[1][0] - b[1][0]).forEach(([rec, [s, e]], n) => heats.push({ id: "H" + String(n + 1).padStart(2, "0"), start: s, end: e, tonnes: +rec.tonnes.toFixed(2), kw: Array.from(series.slice(s, e), v => +v.toFixed(1)), cost: rec.cost, truth: rec.kwh }));
    chain = E.buildChain(heats); anchor = chain[chain.length - 1].hash; meta = heats;
    let prev = E.ZERO;
    heats.forEach((h, n) => { const r = E.receiptFromReadings(h, prev, cfg, h.cost); prev = chain[n].hash; const err = 100 * Math.abs(r.kwh - h.truth) / h.truth;
      rows.push("<tr><td>" + h.id + "</td><td>" + clock(h.start) + "–" + clock(h.end) + "</td><td>" + h.tonnes + "</td><td>" + r.kwh + "</td><td>" + r.kwh_per_t + "</td><td>₹" + r.rs_per_t + "</td><td>" + r.kgco2e_per_t + "</td><td>" + f1(err) + "%</td><td class=hash>" + r.hash + "</td></tr>"); });
    $("rec").innerHTML = "<table><tr><th>Heat</th><th>Window</th><th>t</th><th>kWh</th><th>kWh/t</th><th>₹/t</th><th>kgCO₂e/t</th><th>vs truth</th><th>Hash</th></tr>" + rows.join("") + "</table>";
    $("anchorLine").innerHTML = "Detected " + heats.length + " of " + ev.recs.length + " simulated heats. Anchor (head hash, posted externally): <span class=hash>" + anchor.slice(0, 16) + "…</span>"; $("tOut").textContent = "";
  }
  const edit = d => { d.kw = d.kw.map(x => Math.round(x * 0.9 * 10) / 10); };
  function tamper(kind) { if (!chain || chain.length < 3) return; let t;
    if (kind === "edit") { t = chain.slice(); const d = JSON.parse(t[2].payload); edit(d); t[2] = { payload: JSON.stringify(d), hash: t[2].hash }; }
    else t = E.rechainFrom(chain, 2, edit);
    const internal = kind === "edit" ? null : E.verifyChain(t, t[t.length - 1].hash), v = E.verifyChain(t, anchor);
    $("tOut").innerHTML = (internal ? "Internal consistency check: <b class=ok>" + internal + "</b> (every hash recomputed)<br>" : "") + "Check against anchor: <b class=" + (v === "OK" ? "ok" : "bad") + ">" + v + "</b>"; }
  $("gen").onclick = genDay; $("tEdit").onclick = () => tamper("edit"); $("tRe").onclick = () => tamper("re"); $("tReset").onclick = () => { $("tOut").innerHTML = "Honest chain: <b class=ok>" + (chain ? E.verifyChain(chain, anchor) : "generate a day first") + "</b>"; };
  genDay();

  // ---------- Tab 2 ----------
  const lpVal = () => Math.round(Math.pow(10, Math.log10(5) + (+$("lp").value / 100) * (Math.log10(500) - Math.log10(5))));
  const cfg2 = () => Object.assign({}, BASE, { late_pen: lpVal(), hold_kw: +$("hk").value, fixed: +$("fx").value });
  function gantt(o) {
    const W = 1000, Hh = 190, X = h => 60 + (W - 80) * h / 24; let s = '<svg viewBox="0 0 ' + W + " " + Hh + '" font-family="sans-serif" font-size="13">';
    for (let h = 0; h < 24; h++) { const m = E.multMinute(h * 60); if (m !== 1) s += '<rect x="' + X(h) + '" y="10" width="' + (X(1) - X(0)) + '" height="130" fill="' + (m < 1 ? "#2f5a48" : "#6b4a2c") + '" opacity=".45"/>'; }
    [["Planned", "p", 25], ["Operator habit", "b", 85]].forEach(([lab, k, y]) => { s += '<text x="4" y="' + (y + 22) + '" fill="#a9b8b0">' + lab + "</text>";
      o[k].recs.forEach(r => { s += '<rect x="' + X(r.start / 60) + '" y="' + y + '" width="' + Math.max(1, X(r.ready / 60) - X(r.start / 60)) + '" height="34" fill="' + (k === "p" ? "#5fd3a6" : "#9a9a9a") + '"/>';
        if (r.last_due > r.ready) s += '<rect x="' + X(r.ready / 60) + '" y="' + y + '" width="' + (X(r.last_due / 60) - X(r.ready / 60)) + '" height="34" fill="#f08a4b"/>'; }); });
    o.d.forEach(t => s += '<line x1="' + X(t / 60) + '" x2="' + X(t / 60) + '" y1="10" y2="140" stroke="#f1efe8" stroke-dasharray="3 3" opacity=".7"/>');
    for (let h = 0; h <= 24; h += 3) s += '<text x="' + (X(h) - 8) + '" y="160" fill="#a9b8b0">' + String(h).padStart(2, "0") + ":00</text>";
    return s + '<text x="60" y="182" fill="#a9b8b0">solid = melting · orange = holding · dotted = pour due · green band = night rebate · brown = evening peak</text></svg>'; }
  function runDay() { const cfg = cfg2(), rng = E.makeRng(+$("seed2").value || 1), { q, d, noise } = E.makeDay(rng), brng = E.makeRng(7);
    const b = E.evaluate(E.baselinePlan(q, d, brng, cfg), q, d, noise, cfg), p = E.evaluate(E.planDP(q, d, cfg), q, d, noise, cfg), t = q.reduce((a, c) => a + c, 0);
    $("lpv").textContent = lpVal(); $("hkv").textContent = cfg.hold_kw; $("fxv").textContent = cfg.fixed; $("gantt").innerHTML = gantt({ b, p, d });
    $("dayTiles").innerHTML = tile(f1(b.kwh / t) + " → " + f1(p.kwh / t), "kWh/t, habit → planned") + tile(f1(b.hold_h) + " → " + f1(p.hold_h) + " h", "holding hours") + tile(Math.round(b.late) + " → " + Math.round(p.late) + " min", "late pouring (total)") + tile("₹" + Math.round(b.cost / t) + " → ₹" + Math.round(p.cost / t), "energy cost per tonne"); }
  ["seed2", "lp", "hk", "fx"].forEach(i => $(i).oninput = runDay); runDay();
  $("runStudy").onclick = () => { const b = $("runStudy"); b.disabled = true; $("studyNote").textContent = "running…"; setTimeout(() => { const t0 = performance.now(), c = cfg2(), s = E.summarize(E.study(90, 1, c), c);
    $("studyTiles").innerHTML = tile(f1(s.save_kwh_t) + " kWh/t", "saved (" + f1(s.save_pct) + "%)") + tile(f1(s.b.hold_h_day) + " → " + f1(s.p.hold_h_day) + " h/day", "holding") + tile(f1(s.b.late_min_day) + " → " + f1(s.p.late_min_day) + " min/day", "late pouring") + tile("₹" + f1(s.save_rs_t) + "/t", "energy cost saved");
    $("studyNote").textContent = s.days + " working days · this browser's random generator, so figures differ slightly from the Python reference (15.0 ± 0.6 kWh/t over 7 seeds). " + Math.round(performance.now() - t0) + " ms."; b.disabled = false; }, 30); };

  // ---------- Tab 3 ----------
  function grade(v) { return v > 10 ? "#1f7a5a" : v > 5 ? "#2f5a48" : v > 0 ? "#4a5a3a" : "#7a3a30"; }
  $("runGrid").onclick = () => { $("gridNote").textContent = "running 12 studies…"; setTimeout(() => { const F = [0, 30, 60, 90], Hk = [50, 100, 150]; let h = '<div style="display:grid;grid-template-columns:110px repeat(3,1fr);gap:6px"><div></div>' + Hk.map(x => '<div class="mut" style="text-align:center">hold ' + x + " kW</div>").join("");
    F.forEach(f => { h += '<div class="mut" style="align-self:center">fixed ' + f + " kWh</div>"; Hk.forEach(k => { const c = Object.assign({}, BASE, { fixed: f, hold_kw: k }), v = E.summarize(E.study(45, 1, c), c).save_kwh_t; h += '<div class="cell" style="background:' + grade(v) + '">' + f1(v) + "</div>"; }); }); $("grid").innerHTML = h + "</div>"; $("gridNote").textContent = "kWh/t saved. Red = negative."; }, 30); };
  $("chk").onclick = () => { const c = Object.assign({}, BASE, { hold_kw: +$("ch").value, fixed: +$("cf").value }), s = E.summarize(E.study(45, 1, c), c).save_kwh_t;
    $("chkOut").innerHTML = s > 3 ? "Predicted saving <b class=ok>" + f1(s) + " kWh/t</b>: scheduling pays in this model. Planner mode." : s > 0 ? "Predicted saving <b>" + f1(s) + " kWh/t</b>: marginal. Start with receipts, decide after calibration." : "Predicted saving <b class=bad>" + f1(s) + " kWh/t</b>: scheduling does not pay here. Use receipt-only mode."; };
  $("assump").innerHTML = [["Capacity", "3.0 t"], ["Melt energy", "506 kWh/t"], ["Fixed per heat", "60 kWh (assumption)"], ["Holding power", "100 kW (assumption)"], ["Melt power", "1,500 kW"], ["Tariff", "₹7/kWh; night ×0.90 (22–06); peak ×1.20 (18–22), illustrative"], ["Shiftable window", "240 min"], ["Late penalty", "₹500/min"], ["Emission factor", "0.710 tCO₂/MWh (CEA FY2024-25 v21, provisional)"]].map(r => "<tr><td>" + r[0] + "</td><td>" + r[1] + "</td></tr>").join("");

  // ---------- Tab 4 ----------
  const SAMPLE = "heat,start,tap,tonnes,kwh,hold_min\n1,06:00,07:35,1.10,640,12\n2,08:00,09:30,1.25,722,5\n3,10:10,11:55,1.05,640,25\n4,12:20,13:50,1.20,690,8\n5,14:15,16:00,1.15,684,22\n6,16:30,18:05,1.30,742,6\n7,19:00,20:30,1.18,690,10";
  let lastRows = [];
  function calc() { const rows = E.parseCsv($("csv").value), ef = +$("ef").value, tar = +$("tar").value; const good = []; let bad = 0, prev = E.ZERO; lastRows = [];
    rows.forEach((r, n) => { const s = E.parseClock(r.start), t = E.parseClock(r.tap), tn = +r.tonnes, kwh = +r.kwh; if (!(tn > 0) || !(kwh > 0) || isNaN(s) || isNaN(t)) { bad++; return; }
      const e = t < s ? t + 1440 : t, perT = kwh / tn, cost = tar * kwh * E.avgm(s, e), hold = r.hold_min ? +r.hold_min : null;
      const pl = E.payload({ id: r.heat ? "H" + String(r.heat).padStart(2, "0") : "H" + (n + 1), start: s, end: e, tonnes: tn, kw: [kwh] }, prev), hash = E.sha256(pl);
      good.push({ heat: r.heat || n + 1, window: clock(s) + "–" + clock(e), tonnes: tn, kwh, perT, rsT: cost / tn, kg: perT * ef / 1000 * 1000, hold, hash: hash.slice(0, 12), prev: prev.slice(0, 12) }); prev = hash; });
    if (!good.length) { $("outCard").style.display = "block"; $("sumTiles").innerHTML = ""; $("tbl").innerHTML = "<p class=bad>No valid rows. Check the column names and HH:MM times.</p>"; return; }
    lastRows = good; const T = good.reduce((a, g) => a + g.tonnes, 0), K = good.reduce((a, g) => a + g.kwh, 0), v = good.map(g => g.perT), mn = Math.min.apply(null, v), mxv = Math.max.apply(null, v);
    $("sumTiles").innerHTML = tile(good.length, "heats read" + (bad ? " (" + bad + " rows skipped)" : "")) + tile(T.toFixed(2) + " t", "total metal") + tile(Math.round(K / T) + " kWh/t", "weighted average (range " + Math.round(mn) + "–" + Math.round(mxv) + ")") + tile(Math.round(K / T * ef) + " kgCO₂e/t", "at " + ef + " tCO₂/MWh");
    $("tbl").innerHTML = "<table><tr><th>Heat</th><th>Window</th><th>t</th><th>kWh</th><th>kWh/t</th><th>₹/t</th><th>kgCO₂e/t</th><th>Hold min</th><th>Hash</th></tr>" + good.map(g => "<tr><td>" + g.heat + "</td><td>" + g.window + "</td><td>" + g.tonnes + "</td><td>" + g.kwh + "</td><td>" + Math.round(g.perT) + "</td><td>₹" + Math.round(g.rsT) + "</td><td>" + Math.round(g.perT * ef) + "</td><td>" + (g.hold == null ? "–" : g.hold) + "</td><td class=hash>" + g.hash + "</td></tr>").join("") + "</table>";
    $("yNote").textContent = "Receipts from a heat log hash the totals you entered, not a 1-minute meter series, so they prove the log was not changed afterwards, not that it was right. Meter-grade receipts need the CT meter."; $("outCard").style.display = "block"; }
  $("calc").onclick = calc; $("sample").onclick = () => { $("csv").value = SAMPLE; calc(); };
  $("file").onchange = ev => { const f = ev.target.files[0]; if (f) f.text().then(t => { $("csv").value = t; calc(); }); };
  $("dl").onclick = () => { const csv = "heat,window,tonnes,kwh,kwh_per_t,rs_per_t,kgco2e_per_t,hold_min,prev_hash,hash\n" + lastRows.map(g => [g.heat, g.window, g.tonnes, g.kwh, g.perT.toFixed(1), Math.round(g.rsT), (g.perT * (+$("ef").value)).toFixed(1), g.hold == null ? "" : g.hold, g.prev, g.hash].join(",")).join("\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = "heatledger_receipts.csv"; a.click(); };
})();
