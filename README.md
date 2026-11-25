# pump-fun-sharpe-sprint

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![make.fun rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/a5044673838-gif/pump-fun-sharpe-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![make.fun reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/a5044673838-gif/pump-fun-sharpe-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A dip-buying scalper for make.fun's Pump.fun Sharpe Sprint bounty. It buys
only curves 25–45% off their recent high while buyers are stepping back in,
sizes small (0.10 SOL first buy, 0.30 SOL max per mint), cuts losers fast with
a tight 3% stop, and lets the rare bounce run to a wide 30% take profit. Sharpe
(hourly) rewards steady small wins, not one lucky moonshot — so the bot is
built for small, repeatable gains across many coins, with probe round trips
keeping the 20-mint guardrail met on quiet stretches.

Paper trading only: the replay uses market data, never real funds. No real
money, no real trades, no API keys.

## Run it

Requires Node 22.18 or later (the grader runs Node 22.23.4).

```sh
node main.ts
```

The entry point is `main.ts` at the repository root. It runs through the
vendored SDK shim in `vendor/makefun-bot.ts` (a copy of the kit's
`sdk/ts/makefun-bot.ts`) and speaks the `agent-fun/replay/v2` protocol over
stdio, exactly as the grader drives it. Grade it locally with the kit:

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver docker
```

## Strategy

- Entry: curve at least 200 slots old, real SOL between 3 and 80, price
  25–45% below its 2500-slot high, at least 3 of the last 6 trades buys with
  non-negative net flow, and the most recent trade a buy.
- Sizing: 0.10 SOL first buy, one 0.10 SOL pyramid add when the price steps up
  5% and inflow persists, 0.30 SOL max per mint, 3 SOL max exposure, at most
  5 open positions.
- Exits: +30% take profit, −3% stop loss, 12% trailing stop armed at +4%,
  exit on fading flow or a single >= 5 SOL sell, 1500-slot max hold.
- Guardrail: 0.01 SOL probe round trips when fills or distinct coins lag the
  pace toward 30 coins / 150 fills over 6 hours.
- Deterministic: a pure function of the batches the harness sends — no clock,
  no randomness, no I/O — so two runs produce byte-identical action logs.
