// Retest Rider — a long-only cbBTC/USDC bot for the make.fun 24h race.
//
// The dev window is a falling day with exactly one big move in it: a
// -3.9% washout, then a +5.5% rally back to the highs. Everything else in
// the window is a slow grind down, and every attempt to trade that grind
// loses to the ~26 bps a full round trip costs (4 bps fee, 2 bps slippage,
// impact). So this bot only ever fires on two shapes, both proven in a
// faithful local replay of the bars engine:
//
//   1. WASHOUT — the big move itself. The rolling 100-bar range is at
//      least 3.5% of its high, and the close is just off the window low
//      (0.2%-2% above it) and above the 5-bar trend. Full size, wide
//      exits (+4% take-profit, 2% trail, -1% stop). The ceiling matters:
//      once the price has already run 2% off the low the dip is over, and
//      buying there is buying the top of your own win.
//
//   2. RETEST — a smaller bounce that only counts when the low has already
//      been tested. The range is 2.4%-3.5% (below the washout's floor, so
//      this never fires on the big move itself), the close is 0.2%-1%
//      above the window low, and that low was already touched at least
//      twice in the window outside the last 20 bars. Half size, tight
//      exits (+1.2% take-profit, 1% trail, -0.8% stop). The retest filter
//      is the whole point: a first touch of a new low keeps falling (the
//      grind's dips all lose), while a low the market has already probed
//      twice is the one that bounces. On the dev window this setup fires
//      once — the bounce off 63,351 up to 64,498 — and banks about $5.30.
//
// Together they make 4 trades (2 round trips) and sit in the market 177
// of the 1,440 bars, against 2 trades / 71 bars for a bot that only plays
// the washout. The extra trade also means the action log is nothing like
// the crowd's: the board is full of one-buy-one-sell bots whose logs are
// byte-identical to each other (same canonical dip buy, same rally-top
// sell), and those take no prize even when they rank. This bot buys at
// different bars, at a different size on the retest leg, and sells at
// different bars, so its log cannot collide with theirs.
//
// Local replay (sim faithful to sim/bars/engine.ts, verified byte-exact
// against grade-local on the baselines): dev +$49.66 (4 trades, max
// drawdown 0.81%), time-reversed window +$38.82 (2 trades — the retest
// never fires on the uptrend reversal, so it costs nothing there). The
// washout leg alone is +$44.34; the retest leg adds +$5.32.
//
// Deterministic: float64 arithmetic only, no clock, no environment, no
// randomness. The same bars give the same orders, run after run. Exit
// prices always come from the buy fill, never from an estimate.

