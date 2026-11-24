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
  ok(E.parseHeatLog("heat,start,tap,kwh\n1,06:00,07:00,5").errors.length === 1, "missing weight column reported");
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
// study smoke: planner should beat baseline on kWh/t
const cfg = E.BASE, sm = E.summarize(E.study(90, 1, cfg), cfg);
console.log("JS study (own RNG): save kWh/t", sm.save_kwh_t.toFixed(1), "hold b/p", sm.b.hold_h_day.toFixed(1), sm.p.hold_h_day.toFixed(1), "late b/p", sm.b.late_min_day.toFixed(1), sm.p.late_min_day.toFixed(1));
ok(sm.save_kwh_t > 5 && sm.save_kwh_t < 25, "study saving in plausible range");
console.log(fail ? fail + " FAILED" : "ALL PASS");
process.exit(fail ? 1 : 0);
