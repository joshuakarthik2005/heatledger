#!/usr/bin/env python3
"""Render an animated replay of the simulated heat H01 (SYNTHETIC data from heatledger_sim.py).
Writes heatledger_live_heat_replay.mp4 and .gif next to this script."""
import json, subprocess, sys, os
from PIL import Image, ImageDraw, ImageFont
import imageio_ffmpeg

HERE = os.path.dirname(os.path.abspath(__file__))
lh = json.load(open(os.environ.get("LIVE_HEAT_JSON", os.path.join(HERE, "live_heat_H01.json"))))
rd = lh["readings"]; N = len(rd); TONNES = lh["tonnes"]
W, H, FPS = 1280, 720, 24
BG, CARD, EDGE = (20, 33, 28), (29, 46, 39), (47, 68, 58)
INK, MUT, ORG, GRN = (241, 239, 232), (169, 184, 176), (240, 138, 75), (95, 211, 166)
F = lambda n, s: ImageFont.truetype("/usr/share/fonts/truetype/dejavu/" + n, s)
fb, fr, fm, fmb = lambda s: F("DejaVuSans-Bold.ttf", s), lambda s: F("DejaVuSans.ttf", s), lambda s: F("DejaVuSansMono.ttf", s), lambda s: F("DejaVuSansMono-Bold.ttf", s)
cum = [0.0]
for v in rd: cum.append(cum[-1] + v / 60.0)
TOTAL = cum[-1]; PLAN_KWH = TONNES * 506 + 60
def kwh_at(t):
    i = min(int(t), N - 1); fr_ = min(t - i, 1.0) if t < N else 1.0
    return cum[i] + (rd[i] / 60.0) * fr_ if t < N else TOTAL
def pw_at(t):
    i = min(int(t), N - 1); j = min(i + 1, N - 1); f = t - i
    return rd[i] * (1 - f) + rd[j] * f
def tile(d, x, y, w, h, label, value, sub, vcol=GRN):
    d.rounded_rectangle([x, y, x + w, y + h], 14, fill=CARD, outline=EDGE, width=2)
    d.text((x + 20, y + 14), label, font=fr(20), fill=MUT)
    d.text((x + 20, y + 44), value, font=fmb(36), fill=vcol)
    d.text((x + 20, y + h - 34), sub, font=fr(18), fill=MUT)
def frame(k, total_frames):
    run = 11 * FPS
    t = min(k / run, 1.0) * N; done = k >= run
    img = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(img)
    d.text((48, 30), "HeatLedger · live heat view", font=fb(30), fill=INK)
    d.text((48, 72), "Replay of simulated heat H01 · synthetic data", font=fr(20), fill=ORG)
    status = "Tapped" if done else ("Ramp-up" if t < 7 else ("Melting" if t < 23 else "Ready, waiting for pour"))
    d.rounded_rectangle([W - 48 - 340, 34, W - 48, 84], 25, fill=(11, 110, 79) if not done else EDGE)
    d.text((W - 48 - 340 + 24, 46), status, font=fb(24), fill=INK)
    # chart
    cx, cy, cw, ch = 48, 130, 760, 450
    d.rounded_rectangle([cx, cy, cx + cw, cy + ch], 16, fill=CARD, outline=EDGE, width=2)
    d.text((cx + 24, cy + 16), "Furnace power (kW)", font=fr(20), fill=MUT)
    px0, py0, pw_, ph_ = cx + 40, cy + 60, cw - 80, ch - 120; mx = max(rd) * 1.1
    d.line([px0, py0 + ph_, px0 + pw_, py0 + ph_], fill=EDGE, width=3)
    xs = lambda m: px0 + pw_ * m / N; ys = lambda v: py0 + ph_ - ph_ * v / mx
    d.line([xs(N), py0, xs(N), py0 + ph_], fill=MUT, width=2)
    d.text((xs(N) - 150, py0 - 28), "pour due 08:25", font=fr(18), fill=MUT)
    pts = [(xs(i), ys(rd[i])) for i in range(min(int(t), N - 1) + 1)] + [(xs(t), ys(pw_at(t)))]
    if len(pts) > 1: d.line(pts, fill=ORG, width=6, joint="curve")
    d.ellipse([xs(t) - 9, ys(pw_at(t)) - 9, xs(t) + 9, ys(pw_at(t)) + 9], fill=ORG)
    d.text((px0, py0 + ph_ + 12), "08:00", font=fr(20), fill=MUT); d.text((px0 + pw_ - 60, py0 + ph_ + 12), "08:25", font=fr(20), fill=MUT)
    # tiles
    tx, tw = 850, 382
    tile(d, tx, 130, tw, 120, "Energy so far", "%.1f kWh" % kwh_at(t), "plan %.0f kWh" % PLAN_KWH)
    mins = max(0.0, N - t)
    tile(d, tx, 266, tw, 120, "Minutes to pour due", "%.0f min" % mins if not done else "poured", "ready 2 min before due", vcol=INK)
    final = TOTAL / TONNES
    tile(d, tx, 402, tw, 120, "Specific energy", ("%.1f kWh/t" % final) if done else "calculating", "baseline 589.8 kWh/t", vcol=GRN if done else MUT)
    # receipt line / footer
    if done:
        d.rounded_rectangle([48, 590, W - 48, 676], 14, fill=CARD, outline=GRN, width=2)
        d.text((72, 600), "Receipt H01 · 1.16 t · 653.2 kWh · 563.1 kWh/t · ₹3,937/t", font=fm(22), fill=INK)
        d.text((72, 634), "399.8 kgCO₂e/t · hash 33f8424fce61", font=fm(22), fill=INK)
    else:
        d.text((48, 612), "Operator action: none until tap. Metal will be ready 2 min before the pour is due.", font=fr(24), fill=MUT)
    d.text((48, 684), "Synthetic data from heatledger_sim.py; not a measurement from a real furnace.", font=fr(18), fill=MUT)
    return img
total = 14 * FPS
ff = imageio_ffmpeg.get_ffmpeg_exe()
p = subprocess.Popen([ff, "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "%dx%d" % (W, H), "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20",
                      os.path.join(HERE, "heatledger_live_heat_replay.mp4")], stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
gif = []
for k in range(total):
    im = frame(k, total); p.stdin.write(im.tobytes())
    if k % 2 == 0: gif.append(im.resize((800, 450), Image.LANCZOS).convert("P", palette=Image.ADAPTIVE, colors=64))
p.stdin.close(); p.wait()
gif[0].save(os.path.join(HERE, "heatledger_live_heat_replay.gif"), save_all=True, append_images=gif[1:], duration=int(2000 / FPS), loop=0, optimize=True)
print("done")
