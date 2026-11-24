#!/usr/bin/env python3
"""
HeatLedger - melt-sequence planner simulation (SYNTHETIC DATA).

What this tests: does a planner that groups pours into heats and picks melt start
times beat a plausible operator heuristic on kWh/t, Rs/t and kgCO2e/t, when the
physics is the same for both?  It does NOT prove real-world savings: the energy
model and every parameter in BASE are assumptions to be replaced with a
foundry's own meter data.

Run:  python heatledger_sim.py
"""
import json, math, hashlib, functools, sys, os
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

OUT = os.path.dirname(os.path.abspath(__file__)) + "/"
os.makedirs(OUT + "charts/charts", exist_ok=True)

# ---------------- assumptions (replace with foundry data) ----------------
BASE = dict(
    cap=3.0,        # furnace capacity, tonnes
    e_melt=506.0,   # kWh/t: 396 theoretical + ~110 equipment losses (BEE range 100-130)
    fixed=60.0,     # kWh per heat: start-up / thermal overhead (ASSUMPTION)
    hold_kw=100.0,  # holding power, kW (ASSUMPTION)
    p_melt=1500.0,  # melting power, kW (ASSUMPTION)
    tariff=7.0,     # Rs/kWh base (ASSUMPTION)
    lead=240,       # max minutes a melt may start earlier than strictly needed (shiftable window)
    late_pen=500.0, # Rs per minute late (keeps the planner on-time)
    grid=10,        # planning grid, minutes
    ef=0.710,       # tCO2/MWh, CEA FY2024-25 weighted avg incl. renewables (Version 21, provisional)
    tap=10,         # minutes after last pour before furnace is free
    buf_lo=10, buf_hi=50,  # operator habit: minutes melt is ready BEFORE first pour (ASSUMPTION)
    guard=False,    # True = planner and operators keep one grade per heat
    solar=0.0,      # contracted/on-site solar peak, kW (0 = none). Clear-day bell 07:00-17:00 (ASSUMPTION)
    solar_aware=False,  # True = planner minimises GRID energy cost, with solar kWh treated as free
    maxhold={0: 180, 1: 120, 2: 60},  # max minutes metal may be held, by grade (ASSUMPTIONS, replace with foundry limits)
)


def mult_minute(m):
    """Illustrative time-of-day multiplier. Real slots differ by state/DISCOM."""
    h = (m % 1440) / 60
    if h >= 22 or h < 6:
        return 0.90   # night rebate
    if 18 <= h < 22:
        return 1.20   # evening peak
    return 1.0


PM = np.concatenate([[0.0], np.cumsum([mult_minute(m) for m in range(0, 4320)])])


def avgm(a, b):
    a = int(round(a)); b = int(round(b))
    if b <= a:
        return mult_minute(a)
    return (PM[b] - PM[a]) / (b - a)


# ---------------- demand ----------------
_SOL = {}


def solar_arrays(cfg):
    key = (float(cfg["solar"]), float(cfg["hold_kw"]))
    if key in _SOL:
        return _SOL[key]
    N = 4320; t = np.arange(N) % 1440
    S = np.where((t >= 420) & (t < 1020), cfg["solar"] * np.sin(np.pi * (t - 420) / 600.0) ** 1.5, 0.0)
    mult = np.array([mult_minute(m) for m in range(N)]); hg = np.maximum(0.0, cfg["hold_kw"] - S)
    cs = lambda x: np.concatenate([[0.0], np.cumsum(x)])
    _SOL[key] = dict(PS=cs(S), PMS=cs(mult * S), PH0=cs(hg), PH=cs(mult * hg))
    return _SOL[key]


def make_day(rng):
    n = int(rng.integers(7, 11))
    q = [round(float(x), 2) for x in rng.uniform(1.0, 1.6, n)]
    d = np.sort(np.round(rng.uniform(480, 1080, n) / 5) * 5)
    for k in range(1, n):
        d[k] = max(d[k], d[k - 1] + 40)
    noise = float(rng.uniform(0, 40))  # unobservable kWh/t (rusty charge, slag): same for both policies
    return q, [float(x) for x in d], noise


def melt_min(m, cfg):
    return 60.0 * m * cfg["e_melt"] / cfg["p_melt"]


# ---------------- policies ----------------
def baseline_plan(q, d, rng, cfg, g=None):
    """Plausible operator habit: fill a heat to 85-100% of capacity in due order,
    start melting 10-50 min before the first pour is needed."""
    n = len(q); heats = []; i = 0; prev_end = 0.0
    while i < n:
        target = rng.uniform(0.85, 1.0) * cfg["cap"]
        j = i; m = q[i]
        while j + 1 < n and m + q[j + 1] <= target and (not cfg["guard"] or g is None or g[j + 1] == g[i]):
            j += 1; m += q[j]
        mm = melt_min(m, cfg)
        buffer = rng.uniform(cfg["buf_lo"], cfg["buf_hi"])
        s = max(d[i] - mm - buffer, prev_end)
        ready = s + mm
        heats.append((i, j, s))
        prev_end = max(ready, d[j]) + cfg["tap"]
        i = j + 1
    return heats


