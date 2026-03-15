import { Hono } from "hono";
import type { Env, MarketLiquidityResponse } from "../types/index.js";
import { fetchMarketData, mapMarketInfo, mapOrderbookSummary } from "../services/polymarket.js";
import { calculateLiquidityRating } from "../services/scoring.js";
import { generateSummary } from "../services/summary.js";
import {
  cacheGet,
  cachePut,
  cacheNegativePut,
  recordUpstreamError,
} from "../services/cache.js";

const marketRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /:conditionId
 *
 * Returns orderbook liquidity metrics for a Polymarket market.
 * Condition ID is a 0x-prefixed 64-character hex string.
 */
marketRoutes.get("/:conditionId", async (c) => {
  const requestId = crypto.randomUUID().slice(0, 8);
  const rawConditionId = c.req.param("conditionId");
  const t0 = Date.now();

  // --- Input validation ---
  if (!/^0x[a-fA-F0-9]{64}$/.test(rawConditionId)) {
    return c.json(
      {
        error: "invalid_condition_id",
        message:
          "Condition ID must be a 0x-prefixed 64-character hex string (66 chars total).",
      },
      400,
    );
  }

  // Normalize to lowercase (cache bypass prevention)
  const conditionId = rawConditionId.toLowerCase();
  const kv = c.env.MARKET_CACHE;

  // --- Cache read (circuit breaker + per-key) ---
  const tKvStart = Date.now();
  const cached = await cacheGet(kv, conditionId);
  const tKvRead = Date.now() - tKvStart;

  if (cached.hit) {
    if ("negative" in cached) {
      return c.json(
        {
          error: "upstream_throttled",
          message:
            "Data source temporarily unavailable. Please retry in 15 seconds.",
        },
        429,
      );
    }

    // Positive cache hit
    const response = {
      ...cached.entry.data,
      cached: true,
      data_age_seconds: cached.ageSeconds,
    };

    console.log(
      JSON.stringify({
        event: "request_served",
        request_id: requestId,
        condition_id: conditionId,
        rating: response.liquidity_rating,
        spread_score: response.metrics.spread_score,
        cached: true,
        t_kv_ms: tKvRead,
        t_total_ms: Date.now() - t0,
      }),
    );

    return c.json(response);
  }

  // --- Cache miss: fetch from Polymarket ---
  const tFetchStart = Date.now();
  const result = await fetchMarketData(conditionId);
  const tFetch = Date.now() - tFetchStart;

  // Handle rate limit
  if (result.status === "rate_limited") {
    c.executionCtx.waitUntil(
      Promise.all([
        cacheNegativePut(kv, conditionId, "rate_limited"),
        recordUpstreamError(kv),
      ]),
    );
    return c.json(
      {
        error: "upstream_throttled",
        message:
          "Data source rate limited. Please retry in 15 seconds.",
      },
      429,
    );
  }

  // Handle error
  if (result.status === "error") {
    c.executionCtx.waitUntil(
      Promise.all([
        cacheNegativePut(kv, conditionId, `error_${result.httpStatus}`),
        recordUpstreamError(kv),
      ]),
    );
    return c.json(
      {
        error: "upstream_error",
        message: "Data source temporarily unavailable.",
      },
      503,
    );
  }

  // Handle not found
  if (result.status === "not_found") {
    return c.json(
      {
        error: "market_not_found",
        message:
          "No Polymarket market found for the given condition ID.",
      },
      404,
    );
  }

  // --- Build response ---
  const marketInfo = mapMarketInfo(result.market);
  const primaryBook = result.books[0];
  const orderbook = mapOrderbookSummary(primaryBook);
  const { rating, metrics, factors } = calculateLiquidityRating(primaryBook);
  const summary = generateSummary(rating, metrics, orderbook, factors);

  const response: MarketLiquidityResponse = {
    market: marketInfo,
    orderbook,
    metrics,
    liquidity_rating: rating,
    summary,
    cached: false,
    data_age_seconds: 0,
  };

  // Non-blocking cache write
  c.executionCtx.waitUntil(cachePut(kv, conditionId, response));

  // Structured logging (audit P1 #9)
  console.log(
    JSON.stringify({
      event: "request_served",
      request_id: requestId,
      condition_id: conditionId,
      rating,
      spread_score: metrics.spread_score,
      cached: false,
      t_kv_ms: tKvRead,
      t_fetch_ms: tFetch,
      t_total_ms: Date.now() - t0,
    }),
  );

  return c.json(response);
});

export { marketRoutes };
