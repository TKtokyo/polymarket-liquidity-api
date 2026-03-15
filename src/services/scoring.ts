import type {
  CLOBOrderbook,
  LiquidityMetrics,
  LiquidityRating,
  LiquidityRatingResult,
  FillProbability,
  SlippageEstimate,
} from "../types/index.js";

const FILL_TIERS = [100, 1000, 10000];

/**
 * Calculate all 4 liquidity metrics + composite rating for an orderbook.
 * Deterministic, no external dependencies.
 */
export function calculateLiquidityRating(
  book: CLOBOrderbook,
): LiquidityRatingResult {
  const factors: string[] = [];

  const bids = parseLevels(book.bids);
  const asks = parseLevels(book.asks);
  const tickSize = parseFloat(book.tick_size) || 0.01;

  // Sort: bids high->low, asks low->high
  bids.sort((a, b) => b.price - a.price);
  asks.sort((a, b) => a.price - b.price);

  const bestBid = bids.length > 0 ? bids[0].price : 0;
  const bestAsk = asks.length > 0 ? asks[0].price : 0;
  const midpoint =
    bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : 0;

  // --- Metric 1: spread_score (0-100) ---
  const spreadScore = calcSpreadScore(bestBid, bestAsk, tickSize, factors);

  // --- Metric 2: depth_imbalance (-1 to +1) ---
  const depthImbalance = calcDepthImbalance(bids, asks, factors);

  // --- Metric 3: fill_probability ---
  const fillProbability = calcFillProbability(bids, asks);

  // --- Metric 4: slippage_estimate ---
  const slippageEstimate = calcSlippageEstimate(bids, asks, midpoint);

  const metrics: LiquidityMetrics = {
    spread_score: spreadScore,
    depth_imbalance: Math.round(depthImbalance * 10000) / 10000,
    fill_probability: fillProbability,
    slippage_estimate: slippageEstimate,
  };

  // --- Composite rating ---
  const rating = calcCompositeRating(spreadScore, depthImbalance, fillProbability, factors);

  return { rating, metrics, factors };
}

// --- Internal helpers ---

interface Level {
  price: number;
  size: number;
}

function parseLevels(levels: Array<{ price: string; size: string }>): Level[] {
  return levels
    .map((l) => ({
      price: parseFloat(l.price),
      size: parseFloat(l.size),
    }))
    .filter((l) => !isNaN(l.price) && !isNaN(l.size) && l.price > 0 && l.size > 0);
}

/**
 * Spread score: 100 = 1 tick, decays as spread widens.
 */
function calcSpreadScore(
  bestBid: number,
  bestAsk: number,
  tickSize: number,
  factors: string[],
): number {
  if (bestBid <= 0 || bestAsk <= 0 || tickSize <= 0) {
    factors.push("No active orderbook (missing bids or asks).");
    return 0;
  }

  const spread = bestAsk - bestBid;
  if (spread <= 0) {
    factors.push("Crossed book (bestAsk <= bestBid).");
    return 0;
  }

  const spreadTicks = spread / tickSize;

  if (spreadTicks <= 1) return 100;
  if (spreadTicks <= 2) return 90;
  if (spreadTicks <= 5) return 70;
  if (spreadTicks <= 10) return 50;
  if (spreadTicks <= 20) return 25;

  const score = Math.max(0, Math.round(100 - spreadTicks * 5));

  if (spreadTicks > 10) {
    factors.push(`Wide spread: ${Math.round(spreadTicks)} ticks.`);
  }

  return score;
}

/**
 * Depth imbalance: dollar-denominated bid vs ask depth.
 * +1 = all bids, -1 = all asks, 0 = balanced.
 */