def plan_dp(q, d, cfg, g=None):
    """Exact dynamic programme over contiguous pour groups and 15-min start slots."""
    n = len(q); CAP = cfg["cap"]; G = cfg["grid"]

    @functools.lru_cache(maxsize=None)
    def f(i, tfree):
        if i == n:
            return (0.0, ())
        best = (1e18, ())
        m = 0.0
        for j in range(i, n):
            m += q[j]
            if m > CAP + 1e-9:
                break
            if cfg["guard"] and g is not None and g[j] != g[i]:
                break
            fd, ld = d[i], d[j]
            mm = melt_min(m, cfg)
            lo = max(tfree, fd - mm - cfg["lead"])
            hi = fd - mm + 60
            s0 = int(math.ceil(lo / G) * G)
            for s in range(s0, int(max(hi, s0)) + 1, G):
                ready = s + mm
                late = max(0.0, ready - fd)
                hold_min = max(0.0, ld - ready)
                if cfg["guard"] and g is not None and hold_min > cfg["maxhold"][g[i]]:
                    continue
                melt_kwh = m * cfg["e_melt"] + cfg["fixed"]
                hold_kwh = cfg["hold_kw"] * hold_min / 60.0
                if cfg.get("solar", 0) > 0 and cfg.get("solar_aware"):
                    A = solar_arrays(cfg); a_, b_, c_ = int(round(s)), int(round(ready)), int(round(ld))
                    ml = melt_kwh * 60.0 / mm
                    melt_c = (ml * (PM[b_] - PM[a_]) - (A["PMS"][b_] - A["PMS"][a_])) / 60.0
                    hold_c = (A["PH"][c_] - A["PH"][b_]) / 60.0 if c_ > b_ else 0.0
                    cost = cfg["tariff"] * (melt_c + hold_c) + cfg["late_pen"] * late
                else:
                    cost = cfg["tariff"] * (melt_kwh * avgm(s, ready) + hold_kwh * avgm(ready, ld)) \
                        + cfg["late_pen"] * late
                end = max(ready, ld) + cfg["tap"]
                sub = f(j + 1, int(math.ceil(end / G) * G))
                tot = cost + sub[0]
                if tot < best[0]:
                    best = (tot, ((i, j, float(s)),) + sub[1])
        return best

    return list(f(0, 0)[1])


# ---------------- ground-truth accounting (same physics for both) ----------------
def evaluate(heats, q, d, noise, cfg, g=None):
    recs = []; kwh = cost = hold_h = late = fill = 0.0; viol = mixed = 0; gtot = 0.0
    for (i, j, s) in heats:
        m = sum(q[i:j + 1]); mm = melt_min(m, cfg)
        ready = s + mm; fd, ld = d[i], d[j]
        hold_min = max(0.0, ld - ready)
        if g is not None:
            viol += int(hold_min > cfg["maxhold"][g[i]]); mixed += int(len(set(g[i:j + 1])) > 1)
        melt_kwh = m * (cfg["e_melt"] + noise) + cfg["fixed"]
        hold_kwh = cfg["hold_kw"] * hold_min / 60.0
        c = cfg["tariff"] * (melt_kwh * avgm(s, ready) + hold_kwh * avgm(ready, ld))
        gk = melt_kwh + hold_kwh
        if cfg.get("solar", 0) > 0:
            A = solar_arrays(cfg); a_, b_, c_ = int(round(s)), int(round(ready)), int(round(ld)); ml = melt_kwh * 60.0 / mm
            gk = melt_kwh - (A["PS"][b_] - A["PS"][a_]) / 60.0 + ((A["PH0"][c_] - A["PH0"][b_]) / 60.0 if c_ > b_ else 0.0)
            c = cfg["tariff"] * ((ml * (PM[b_] - PM[a_]) - (A["PMS"][b_] - A["PMS"][a_])) / 60.0
                                 + ((A["PH"][c_] - A["PH"][b_]) / 60.0 if c_ > b_ else 0.0))
        recs.append(dict(i=i, j=j, tonnes=m, start=s, ready=ready, first_due=fd, last_due=ld,
                         kwh=melt_kwh + hold_kwh, gkwh=gk, cost=c, hold_min=hold_min))
        kwh += melt_kwh + hold_kwh; gtot += gk; cost += c; hold_h += hold_min / 60
        late += max(0.0, ready - fd); fill += m / cfg["cap"]
    return dict(kwh=kwh, cost=cost, hold_h=hold_h, late=late, heats=len(heats),
                fill=fill / len(heats), recs=recs, viol=viol, mixed=mixed, gkwh=gtot)


