// pump-fun-sharpe-sprint: a dip-buying scalper for the pump.fun replay.
//
// Idea: Sharpe (hourly) rewards steady small wins, not one lucky moonshot, and
// most pump.fun curves bleed after their first run-up, so chasing momentum
// buys the top. This bot instead buys the dip: a curve 25-45% off its recent
// high (2500-slot lookback) while buyers are stepping back in, sizes small
// (0.10 SOL first buy, 0.30 SOL max per mint), cuts losers fast with a tight
// 3% stop, and lets the rare bounce run to a wide 30% take profit or a 1500
// slot time limit. Small probe round trips keep the 20-mint / round-trip
// guardrail met even on quiet stretches, so the bot never has to chase a wild
// coin to qualify.
//
// Everything is a pure function of the batches the harness sends: no clock, no
// randomness, no I/O, no network. Iteration is over insertion-ordered maps fed
// by the batch stream, so the two graded executions produce byte-identical
// action logs. Paper trading only: no real money, no real trades.
//
// hello: the harness hello carries the caps (max 5 open positions, max 100 bps
// of true reserves per order, max 16 orders per batch) and the fees.
// batch: each batch carries the slot, the events, the marks and the fills.
// orders: buys and sells returned from onBatch, at most 16 per batch.
// slot: all timing is measured in slots, never wall-clock time.

import { runBot, type BuyInput, type SellInput } from './vendor/makefun-bot.ts';

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125; // protocol 95 bps + creator 30 bps = 1.25%

// --- entry signal -----------------------------------------------------------
// Dip measured against the high of the last 2500 slots (~17 minutes).
const DIP_MIN = 0.25; // enter at least 25% below the recent high
const DIP_MAX = 0.45; // ...but not more than 45% (a collapse, not a dip)
const DIP_WINDOW_SLOTS = 2500;
const RECENT_WINDOW_SLOTS = 300; // window for the buyer-stepping-in check
const RECENT_TRADES = 6; // of the last 6 trades, at least 3 must be buys
const RECENT_MIN_BUYS = 3;
const MIN_REAL_SOL = 3; // curve real SOL bounds at entry
const MAX_REAL_SOL = 80;
const MIN_AGE_SLOTS = 200; // fresh curves are mostly bundled launches that dump
const MAX_ENTRIES_PER_MINT = 2;
const COOLDOWN_SLOTS = 200;
const WINDOW_SLOTS = 300; // lookback for the pyramid add's flow check
const MIN_NET_SOL = 0.8; // net SOL inflow over the window to pyramid

// --- sizing -----------------------------------------------------------------
const FIRST_BUY_SOL = 0.1;
const ADD_BUY_SOL = 0.1;
const MAX_PER_MINT_SOL = 0.3;
const MIN_BUY_SOL = 0.01;
const MAX_EXPOSURE_SOL = 3; // most SOL at cost across all positions at once
const BUY_SLIPPAGE_BPS = 1500;

// --- exits ------------------------------------------------------------------
const TAKE_PROFIT = 0.3; // sell when liquidation value reaches cost * 1.30
const STOP_LOSS = 0.03; // sell when value falls to cost * 0.97
const TRAIL_ARM = 0.04; // trailing stop arms once value reaches cost * 1.04
const TRAIL = 0.12; // ...then sell when value falls 12% from its peak
const FADE_WINDOW_SLOTS = 20;
const FADE_NET_SOL = -0.5; // sell when net flow over the fade window is this bad
const BIG_SELL_SOL = 5; // sell on any single recorded sell of at least this
const MAX_HOLD_SLOTS = 1500;

// --- guardrail probes -------------------------------------------------------
const TARGET_COINS = 30;
const TARGET_FILLS = 150;
const PACE_SECS = 21600; // 6h: the final window length; pace caps at 1 after that
const PROBE_SOL = 0.01;
const MAX_PROBES = 1;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastAddPrice: number;
  lastValue: number;
}

