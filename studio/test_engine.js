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
// study smoke: planner should beat baseline on kWh/t
const cfg = E.BASE, sm = E.summarize(E.study(90, 1, cfg), cfg);
console.log("JS study (own RNG): save kWh/t", sm.save_kwh_t.toFixed(1), "hold b/p", sm.b.hold_h_day.toFixed(1), sm.p.hold_h_day.toFixed(1), "late b/p", sm.b.late_min_day.toFixed(1), sm.p.late_min_day.toFixed(1));
ok(sm.save_kwh_t > 5 && sm.save_kwh_t < 25, "study saving in plausible range");
console.log(fail ? fail + " FAILED" : "ALL PASS");
process.exit(fail ? 1 : 0);