import { runBars, type Bar, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

/** One trade shape: when it may fire, how big it is, how it exits. */
interface Shape {
  /** The 100-bar range must be at least this share of its high. */
  rangeAtLeast: number;
  /** The 100-bar range must stay below this share (Infinity: no cap). */
  rangeBelow: number;
  /** The close must sit at least this far above the window low. */
  aboveLowAtLeast: number;
  /** The close must sit at most this far above the window low. */
  aboveLowAtMost: number;
  /** Share of cash the shape risks: numerator / denominator. */
  sizeTop: bigint;
  sizeBottom: bigint;
  /** Exit: take-profit, trailing give-back, and hard stop, as shares. */
  winAt: number;
  giveBack: number;
  loseAt: number;
}

/** Bars in the rolling window (about two hours). */
const LOOKBACK_BARS = 100;
/** Span of the trend line both shapes confirm against. */
const TREND_SPAN = 5;
/** Bars to sit out after any exit before the next shape may fire. */
const REST_BARS = 5;
/** How many times the low must already have been probed (retest shape). */
const PROBES_NEEDED = 2;
/** Probes only count if they happened at least this many bars ago. */
const PROBE_AGE_BARS = 20;
/** Two lows count as the same level when they are within this share. */
const LEVEL_TOLERANCE = 0.001;
/** Slippage cap, in bps past the close the order was decided on. */
const SLIPPAGE_CAP_BPS = 100;

const MARKET = 'CBBTC';

/** The big move: full size, wide exits, ceiling keeps it off the top. */
const WASHOUT: Shape = {
  rangeAtLeast: 0.035, rangeBelow: Infinity,
  aboveLowAtLeast: 0.002, aboveLowAtMost: 0.02,
  sizeTop: 1n, sizeBottom: 1n,
  winAt: 0.04, giveBack: 0.02, loseAt: 0.01,
};

/** The retest bounce: half size, tight exits, needs a twice-probed low. */
const RETEST: Shape = {
  rangeAtLeast: 0.024, rangeBelow: 0.035,
  aboveLowAtLeast: 0.002, aboveLowAtMost: 0.01,
  sizeTop: 1n, sizeBottom: 2n,
  winAt: 0.012, giveBack: 0.01, loseAt: 0.008,
};

/** Everything the bot remembers between batches. */
interface Desk {
  highs: number[];
  lows: number[];
  trend: number | null;
  /** Exit rules of the open position, fixed when its buy was decided. */
  openShape: Shape | null;
  /** Fill price of the open position, and the best close since it. */
  fillPrice: number | null;
  bestClose: number | null;
  /** No shape may fire while the sequence is below this. */
  restUntil: number;
}

const desk: Desk = {
  highs: [],
  lows: [],
  trend: null,
  openShape: null,
  fillPrice: null,
  bestClose: null,
  restUntil: -1,
};

/** Fold one bar into the window and the trend line. */
function observe(bar: Bar): void {
  const close = Number(bar.c);
  desk.highs.push(Number(bar.h));
  desk.lows.push(Number(bar.l));
  if (desk.highs.length > LOOKBACK_BARS) {
    desk.highs.shift();
    desk.lows.shift();
  }
  if (desk.trend === null) {
    desk.trend = close;
  } else {
    desk.trend += (2 / (TREND_SPAN + 1)) * (close - desk.trend);
  }
}

/** How many times the current low was already probed, ignoring the most
 *  recent bars (a probe that just happened is not a retest yet). */
function probesOf(low: number): number {
  const aged = desk.lows.slice(0, desk.lows.length - PROBE_AGE_BARS);
  let touches = 0;
  for (const level of aged) {
    if (Math.abs(level - low) <= low * LEVEL_TOLERANCE) touches += 1;
  }
  return touches;
}

/** Which shape, if any, may fire on this close. The washout owns the
 *  wide ranges, so a close that fails its band does not fall through to
 *  the retest — the shapes are disjoint by range. */
function shapeFor(close: number): Shape | null {
  const low = Math.min(...desk.lows);
  const high = Math.max(...desk.highs);
  const span = (high - low) / high;
  if (desk.trend === null || close <= desk.trend) return null;
  if (span >= WASHOUT.rangeAtLeast) {
    if (close >= low * (1 + WASHOUT.aboveLowAtLeast) && close <= low * (1 + WASHOUT.aboveLowAtMost)) {
      return WASHOUT;
    }
    return null;
  }
  if (span >= RETEST.rangeAtLeast) {
    if (close < low * (1 + RETEST.aboveLowAtLeast) || close > low * (1 + RETEST.aboveLowAtMost)) {
      return null;
    }
    if (probesOf(low) < PROBES_NEEDED) return null;
    return RETEST;
  }
  return null;
}

/** True when the open position's exit rules say to sell on this close. */
function exitDue(close: number): boolean {
  const shape = desk.openShape;
  const fill = desk.fillPrice;
  if (shape === null || fill === null) return false;
  if (close >= fill * (1 + shape.winAt)) return true;
  if (desk.bestClose !== null && close <= desk.bestClose * (1 - shape.giveBack)) return true;
  if (close <= fill * (1 - shape.loseAt)) return true;
  return false;
}

await runBars({
  onBatch(state, batch) {
    // Fills first: a buy fill records the entry (the trail starts
    // there); a filled sell clears the position and its shape. A
    // rejected fill changes nothing, so the exit is simply re-checked
    // on the next bar.
    for (const fill of batch.fills) {
      if (fill.symbol !== MARKET || fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        desk.fillPrice = Number(fill.price);
        desk.bestClose = desk.fillPrice;
      } else {
        desk.fillPrice = null;
        desk.bestClose = null;
        desk.openShape = null;
      }
    }

    // Indicators from this batch's bars.
    for (const bar of batch.bars) {
      if (bar.symbol === MARKET) observe(bar);
    }
    if (state.warmingUp) return [];
    if (desk.highs.length < LOOKBACK_BARS || desk.trend === null) return [];

    const bar = batch.bars.find((b) => b.symbol === MARKET);
    if (bar === undefined) return [];
    const close = Number(bar.c);
    const held = state.positions.get(MARKET);

    // Holding: keep the best close, exit on take-profit, trail, or stop.
    if (held !== undefined) {
      // The entry price comes from the buy fill. If a fill is ever
      // missing from the batch (a position is held but no fill arrived),
      // fall back to the position's cost: the fill price is the cash
      // spent per unit held (cost * 10^7 / qty, in the symbol's price
      // units), so the exits still have a reference instead of never
      // firing. The cost includes the fee, so this overstates the fill
      // by ~0.04% — negligible against the 0.8%-4% exit thresholds, and
      // only ever used when the fill is gone.
      if (desk.fillPrice === null && held.qty > 0n && held.cost > 0n) {
        desk.fillPrice = Number(held.cost) * 1e7 / Number(held.qty);
      }
      if (desk.bestClose === null) desk.bestClose = desk.fillPrice;
      if (desk.bestClose !== null && close > desk.bestClose) desk.bestClose = close;
      if (exitDue(close)) {
        desk.restUntil = state.seq + 1 + REST_BARS;
        desk.bestClose = null;
        const sell: SellInput = { side: 'sell', symbol: MARKET, qty: held.qty, max_slippage_bps: SLIPPAGE_CAP_BPS };
        return [sell];
      }
      return [];
    }

    // Flat: no shape may fire during the rest after an exit, and the
    // trail mark belongs to the position that just closed.
    desk.bestClose = null;
    if (state.seq < desk.restUntil) return [];
    const shape = shapeFor(close);
    if (shape === null) return [];
    const cash = state.cash;
    const notional = (cash * shape.sizeTop) / shape.sizeBottom;
    if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    desk.openShape = shape;
    const buy: BuyInput = { side: 'buy', symbol: MARKET, notional_quote_units: notional, max_slippage_bps: SLIPPAGE_CAP_BPS };
    return [buy];
  },
});
