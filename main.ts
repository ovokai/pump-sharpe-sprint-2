// Steady Sharpe bot for the pump.fun paper replay (agent-fun/replay/v2).
//
// The contest ranks by hourly Sharpe, and a place pays only when net PnL is
// above zero after every fee. So this bot trades like a bookkeeper, not a
// gambler: it stakes the same small amount on every position, only enters a
// curve that has already run up on broad buying and then pulled back a
// little while SOL kept flowing in — a dip inside strength, bought when
// buyers return rather than at the top — and exits on the first of a fixed
// take profit, a fixed stop loss, a trailing stop, a flow fade, or a short
// time limit. No pyramiding, no averaging down, no hero trades: small,
// similar, short-lived round trips are what keep the equity line smooth.
//
// Guardrails shape the run: at most 5 open positions (this bot uses 4 for
// strategy positions and keeps the fifth slot for pacing probes), at least
// 20 distinct mints with a round trip of at least 0.01 SOL, and a maximum
// drawdown of 50%. A pacing probe watches the count of finished round trips
// against the share of the window that has elapsed in block time and, when
// the count lags, opens a small round trip on a deep curve and closes it as
// soon as it lands, so the minimum-mints bar is met by construction rather
// than by luck.
//
// Everything is decided from the batch stream alone: no clock, no
// randomness, no files, no network, so the two grading runs agree byte for
// byte. Prices are the virtual-reserve ratio of each trade; a position's
// close value is what selling its tokens into the latest reserves would
// return after the curve fee, less one transaction fee.

import { runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const SOL = 1e9;
const CURVE_FEE = 0.0125; // protocol + creator, near enough for value estimates

// ---- entry signal -----------------------------------------------------------
const TAPE_WINDOW = 24; // slots of tape the entry signal reads
const MIN_AGE_SLOTS = 400; // fresh curves are mostly bundled launches
const MIN_RESERVE_SOL = 3; // below this the exit is too thin to trust
const MAX_RESERVE_SOL = 90; // above this the move has usually already happened
const MIN_WINDOW_BUYS = 5;
const MIN_WINDOW_BUYERS = 4;
const MIN_NET_INFLOW_SOL = 2;
const MIN_ACCEL = 0.8; // second-half net inflow vs first-half
const MAX_TOP_BUYER_SHARE = 0.55;

// ---- sizing -----------------------------------------------------------------
const STAKE_SOL = 0.05; // one size for every strategy position
const MAX_MAIN_POSITIONS = 4; // the fifth slot stays free for probes
const MAX_EXPOSURE_SOL = 0.35; // total SOL at cost across strategy positions
const MIN_BUY_SOL = 0.02;
const BUY_SLIPPAGE_BPS = 1200;
const SELL_SLIPPAGE_BPS = 10_000;

// ---- exits ------------------------------------------------------------------
const TAKE_PROFIT = 0.07; // close value over cost
const STOP_LOSS = 0.06; // close value under cost
const TRAIL_ARM = 0.06; // trailing stop arms at this gain
const TRAIL_DROP = 0.06; // and fires this far below the peak value
const FADE_WINDOW = 20; // slots of tape for the flow fade
const FADE_NET_SOL = -1; // exit when net flow over the fade window is below this
const DEAD_SLOTS = 120; // exit a position that has gone nowhere by here
const DEAD_GAIN = 0.02; // "nowhere" means up less than this
const MAX_HOLD_SLOTS = 250; // hard time limit whatever the value
const COOLDOWN_SLOTS = 250; // after an exit before the same curve may re-enter
const MAX_ENTRIES_PER_MINT = 2;

// ---- guardrail pacing ---------------------------------------------------------
const TARGET_ROUND_TRIP_MINTS = 26; // the bar is 20; aim past it
const PACE_SECONDS = 21_600; // the final window is 6 hours of block time
const PROBE_SOL = 0.02; // above the 0.01 SOL round-trip minimum
const PROBE_MIN_RESERVE_SOL = 8; // probes only on curves deep enough to leave at once

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  createdSlot: number | null;
  trades: TapeTrade[];
  entries: number;
  lastExitSlot: number;
}

interface Open {
  openedSlot: number;
  peakValue: number;
  exiting: boolean;
  filled: boolean;
}

const tapes = new Map<Pubkey, Tape>();
const open = new Map<Pubkey, Open>();
/** Probe round trips in flight, by mint: whether the probe buy has landed. */
const probes = new Map<Pubkey, boolean>();
const roundTripped = new Set<Pubkey>();
let firstBlockTime: number | null = null;
let lastBlockTime: number | null = null;

const KEEP_SLOTS = Math.max(TAPE_WINDOW, FADE_WINDOW) + 10;

function tapeOf(mint: Pubkey): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { createdSlot: null, trades: [], entries: 0, lastExitSlot: -1_000_000_000 };
    tapes.set(mint, t);
  }
  return t;
}

