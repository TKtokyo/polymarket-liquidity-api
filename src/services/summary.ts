import type {
  LiquidityRating,
  LiquidityMetrics,
  OrderbookSummary,
} from "../types/index.js";

/**
 * Generate a human-readable summary of market liquidity.
 * Template-based, no LLM needed.
 */
export function generateSummary(
  rating: LiquidityRating,
  metrics: LiquidityMetrics,
  orderbook: OrderbookSummary,
  factors: string[],
): string {
  const parts: string[] = [];

  // Rating header
  parts.push(`${rating} liquidity.`);

  // Spread
  const { spread, tick_size } = orderbook;
  if (tick_size > 0 && spread > 0) {
    const spreadTicks = Math.round(spread / tick_size);
    if (metrics.spread_score >= 90) {
      parts.push(`Tight spread (${spreadTicks} tick${spreadTicks > 1 ? "s" : ""}).`);
    } else if (metrics.spread_score >= 50) {
      parts.push(`Moderate spread (${spreadTicks} ticks).`);
    } else {
      parts.push(`Wide spread (${spreadTicks} ticks) — high cost to cross.`);
    }
  } else if (orderbook.bid_levels === 0 || orderbook.ask_levels === 0) {
    parts.push("One-sided book — no spread available.");
  }

  // Depth imbalance
  const imb = metrics.depth_imbalance;
  if (Math.abs(imb) > 0.5) {
    const side = imb > 0 ? "bid" : "ask";
    parts.push(
      `Strong ${side}-side imbalance (${(Math.abs(imb) * 100).toFixed(0)}%).`,
    );
  } else if (Math.abs(imb) > 0.2) {
    const side = imb > 0 ? "bid" : "ask";
    parts.push(`Moderate ${side}-side bias.`);
  } else {
    parts.push("Balanced order book.");
  }

  // Fill probability at $1K
  const fill1k = metrics.fill_probability["1000"];
  if (fill1k) {
    if (fill1k.bid >= 0.9 && fill1k.ask >= 0.9) {
      parts.push("Deep liquidity at $1K.");
    } else if (fill1k.bid < 0.5 || fill1k.ask < 0.5) {
      parts.push("Thin liquidity — $1K orders may partially fill.");
    }
  }

  // Slippage warning at $1K
  const slip1k = metrics.slippage_estimate["1000"];
  if (slip1k) {
    const maxSlip = Math.max(slip1k.bid ?? 0, slip1k.ask ?? 0);
    if (maxSlip > 0.05) {
      parts.push(
        `Significant slippage risk at $1K+ size (${(maxSlip * 100).toFixed(1)}%).`,
      );
    }
  }

  // Append any additional factors from scoring
  const extraFactors = factors.filter(
    (f) =>
      !f.includes("spread") &&
      !f.includes("imbalance") &&
      !f.includes("Extremely"),
  );
  if (extraFactors.length > 0) {
    parts.push(extraFactors.join(" "));
  }

  return parts.join(" ");
}