function calcDepthImbalance(
  bids: Level[],
  asks: Level[],
  factors: string[],
): number {
  const bidDepth = bids.reduce((sum, l) => sum + l.price * l.size, 0);
  const askDepth = asks.reduce((sum, l) => sum + l.price * l.size, 0);

  const total = bidDepth + askDepth;
  if (total === 0) return 0;

  const imbalance = (bidDepth - askDepth) / total;

  if (Math.abs(imbalance) > 0.5) {
    const side = imbalance > 0 ? "bid" : "ask";
    factors.push(`Strong ${side}-side depth imbalance (${(imbalance * 100).toFixed(1)}%).`);
  }

  return imbalance;
}

/**
 * Fill probability for each tier: fraction of tier amount coverable by cumulative depth.
 */
function calcFillProbability(
  bids: Level[],
  asks: Level[],
): Record<string, FillProbability> {
  const bidCumDollars = cumulativeDollarDepth(bids);
  const askCumDollars = cumulativeDollarDepth(asks);

  const result: Record<string, FillProbability> = {};
  for (const tier of FILL_TIERS) {
    result[String(tier)] = {
      bid: Math.round(Math.min(1, bidCumDollars / tier) * 100) / 100,
      ask: Math.round(Math.min(1, askCumDollars / tier) * 100) / 100,
    };
  }
  return result;
}

function cumulativeDollarDepth(levels: Level[]): number {
  return levels.reduce((sum, l) => sum + l.price * l.size, 0);
}

/**
 * Slippage estimate: VWAP-based slippage for each tier.
 * Walks the book to calculate volume-weighted average price.
 */
function calcSlippageEstimate(
  bids: Level[],
  asks: Level[],
  midpoint: number,
): Record<string, SlippageEstimate> {
  const result: Record<string, SlippageEstimate> = {};

  for (const tier of FILL_TIERS) {
    result[String(tier)] = {
      bid: walkBookForSlippage(bids, tier, midpoint),
      ask: walkBookForSlippage(asks, tier, midpoint),
    };
  }
  return result;
}

/**
 * Walk the book level by level, consuming $tier worth of liquidity.
 * Returns |VWAP - midpoint| / midpoint, or null if insufficient depth.
 *
 * For bids: sorted high->low (best first, selling into bids).
 * For asks: sorted low->high (best first, buying into asks).
 */
function walkBookForSlippage(
  levels: Level[],
  amountDollars: number,
  midpoint: number,
): number | null {
  if (levels.length === 0 || midpoint <= 0) return null;

  let remaining = amountDollars;
  let totalUnits = 0;
  let totalSpent = 0;

  for (const level of levels) {
    const dollarAvailable = level.price * level.size;
    const dollarToConsume = Math.min(remaining, dollarAvailable);
    const units = dollarToConsume / level.price;

    totalUnits += units;
    totalSpent += dollarToConsume;
    remaining -= dollarToConsume;

    if (remaining <= 0) break;
  }

  if (totalUnits === 0) return null;
  if (remaining > amountDollars * 0.5) return null; // less than 50% fillable

  const vwap = totalSpent / totalUnits;
  const slippage = Math.abs(vwap - midpoint) / midpoint;

  return Math.round(slippage * 10000) / 10000;
}

/**
 * Composite rating from all metrics.
 */
function calcCompositeRating(
  spreadScore: number,
  depthImbalance: number,
  fillProb: Record<string, FillProbability>,
  factors: string[],
): LiquidityRating {
  const balanceScore = (1 - Math.abs(depthImbalance)) * 100;

  const fill1k = fillProb["1000"];
  const fillScore = fill1k
    ? ((fill1k.bid + fill1k.ask) / 2) * 100
    : 0;

  const composite =
    spreadScore * 0.5 + balanceScore * 0.3 + fillScore * 0.2;

  let rating: LiquidityRating;
  if (composite >= 85) {
    rating = "EXCELLENT";
  } else if (composite >= 65) {
    rating = "GOOD";
  } else if (composite >= 40) {
    rating = "FAIR";
  } else if (composite >= 15) {
    rating = "POOR";
  } else {
    rating = "DEAD";
    factors.push("Extremely low liquidity.");
  }

  return rating;
}
