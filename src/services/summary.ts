import type { GoPlusTokenData } from "../types/index.js";

/**
 * Template-based summary generation (no GPU/LLM needed).
 *
 * Builds a human-readable summary from risk factors and token data.
 * See design doc section 3.5.
 */
export function generateSummary(
  score: number,
  level: string,
  factors: string[],
  data: GoPlusTokenData,
): string {
  const parts: string[] = [];

  // Risk level
  parts.push(`${level} risk.`);

  // Contract status
  if (data.is_open_source === "1") {
    parts.push("Contract is open source, verified.");
  } else if (data.is_open_source === "0") {
    parts.push("Contract is NOT open source.");
  }

  if (data.is_honeypot === "1") {
    parts.push("HONEYPOT DETECTED — do not trade.");
  }

  // Tax rates
  const sellTax = parseFloat(data.sell_tax || "0") * 100;
  const buyTax = parseFloat(data.buy_tax || "0") * 100;
  if (sellTax > 0 || buyTax > 0) {
    parts.push(`Tax: ${buyTax.toFixed(1)}% buy / ${sellTax.toFixed(1)}% sell.`);
  }

  // Holder concentration (from holders array)
  if (data.holders && data.holders.length > 0) {
    const top10 = data.holders.slice(0, 10);
    const pct =
      top10.reduce((sum, h) => sum + parseFloat(h.percent || "0"), 0) * 100;
    if (pct > 50) {
      parts.push(
        `Top 10 holders control ${pct.toFixed(1)}% (HIGH concentration).`,
      );
    } else if (pct > 30) {
      parts.push(
        `Top 10 holders control ${pct.toFixed(1)}% (elevated concentration).`,
      );
    } else {
      parts.push(`Top 10 holders control ${pct.toFixed(1)}%.`);
    }
  }

  // Liquidity
  if (data.dex && data.dex.length > 0) {
    // Find highest-liquidity DEX
    let maxLiq = 0;
    let maxDexName = "";
    for (const d of data.dex) {
      const liq = parseFloat(d.liquidity || "0");
      if (liq > maxLiq) {
        maxLiq = liq;
        maxDexName = d.name || "Unknown DEX";
      }
    }
    if (maxLiq > 0) {
      parts.push(
        `$${formatLiquidity(maxLiq)} in ${maxDexName} pool.`,
      );
    }
  }

  // Severe risk factors
  const severeFactors = factors.filter(
    (f) =>
      f.includes("Mintable") ||
      f.includes("Hidden") ||
      f.includes("Self-destruct") ||
      f.includes("reclaimable"),
  );
  if (severeFactors.length > 0) {
    parts.push(`Severe risks: ${severeFactors.join(", ")}.`);
  }

  return parts.join(" ");
}

/** Format liquidity number for display (e.g. 240000 → "240K") */
function formatLiquidity(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return value.toFixed(0);
}