def make_grades(n, seed, day):
    """Orders arrive in grade runs (ASSUMPTION): 2-3 runs per day, separate RNG so other results are unchanged."""
    r = np.random.default_rng([seed, day, 77])
    k = int(r.integers(2, 4)); cuts = sorted(int(c) for c in r.choice(np.arange(1, n), size=k - 1, replace=False))
    order = r.permutation(3)[:k]; g = []; prev = 0
    for b, cut in enumerate(cuts + [n]):
        g += [int(order[b])] * (cut - prev); prev = cut
    return g


def simulate(days, seed, cfg, plan_cfg=None):
    rng = np.random.default_rng(seed)
    out = []
    for day in range(days):
        if day % 7 == 6:       # Sunday off
            continue
        q, d, noise = make_day(rng)
        g = make_grades(len(q), seed, day)
        brng = np.random.default_rng(int(rng.integers(1 << 31)))
        b = evaluate(baseline_plan(q, d, brng, cfg, g), q, d, noise, cfg, g)
        p = evaluate(plan_dp(q, d, plan_cfg or cfg, g), q, d, noise, cfg, g)
        out.append(dict(day=day, q=q, d=d, noise=noise, b=b, p=p, t=sum(q)))
    return out


def summarize(out, cfg):
    t = sum(o["t"] for o in out)
    r = {}
    for k in ("b", "p"):
        kwh = sum(o[k]["kwh"] for o in out); cost = sum(o[k]["cost"] for o in out)
        r[k] = dict(kwh_t=kwh / t, rs_t=cost / t, kg_t=kwh / t * cfg["ef"],
                    gkg_t=sum(o[k]["gkwh"] for o in out) / t * cfg["ef"],
                    heats_day=np.mean([o[k]["heats"] for o in out]),
                    fill=np.mean([o[k]["fill"] for o in out]),
                    hold_h_day=np.mean([o[k]["hold_h"] for o in out]),
                    late_min_day=np.mean([o[k]["late"] for o in out]),
                    viol_day=np.mean([o[k]["viol"] for o in out]), mixed_day=np.mean([o[k]["mixed"] for o in out]))
    r["save_kwh_t"] = r["b"]["kwh_t"] - r["p"]["kwh_t"]
    r["save_rs_t"] = r["b"]["rs_t"] - r["p"]["rs_t"]
    r["save_kg_t"] = r["b"]["kg_t"] - r["p"]["kg_t"]
    r["save_gkg_t"] = r["b"]["gkg_t"] - r["p"]["gkg_t"]
    r["save_pct"] = 100 * r["save_kwh_t"] / r["b"]["kwh_t"]
    r["tonnes"] = t; r["days"] = len(out)
    return r


