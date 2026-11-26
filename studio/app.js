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
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const abs = m => clock(m) + (m >= 1440 ? " +" + Math.floor(m / 1440) + "d" : "");
  const hid = n => "H" + String(n).padStart(2, "0");
  document.querySelectorAll("#modes button").forEach(b => b.onclick = () => {
    document.querySelectorAll("#modes button").forEach(x => x.classList.toggle("on", x === b));
    ["mLog", "mSer"].forEach(id => $(id).style.display = id === b.dataset.m ? "block" : "none"); });

  // --- mode 1: heat log ---
  const SAMPLE = "heat,grade,weight_kg,start,tap,kwh,remarks\n1,SYN-A,1100,18:10,19:50,640,\n2,SYN-A,1250,20:20,21:55,722,\n3,SYN-B,1050,22:30,00:15,690,long wait for pour\n4,SYN-A,1200,00:40,02:10,690,\n5,SYN-B,1150,02:45,04:30,684,hold for ladle\n6,SYN-A,1300,05:10,06:40,742,\n7,SYN-A,1180,07:20,08:50,690,";
  let lastRows = [];
  let userMap = null, lastStats = null, lastCmp = null;
  const FIELDS = [["weight", "Weight", 1], ["start", "Start time", 1], ["tap", "Tap time", 1], ["kwh", "kWh", 1], ["heat", "Heat no.", 0], ["grade", "Grade", 0], ["remarks", "Remarks", 0]];
  function parseLog() { const text = $("csv").value; let P = E.parseHeatLog(text);
    if (userMap && P.headers.join("") === userMap.sig) P = E.parseHeatLog(text, { map: userMap.map, weightUnit: userMap.weightUnit }); return P; }
  function mapUi(P) {
    const opt = (f) => '<option value="">— none —</option>' + P.headers.map(h => '<option' + (P.mapping[f] === h ? " selected" : "") + ' value="' + esc(h) + '">' + esc(h) + "</option>").join("");
    return '<div class="card" style="margin-top:12px"><h3>Map your columns</h3><p class="mut">Some required columns were not recognised' + (P.unmapped.length ? " (" + P.unmapped.join(", ") + ")" : "") + ". Pick which column of your file holds each field.</p><div class=\"row\">" +
      FIELDS.map(([f, l, req]) => "<div><label>" + l + (req ? " *" : " (optional)") + '</label><select data-f="' + f + '">' + opt(f) + "</select></div>").join("") +
      '<div><label>Weight unit</label><select id="mapUnit"><option value="kg"' + (P.weightUnit === "kg" ? " selected" : "") + '>kilograms</option><option value="t"' + (P.weightUnit === "t" ? " selected" : "") + ">tonnes</option></select></div></div>" +
      '<p><button class="act" id="mapApply">Apply mapping</button> <span class="mut">Detected delimiter: ' + (P.delimiter === "	" ? "tab" : P.delimiter === ";" ? "semicolon" : "comma") + "</span></p></div>"; }
  $("mapBox").onclick = ev => { if (ev.target.id !== "mapApply") return; const map = {}; $("mapBox").querySelectorAll("select[data-f]").forEach(sel => map[sel.dataset.f] = sel.value);
    const P0 = E.parseHeatLog($("csv").value); userMap = { sig: P0.headers.join(""), map, weightUnit: $("mapUnit").value }; calc(); };
  $("csv").addEventListener("input", () => { userMap = null; });
  function calc() {
    const P = parseLog(), ef = +$("ef").value, tar = +$("tar").value; lastRows = []; $("outCard").style.display = "block"; $("flagBox").innerHTML = "";
    $("mapBox").innerHTML = ""; lastStats = null;
    if (P.needsMapping) { $("lWarn").innerHTML = ""; $("sumTiles").innerHTML = ""; $("tbl").innerHTML = ""; $("mapBox").innerHTML = mapUi(P); return; }
    $("lWarn").innerHTML = P.errors.concat(P.warnings).map(w => '<div class="warn">' + esc(w) + "</div>").join("");
    if (!P.rows.length) { $("sumTiles").innerHTML = ""; $("tbl").innerHTML = "<p class=bad>" + (P.errors.length ? "Fix the header and try again." : "No valid rows. Check HH:MM times, weights and kWh.") + "</p>" +
      P.skipped.map(s => "<div class=mut>line " + s.line + ": " + s.reason + "</div>").join(""); return; }
    let prev = E.ZERO; const hasGrade = P.rows.some(r => r.grade), hasRem = P.rows.some(r => r.remarks), hasHold = P.rows.some(r => r.hold != null);
    const good = P.rows.map((r, n) => { const dur = r.tap - r.start, cost = tar * r.kwh * E.avgm(r.start % 1440, r.start % 1440 + Math.min(dur, 2880));
      const pl = E.payload({ id: hid(n + 1), start: r.start, end: r.tap, tonnes: r.tonnes, kw: [r.kwh] }, prev), hash = E.sha256(pl);
      const g = Object.assign({}, r, { rsT: cost / r.tonnes, hash: hash.slice(0, 12), full: hash, prev: prev.slice(0, 12) }); prev = hash; return g; });
    lastRows = good; const S = E.logStats(good, ef); lastStats = S;
    const sk = P.skipped.length ? " (" + P.skipped.length + " rows skipped)" : "";
    $("sumTiles").innerHTML = tile(good.length, "heats read" + sk) + tile(S.all.tonnes.toFixed(2) + " t", "total metal") + tile(Math.round(S.all.kwh_t) + " kWh/t", "weighted average (range " + Math.round(S.min) + "–" + Math.round(S.max) + ")") + tile(Math.round(S.all.kg_t) + " kgCO₂e/t", "at " + ef + " tCO₂/MWh");
    $("tbl").innerHTML = "<table><tr><th>Heat</th>" + (hasGrade ? "<th>Grade</th>" : "") + "<th>Window</th><th>t</th><th>kWh</th><th>kWh/t</th><th>₹/t</th><th>kgCO₂e/t</th>" + (hasHold ? "<th>Hold min</th>" : "") + (hasRem ? "<th>Remarks</th>" : "") + "<th>Hash</th></tr>" +
      good.map(g => "<tr" + (g.flagged ? ' class="flag"' : "") + "><td>" + esc(g.heat) + "</td>" + (hasGrade ? "<td>" + esc(g.grade) + "</td>" : "") + "<td>" + abs(g.start) + "–" + abs(g.tap) + "</td><td>" + g.tonnes.toFixed(3) + "</td><td>" + g.kwh + "</td><td>" + Math.round(g.perT) + "</td><td>₹" + Math.round(g.rsT) + "</td><td>" + Math.round(g.perT * ef) + "</td>" +
        (hasHold ? "<td>" + (g.hold == null ? "–" : g.hold) + "</td>" : "") + (hasRem ? "<td>" + esc(g.remarks) + (g.flagged ? " ⚑" : "") + "</td>" : "") + "<td class=hash>" + g.hash + "</td></tr>").join("") + "</table>" +
      (P.skipped.length ? "<p class=mut>Skipped: " + P.skipped.map(s => "line " + s.line + " (" + s.reason + ")").join("; ") + "</p>" : "");
    $("flagBox").innerHTML = S.flagged.n ? '<div class="card" style="margin-top:12px"><h3>Flagged heats (remarks contain "hold" or "long") · observational</h3><div class="row">' + tile(S.flagged.n + " heats", "flagged") + tile(Math.round(S.flagged.kwh_t) + " kWh/t", "flagged average") +
      (S.rest.n ? tile(Math.round(S.rest.kwh_t) + " kWh/t", "other " + S.rest.n + " heats") + tile((S.diff >= 0 ? "+" : "") + Math.round(S.diff) + " kWh/t", "flagged minus rest (" + (S.diff >= 0 ? "+" : "") + (100 * S.diff / S.rest.kwh_t).toFixed(1) + "%)") : tile("–", "no unflagged heats to compare")) +
      '</div><p class="note">Observational only: this compares groups of heats as they happened, not a controlled test. Flagged heats may also differ in grade, size or start-up condition, and small samples are noisy.</p></div>'
      : '<p class="mut">No remarks contain "hold" or "long", so no heats are flagged.</p>';
    $("yNote").textContent = "Receipts from a heat log hash the totals you entered, not a 1-minute meter series, so they prove the log was not changed afterwards, not that it was right. Meter-grade receipts need the CT meter (see the meter series mode).";
  }
  $("calc").onclick = calc; $("sample").onclick = () => { $("csv").value = SAMPLE; calc(); };
  $("file").onchange = ev => { const f = ev.target.files[0]; if (f) f.text().then(t => { $("csv").value = t; calc(); }); };
  const q = v => /[",\n]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : v;
  $("dl").onclick = () => { const ef = +$("ef").value, csv = "heat,grade,window,tonnes,kwh,kwh_per_t,rs_per_t,kgco2e_per_t,hold_min,remarks,flagged,prev_hash,hash\n" + lastRows.map(g => [q(g.heat), q(g.grade), abs(g.start) + "-" + abs(g.tap), g.tonnes, g.kwh, g.perT.toFixed(1), Math.round(g.rsT), (g.perT * ef).toFixed(1), g.hold == null ? "" : g.hold, q(g.remarks), g.flagged ? 1 : 0, g.prev, g.hash].join(",")).join("\n");
    download("heatledger_receipts.csv", csv, "text/csv"); };

  // --- mode 2: meter series ---
  let SER = null, mtTouched = false;
  $("np").oninput = () => { if (!mtTouched) $("mt").value = E.defaultMeltThreshold(+$("np").value); }; $("mt").oninput = () => { mtTouched = true; };
  const warnBox = (id, a) => $(id).innerHTML = a.map(w => '<div class="warn">' + esc(w) + "</div>").join("");
  function renderDet() {
    const S = SER, L = S.log;
    $("detTbl").innerHTML = "<table><tr><th>#</th><th>Window</th><th>Min</th><th>kWh detected</th><th>Melt kWh</th><th>Hold kW</th><th>Log heat</th><th>Tonnes</th></tr>" + S.desc.map((d, i) => "<tr><td>" + (i + 1) + "</td><td>" + abs(d.start) + "–" + abs(d.end) + "</td><td>" + (d.end - d.start) + "</td><td>" + f1(d.kwhDet) + "</td><td>" + f1(d.meltKwh) + "</td><td>" + (d.holdKw == null ? "–" : f1(d.holdKw)) +
      "</td><td>" + (S.match[i] >= 0 && L ? esc(L[S.match[i]].heat) : "–") + '</td><td><input class="tn" type="number" step="0.01" min="0" data-i="' + i + '" value="' + (S.tonnes[i] > 0 ? +S.tonnes[i].toFixed(3) : "") + '"></td></tr>').join("") + "</table>";
  }
  let serMap = null; const SFIELDS = [["ts", "Timestamp", 1], ["kw", "Total power", 1], ["l1", "Phase 1 power", 0], ["l2", "Phase 2 power", 0], ["l3", "Phase 3 power", 0], ["kva", "kVA", 0], ["pf", "Power factor", 0]];
  function sMapUi(P) {
    const opt = f => '<option value="">— none —</option>' + P.headers.map(h => '<option' + (P.mapping[f] === h ? " selected" : "") + ' value="' + esc(h) + '">' + esc(h) + "</option>").join("");
    return '<div class="card" style="margin-top:12px"><h3>Map your columns</h3><p class="mut">Could not find ' + (P.unmapped.indexOf("ts") >= 0 ? "a timestamp column" : "") + (P.unmapped.length > 1 ? " and " : "") + (P.unmapped.indexOf("kw") >= 0 ? "a power column (total, or all phases)" : "") + ". Pick the columns of your file. Leave phases empty if you have a total.</p><div class=\"row\">" +
      SFIELDS.map(([f, l, req]) => "<div><label>" + l + (req ? " *" : " (optional)") + '</label><select data-f="' + f + '">' + opt(f) + "</select></div>").join("") +
      '<div><label>Power unit</label><select id="sMapUnit"><option value="auto">auto-detect</option><option value="kw">kilowatts</option><option value="w">watts</option></select></div></div>' +
      '<p><button class="act" id="sMapApply">Apply mapping</button> <span class="mut">Header row found at line ' + (P.preamble + 1) + "; delimiter: " + (P.delimiter === "	" ? "tab" : P.delimiter === ";" ? "semicolon" : "comma") + "</span></p></div>"; }
  $("sMapBox").onclick = ev => { if (ev.target.id !== "sMapApply") return; const map = {}; $("sMapBox").querySelectorAll("select[data-f]").forEach(sel => map[sel.dataset.f] = sel.value);
    const P0 = E.parseSeries($("scsv").value); serMap = { sig: P0.sig, map, unit: $("sMapUnit").value }; detect(); };
  $("scsv").addEventListener("input", () => { serMap = null; });
  function detect() {
    const np = +$("np").value, txt = $("scsv").value; let ps = E.parseSeries(txt, { nameplate: np, now: new Date() });
    if (serMap && ps.sig === serMap.sig) ps = E.parseSeries(txt, { nameplate: np, now: new Date(), map: serMap.map, unit: serMap.unit }); else serMap = null;
    const he = +$("he").value, mt = +$("mt").value;
    $("detCard").style.display = "none"; $("recCard").style.display = "none"; SER = null; $("sMapBox").innerHTML = "";
    if (ps.needsMapping) { $("sWarn").innerHTML = ps.warnings.map(w => '<div class="warn">' + esc(w) + "</div>").join(""); $("sMapBox").innerHTML = sMapUi(ps); return; }
    const w = ps.warnings.slice(); if (ps.errors.length) { warnBox("sWarn", ps.errors.concat(w)); return; }
    if (mt <= 1.2 * he) w.push("Melt threshold (" + mt + " kW) is close to the holding-power estimate (" + he + " kW): holding periods may be detected as melts. Lower the holding estimate or raise the threshold if you see false heats.");
    const det = E.detectClean(ps.p, he, mt), desc = E.describeDetected(ps.p, det, mt, ps.t0);
    w.push(ps.n + " readings (" + (ps.step === 1 ? "1-minute" : ps.step + "-minute") + ") spanning " + Math.round(ps.p.length / 60 * 10) / 10 + " h; " + desc.length + " heat(s) detected at melt threshold " + mt + " kW.");
    warnBox("sWarn", w); if (!desc.length) return;
    SER = { ps, desc, tonnes: desc.map(() => NaN), match: desc.map(() => -1), log: null, issued: null, mt };
    $("detCard").style.display = "block"; $("matchNote").textContent = ""; renderDet();
  }
  $("detect").onclick = detect;
  $("sfile").onchange = ev => { const f = ev.target.files[0]; if (f) f.text().then(t => { $("scsv").value = t; serMap = null; detect(); }); };
  $("detTbl").oninput = ev => { const i = ev.target.dataset && ev.target.dataset.i; if (i != null && SER) SER.tonnes[+i] = parseFloat(ev.target.value); };
  $("matchBtn").onclick = () => { if (!SER) return; const P = parseLog();
    if (!P.rows.length) { $("matchNote").textContent = "No valid heat log loaded. Paste one in the “Heat log CSV” mode first (or use the synthetic sample series, which also loads a synthetic log)."; return; }
    const mi = E.matchLog(SER.desc, P.rows, +$("dayOff").value || 0); SER.log = P.rows; SER.match = mi;
    mi.forEach((j, i) => { if (j >= 0) SER.tonnes[i] = P.rows[j].tonnes; });
    $("matchNote").textContent = "Matched " + mi.filter(j => j >= 0).length + " of " + SER.desc.length + " detected heats to " + P.rows.length + " log rows by time overlap. Check the table; edit tonnes if a match is wrong."; renderDet(); };
  let issuedCtx = null;
  $("issue").onclick = () => { if (!SER) return; const ef = +$("ef2").value, idx = [];
    SER.desc.forEach((d, i) => { if (SER.tonnes[i] > 0) idx.push(i); });
    if (!idx.length) { $("matchNote").textContent = "Enter tonnes for at least one heat (or match to a heat log) first."; return; }
    const heats = idx.map((i, n) => { const d = SER.desc[i]; return { id: hid(n + 1), start: d.start, end: d.end, s: d.s, e: d.e, tonnes: +SER.tonnes[i].toFixed(3) }; });
    const R = E.seriesReceipts(SER.ps.p, heats, ef); SER.issued = { R, idx }; issuedCtx = { chain: R.chain, anchor: R.chain[R.chain.length - 1].hash };
    $("recCard").style.display = "block"; $("expNote2").textContent = "";
    $("sRec").innerHTML = "<table><tr><th>Heat</th><th>Window</th><th>t</th><th>kWh</th><th>kWh/t</th><th>kgCO₂e/t</th><th>Prev hash</th><th>Hash</th></tr>" + R.rows.map(r => "<tr><td>" + r.id + "</td><td>" + abs(r.start) + "–" + abs(r.end) + "</td><td>" + r.tonnes + "</td><td>" + r.kwh + "</td><td>" + r.kwh_per_t + "</td><td>" + r.kgco2e_per_t + "</td><td class=hash>" + r.prev_hash + "</td><td class=hash>" + r.hash + "</td></tr>").join("") + "</table>";
    // side-by-side vs heat log
    if (SER.log && idx.some(i => SER.match[i] >= 0)) { const C = E.compareLog(R.rows, SER.log, idx.map(i => SER.match[i])); SER.issued.C = C;
      $("cmpBox").innerHTML = '<h2 style="margin-top:14px">Meter series vs heat log (kWh per heat)</h2><div class="row">' + tile(C.pairs.length, "heats compared") + tile(C.mad.toFixed(1) + "%", "mean absolute difference") + "</div>" +
        '<div class="tw"><table><tr><th>Heat</th><th>Meter kWh</th><th>Log kWh</th><th>Difference</th></tr>' + C.pairs.map(p => "<tr><td>" + p.id + "</td><td>" + f1(p.meter) + "</td><td>" + f1(p.log) + "</td><td>" + (p.pct >= 0 ? "+" : "") + p.pct.toFixed(1) + "%</td></tr>").join("") + '</table></div><p class="note">Difference = (meter − log) / log. Positive means the meter series recorded more energy than the log. The meter window may include holding time the log does not.</p>';
    } else $("cmpBox").innerHTML = SER.log ? '<p class="mut">A heat log is loaded but no detected heat in these receipts is matched to it. Use “Match to heat log by time” to compare.</p>' : '<p class="mut">Load a heat log (Heat log CSV mode) and match by time to see a side-by-side comparison.</p>';
    // calibration
    const cal = E.calibrate(idx.map(i => ({ tonnes: SER.tonnes[i], meltKwh: SER.desc[i].meltKwh, holdKw: SER.desc[i].holdKw }))), nh = idx.filter(i => SER.desc[i].holdKw != null).length, fin = v => v != null && isFinite(v); SER.issued.cal = cal; SER.issued.nHold = nh;
    $("calBox").innerHTML = (cal.n < 20 ? '<div class="warn">Only ' + cal.n + " heat(s) used; calibration needs 20 or more to be reliable. Treat these as rough.</div>" : "") +
      '<div class="row">' + tile(fin(cal.hold_kw_est) ? f1(cal.hold_kw_est) + " kW" : "n/a", "estimated holding power (median over " + nh + " heats with a hold phase)") + tile(fin(cal.fixed_est) ? f1(cal.fixed_est) + " kWh" : "n/a", "fixed energy per heat (regression intercept)") +
      tile(fin(cal.kwh_per_t_melt_est) ? f1(cal.kwh_per_t_melt_est) + " kWh/t" : "n/a", "melt energy (slope)") + tile(cal.n, "heats used") + "</div>" +
      '<p class="note">Melt energy is regressed on tonnes, so it needs heats of different sizes' + (fin(cal.fixed_est) ? "" : " (not estimable here: fewer than 2 heats or identical tonnes)") + ". Feed these into the Break-even tab’s “Check your own furnace” to see whether scheduling pays.</p>"; };

  // --- shared export / copy ---
  function download(name, text, type) { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); }
  function copyText(t) { // execCommand first: synchronous inside the click, never waits on a permission prompt; Clipboard API (with a timeout) as backup
    try { const ta = document.createElement("textarea"); ta.value = t; ta.style.cssText = "position:fixed;opacity:0"; document.body.appendChild(ta); ta.select(); const r = document.execCommand("copy"); ta.remove(); if (r) return Promise.resolve(true); } catch (e) { }
    if (!(navigator.clipboard && navigator.clipboard.writeText)) return Promise.resolve(false);
    return Promise.race([navigator.clipboard.writeText(t).then(() => true, () => false), new Promise(r => setTimeout(() => r(false), 2000))]); }
  function wireExport(bExp, bCopy, noteId, get) {
    $(bExp).onclick = () => { const c = get(); if (!c) { $(noteId).textContent = "Nothing to export yet."; return; } download("heatledger_chain.json", E.exportChain(c.chain), "application/json"); $(noteId).textContent = "Exported " + c.chain.length + " heats. Anchor (head hash): " + c.anchor; };
    $(bCopy).onclick = () => { const c = get(); if (!c) { $(noteId).textContent = "Nothing to copy yet."; return; } copyText(c.anchor).then(okk => { $(noteId).textContent = okk ? "Anchor copied: " + c.anchor : "Copy was blocked by the browser. Select the anchor here: " + c.anchor; }); };
  }
  wireExport("expChain", "copyAnchor", "expNote", () => chain ? { chain, anchor } : null);
  wireExport("expChain2", "copyAnchor2", "expNote2", () => issuedCtx);

  // --- synthetic sample series (reference model; not real) ---
  function syntheticSample() {
    const cfg = BASE, hh = i => clock(i);
    for (let seed = 21; seed < 60; seed++) {
      const rng = E.makeRng(seed), pieces = [], log = []; let day = 0;
      for (let k = 0; k < 4; k++) { const { q, d, noise } = E.makeDay(rng), ev = E.evaluate(E.planDP(q, d, cfg), q, d, noise, cfg), p = E.powerSeries(ev.recs, cfg, rng);
        pieces.push(p); ev.recs.forEach((r, n) => log.push({ day: k, s: Math.round(r.start), t: Math.round(Math.max(r.ready, r.last_due)), kg: Math.round(r.tonnes * 1000), kwh: Math.round(r.kwh), hold: r.hold_min > 20 })); }
      const text = "heat,grade,weight_kg,start,tap,kwh,remarks\n" + log.map((r, n) => [n + 1, "SYN", r.kg, hh(r.s), hh(r.t), r.kwh, r.hold ? "long hold" : ""].join(",")).join("\n");
      const P = E.parseHeatLog(text); if (P.rows.length !== log.length || !P.rows.every((r, n) => r.start === log[n].day * 1440 + log[n].s)) continue; // day roll-over must be recoverable from clock times
      const lines = ["timestamp,kw"]; pieces.forEach(p => { for (let i = 0; i < p.length; i++) lines.push(hh(i) + "," + p[i].toFixed(1)); });
      return { series: lines.join("\n"), log: text, seed };
    }
    return null;
  }
  $("sSample").onclick = () => { const S = syntheticSample(); if (!S) { warnBox("sWarn", ["Could not generate a sample."]); return; }
    $("scsv").value = S.series; serMap = null; $("csv").value = S.log; $("np").value = 1500; $("mt").value = 200; mtTouched = true; $("he").value = 100; calc(); detect();
    $("sWarn").insertAdjacentHTML("afterbegin", '<div class="warn"><b>SYNTHETIC sample.</b> Four simulated days generated in your browser by the reference model (engine.powerSeries) with nameplate 1500 kW and melt threshold 200 kW; a synthetic heat log was also loaded into the Heat log mode so you can try matching. No real foundry data.</div>'); };

  // --- pilot report (opens a self-contained printable page; nothing is uploaded) ---
  $("report").onclick = () => {
    const note = $("repNote"); if (!lastRows.length || !lastStats) { note.textContent = "Compute receipts from a heat log first (Heat log CSV mode), then open the report."; return; }
    const ef = +$("ef").value, d = new Date(), pad = n => String(n).padStart(2, "0"), I = SER && SER.issued;
    const data = { date: d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()), source: $("srcLabel").value || "user-supplied heat log, unaudited", ef,
      efSource: ef === 0.71 ? "CEA FY2024-25 v21 grid factor (provisional)" : "user-entered value (the default 0.710 is the CEA FY2024-25 v21 grid factor, provisional)",
      stats: E.logStats(lastRows, ef), rows: lastRows, hasGrade: lastRows.some(r => r.grade), hasRemarks: lastRows.some(r => r.remarks), anchor: lastRows[lastRows.length - 1].full,
      calibration: I && I.cal ? Object.assign({ nHold: I.nHold }, I.cal) : null, comparison: I && I.C ? I.C : null, seriesAnchor: I ? I.R.chain[I.R.chain.length - 1].hash : null,
      seriesInfo: I ? SER.ps.n + " readings, " + (SER.ps.step === 1 ? "1-minute" : SER.ps.step + "-minute") + ", " + (SER.ps.p.length / 60).toFixed(1) + " h; nameplate " + $("np").value + " kW, melt threshold " + SER.mt + " kW, holding estimate " + $("he").value + " kW; " + I.R.rows.length + " heats receipted" : "" };
    const w = window.open("", "_blank");
    if (!w) { note.textContent = "The browser blocked the new window. Allow pop-ups for this page and try again."; return; }
    w.document.open(); w.document.write(E.reportHtml(data)); w.document.close(); w.focus();
    note.textContent = "Report opened in a new tab. Use its “Print / Save as PDF” button.";
  };
})();
