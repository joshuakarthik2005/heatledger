# HeatLedger: Challenge 04, Smart Manufacturing

*Right-size every heat. Cut the holding. Prove it with a receipt.*

> Indian foundry SMEs melt on habit: metal is ready long before it is poured, furnaces idle at holding power, and no one sees what a melt costs in energy or carbon while it is happening. HeatLedger gives operators a live view of the current heat, plans the next heats from the pour schedule, and issues a tamper-evident energy-and-carbon receipt for every heat, splitting solar from grid energy where a plant has solar. Where scheduling pays, it saves energy; where it does not, the receipt and on-time delivery carry the value, and the system tells the plant which case it is in.

**Metric used throughout:** furnace kWh per tonne of metal tapped. Cluster reports that quote whole-foundry figures (for example 1,000-1,200 kWh for Kolhapur induction foundries) are not comparable and are not used.

## 1. Why now
- **The gap:** coreless induction furnaces use about 500-800 kWh/t (BEE best-operating-practices guide, Belgaum cluster), against a theoretical figure of about 396 kWh/t to reach 1500 C. The same guide says a separate furnace energy meter must be installed; most SMEs have none.
- **Buyer pressure:** the EU's CBAM definitive regime has applied since 1 January 2026, with certificate purchases from February 2027. Exporters need defensible per-batch data. CBAM coverage of the target castings is unconfirmed.

## 2. Solution
1. **Measure:** a three-phase true-RMS Modbus meter on the furnace. Operators enter only tonnes tapped.
2. **Live heat view:** power curve against plan, kWh so far, projected kWh/t, holding against the grade limit, minutes to the pour, one next action.
3. **Plan:** heat sizes and start times from the day's pour file (Excel or Tally), with a dial between energy and on-time pours.
4. **Prove:** per-heat kWh/t, Rs/t and kgCO2e/t in a hash-chained log; the head hash is posted outside the foundry each shift. The hash shows the log was not edited after posting; it does not prove the meter read correctly.
5. **Calibrate:** holding power and per-heat overhead are measured from the first 30 heats (simulated: 52.5 kW and 93 kWh estimated against true 50 and 90, from 35 heats), which decides whether scheduling pays (section 7).

