// Parity tests: JS engine vs Python reference (fixtures.json exported from heatledger_sim.py)
const E = require("./engine.js"), fx = require("./fixtures.json"), crypto = require("crypto");
let fail = 0; const ok = (c, m) => { if (!c) { fail++; console.log("FAIL", m); } };
const near = (a, b, t) => Math.abs(a - b) <= t * Math.max(1, Math.abs(b));
fx.forEach((f, k) => {
  const cfg = Object.assign({}, E.BASE, f.cfg || {});
  const heats = E.planDP(f.q, f.d, cfg);
  ok(JSON.stringify(heats) === JSON.stringify(f.plan), "plan " + k + " " + JSON.stringify(heats) + " vs " + JSON.stringify(f.plan));
  const ev = E.evaluate(heats, f.q, f.d, f.noise, cfg);
  ok(near(ev.kwh, f.plan_kwh, 1e-9) && near(ev.cost, f.plan_cost, 1e-9) && near(ev.late, f.plan_late, 1e-9) && near(ev.hold_h, f.plan_hold_h, 1e-9), "eval " + k);
  if (f.base.length) {
    const eb = E.evaluate(f.base, f.q, f.d, f.noise, cfg);
    ok(near(eb.kwh, f.base_kwh, 1e-9) && near(eb.cost, f.base_cost, 1e-9), "baseline eval " + k);
  }
  if (f.series.length) {
    const det = E.detectClean(Float64Array.from(f.series), 100.0);
    ok(det.length === f.det.length && det.every((x, i) => x[0] === f.det[i][0] && x[1] === f.det[i][1] && near(x[2], f.det[i][2], 1e-9)), "detect " + k + " " + JSON.stringify(det) + " vs " + JSON.stringify(f.det));
  }
});
// hashes
for (const s of ["", "abc", "x".repeat(1000), "héat ✓"]) ok(E.sha256(s) === crypto.createHash("sha256").update(s).digest("hex"), "sha " + s.slice(0, 5));
const lh = require("../live_heat_H01.json");
ok(E.sha256(E.payload({ id: "H01", start: 480, end: 505, tonnes: 1.16, kw: lh.readings }, E.ZERO)).startsWith("33f8424fce61"), "H01 hash");
// tamper
const hs = [0, 1, 2, 3].map(i => ({ id: "H0" + (i + 1), start: i * 100, end: i * 100 + 50, tonnes: 1.2, kw: Array.from({ length: 50 }, (_, j) => 100 + i + j / 10) }));
const ch = E.buildChain(hs), anchor = ch[3].hash;
ok(E.verifyChain(ch, anchor) === "OK", "honest");
const t = ch.slice(); const d = JSON.parse(t[1].payload); d.kw = d.kw.map(x => Math.round(x * 0.9 * 10) / 10); t[1] = { payload: JSON.stringify(d), hash: t[1].hash };
ok(/altered/.test(E.verifyChain(t, anchor)), "edit caught");
const rc = E.rechainFrom(ch, 1, d => { d.kw = d.kw.map(x => Math.round(x * 0.9 * 10) / 10); });
ok(E.verifyChain(rc, rc[3].hash) === "OK", "rechain passes internally");
ok(/anchor/.test(E.verifyChain(rc, anchor)), "rechain fails vs anchor");
// ---- chain export / verify round trip ----
{
  const ex = E.exportChain(ch), back = E.parseChainJson(ex);
  ok(Array.isArray(JSON.parse(ex)) && JSON.parse(ex).every(x => Object.keys(x).join() === "payload,hash"), "export is array of {payload,hash}");
  ok(back.chain && E.verifyChain(back.chain, anchor) === "OK", "round trip verifies");
  const det = E.verifyChainDetail(back.chain, anchor.toUpperCase() + " ");
  ok(det.ok && det.heats.length === 4 && det.heats.every(h => h.ok), "detail ok (anchor case/space tolerant)");
  const tt = back.chain.slice(); const dd = JSON.parse(tt[1].payload); dd.tonnes = 9.9; tt[1] = { payload: JSON.stringify(dd), hash: tt[1].hash };
  const d2 = E.verifyChainDetail(tt, anchor);
  ok(!d2.ok && !d2.heats[1].ok && d2.heats[0].ok && /altered/.test(d2.verdict), "detail flags edited heat 2");
  const d3 = E.verifyChainDetail(E.rechainFrom(ch, 1, d => { d.tonnes = 9.9; }), anchor);
  ok(!d3.ok && d3.heats.every(h => h.ok) && /anchor/.test(d3.verdict), "rechained: per-heat ok, anchor fails");
  ok(E.parseChainJson("nope").error && E.parseChainJson("[]").error && E.parseChainJson('[{"payload":1,"hash":"x"}]').error, "bad chain json rejected");
  ok(/not valid JSON/.test(E.verifyChain([{ payload: "{", hash: "x" }], anchor)), "bad payload does not throw");
}
// ---- heat log parsing ----
{
  const r1 = E.parseHeatLog("Heat,Grade,Weight_KG,Start,Tap,KWH,Remarks\n1,SG,1100,22:00,23:30,700,\n2,,1200,23:50,01:10,780,\"long hold, waiting\"\n3,SG,1000,00:30,02:00,600,\n4,SG,1000,03:00,04:30,640,Hold\nx,,0,01:00,02:00,5,\n");
  ok(!r1.errors.length && r1.rows.length === 4 && r1.skipped.length === 1 && r1.skipped[0].line === 6, "log: 4 valid, 1 skipped " + JSON.stringify(r1.skipped));
  const a = r1.rows;
  ok(a[0].start === 1320 && a[0].tap === 1410, "log row1 abs");
  ok(a[1].start === 1430 && a[1].tap === 1510, "log row2 tap crosses midnight: " + a[1].tap);
  ok(a[2].start === 1470 && a[2].tap === 1560, "log row3 start rolls to next day: " + a[2].start);
  ok(a[3].start === 1620 && a[3].tap === 1710, "log row4 same day as row3");
  ok(Math.abs(a[0].tonnes - 1.1) < 1e-12 && a[1].grade === "" && a[0].grade === "SG", "weight_kg -> tonnes, optional grade");
  ok(a[1].flagged && a[3].flagged && !a[0].flagged && a[1].remarks === "long hold, waiting", "flags from remarks, quoted comma");
  ok(r1.warnings.length === 1, "midnight warning");
  const st = E.logStats(a, 0.71);
  ok(st.flagged.n === 2 && st.rest.n === 2 && Math.abs(st.flagged.kwh_t - (780 + 640) / 2.2) < 1e-9 && Math.abs(st.diff - (st.flagged.kwh_t - st.rest.kwh_t)) < 1e-12, "flag stats");
  const r2 = E.parseHeatLog("heat,start,tap,tonnes,kwh,hold_min\n1,06:00,07:35,1.10,640,12\n2,08:00,09:30,1.25,722,5");
  ok(r2.rows.length === 2 && r2.rows[0].tonnes === 1.1 && r2.rows[0].tap === 455 && r2.rows[0].hold === 12 && !r2.warnings.length, "old tonnes format still parses");
  { const m = E.parseHeatLog("heat,start,tap,kwh\n1,06:00,07:00,5"); ok(m.needsMapping && m.unmapped.join() === "weight" && !m.rows.length && !m.errors.length, "missing weight column -> mapping fallback"); }
  ok(isNaN(E.parseClock("24:00")) && isNaN(E.parseClock("12:60")) && E.parseClock("7:05") === 425, "clock validation");
  const r3 = E.parseHeatLog("heat,start,tap,tonnes,kwh\n1,20:00,21:00,1,600\n2,23:00,23:50,1,600\n3,02:00,03:00,1,600\n4,01:00,02:00,1,600\n5,06:00,07:00,1,600");
  ok(r3.rows.map(x => x.start).join() === [1200, 1380, 1560, 2940, 3240].join(), "multi-day run: " + r3.rows.map(x => x.start));
}
// ---- series parse, detect, match, receipts, calibrate ----
{
  const cfg = E.BASE, rng = E.makeRng(11), series = [], recsAll = [];
  for (let k = 0; k < 4; k++) { const { q, d, noise } = E.makeDay(rng), ev = E.evaluate(E.planDP(q, d, cfg), q, d, noise, cfg), p = E.powerSeries(ev.recs, cfg, rng);
    series.push(p); ev.recs.forEach(r => recsAll.push(Object.assign({ day: k }, r))); }
  const hhmm = i => String(Math.floor(i / 60) % 24).padStart(2, "0") + ":" + String(i % 60).padStart(2, "0");
  const csv = ["timestamp,kw"].concat(series.flatMap(p => Array.from(p, (v, i) => hhmm(i) + "," + v.toFixed(1)))).join("\n");
  const ps = E.parseSeries(csv, { nameplate: 1500 });
  ok(!ps.errors.length && ps.p.length === 5760 && ps.step === 1 && ps.t0 === 0 && !ps.warnings.length, "series 1-min parse " + JSON.stringify(ps.errors.concat(ps.warnings)));
  ok(E.parseSeries("timestamp,kw\n" + Array.from({ length: 12 }, (_, i) => "00:" + String(i).padStart(2, "0") + ",650.5").join("\n"), { nameplate: 1500 }).max === 650.5, "kW above 600 not clipped");
  const det = E.detectClean(ps.p, 100, 200), desc = E.describeDetected(ps.p, det, 200, ps.t0);
  ok(det.length >= recsAll.length - 2 && det.length <= recsAll.length + 2, "detect count " + det.length + " vs " + recsAll.length);
  const logRows = recsAll.map(r => ({ start: r.day * 1440 + Math.round(r.start), tap: r.day * 1440 + Math.round(Math.max(r.ready, r.last_due)), kwh: r.kwh, tonnes: r.tonnes }));
  const mi = E.matchLog(desc, logRows, 0), matched = mi.filter(i => i >= 0);
  ok(new Set(matched).size === matched.length && matched.length >= recsAll.length - 2, "match by time one-to-one " + matched.length);
  const heats = desc.map((d, n) => ({ id: "H" + (n + 1), start: d.start, end: d.end, s: d.s, e: d.e, tonnes: mi[n] >= 0 ? logRows[mi[n]].tonnes : 1.2 }));
  const sr = E.seriesReceipts(ps.p, heats, 0.71);
  ok(E.verifyChain(E.parseChainJson(E.exportChain(sr.chain)).chain, sr.chain[sr.chain.length - 1].hash) === "OK", "series receipts chain verifies");
  const cmp = E.compareLog(sr.rows, logRows, mi);
  ok(cmp.pairs.length === matched.length && cmp.mad < 5, "meter vs log mean abs diff small: " + cmp.mad.toFixed(2));
  const cal = E.calibrate(desc.map((d, n) => ({ tonnes: heats[n].tonnes, meltKwh: d.meltKwh, holdKw: d.holdKw })));
  ok(cal.n === desc.length && cal.n >= 20 && cal.hold_kw_est > 85 && cal.hold_kw_est < 115, "calibrate hold ~100: " + JSON.stringify(cal));
  ok(cal.fixed_est > 20 && cal.fixed_est < 100 && cal.kwh_per_t_melt_est > 480 && cal.kwh_per_t_melt_est < 540, "calibrate fixed/slope plausible");
  const five = ["timestamp,kw"]; for (let i = 0; i < 1440; i += 5) five.push(hhmm(i) + "," + ps.p[i].toFixed(1));
  const p5 = E.parseSeries(five.join("\n")); ok(!p5.errors.length && p5.step === 5 && p5.p.length === 1440 && p5.warnings.some(w => /5 minutes/.test(w)), "5-minute accepted with warning");
  ok(E.detectClean(p5.p, 100, 200).length >= 1, "5-minute detect runs");
  const mid = ["timestamp,kw"]; for (let i = 0; i < 40; i++) mid.push(hhmm((23 * 60 + 40 + i) % 1440) + ",100");
  const pm = E.parseSeries(mid.join("\n")); ok(!pm.errors.length && pm.p.length === 40 && pm.t0 === 1420 && pm.missing === 0, "HH:MM series across midnight is contiguous");
  const pi = E.parseSeries(["timestamp,kw", "2025-03-31T23:58:00,5", "2025-03-31T23:59:00,5", "2025-04-01T00:00:00,5", "2025-04-01 00:01,5", "2025-04-01T00:02:00Z,5", "2025-04-01T00:03:00+05:30,5", "2025-04-01T00:04:00,5", "2025-04-01T00:05:00,5", "2025-04-01T00:06:00,5", "2025-04-01T00:07:00,5", "2025-04-01T00:08:00,abc"].join("\n"));
  ok(!pi.errors.length && pi.p.length === 10 && pi.skipped === 1 && pi.t0 === 1438, "ISO timestamps incl. date rollover: " + JSON.stringify(pi.errors) + pi.p.length + " " + pi.t0);
  ok(E.parseSeries("timestamp,kw\n" + Array.from({ length: 12 }, (_, i) => "2025-01-01T" + String(i).padStart(2, "0") + ":00,5").join("\n")).errors.length === 1, "hourly data rejected");
  ok(E.defaultMeltThreshold(550) === 100 && E.defaultMeltThreshold(1000) === 200 && E.defaultMeltThreshold(1500) === 200, "melt threshold default by nameplate");
}
// ---- header aliases, delimiters, meter before/after, mapping fallback, report (invented rows only) ----
{
  const h1 = E.parseHeatLog("Heat No.,Grade,Wt (kg),Start Time,Tap,kWh (meter),Remarks\n1,A,500,06:00,07:30,310,\n2,A,520,08:00,09:30,330,long wait\n");
  ok(!h1.needsMapping && h1.rows.length === 2 && !h1.errors.length, "aliases map: " + JSON.stringify(h1.unmapped));
  ok(h1.rows[0].tonnes === 0.5 && h1.rows[0].kwh === 310 && h1.rows[0].heat === "1" && h1.rows[0].grade === "A" && h1.rows[1].flagged && h1.rows[1].tap === 570, "alias values read");
  ok(h1.mapping.weight === "Wt (kg)" && h1.mapping.kwh === "kWh (meter)" && h1.mapping.heat === "Heat No." && h1.mapping.remarks === "Remarks" && h1.mapping.tap === "Tap", "mapping reports raw headers");
  const keys = { "Weight (kg)": "weight", "WT": "weight", "Charge kg": "weight", "Metal (kg)": "weight", "No": "heat", "Heat Number": "heat", "Charging Time": "start", "Tapping": "tap", "Tap Time": "tap", "Energy": "kwh", "Meter kWh": "kwh", "Notes": "remarks", "Remark": "remarks" };
  Object.keys(keys).forEach(k => { const am = E.autoMap([k]), f = keys[k]; ok(am[f] && am[f].idx === 0, "alias " + k + " -> " + f); });
  ok(E.autoMap(["Weight (t)"]).weight.unit === "t" && E.autoMap(["Tonnes"]).weight.unit === "t" && E.autoMap(["Wt (kg)"]).weight.unit === "kg" && E.autoMap(["Weight"]).weight.unit === null, "weight units from header");
  const ht = E.parseHeatLog("heat,start,tap,Weight (t),kwh\n1,06:00,07:00,0.5,300");
  ok(ht.rows[0].tonnes === 0.5 && !ht.warnings.some(w => /no unit/.test(w)), "tonnes header respected");
  const hk = E.parseHeatLog("heat,start,tap,weight,kwh\n1,06:00,07:00,500,300"); ok(hk.rows[0].tonnes === 0.5 && hk.warnings.some(w => /kilograms/.test(w)), "unitless weight assumed kg with warning");
  // tab-separated (pasted spreadsheet cells) incl. thousands separator and am/pm; semicolon with decimal comma
  const tsv = E.parseHeatLog("Heat No.\tWt (kg)\tStart\tTap\tkWh (meter)\tRemarks\n1\t1,100\t6:00 AM\t7:30:00\t640\t\n2\t1,200\t08:00\t09:30\t720\tHold");
  ok(tsv.delimiter === "\t" && tsv.rows.length === 2 && tsv.rows[0].tonnes === 1.1 && tsv.rows[0].start === 360 && tsv.rows[1].flagged, "tab-separated paste");
  const sc = E.parseHeatLog("heat;weight_kg;start;tap;kwh\n1;480,5;06:00;07:30;310,5\n");
  ok(sc.delimiter === ";" && sc.rows.length === 1 && Math.abs(sc.rows[0].tonnes - 0.4805) < 1e-9 && sc.rows[0].kwh === 310.5, "semicolon with decimal comma");
  // meter before/after
  const mb = E.parseHeatLog("heat,wt,start,tap,meter_before,meter_after,kwh\n1,500,06:00,07:00,1000,1310,\n2,500,08:00,09:00,1310,1630,325\n3,500,10:00,11:00,5000,4900,\n");
  ok(!mb.needsMapping && mb.rows.length === 2 && mb.rows[0].kwh === 310 && mb.rows[0].fromMeters && mb.rows[1].kwh === 325 && !mb.rows[1].fromMeters, "kWh from meters only when kwh missing");
  ok(mb.skipped.length === 1 && mb.skipped[0].reason === "negative kWh from meters" && mb.warnings.some(w => /lower than meter_before/.test(w)), "negative meter difference warned and skipped");
  const mb2 = E.parseHeatLog("heat,wt,start,tap,meter_before,meter_after\n1,500,06:00,07:00,10,25.5"); ok(!mb2.needsMapping && mb2.rows[0].kwh === 15.5, "no kwh column at all: meters suffice");
  // unmapped fallback + user mapping
  const um = E.parseHeatLog("Furnace run,Metal poured,Begin,Finish,Units used\n1,500,06:00,07:00,300");
  ok(um.needsMapping && um.unmapped.join() === "weight,start,tap,kwh" && um.headers.length === 5 && !um.rows.length, "unmapped fallback lists required fields");
  const um2 = E.parseHeatLog("Furnace run,Metal poured,Begin,Finish,Units used\n1,500,06:00,07:00,300\n2,0.52,08:00,09:00,310", { map: { heat: "Furnace run", weight: "Metal poured", start: "Begin", tap: "Finish", kwh: "Units used" }, weightUnit: "t" });
  ok(!um2.needsMapping && um2.rows.length === 2 && um2.rows[1].tonnes === 0.52 && um2.rows[0].heat === "1", "user mapping + unit applies");
  const um3 = E.parseHeatLog("Begin,Finish,Units used,Metal poured\n06:00,07:00,300,500", { map: { start: "Begin", tap: "Finish", kwh: "Units used", weight: "Metal poured" } });
  ok(!um3.needsMapping && um3.rows[0].tonnes === 0.5, "mapping with default kg");
  ok(E.parseHeatLog("heat,wt,start,tap,kwh\n1,500,06:00,07:00,300", { map: { kwh: "" } }).unmapped.join() === "kwh", "explicit 'none' unmaps a field");
  // report
  const lg = E.parseHeatLog("heat,grade,wt,start,tap,kwh,remarks\n1,A,500,06:00,07:30,310,\n2,A,520,08:00,09:30,330,hold <b>x</b>"), st = E.logStats(lg.rows, 0.71);
  const rep = E.reportHtml({ date: "2026-01-02", source: 'my <label> "x"', ef: 0.71, efSource: "CEA FY2024-25 v21 (provisional)", stats: st, rows: lg.rows.map(r => Object.assign({ hash: "abcdef123456" }, r)), hasGrade: true, hasRemarks: true, anchor: "f".repeat(64), seriesAnchor: null, calibration: { n: 5, nHold: 3, hold_kw_est: 99, fixed_est: 60, kwh_per_t_melt_est: 510 }, seriesInfo: "x", comparison: null });
  ok(rep.includes("my &lt;label&gt; &quot;x&quot;") && rep.includes("f".repeat(64)) && rep.includes("@page{size:A4") && rep.includes("window.print()") && rep.includes("observational") && rep.includes("CEA FY2024-25") && rep.includes("Only 5 heat(s)"), "report content");
  ok(!/(src|href)\s*=|@import|url\(|<link|<script/i.test(rep) && !rep.includes("<b>x</b>"), "report has no external requests and escapes user text");
  ok(!/field_evidence|project_description/i.test(rep), "report names nothing else");
}
// ---- analyzer-export series import. ALL ROWS BELOW ARE INVENTED: made-up numbers around 4.8 kW, no real foundry or lab data. ----
{
  const now = new Date(2026, 10, 27, 12, 0), NP = 550, HDR = "Timestamp,L1_kW,L2_kW,L3_kW,Total_kW,Total_kVA,Power_Factor";
  const stamp = i => "2026-11-27 " + String(10 + Math.floor(i / 60)).padStart(2, "0") + ":" + String(i % 60).padStart(2, "0") + ":00";
  const rowsOf = (n, f) => Array.from({ length: n }, (_, i) => { const l1 = +(1.6 + (i % 3) * 0.02).toFixed(2), l2 = +(1.6 + (i % 4) * 0.01).toFixed(2), l3 = +(1.6 - (i % 2) * 0.02).toFixed(2), tot = +(l1 + l2 + l3).toFixed(2), kva = +(tot / 0.96).toFixed(2);
    return Object.assign({ ts: stamp(i), l1, l2, l3, tot, kva, pf: 0.96 }, f ? f(i) : {}); });
  const toText = rs => [HDR].concat(rs.map(r => [r.ts, r.l1, r.l2, r.l3, r.tot, r.kva, r.pf].join(","))).join("\n");
  const P = (text, o) => E.parseSeries(text, Object.assign({ nameplate: NP, now }, o || {}));
  const has = (r, re) => r.warnings.some(w => re.test(w));
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  // exact layout, 11 rows
  const base = P(toText(rowsOf(11)));
  ok(!base.errors.length && base.n === 11 && base.p.length === 11 && base.step === 1 && base.t0 === 600, "layout file parses: " + JSON.stringify(base.errors));
  ok(!base.warnings.length, "clean layout file raises no warnings: " + JSON.stringify(base.warnings));
  ok(near(base.p[0], 4.8) && base.max > 4.7 && base.max < 4.9, "uses Total_kW (about 4.8 kW)");
  ok(base.mapping.kw === "Total_kW" && base.mapping.l1 === "L1_kW" && base.mapping.kva === "Total_kVA" && base.mapping.pf === "Power_Factor" && base.mapping.ts === "Timestamp", "mapping reports raw headers");
  // other header spellings
  const alt = (h, v) => P(h + "\n" + Array.from({ length: 11 }, (_, i) => stamp(i) + "," + v).join("\n"));
  ["timestamp,kw", "Time,Total kW", "DateTime,total_kw", "Date & Time,P total (kW)", "date-time,Active Power Total", "Date Time,Power Total", "TIME,Total Power"].forEach(h => {
    const r = alt(h, "4.8"); ok(!r.errors.length && !r.needsMapping && r.n === 11 && near(r.p[0], 4.8), "header spelling accepted: " + h); });
  // per-phase only: summed
  const pp = P(["Timestamp,L1_kW,L2_kW,L3_kW"].concat(rowsOf(11).map(r => [r.ts, r.l1, r.l2, r.l3].join(","))).join("\n"));
  ok(!pp.errors.length && near(pp.p[0], 4.8) && has(pp, /summed 3 per-phase/), "per-phase columns are summed: " + JSON.stringify(pp.warnings));
  const pp2 = P("time,p1,p2,p3\n" + rowsOf(11).map(r => [r.ts, r.l1, r.l2, r.l3].join(",")).join("\n"));
  ok(!pp2.errors.length && near(pp2.p[0], 4.8), "p1/p2/p3 columns are summed");
  // watts
  const w1 = P(["Timestamp,Total_W"].concat(rowsOf(11).map(r => r.ts + "," + Math.round(r.tot * 1000))).join("\n"));
  ok(!w1.errors.length && w1.wattsConverted && near(w1.p[0], 4.8) && has(w1, /watts/), "header with W converts to kW and warns");
  const big = rowsOf(11).map(r => r.ts + "," + Math.round(r.tot * 1000 + 700));
  const w2 = P(["timestamp,power"].concat(big).join("\n"));
  ok(w2.wattsConverted && near(w2.p[0], 5.5) && has(w2, /median/), "median above 5000 with nameplate under 1000 kW converts");
  ok(!P(["timestamp,power"].concat(big).join("\n"), { nameplate: 1500 }).wattsConverted, "no conversion when nameplate is 1000 kW or more");
  const w4 = P(["timestamp,kw"].concat(big).join("\n"));
  ok(!w4.wattsConverted && has(w4, /header says kW/), "header kW with watt-sized values warns, not converted");
  const w5 = P(["timestamp,power"].concat(rowsOf(11).map(r => r.ts + "," + r.tot)).join("\n"), { unit: "w" });
  ok(w5.wattsConverted && w5.p[0] < 0.01, "explicit unit choice W is honoured");
  // semicolon + decimal comma, tab
  const sc = P("Timestamp;Total_kW;Total_kVA;Power_Factor\n" + rowsOf(11).map(r => [r.ts, String(r.tot).replace(".", ","), String(r.kva).replace(".", ","), "0,96"].join(";")).join("\n"));
  ok(!sc.errors.length && sc.n === 11 && near(sc.p[0], 4.8) && sc.delimiter === ";" && has(sc, /decimal comma/) && sc.warnings.length === 1, "semicolon decimal-comma file: " + JSON.stringify(sc.warnings));
  const tabs = P(["Timestamp\tTotal_kW"].concat(rowsOf(11).map(r => r.ts + "\t" + r.tot)).join("\n"));
  ok(!tabs.errors.length && tabs.n === 11, "tab-separated file");
  // preamble
  const pre = P(["Invented analyzer report", "Site: made-up lab, bay 3", "Exported: 27/11/2026 12:00", toText(rowsOf(11))].join("\n"));
  ok(!pre.errors.length && pre.preamble === 3 && pre.n === 11 && has(pre, /3 preamble line/) && near(pre.p[0], 4.8), "3 preamble lines skipped: " + JSON.stringify(pre.warnings));
  // timestamp formats
  const ts = (s, o) => { const r = E.parseTimestamp(s, o); return r && r.t; }, d0 = (y, m, d, h, mi) => Date.UTC(y, m - 1, d, h || 0, mi || 0) / 60000;
  ok(ts("2026-11-27 10:00:00") === d0(2026, 11, 27, 10, 0), "ISO with space");
  ok(ts("27/11/2026 10:05") === d0(2026, 11, 27, 10, 5) && ts("27/11/2026 10:05:30") === d0(2026, 11, 27, 10, 5) + 0.5, "dd/mm/yyyy hh:mm[:ss]");
  ok(ts("03/04/2026 00:00") === d0(2026, 4, 3), "dd/mm is day-first by default");
  ok(ts("03/04/2026 00:00", { monthFirst: true }) === d0(2026, 3, 4), "month-first on request");
  ok(ts("27-11-2026 10:05") === d0(2026, 11, 27, 10, 5) && ts("27.11.2026 10:05") === d0(2026, 11, 27, 10, 5), "dd-mm-yyyy and dd.mm.yyyy");
  ok(ts("27/11/2026 12:00 AM") === d0(2026, 11, 27, 0, 0) && ts("27/11/2026 12:30 PM") === d0(2026, 11, 27, 12, 30) && ts("27/11/2026 01:05 pm") === d0(2026, 11, 27, 13, 5) && ts("2026-11-27 11:59 PM") === d0(2026, 11, 27, 23, 59), "12-hour AM/PM");
  ok(ts("31/02/2026 10:00") === null && ts("27/11/2026 13:00 PM") === null && ts("garbage") === null, "invalid timestamps rejected");
  const dm = P(["Timestamp,Total_kW"].concat(rowsOf(11).map((r, i) => "27/11/2026 " + stamp(i).slice(11) + "," + r.tot)).join("\n"));
  ok(!dm.errors.length && dm.n === 11 && dm.t0 === 600 && !dm.warnings.length, "dd/mm/yyyy series: " + JSON.stringify(dm.warnings));
  const mf = P(["Timestamp,Total_kW"].concat(rowsOf(11).map((r, i) => "11/27/2026 " + stamp(i).slice(11) + "," + r.tot)).join("\n"));
  ok(!mf.errors.length && mf.n === 11 && has(mf, /month-first/), "mm/dd/yyyy detected from a day above 12");
  const ap = P(["Timestamp,Total_kW"].concat(rowsOf(11).map((r, i) => "27-11-2026 10:" + String(i).padStart(2, "0") + " AM," + r.tot)).join("\n"));
  ok(!ap.errors.length && ap.n === 11 && ap.t0 === 600, "AM/PM series");
  // gap, duplicate, step
  const gp = P(toText(rowsOf(14).filter((r, i) => i < 5 || i > 7)));
  ok(!gp.errors.length && gp.missing === 3 && gp.gaps.length === 1 && gp.p.length === 14 && has(gp, /3 minute\(s\) have no reading/), "gap reported: " + JSON.stringify(gp.warnings));
  const dup = rowsOf(11); dup.splice(4, 0, dup[4]);
  const dp = P(toText(dup));
  ok(!dp.errors.length && dp.duplicates === 1 && dp.n === 11 && dp.missing === 0 && has(dp, /1 duplicate timestamp/), "duplicate timestamp reported: " + JSON.stringify(dp.warnings));
  const every = k => P(["Timestamp,Total_kW"].concat(Array.from({ length: 12 }, (_, i) => { const m = i * k; return "2026-11-27 " + String(10 + Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0") + ":00,4.8"; })).join("\n"));
  const s5 = every(5), s10 = every(10), s15 = every(15);
  ok(!s5.errors.length && s5.step === 5 && has(s5, /5 minutes, not 1/) && s5.p.length === 60, "5-minute accepted with warning");
  ok(!s10.errors.length && s10.step === 10 && has(s10, /10 minutes, not 1/) && s10.p.length === 120 && s10.missing === 0, "10-minute accepted with warning");
  ok(s15.errors.length === 1, "15-minute rejected");
  // sanity warnings (never errors)
  const warnOnly = (r, re, what) => ok(!r.errors.length && r.n === 11 && has(r, re), what + ": " + JSON.stringify(r.errors.concat(r.warnings)));
  warnOnly(P(toText(rowsOf(11, i => i === 3 ? { tot: 5.2 } : {}))), /sum of the per-phase kW by more than 1%/, "total vs phase sum");
  warnOnly(P(toText(rowsOf(11, i => i === 3 ? { kva: 4.0 } : {}))), /kVA is below kW/, "kVA below kW");
  warnOnly(P(toText(rowsOf(11, i => i === 3 ? { pf: 1.2 } : {}))), /outside 0 to 1/, "PF above 1");
  warnOnly(P(toText(rowsOf(11, i => i === 3 ? { pf: -0.2 } : {}))), /outside 0 to 1/, "PF below 0");
  warnOnly(P(toText(rowsOf(11, i => i === 3 ? { pf: 0.8 } : {}))), /differs from kW\/kVA by more than 0.02/, "PF inconsistent with kW/kVA");
  warnOnly(P(toText(rowsOf(11)), { nameplate: 2 }), /above 1.5x the furnace nameplate/, "reading above 1.5x nameplate");
  warnOnly(P(toText(rowsOf(11)), { now: new Date(2026, 10, 27, 9, 0) }), /timestamps are in the future: check the instrument clock/i, "timestamps in the future");
  ok(!has(P(toText(rowsOf(11)), { now: new Date(2026, 10, 27, 10, 30) }), /future/i), "past timestamps not flagged");
  ok(!has(P(toText(rowsOf(11, i => i === 3 ? { pf: 0.97 } : {}))), /differs from kW\/kVA/), "PF within 0.02 not flagged");
  ok(!has(P("timestamp,kw\n" + Array.from({ length: 11 }, (_, i) => "10:" + String(i).padStart(2, "0") + ",4.8").join("\n"), { now: new Date(2020, 0, 1) }), /future/i), "clock-only times never trigger the future check");
  // mapping fallback
  const odd = ["Invented export", "Reading time,Active load"].concat(Array.from({ length: 11 }, (_, i) => stamp(i) + ",4.8")).join("\n");
  const m0 = P(odd);
  ok(m0.needsMapping && m0.unmapped.join() === "ts,kw" && m0.headers.join("|") === "Reading time|Active load", "unrecognised headers ask for a mapping: " + JSON.stringify(m0.unmapped));
  const m1 = P(odd, { map: { ts: "Reading time", kw: "Active load" } });
  ok(!m1.needsMapping && m1.n === 11 && near(m1.p[0], 4.8) && m1.sig === m0.sig, "user mapping parses the file");
  const m2 = P(odd, { map: { ts: "Reading time", kw: "" } });
  ok(m2.needsMapping && m2.unmapped.join() === "kw", "mapping with no power column still asks");
  const m3 = P("Reading time,Phase A,Phase B,Phase C\n" + Array.from({ length: 11 }, (_, i) => stamp(i) + ",1.6,1.6,1.6").join("\n"), { map: { ts: "Reading time", l1: "Phase A", l2: "Phase B", l3: "Phase C" } });
  ok(!m3.needsMapping && near(m3.p[0], 4.8), "mapping per-phase columns by hand");
  ok(E.parseSeries("").errors.length === 1 && E.parseSeries("timestamp,kw\n10:00,5").errors.length === 1, "empty and short input are errors");
}
// study smoke: planner should beat baseline on kWh/t
const cfg = E.BASE, sm = E.summarize(E.study(90, 1, cfg), cfg);
console.log("JS study (own RNG): save kWh/t", sm.save_kwh_t.toFixed(1), "hold b/p", sm.b.hold_h_day.toFixed(1), sm.p.hold_h_day.toFixed(1), "late b/p", sm.b.late_min_day.toFixed(1), sm.p.late_min_day.toFixed(1));
ok(sm.save_kwh_t > 5 && sm.save_kwh_t < 25, "study saving in plausible range");
console.log(fail ? fail + " FAILED" : "ALL PASS");
process.exit(fail ? 1 : 0);