# ---------------- heat detection demo (noisier, harder) ----------------
def power_series(recs, cfg, rng):
    """1-min furnace-meter series with idle noise, auxiliary loads, melt ramp-up and holding-power drift."""
    p = np.abs(rng.normal(0, 8, 1440))
    for _ in range(int(rng.integers(2, 6))):          # pumps/fans that the meter also sees
        s0 = int(rng.integers(0, 1380)); L = int(rng.integers(10, 60))
        p[s0:s0 + L] += rng.uniform(20, 60)
    for h in recs:
        s0 = max(int(round(h["start"])), 0); r = min(int(round(h["ready"])), 1440)
        l = min(int(round(h["last_due"])), 1440)
        melt_kwh = h["kwh"] - cfg["hold_kw"] * h["hold_min"] / 60.0
        if r > s0:
            n = r - s0; shape = np.ones(n); ramp = min(8, n // 3)
            if ramp > 0:
                shape[:ramp] = np.linspace(0.25, 1.0, ramp)
            shape *= (1 + rng.normal(0, 0.05, n))
            p[s0:r] = shape * melt_kwh * 60.0 / shape.sum()
        if l > r:
            p[r:l] = np.clip(cfg["hold_kw"] + np.cumsum(rng.normal(0, 3, l - r)), 20, None)
    return p


def detect(p, thr=40.0, gap=3, melt_thr=400.0, min_melt=5):
    """A heat = active run containing a real melt (>=5 min above melt_thr). Hold-only runs are ignored."""
    act = p > thr; runs = []; st = None; last = None
    for m, a in enumerate(act):
        if a:
            if st is None:
                st = m
            last = m
        elif st is not None and m - last > gap:
            runs.append((st, last + 1)); st = None
    if st is not None:
        runs.append((st, last + 1))
    return [(s0, e, float(p[s0:e].sum() / 60.0)) for s0, e in runs if (p[s0:e] > melt_thr).sum() >= min_melt]


def _match(recs, det):
    pairs = []; used = set()
    for h in recs:
        hs, he = h["start"], max(h["ready"], h["last_due"]); best = None
        for k, (s0, e, kw) in enumerate(det):
            ov = min(e, he) - max(s0, hs)
            if ov > 0 and (best is None or ov > best[0]):
                best = (ov, k)
        if best:
            used.add(best[1]); pairs.append((h, det[best[1]]))
    return pairs, len(det) - len(used)


def detection_study(out, cfg, seed=7):
    rng = np.random.default_rng(seed)
    total = found = fp = 0; serr = []; eerr = []; kerr = []
    for o in out[:40]:
        for key in ("b", "p"):
            recs = o[key]["recs"]; det = detect(power_series(recs, cfg, rng))
            pairs, f = _match(recs, det); total += len(recs); found += len(pairs); fp += f
            for h, (s0, e, kw) in pairs:
                serr.append(abs(s0 - h["start"])); eerr.append(abs(e - max(h["ready"], h["last_due"])))
                kerr.append(100 * abs(kw - h["kwh"]) / h["kwh"])
    return dict(heats=total, matched=found, match_pct=100 * found / total, false_positives=fp,
                mean_start_err_min=float(np.mean(serr)), mean_end_err_min=float(np.mean(eerr)),
                mean_energy_err_pct=float(np.mean(kerr)), median_energy_err_pct=float(np.median(kerr)))


def calibrate(out, cfg, n_heats=30, seed=11):
    """Estimate holding power and fixed per-heat overhead from the first n_heats the meter sees."""
    rng = np.random.default_rng(seed)
    holds = []; X = []; Y = []
    for o in out:
        recs = o["b"]["recs"]; series = power_series(recs, cfg, rng)
        pairs, _ = _match(recs, detect(series))
        for h, (s0, e, kw) in pairs:
            seg = series[s0:e]; melt_idx = np.where(seg > 200)[0]
            if len(melt_idx) == 0:
                continue
            mend = melt_idx[-1] + 1
            X.append(h["tonnes"]); Y.append(float(seg[:mend].sum() / 60.0))
            if len(seg) - mend >= 8:
                holds.append(float(np.median(seg[mend + 2:])))
        if len(X) >= n_heats:
            break
    A = np.vstack([X, np.ones(len(X))]).T
    slope, icpt = np.linalg.lstsq(A, np.array(Y), rcond=None)[0]
    return dict(n=len(X), hold_kw_est=float(np.median(holds)) if holds else None,
                fixed_est=float(icpt), kwh_per_t_melt_est=float(slope))


def detect_clean(p, hold_est=100.0, melt_thr=200.0, min_melt=5, gap=3):
    """Melt-anchored detection with auxiliary-load subtraction.
    Start = first melt minute. Aux level = median of the idle window before the melt (if clean),
    subtracted from the whole heat. End = hold drops below half the (calibrated) holding power."""
    n = len(p); melt = np.where(p > melt_thr)[0]
    if len(melt) == 0:
        return []
    groups = []; st = prev = melt[0]
    for m in melt[1:]:
        if m - prev > 6:
            groups.append((st, prev)); st = m
        prev = m
    groups.append((st, prev)); out = []
    for k, (ms, me) in enumerate(groups):
        if me - ms + 1 < min_melt:
            continue
        pre = p[max(ms - 25, 0):max(ms - 3, 0)]
        aux = 0.0
        if len(pre) >= 5 and not (pre > 0.8 * hold_est).any():
            aux = max(0.0, float(np.median(pre)) - 5.4)       # 5.4 kW = median idle noise
        c = np.clip(p - aux, 0, None); thr = 0.5 * hold_est
        nxt = groups[k + 1][0] if k + 1 < len(groups) else n
        e = me + 1; low = 0
        while e < min(n, nxt - 1):
            if c[e] > thr:
                low = 0
            else:
                low += 1
                if low > gap:
                    break
            e += 1
        e -= low
        out.append((int(ms), int(e), float(c[ms:e].sum() / 60.0)))
    return out


def detection_study2(out, cfg, hold_est, clean, seed=7):
    rng = np.random.default_rng(seed)
    total = found = fp = 0; serr = []; eerr = []; kerr = []
    for o in out[:40]:
        for key in ("b", "p"):
            recs = o[key]["recs"]; series = power_series(recs, cfg, rng)
            det = detect_clean(series, hold_est) if clean else detect(series)
            pairs, f = _match(recs, det); total += len(recs); found += len(pairs); fp += f
            for h, (s0, e, kw) in pairs:
                serr.append(abs(s0 - h["start"])); eerr.append(abs(e - max(h["ready"], h["last_due"])))
                kerr.append(100 * abs(kw - h["kwh"]) / h["kwh"])
    k = np.array(kerr)
    return dict(heats=total, matched=found, false_positives=fp,
                start_err_min=float(np.mean(serr)), end_err_min=float(np.mean(eerr)),
                energy_err_mean_pct=float(k.mean()), energy_err_median_pct=float(np.median(k)),
                energy_err_p95_pct=float(np.percentile(k, 95)), energy_err_max_pct=float(k.max()))


# ---------------- tamper-evidence demo (hash chain + external anchor) ----------------
def build_chain(recs, series):
    prev = "0" * 64; chain = []
    for n, h in enumerate(recs):
        s0 = int(round(h["start"])); e = int(round(max(h["ready"], h["last_due"])))
        payload = json.dumps(dict(id=n, kw=[round(float(x), 1) for x in series[s0:e]], prev=prev), separators=(",", ":"))
        prev = hashlib.sha256(payload.encode()).hexdigest(); chain.append((payload, prev))
    return chain


def verify(chain, anchor_head):
    prev = "0" * 64
    for n, (payload, hsh) in enumerate(chain):
        d = json.loads(payload)
        if d["prev"] != prev:
            return f"FAIL: chain broken at heat {n}"
        if hashlib.sha256(payload.encode()).hexdigest() != hsh:
            return f"FAIL: heat {n} payload altered"
        prev = hsh
    return "OK" if prev == anchor_head else "FAIL: head hash does not match the externally anchored value"


def tamper_demo(o, cfg):
    series = power_series(o["b"]["recs"], cfg, np.random.default_rng(5))
    chain = build_chain(o["b"]["recs"], series); anchor = chain[-1][1]       # emailed/posted daily to a third party
    r = {"honest": verify(chain, anchor)}
    t = list(chain); d = json.loads(t[2][0]); d["kw"] = [round(x * 0.9, 1) for x in d["kw"]]
    t[2] = (json.dumps(d, separators=(",", ":")), t[2][1]); r["edit_one_heat"] = verify(t, anchor)
    new = []; prev = chain[1][1]                                              # attacker recomputes every hash from heat 2 onward
    for n in range(2, len(chain)):
        d = json.loads(chain[n][0]); d["prev"] = prev
        if n == 2: d["kw"] = [round(x * 0.9, 1) for x in d["kw"]]
        p = json.dumps(d, separators=(",", ":")); prev = hashlib.sha256(p.encode()).hexdigest(); new.append((p, prev))
    r["rewrite_chain_without_anchor_check"] = verify(chain[:2] + new, chain[:2][-1][1] if False else (chain[:2] + new)[-1][1])
    r["rewrite_chain_with_anchor_check"] = verify(chain[:2] + new, anchor)
    return r


def make_receipt(o, cfg, key="p"):
    rng = np.random.default_rng(99)
    recs = o[key]["recs"]
    series = power_series(recs, cfg, rng)
    prev = "0" * 64; chain = []
    for n, h in enumerate(recs):
        s = int(round(h["start"])); e = int(round(max(h["ready"], h["last_due"])))
        readings = [round(float(x), 1) for x in series[s:e]]
        payload = json.dumps(dict(id=f"H{n+1:02d}", start=s, end=e, tonnes=round(h["tonnes"], 2),
                                  kw=readings, prev=prev), separators=(",", ":"))
        hsh = hashlib.sha256(payload.encode()).hexdigest()
        kwh = sum(readings) / 60.0
        chain.append(dict(heat=f"H{n+1:02d}", start=f"{s//60:02d}:{s%60:02d}", end=f"{e//60:02d}:{e%60:02d}",
                          tonnes=round(h["tonnes"], 2), kwh=round(kwh, 1),
                          kwh_per_t=round(kwh / h["tonnes"], 1),
                          rs_per_t=float(round(h["cost"] / h["tonnes"], 0)),
                          kgco2e_per_t=round(kwh / h["tonnes"] * cfg["ef"], 1),
                          prev_hash=prev[:12], hash=hsh[:12]))
        prev = hsh
    return chain


# ---------------- charts ----------------
C_B, C_P, C_G = "#9a9a9a", "#0b6e4f", "#d9822b"


def chart_daily(out, cfg):
    x = [o["day"] for o in out]
    b = [o["b"]["kwh"] / o["t"] for o in out]; p = [o["p"]["kwh"] / o["t"] for o in out]
    roll = lambda v: np.convolve(v, np.ones(7) / 7, mode="valid")
    fig, ax = plt.subplots(figsize=(9, 4.2))
    ax.plot(x, b, color=C_B, alpha=.35, lw=1); ax.plot(x, p, color=C_P, alpha=.35, lw=1)
    ax.plot(x[6:], roll(b), color=C_B, lw=2.4, label="Operator habit (7-day avg)")
    ax.plot(x[6:], roll(p), color=C_P, lw=2.4, label="Planned (7-day avg)")
    ax.set_xlabel("Day"); ax.set_ylabel("kWh per tonne")
    ax.set_title("Daily specific energy: baseline vs planned (synthetic; 90 calendar days = 78 working days)", loc="left")
    ax.legend(frameon=False); ax.spines[["top", "right"]].set_visible(False)
    fig.tight_layout(); fig.savefig(OUT + "charts/chart1_daily_kwh_per_t.png", dpi=160); plt.close(fig)


def chart_gantt(out, cfg):
    o = next(o for o in out if len(o["q"]) >= 9)
    fig, ax = plt.subplots(figsize=(10, 3.6))
    for h0 in range(0, 1440, 60):
        m = mult_minute(h0)
        if m != 1.0:
            ax.axvspan(h0 / 60, (h0 + 60) / 60, color=("#cfe8d8" if m < 1 else "#f6d8c0"), alpha=.5, lw=0)
    for row, (lab, key) in enumerate((("Planned", "p"), ("Operator habit", "b"))):
        for h in o[key]["recs"]:
            ax.barh(row, (h["ready"] - h["start"]) / 60, left=h["start"] / 60, color=C_P if key == "p" else C_B, height=.5)
            if h["last_due"] > h["ready"]:
                ax.barh(row, (h["last_due"] - h["ready"]) / 60, left=h["ready"] / 60, color=C_G, height=.5)
    ax.vlines([x / 60 for x in o["d"]], -.45, 1.45, color="k", lw=.6, ls=":")
    ax.set_yticks([0, 1]); ax.set_yticklabels(["Planned", "Operator habit"])
    ax.set_xlim(0, 24); ax.set_xlabel("Hour of day")
    ax.set_title("One day: melting (solid) and holding (orange); dotted = pour due; green band = night rebate, orange = peak", loc="left", fontsize=9)
    ax.spines[["top", "right"]].set_visible(False)
    fig.tight_layout(); fig.savefig(OUT + "charts/chart2_day_gantt.png", dpi=160); plt.close(fig)


def chart_lead(rows):
    fig, ax = plt.subplots(1, 2, figsize=(9, 3.8))
    lab = [f"{int(r['lead']/60)} h" for r in rows]
    ax[0].bar(lab, [r["save_kwh_t"] for r in rows], color=C_P); ax[0].set_title("kWh/t saved", loc="left")
    ax[1].bar(lab, [r["save_rs_t"] for r in rows], color=C_G); ax[1].set_title("Rs/t saved", loc="left")
    for a in ax:
        a.set_xlabel("Shiftable window (how early a melt may start)"); a.spines[["top", "right"]].set_visible(False)
    fig.tight_layout(); fig.savefig(OUT + "charts/chart3_shiftable_window.png", dpi=160); plt.close(fig)


def chart_sens(grid, fixeds, holds):
    fig, ax = plt.subplots(figsize=(6, 4))
    im = ax.imshow(grid, cmap="Greens", aspect="auto")
    ax.set_xticks(range(len(holds))); ax.set_xticklabels([f"{h:.0f} kW" for h in holds])
    ax.set_yticks(range(len(fixeds))); ax.set_yticklabels([f"{f:.0f} kWh" for f in fixeds])
    ax.set_xlabel("Holding power (assumption)"); ax.set_ylabel("Fixed overhead per heat (assumption)")
    for i in range(len(fixeds)):
        for j in range(len(holds)):
            ax.text(j, i, f"{grid[i][j]:.0f}", ha="center", va="center", color="k")
    ax.set_title("kWh/t saved depends on two assumed parameters", loc="left", fontsize=10)
    fig.tight_layout(); fig.savefig(OUT + "charts/chart4_sensitivity.png", dpi=160); plt.close(fig)


# ---------------- main ----------------
if __name__ == "__main__":
    cfg = dict(BASE); res = {}
    out = simulate(90, 1, cfg)
    res["main"] = summarize(out, cfg)
    chart_daily(out, cfg); chart_gantt(out, cfg)
    print("MAIN", json.dumps(res["main"], default=float)); sys.stdout.flush()

    mc = [summarize(simulate(90, sd, cfg), cfg) for sd in range(2, 8)] + [res["main"]]
    res["seeds"] = {k: (float(np.mean([x[k] for x in mc])), float(np.std([x[k] for x in mc])))
                    for k in ("save_kwh_t", "save_rs_t", "save_kg_t", "save_pct")}
    print("SEEDS", res["seeds"]); sys.stdout.flush()

    rows = []
    for lead in (0, 120, 240, 360):
        c = dict(cfg, lead=lead); sm = summarize(simulate(90, 1, c), c); sm["lead"] = lead; rows.append(sm)
    res["lead"] = [dict(lead=r["lead"], save_kwh_t=float(r["save_kwh_t"]), save_rs_t=float(r["save_rs_t"]),
                        late_baseline=float(r["b"]["late_min_day"]), late_planned=float(r["p"]["late_min_day"])) for r in rows]
    chart_lead(rows); print("LEAD", res["lead"]); sys.stdout.flush()

    # how good must the operator be before the planner stops helping?
    res["baseline_quality"] = []
    for lo, hi in ((0, 10), (5, 25), (10, 50), (20, 70)):
        c = dict(cfg, buf_lo=lo, buf_hi=hi); sm = summarize(simulate(90, 1, c), c)
        res["baseline_quality"].append(dict(buffer_min=f"{lo}-{hi}", save_kwh_t=float(sm["save_kwh_t"]),
                                            hold_h_baseline=float(sm["b"]["hold_h_day"]), hold_h_planned=float(sm["p"]["hold_h_day"]),
                                            late_baseline=float(sm["b"]["late_min_day"]), late_planned=float(sm["p"]["late_min_day"])))
    print("BASEQ", res["baseline_quality"]); sys.stdout.flush()

    fixeds = [0, 30, 60, 90]; holds = [50, 100, 150]; grid = []; lates = []
    for f_ in fixeds:
        row = []; lrow = []
        for h_ in holds:
            c = dict(cfg, fixed=f_, hold_kw=h_); sm = summarize(simulate(45, 1, c), c)
            row.append(float(sm["save_kwh_t"])); lrow.append((float(sm["b"]["late_min_day"]), float(sm["p"]["late_min_day"])))
        grid.append(row); lates.append(lrow)
    res["sens"] = dict(fixed=fixeds, hold=holds, save_kwh_t=grid, late_baseline_planned=lates)
    chart_sens(grid, fixeds, holds); print("SENS", grid); print("SENS_LATE", lates); sys.stdout.flush()

    # self-calibration: a foundry whose true parameters differ from the planner's defaults
    truth = dict(cfg, fixed=90.0, hold_kw=50.0)
    out_t = simulate(90, 1, truth)
    est = calibrate(out_t, truth)
    cal = dict(truth, fixed=max(est["fixed_est"], 0.0), hold_kw=est["hold_kw_est"])
    unc = dict(truth, fixed=60.0, hold_kw=100.0)
    s_cal = summarize(simulate(90, 1, truth, plan_cfg=cal), truth)
    s_unc = summarize(simulate(90, 1, truth, plan_cfg=unc), truth)
    res["calibration"] = dict(truth=dict(fixed=90, hold_kw=50), estimate=est,
                              saving_kwh_t_calibrated=float(s_cal["save_kwh_t"]), saving_kwh_t_uncalibrated=float(s_unc["save_kwh_t"]),
                              late_planned_calibrated=float(s_cal["p"]["late_min_day"]), late_planned_uncalibrated=float(s_unc["p"]["late_min_day"]),
                              late_baseline=float(s_cal["b"]["late_min_day"]))
    print("CALIB", res["calibration"]); sys.stdout.flush()

    res["detection"] = detection_study(out, cfg); print("DETECT", res["detection"])
    sample = next(o for o in out if len(o["q"]) >= 9)
    res["receipt"] = make_receipt(sample, cfg)

    # --- v2 detection with auxiliary-load subtraction, in two foundry types ---
    res["detection_v2"] = {}
    for name, extra_cfg in (("high_hold_100kW", {}), ("low_hold_50kW", dict(fixed=90.0, hold_kw=50.0))):
        c = dict(cfg, **extra_cfg); o2 = simulate(90, 1, c); est2 = calibrate(o2, c)
        res["detection_v2"][name] = dict(
            raw=detection_study2(o2, c, est2["hold_kw_est"], clean=False),
            cleaned=detection_study2(o2, c, est2["hold_kw_est"], clean=True))
        print("DET2", name, json.dumps(res["detection_v2"][name], default=float)); sys.stdout.flush()
    res["tamper"] = tamper_demo(sample, cfg); print("TAMPER", res["tamper"])

    # --- payback break-even (assumptions flagged) ---
    rs_per_kwh = res["main"]["save_rs_t"] / res["main"]["save_kwh_t"]
    scen = {"tight_operator": 6.4, "central": res["main"]["save_kwh_t"], "loose_operator": 18.1}
    pb = {}
    for tpm in (100, 300, 600):
        pb[tpm] = {k: round(v * rs_per_kwh * tpm * 12 / 1e5, 2) for k, v in scen.items()}
    res["annual_saving_lakh"] = pb; res["rs_per_kwh_saved"] = rs_per_kwh
    print("PAYBACK", pb, rs_per_kwh)

    # --- grade / holding-time guardrails (4 seeds, 90 calendar days each) ---
    def _run(c, seeds=(1, 2, 3, 4)):
        ss = [summarize(simulate(90, sd, c), c) for sd in seeds]
        m = lambda f: float(np.mean([f(x) for x in ss]))
        return dict(save_kwh_t=m(lambda x: x["save_kwh_t"]), save_rs_t=m(lambda x: x["save_rs_t"]), save_kg_t=m(lambda x: x["save_kg_t"]),
                    heats_b=m(lambda x: x["b"]["heats_day"]), heats_p=m(lambda x: x["p"]["heats_day"]),
                    fill_b=m(lambda x: x["b"]["fill"]), fill_p=m(lambda x: x["p"]["fill"]),
                    hold_b=m(lambda x: x["b"]["hold_h_day"]), hold_p=m(lambda x: x["p"]["hold_h_day"]),
                    late_b=m(lambda x: x["b"]["late_min_day"]), late_p=m(lambda x: x["p"]["late_min_day"]),
                    viol_b=m(lambda x: x["b"]["viol_day"]), viol_p=m(lambda x: x["p"]["viol_day"]),
                    mixed_b=m(lambda x: x["b"]["mixed_day"]), mixed_p=m(lambda x: x["p"]["mixed_day"]))
    res["guardrails"] = dict(guard_off_4seeds=_run(dict(cfg)), guard_on_default=_run(dict(cfg, guard=True)),
                             guard_on_strict=_run(dict(cfg, guard=True, maxhold={0: 90, 1: 60, 2: 30})))
    print("GUARDRAILS", {k: round(v["save_kwh_t"], 1) for k, v in res["guardrails"].items()}); sys.stdout.flush()

    # --- energy-vs-on-time dial (90 calendar days, seed 1) ---
    res["lateness_tradeoff"] = []
    for label, ex in (("default (fixed 60 kWh, hold 100 kW)", {}), ("low-hold (fixed 90 kWh, hold 50 kW)", dict(fixed=90.0, hold_kw=50.0))):
        for lp in (5, 20, 50, 150, 500):
            c = dict(cfg, **ex, late_pen=float(lp)); sm = summarize(simulate(90, 1, c), c)
            res["lateness_tradeoff"].append(dict(world=label, late_pen=lp, save_kwh_t=round(float(sm["save_kwh_t"]), 1),
                                                 late_b=round(float(sm["b"]["late_min_day"]), 1), late_p=round(float(sm["p"]["late_min_day"]), 1),
                                                 heats_p=round(float(sm["p"]["heats_day"]), 1)))
    print("DIAL done"); sys.stdout.flush()

    # --- contracted solar: baseline vs solar-blind vs solar-aware planner (clear-day profile, ASSUMPTION) ---
    res["solar_scenario"] = {}
    for peak in (150, 300, 600):
        c0 = dict(cfg, solar=float(peak), solar_aware=False); c1 = dict(cfg, solar=float(peak), solar_aware=True)
        o0 = simulate(90, 1, c0); o1 = simulate(90, 1, c1); a, b = summarize(o0, c0), summarize(o1, c1)
        share = lambda o, k: 1 - sum(x[k]["gkwh"] for x in o) / sum(x[k]["kwh"] for x in o)
        res["solar_scenario"][str(peak)] = {k: float(v) for k, v in dict(
            peak_kw=peak, base_gkg_t=a["b"]["gkg_t"], blind_gkg_t=a["p"]["gkg_t"], aware_gkg_t=b["p"]["gkg_t"],
            base_rs_t=a["b"]["rs_t"], blind_rs_t=a["p"]["rs_t"], aware_rs_t=b["p"]["rs_t"],
            solar_share_base=share(o0, "b"), solar_share_blind=share(o0, "p"), solar_share_aware=share(o1, "p"),
            late_base=a["b"]["late_min_day"], late_blind=a["p"]["late_min_day"], late_aware=b["p"]["late_min_day"],
            kwh_t_base=a["b"]["kwh_t"], kwh_t_blind=a["p"]["kwh_t"], kwh_t_aware=b["p"]["kwh_t"]).items()}
    print("SOLAR done"); sys.stdout.flush()

    res["labels"] = dict(headline="90 calendar days = 78 working days, seed 1 (4-seed means where stated)",
                         sensitivity_grid="45 calendar days = 39 working days, seed 1", dial="90 calendar days, seed 1",
                         solar="90 calendar days, seed 1, clear-day solar profile, solar kWh free at the margin (assumptions)",
                         metric="furnace kWh per tonne of metal tapped (not whole-foundry kWh per tonne of castings)")
    json.dump(res, open(OUT + "heatledger_results.json", "w"), indent=1, default=float)