/** Net SOL (buys minus sells) a tape recorded over the last `w` slots. */
function netFlow(t: Tape, now: number, w: number): number {
  let net = 0;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i]!;
    if (tr.slot <= now - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

/** Whether a curve's tape shows a dip inside strength, buyers returning. */
function entrySignal(t: Tape, now: number, reserveSol: number): boolean {
  if (reserveSol < MIN_RESERVE_SOL || reserveSol > MAX_RESERVE_SOL) return false;
  if (t.createdSlot === null || now - t.createdSlot < MIN_AGE_SLOTS) return false;
  const from = now - TAPE_WINDOW;
  const mid = now - TAPE_WINDOW / 2;
  let buys = 0;
  let buySol = 0;
  let sellSol = 0;
  let netEarly = 0;
  let netLate = 0;
  let startPrice = -1;
  let high = 0;
  let last = 0;
  const perBuyer = new Map<string, number>();
  for (const tr of t.trades) {
    if (tr.slot <= from) {
      startPrice = tr.price;
      continue;
    }
    if (startPrice < 0) startPrice = tr.price;
    const signed = tr.buy ? tr.sol : -tr.sol;
    if (tr.slot <= mid) netEarly += signed;
    else netLate += signed;
    if (tr.buy) {
      buys++;
      buySol += tr.sol;
      perBuyer.set(tr.user, (perBuyer.get(tr.user) ?? 0) + tr.sol);
    } else {
      sellSol += tr.sol;
    }
    if (tr.price > high) high = tr.price;
    last = tr.price;
  }
  if (startPrice <= 0 || last <= 0) return false;
  if (buys < MIN_WINDOW_BUYS || perBuyer.size < MIN_WINDOW_BUYERS) return false;
  if (buySol - sellSol < MIN_NET_INFLOW_SOL) return false;
  // Dip inside strength: the window ran up hard, the price has since pulled
  // back a little from its high, and SOL is still flowing in faster in the
  // newer half of the window than the older half — buyers are returning to a
  // proven curve rather than chasing its top.
  const runUp = high / startPrice - 1;
  if (runUp < 0.15) return false;
  const pullback = 1 - last / high;
  if (pullback < 0.05 || pullback > 0.2) return false;
  if (netLate <= 0 || netLate < MIN_ACCEL * netEarly) return false;
  let top = 0;
  for (const v of perBuyer.values()) if (v > top) top = v;
  if (top > MAX_TOP_BUYER_SHARE * buySol) return false;
  return true;
}

/** What selling `tokens` into the given reserves returns, in SOL, after fees. */
function closeValueSol(tokens: bigint, virtualQuote: bigint, virtualTokens: bigint, txFeeSol: number): number {
  const t = Number(tokens);
  const out = (t * Number(virtualQuote)) / (Number(virtualTokens) + t) / SOL;
  return out * (1 - CURVE_FEE) - txFeeSol;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const caps = state.hello.caps;
    const txFeeSol = Number(state.txFeeLamports()) / SOL;
    const traded = new Set<Pubkey>();

    // Fold the batch into the tapes.
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstBlockTime === null) firstBlockTime = e.block_time;
        if (lastBlockTime === null || e.block_time > lastBlockTime) lastBlockTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        tapeOf(e.mint).createdSlot = e.slot;
      } else if (e.event === 'TradeEvent') {
        tapeOf(e.mint).trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol: Number(e.sol_amount) / SOL,
          user: e.user,
          price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
        });
        traded.add(e.mint);
      }
    }
    for (const mint of traded) {
      const t = tapes.get(mint)!;
      let cut = 0;
      while (cut < t.trades.length && t.trades[cut]!.slot <= now - KEEP_SLOTS) cut++;
      if (cut > 0) t.trades.splice(0, cut);
    }

    const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
    const pendingMints = new Set<Pubkey>();
    const pendingSellMints = new Set<Pubkey>();
    for (const p of state.pending.values()) {
      pendingMints.add(p.order.mint);
      if (p.order.side === 'sell') pendingSellMints.add(p.order.mint);
    }
    const reservesOf = (mint: Pubkey) => {
      const mk = marks.get(mint);
      const curve = state.curves.get(mint);
      if (mk !== undefined) {
        return { vq: BigInt(mk.virtual_quote_reserves), vt: BigInt(mk.virtual_token_reserves), rq: Number(mk.real_quote_reserves) / SOL, complete: curve?.complete ?? false };
      }
      if (curve === undefined) return null;
      return { vq: curve.virtual_quote_reserves, vt: curve.virtual_token_reserves, rq: Number(curve.real_quote_reserves) / SOL, complete: curve.complete };
    };

    const orders: OrderInput[] = [];

    // Retire positions the account no longer holds: a filled one that is gone
    // counts as a finished round trip and starts the mint's cooldown.
    for (const [mint, o] of open) {
      if (state.positions.has(mint) || pendingMints.has(mint)) continue;
      open.delete(mint);
      if (o.filled) {
        roundTripped.add(mint);
        tapeOf(mint).lastExitSlot = now;
      } else {
        tapeOf(mint).entries = Math.max(0, tapeOf(mint).entries - 1);
      }
    }
    for (const [mint, landed] of probes) {
      if (state.positions.has(mint)) {
        probes.set(mint, true);
      } else if (!pendingMints.has(mint)) {
        if (landed) roundTripped.add(mint);
        probes.delete(mint);
      }
    }

    // Exits first: strategy positions.
    for (const [mint, o] of open) {
      const pos = state.positions.get(mint);
      if (pos === undefined) continue;
      o.filled = true;
      const r = reservesOf(mint);
      if (r === null || r.complete) continue; // the replay closes a completed curve itself
      const value = closeValueSol(pos.token_amount, r.vq, r.vt, txFeeSol);
      const cost = Number(pos.cost_lamports) / SOL;
      if (value > o.peakValue) o.peakValue = value;
      let exit = o.exiting;
      if (!exit && value >= cost * (1 + TAKE_PROFIT)) exit = true;
      if (!exit && value <= cost * (1 - STOP_LOSS)) exit = true;
      if (!exit && o.peakValue >= cost * (1 + TRAIL_ARM) && value <= o.peakValue * (1 - TRAIL_DROP)) exit = true;
      if (!exit && netFlow(tapeOf(mint), now, FADE_WINDOW) < FADE_NET_SOL) exit = true;
      if (!exit && now - o.openedSlot > DEAD_SLOTS && value < cost * (1 + DEAD_GAIN)) exit = true;
      if (!exit && now - o.openedSlot > MAX_HOLD_SLOTS) exit = true;
      if (!exit) continue;
      o.exiting = true;
      if (pendingSellMints.has(mint)) continue;
      if (orders.length >= caps.max_orders_per_batch) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
    }

    // Probes: sell the whole probe as soon as its buy has landed.
    for (const mint of probes.keys()) {
      const pos = state.positions.get(mint);
      if (pos === undefined) continue;
      const r = reservesOf(mint);
      if (r === null || r.complete || pendingMints.has(mint)) continue;
      if (orders.length >= caps.max_orders_per_batch) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
    }

    // Entries: one fixed stake, only on a fresh signal, only into a free slot.
    let free = Number(state.freeCashLamports()) / SOL;
    let slotsLeft = caps.max_open_positions - state.committedPositionCount();
    let exposure = 0;
    for (const mint of open.keys()) {
      const pos = state.positions.get(mint);
      if (pos !== undefined) exposure += Number(pos.cost_lamports) / SOL;
    }
    for (const mint of traded) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (slotsLeft <= 0 || open.size >= MAX_MAIN_POSITIONS) break;
      if (open.has(mint) || probes.has(mint) || pendingMints.has(mint) || state.positions.has(mint)) continue;
      const r = reservesOf(mint);
      if (r === null || r.complete) continue;
      const t = tapeOf(mint);
      if (t.entries >= MAX_ENTRIES_PER_MINT || now - t.lastExitSlot < COOLDOWN_SLOTS) continue;
      if (!entrySignal(t, now, r.rq)) continue;
      const sizeCap = Number(state.maxBuyLamports(mint)) / SOL;
      const amount = Math.min(STAKE_SOL, sizeCap, MAX_EXPOSURE_SOL - exposure);
      if (amount < MIN_BUY_SOL || amount > free - txFeeSol) continue;
      orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * SOL)), max_slippage_bps: BUY_SLIPPAGE_BPS });
      open.set(mint, { openedSlot: now, peakValue: 0, exiting: false, filled: false });
      t.entries++;
      free -= amount + txFeeSol;
      exposure += amount;
      slotsLeft--;
    }

    // Guardrail pacing: if finished round trips lag the elapsed share of the
    // window, open one small probe round trip on a deep curve.
    if (
      probes.size === 0 &&
      slotsLeft > 0 &&
      orders.length < caps.max_orders_per_batch &&
      firstBlockTime !== null &&
      lastBlockTime !== null &&
      roundTripped.size < TARGET_ROUND_TRIP_MINTS
    ) {
      const elapsedShare = Math.min(1, (lastBlockTime - firstBlockTime) / PACE_SECONDS);
      const due = Math.ceil(TARGET_ROUND_TRIP_MINTS * elapsedShare);
      if (roundTripped.size < due && free >= PROBE_SOL + 2 * txFeeSol) {
        for (const mint of traded) {
          if (open.has(mint) || probes.has(mint) || pendingMints.has(mint) || state.positions.has(mint)) continue;
          if (roundTripped.has(mint)) continue; // a probe only counts on a fresh mint
          const r = reservesOf(mint);
          if (r === null || r.complete || r.rq < PROBE_MIN_RESERVE_SOL) continue;
          if (Number(state.maxBuyLamports(mint)) / SOL < PROBE_SOL) continue;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(PROBE_SOL * SOL)), max_slippage_bps: BUY_SLIPPAGE_BPS });
          probes.set(mint, false);
          break;
        }
      }
    }

    return orders;
  },
});