## 3. Quality and throughput guardrails (simulated)
One grade per heat and a maximum holding time per grade (assumed 180/120/60 minutes; replace with the foundry's limits). Over 4 seeds the planner had 0 hold-limit breaches against 0.65 heats a day for the baseline operator, and the saving held at 15.5 kWh/t. Pouring temperature, chemistry drift and lining wear from extra heats are not modelled.

## 4. Two regimes: without and with solar
**Without solar** the planner saves energy (section 5). Receipts report kgCO2e/t at the CEA FY2024-25 factor (0.710 tCO2/MWh, provisional, Version 21): 418.8 for the operator habit, 408.7 planned.

**With solar** the planner's incremental furnace-energy saving shrinks to about 3-6 kWh/t, and its Rs saving ranges from about -Rs 2 to +Rs 49/t depending on solar size. The value moves to the receipt. Grid kgCO2e/t, 90 calendar days, seed 1, clear-day solar curve:

| Contracted solar (peak) | Baseline schedule | Solar-blind planner | Solar-aware planner | Solar share of load |
|---|---|---|---|---|
| None | 418.8 | 408.7 | not applicable | 0% |
| 150 kW | 382.0 | 384.1 | 381.6 | 8% |
| 300 kW | 360.0 | 363.8 | 359.1 | 14% |
| 600 kW | 320.9 | 324.8 | 315.3 | 24% |

- The emissions cut comes from the solar supply the plant buys (about 60 kg/t, 14%, at 300 kW), not from HeatLedger.
- HeatLedger's role is measurement and protection: each receipt splits solar and grid kWh so the claim can be checked, and a solar-aware planner avoids the 2-4 kg/t that a solar-blind one gives back. Scheduling adds only about 1 kg/t at 300 kW (about 6 at 600 kW).
- The solar model is optimistic: cloudless day, no seasons, solar free at the margin, no export or curtailment. Verifier treatment of a solar share is unconfirmed. Fuel switching does not apply to an electric furnace.

## 5. Headline benefit without solar (synthetic data)
- **Holding time:** down about 70% (4.0 to 1.2 h/day). **Late pours:** down about 75% (36 to 9 min/day).
- **Energy:** 14.2 kWh/t (2.4%) in the main run, 15.0 +/- 0.6 across 7 seeds, 15.5 with grade rules (4 seeds). Range 6.4 to 18.1 kWh/t from a tight to a loose operator baseline. About Rs 94-105/t and 10-11 kgCO2e/t.
- **Receipt accuracy:** mean energy error 1.7% in both furnace types; 95th percentile 5.2% (100 kW holding) and 4.9% (50 kW); worst single heat 13.6% and 16.6%. Tested on the simulator's own curves.
- The operator baseline is an assumption. Replace it with the foundry's last 30 heats.

## 6. Scope and honesty about benefit
The energy saving is about 2.5% and applies where holding is significant, at about 300 t/month and above. Below that, energy savings alone do not pay back.

## 7. When it pays: break-even disclosure
kWh/t saved by the planner (45 calendar days = 39 working days, on-time pours prioritised; late pours fall 39 to 10 min/day in every cell):

| Per-heat overhead \ holding power | 50 kW | 100 kW | 150 kW |
|---|---|---|---|
| 0 kWh | 13.2 | 28.3 | 42.7 |
| 30 kWh | 3.5 | 20.5 | 35.0 |
| 60 kWh | -2.0 | 13.2 | 27.2 |
| 90 kWh | **-6.5** | 8.0 | 19.9 |

- At 50 kW holding, scheduling saves energy only when per-heat overhead is below roughly 50 kWh. At 100 kW and above it stays positive across this grid; values beyond it were not run.
- Why: the planner runs more, smaller heats (7.4 a day against 5.3), and each extra heat costs its fixed overhead.
- After 30 heats the meter reports holding power and overhead, and HeatLedger says which regime the plant is in. In the unfavourable regime the plant has three options (90 calendar days, seed 1, 50 kW / 90 kWh foundry):
  1. **Receipt-only mode:** meter and ledger without the planner. No energy claim.
  2. **Energy-first dial (Rs 20 per late minute):** +4.9 kWh/t, 32.2 late minutes a day (baseline 36.2).
  3. **On-time dial (Rs 50 per late minute):** 11.6 late minutes a day, -2.4 kWh/t. That costs about Rs 16/t against the operator baseline, and 7.3 kWh/t (about Rs 49/t, Rs 1.75 lakh a year at 3,600 t) against the energy-first dial, for cutting late pours from 32 to 12 minutes a day.
- **The value of receipt-only mode is not priced here.** Notes from five buyer and compliance conversations (undated, unaudited) all wanted heat- or batch-level energy and carbon data, and four named a modest premium in mixed units (EUR per shipment, INR per tonne, EUR per tonne). They are not converted or averaged.

## 8. Deployment, payback and scale-up
The meter is listed in India at Rs 2,350-7,000. CTs, gateway and installation are unquoted, so the all-in costs below are placeholders.

Payback in months at 300 t/month, no-solar energy savings only:

| All-in cost | Tight operator | Central | Loose operator |
|---|---|---|---|
| Rs 1.5 lakh | 12 | 5 | 4 |
| Rs 3 lakh | 23 | 11 | 8 |
| Rs 5 lakh | 39 | 18 | 14 |

With solar (aware planner alone, Rs 1.5 lakh, 3,600 t/year): 150 kW never pays back (-Rs 2.3/t); 300 kW about 14 years (+Rs 3.0/t); 600 kW about 10 months (+Rs 48.7/t). A solar plant should start in receipt-only mode unless it is at the large end.

**Scale-up pathway**
1. **Pilot:** 3-5 foundries above about 300 t/month in a cluster such as Belgaum or Kolhapur (BEE publishes a best-operating-practices guide for Belgaum and a foundry-sector energy mapping covering both; SIDBI has a Kolhapur cluster profile). Each runs the 30-heat calibration, is classified into a regime, then runs the plan against its own baseline. Success measures: kWh/t and late minutes against the plant's history, and receipt error against a reference meter.
2. **Funded rollout:** a cluster association or ESCO partner finances meters and recovers cost from savings or a subscription; plants in the unfavourable regime stay on receipt-only terms.
3. **Replication:** other foundry clusters, then other furnace-heavy SME segments. The meter, ledger and receipt carry over; the planner needs a model per process, and there is no evidence yet beyond induction foundries.

## 9. Deliverables
Write-up (this document); architecture, data schema and wireframes (dashboard, operator screen, receipt, live heat view) on the design canvas; simulation, sensitivity, guardrails and solar scenarios (`heatledger_sim.py`, `heatledger_results.json`, four charts).

## 10. Limits and open items
- Results are synthetic; the operator baseline, grade rules, holding power, overhead and solar profile are assumptions.
- Quality is covered for grade mixing and holding time only.
- Field evidence (foundry-reported, anonymised, unaudited; one plant, 14 heats): a 500 kg induction foundry reports 12-14 heats a day and 600-700 kWh/t, and its shift log of 14 consecutive heats averages 663 kWh/t (range 610-782). The raw notes are withheld to protect the foundry's anonymity. The log does not validate the simulator, whose heats average over 1 t.
- Open items: a formal hardware quote (public list prices only so far), a longer foundry log with monthly production confirmed, and the HS codes of target castings for CBAM scope.
- The receipt is data for a verifier, not a verified report.
