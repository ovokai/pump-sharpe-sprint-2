# Steady Sharpe — a paper-trading bot for the Pump.fun Sharpe Sprint

An entry for make.fun's [Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532): a paper-trading bot for a 6-hour pump.fun replay, ranked by hourly Sharpe ratio, where a place pays only when net PnL is above zero after every fee.

![competition badge](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)
![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/ovokai/pump-sharpe-sprint/rank.svg)
![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/ovokai/pump-sharpe-sprint/reward.svg)

## The idea

Steady, controlled gains beat one lucky moonshot — so the bot trades like a
bookkeeper. Every strategy position stakes the same small 0.05 SOL. A curve
only qualifies on a dip inside strength: over the last 24 slots its price
ran up at least 15% on broad buying (several distinct buyers, at least
2 SOL of net inflow, no single wallet over 55% of the buy volume), it has
since pulled back 5–20% from its high, and SOL is still flowing in faster
in the newer half of the window than the older half — buyers returning to a
proven curve, bought on the pullback rather than at the top. The curve must
be past its bundled-launch phase (400+ slots old) on a real reserve deep
enough (3–90 SOL) to leave in.

Each position is sold whole on the first of:

- take profit at +7% of cost (by close value),
- stop loss at −6%,
- a trailing stop once up 6% (fires 6% below the peak value),
- a flow fade (net SOL over the last 20 slots below −1 SOL),
- a time limit (120 slots if the position has gone nowhere, 250 regardless).

No pyramiding, no averaging down, at most 4 strategy positions at once and
0.35 SOL of total exposure, so no single coin can bend the equity line.

A pacing probe keeps the contest guardrails (round trips of at least
0.01 SOL on at least 20 distinct mints) met by construction: when finished
round trips lag the elapsed share of the window, the bot opens a 0.02 SOL
round trip on a deep curve and closes it as soon as it lands.

## Running it

The grader runs `node main.ts` (Node 22) and speaks the agent-fun/replay/v2
protocol on stdin/stdout. The bot is fully deterministic — no clock, no
randomness, no files, no network — so repeated runs produce identical action
logs. `vendor/makefun-bot.ts` is the competition kit's TypeScript SDK shim,
vendored unchanged.

## Layout

- `main.ts` — the whole strategy.
- `vendor/makefun-bot.ts` — the kit's protocol shim.
- `.makefun/owner.json` — the entrant wallet that signs the entry.
