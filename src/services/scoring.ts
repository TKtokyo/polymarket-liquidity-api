import type { GoPlusTokenData, ScoringResult } from "../types/index.js";

/**
 * Deterministic risk score calculation.
 *
 * Starts at 100 (safest) and deducts points based on risk factors.
 * Field absence → skip rule (no impact on score), record in factors.
 *
 * See design doc section 3.4 for scoring rules.
 */
export function calculateRiskScore(data: GoPlusTokenData): ScoringResult {
  let score = 100;
  const factors: string[] = [];

  // --- CRITICAL (instant 0) ---
  if (data.is_honeypot === "1") {
    return { score: 0, level: "CRITICAL", factors: ["Honeypot detected"] };
  }

  // --- SEVERE (-30 each) ---
  if (data.is_mintable !== undefined) {
    if (data.is_mintable === "1") {
      score -= 30;
      factors.push("Mintable token");
    }
  } else {
    factors.push("Data unavailable: is_mintable");
  }

  if (data.hidden_owner !== undefined) {
    if (data.hidden_owner === "1") {
      score -= 30;
      factors.push("Hidden owner");
    }
  } else {
    factors.push("Data unavailable: hidden_owner");
  }

  if (data.can_take_back_ownership !== undefined) {
    if (data.can_take_back_ownership === "1") {
      score -= 30;
      factors.push("Ownership reclaimable");
    }
  } else {
    factors.push("Data unavailable: can_take_back_ownership");
  }

  if (data.selfdestruct !== undefined) {
    if (data.selfdestruct === "1") {
      score -= 30;
      factors.push("Self-destruct capability");
    }
  } else {
    factors.push("Data unavailable: selfdestruct");
  }

  // --- HIGH (-20 each) ---
  if (data.sell_tax !== undefined) {
    const sellTax = parseFloat(data.sell_tax);
    if (sellTax > 0.1) {
      score -= 20;
      factors.push(`High sell tax: ${(sellTax * 100).toFixed(1)}%`);
    }
  } else {
    factors.push("Data unavailable: sell_tax");
  }

  if (data.buy_tax !== undefined) {
    const buyTax = parseFloat(data.buy_tax);
    if (buyTax > 0.1) {
      score -= 20;
      factors.push(`High buy tax: ${(buyTax * 100).toFixed(1)}%`);
    }
  } else {
    factors.push("Data unavailable: buy_tax");
  }

  if (data.is_proxy !== undefined) {
    if (data.is_proxy === "1") {
      score -= 20;
      factors.push("Proxy contract");
    }
  } else {
    factors.push("Data unavailable: is_proxy");
  }

  // --- MODERATE (-10 each) ---
  if (data.is_open_source !== undefined) {
    if (data.is_open_source !== "1") {
      score -= 10;
      factors.push("Not open source");
    }
  } else {
    factors.push("Data unavailable: is_open_source");
  }

  if (data.external_call !== undefined) {
    if (data.external_call === "1") {
      score -= 10;
      factors.push("External calls");
    }
  } else {
    factors.push("Data unavailable: external_call");
  }

  if (data.is_blacklisted !== undefined) {
    if (data.is_blacklisted === "1") {
      score -= 10;
      factors.push("Blacklist function");
    }
  } else {
    factors.push("Data unavailable: is_blacklisted");
  }

  // --- LOW (-5 each) ---
  if (data.holder_count !== undefined) {
    if (parseInt(data.holder_count, 10) < 100) {
      score -= 5;
      factors.push("Low holder count");
    }
  }

  score = Math.max(0, score);

  const level: ScoringResult["level"] =
    score <= 25
      ? "CRITICAL"
      : score <= 50
        ? "HIGH"
        : score <= 75
          ? "MODERATE"
          : "LOW";

  return { score, level, factors };
}