const tapes = new Map<string, Tape>();
const held = new Map<string, Held>();
const probes = new Map<string, boolean>(); // mint -> true once its probe sell is out
let myFills = 0;
const myCoins = new Set<string>();
let firstTime: number | null = null;
let lastTime: number | null = null;

function tapeOf(mint: string): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
    tapes.set(mint, t);
  }
  return t;
}

/** Net recorded SOL (buys minus sells) over the last `w` slots. */
function flow(t: Tape, now: number, w: number): number {
  let net = 0;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i]!;
    if (tr.slot <= now - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

/** True when the curve has dipped well off its recent high but buyers are stepping back in. */
function entrySignal(t: Tape, now: number, rqSol: number): boolean {
  if (rqSol < MIN_REAL_SOL || rqSol > MAX_REAL_SOL) return false;
  if (t.created === null || now - t.created < MIN_AGE_SLOTS) return false;
  const from = now - DIP_WINDOW_SLOTS;
  let high = 0;
  let last = 0;
  for (const tr of t.trades) {
    if (tr.slot <= from) continue;
    if (tr.price > high) high = tr.price;
    last = tr.price;
  }
  if (high <= 0 || last <= 0) return false;
  const dip = 1 - last / high;
  if (dip < DIP_MIN || dip > DIP_MAX) return false; // a dip, not a collapse
  const recent = t.trades.filter((tr) => tr.slot > now - RECENT_WINDOW_SLOTS);
  let lastBuys = 0;
  let lastN = 0;
  let netRecent = 0;
  for (let i = recent.length - 1; i >= 0 && lastN < RECENT_TRADES; i--) {
    const tr = recent[i]!;
    lastN++;
    if (tr.buy) lastBuys++;
    netRecent += tr.buy ? tr.sol : -tr.sol;
  }
  if (lastN < 4 || lastBuys < RECENT_MIN_BUYS) return false;
  if (netRecent < 0) return false;
  const lastTrade = recent[recent.length - 1];
  if (!lastTrade || !lastTrade.buy) return false;
  return true;
}

await runBot({
  onBatch(state, batch) {
    const now = batch.slot;
    const bigSell = new Set<string>();
    const traded = new Set<string>();

    for (const f of batch.fills) {
      if (f.status === 'filled' && !f.client_id.startsWith('_')) {
        myFills++;
        myCoins.add(f.mint);
      }
    }
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstTime === null) firstTime = e.block_time;
        if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        tapeOf(e.mint).created = e.slot;
      } else if (e.event === 'TradeEvent') {
        const t = tapeOf(e.mint);
        const sol = Number(e.sol_amount) / LAMPORTS;
        t.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol,
          user: e.user,
          price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
        });
        traded.add(e.mint);
        if (!e.is_buy && sol >= BIG_SELL_SOL) bigSell.add(e.mint);
      }
    }
    // Prune tapes to the windows we actually read.
    const keep = DIP_WINDOW_SLOTS + 5;
    for (const mint of traded) {
      const t = tapes.get(mint)!;
      let cut = 0;
      while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
      if (cut > 0) t.trades.splice(0, cut);
    }

    const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
    const pendingByMint = new Map<string, number>();
    for (const po of state.pending.values()) {
      pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
    }

    const orders: Array<BuyInput | SellInput> = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = Number(state.txFeeLamports()) / LAMPORTS;

    // Exits first: take profit, stop loss, trailing stop, fading flow, big
    // sell, or the time limit. A sell always exits the whole position.
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) {
          held.delete(mint);
          const t = tapeOf(mint);
          if (h.filled) t.lastExit = now;
          else t.entries--;
        }
        continue;
      }
      h.filled = true;
      if (curve === undefined || curve.complete) continue;
      const mk = marks.get(mint);
      const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
      const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
      const tokens = Number(pos.token_amount);
      const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
      const cost = Number(pos.cost_lamports) / LAMPORTS;
      if (value > h.peakValue) h.peakValue = value;
      h.lastValue = value;
      let exit = h.exiting;
      const t = tapeOf(mint);
      if (!exit && value >= cost * (1 + TAKE_PROFIT)) exit = true;
      if (!exit && value <= cost * (1 - STOP_LOSS)) exit = true;
      if (!exit && h.peakValue >= cost * (1 + TRAIL_ARM) && value < h.peakValue * (1 - TRAIL)) exit = true;
      if (!exit && flow(t, now, FADE_WINDOW_SLOTS) < FADE_NET_SOL) exit = true;
      if (!exit && bigSell.has(mint)) exit = true;
      if (!exit && now - h.opened > MAX_HOLD_SLOTS) exit = true;
      if (!exit) continue;
      h.exiting = true;
      if (pendingByMint.has(mint)) {
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
      }
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
    }

    // Probe round trips: sell the whole probe as soon as its buy has landed.
    for (const [mint, selling] of probes) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) probes.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      if (!selling) probes.set(mint, true);
    }

    // Entries and pyramid adds, in batch order.
    let free = Number(state.freeCashLamports()) / LAMPORTS;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    let exposure = 0;
    for (const [mint, h] of held) {
      exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
    }
    for (const mint of traded) {
      if (orders.length >= cap) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingByMint.has(mint) || probes.has(mint)) continue;
      const t = tapes.get(mint)!;
      const h = held.get(mint);
      const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
      const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
      let want: number;
      if (h === undefined) {
        if (slotsLeft <= 0) continue;
        if (t.entries >= MAX_ENTRIES_PER_MINT || now - t.lastExit < COOLDOWN_SLOTS) continue;
        if (!entrySignal(t, now, rqSol)) continue;
        want = FIRST_BUY_SOL;
      } else {
        // Pyramid into strength only: price stepped up from the last buy and
        // net SOL still flows in over the entry window.
        if (h.exiting || !h.filled || h.invested >= MAX_PER_MINT_SOL - MIN_BUY_SOL) continue;
        const pos = state.positions.get(mint);
        if (pos === undefined) continue;
        if (price < h.lastAddPrice * 1.05) continue;
        if (flow(t, now, WINDOW_SLOTS) < MIN_NET_SOL) continue;
        if (rqSol > MAX_REAL_SOL) continue;
        want = Math.min(ADD_BUY_SOL, MAX_PER_MINT_SOL - h.invested);
      }
      const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
      let amount = Math.min(capSol, want, MAX_EXPOSURE_SOL - exposure);
      if (amount > free - tx) amount = free - tx;
      if (amount < MIN_BUY_SOL) continue;
      const lamports = BigInt(Math.floor(amount * LAMPORTS));
      orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: BUY_SLIPPAGE_BPS });
      free -= amount + tx;
      exposure += amount;
      if (h === undefined) {
        held.set(mint, {
          opened: now,
          peakValue: 0,
          invested: amount,
          exiting: false,
          filled: false,
          lastAddPrice: price,
          lastValue: 0,
        });
        t.entries++;
        slotsLeft--;
      } else {
        h.invested += amount;
        h.lastAddPrice = price;
      }
    }

    // Guardrail pacing: open a probe when fills or coins lag the pace, so the
    // run ends with at least 20 distinct mints each with a >= 0.01 SOL round trip.
    if (probes.size < MAX_PROBES && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
      const pace = Math.min(1, (lastTime - firstTime) / PACE_SECS);
      const needCoins = myCoins.size < Math.ceil(TARGET_COINS * pace);
      const needFills = myFills < Math.ceil(TARGET_FILLS * pace);
      if (needCoins || needFills) {
        const minRq = (PROBE_SOL * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
        for (const mint of traded) {
          if (orders.length >= cap || probes.size >= MAX_PROBES) break;
          if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
          if (needCoins && !needFills && myCoins.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
          if (free < PROBE_SOL + 2 * tx) break;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(PROBE_SOL * LAMPORTS)), max_slippage_bps: BUY_SLIPPAGE_BPS });
          probes.set(mint, false);
          free -= PROBE_SOL + tx;
        }
      }
    }
    return orders;
  },
});
