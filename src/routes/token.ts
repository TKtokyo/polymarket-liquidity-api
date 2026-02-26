import { Hono } from "hono";
import type { Env, TokenIntelResponse } from "../types/index.js";
import {
  fetchGoPlus,
  mapTokenInfo,
  mapSecurityInfo,
  mapHolderInfo,
  mapLiquidityInfo,
} from "../services/goplus.js";
import { calculateRiskScore } from "../services/scoring.js";
import { generateSummary } from "../services/summary.js";
import {
  cacheGet,
  cachePut,
  cacheNegativePut,
} from "../services/cache.js";

const ALLOWED_CHAINS = ["1", "8453"];

const tokenRoutes = new Hono<{ Bindings: Env }>();

tokenRoutes.get("/:chainId/:address", async (c) => {
  const requestId = crypto.randomUUID().slice(0, 8);
  const chainId = c.req.param("chainId");
  const rawAddress = c.req.param("address");

  // Input validation: chainId allowlist (MVP: Ethereum + Base only)
  if (!ALLOWED_CHAINS.includes(chainId)) {
    return c.json(
      {
        error: "invalid_chain",
        message: `Unsupported chain. Allowed: ${ALLOWED_CHAINS.join(", ")}`,
      },
      400,
    );
  }

  // Input validation: address format
  if (!/^0x[a-fA-F0-9]{40}$/.test(rawAddress)) {
    return c.json(
      { error: "invalid_address", message: "Invalid contract address format." },
      400,
    );
  }

  // Normalize address (cache bypass prevention)
  const address = rawAddress.toLowerCase();
  const kv = c.env.TOKEN_CACHE;

  // --- Cache read ---
  const t0 = Date.now();
  const cached = await cacheGet(kv, chainId, address);
  const tKvRead = Date.now() - t0;

  if (cached.hit) {
    if ("negative" in cached) {
      // Negative cache hit — upstream was degraded recently
      console.log(
        `[${requestId}] ${chainId}:${address} negative_cache_hit reason=${cached.reason} t_kv=${tKvRead}ms`,
      );
      return c.json(
        {
          error: "upstream_throttled",
          message: "Data source rate limited. Please retry in 30 seconds.",
        },
        429,
      );
    }

    // Positive cache hit
    const response = { ...cached.entry.data, cached: true, data_age_seconds: cached.ageSeconds };
    console.log(
      `[${requestId}] ${chainId}:${address} cache_hit age=${cached.ageSeconds}s t_kv=${tKvRead}ms`,
    );
    return c.json(response);
  }

  // --- Cache miss: fetch from GoPlus ---
  console.log(`[${requestId}] ${chainId}:${address} cache_miss t_kv=${tKvRead}ms`);

  const tGoplusStart = Date.now();
  const result = await fetchGoPlus(chainId, address, c.env.GOPLUS_API_KEY);
  const tGoplus = Date.now() - tGoplusStart;

  // Handle error states with negative caching
  if (result.status === "rate_limited") {
    await cacheNegativePut(kv, chainId, address, "rate_limited");
    console.log(
      `[${requestId}] ${chainId}:${address} goplus_429 t_goplus=${tGoplus}ms`,
    );
    return c.json(
      {
        error: "upstream_throttled",
        message: "Data source rate limited. Please retry in 30 seconds.",
      },
      429,
    );
  }

  if (result.status === "error") {
    // Negative cache for 5xx errors
    if (result.httpStatus >= 500 || result.httpStatus === 0) {
      await cacheNegativePut(kv, chainId, address, `error_${result.httpStatus}`);
    }
    console.error(
      `[${requestId}] ${chainId}:${address} goplus_error http=${result.httpStatus} msg=${result.message || "unknown"} t_goplus=${tGoplus}ms`,
    );
    return c.json(
      {
        error: "upstream_unavailable",
        message: "Security data source temporarily unavailable.",
      },
      503,
    );
  }

  if (result.status === "not_found") {
    console.log(
      `[${requestId}] ${chainId}:${address} not_found t_goplus=${tGoplus}ms`,
    );
    return c.json(
      {
        error: "token_not_found",
        message: "No security data available for this token.",
      },
      404,
    );
  }

  // --- Build response ---
  const data = result.data;
  const token = mapTokenInfo(data, chainId, address);
  const security = mapSecurityInfo(data);
  const holders = mapHolderInfo(data);
  const liquidity = mapLiquidityInfo(data);
  const { score, level, factors } = calculateRiskScore(data);
  const summary = generateSummary(score, level, factors, data);

  const response: TokenIntelResponse = {
    token,
    security,
    holders,
    liquidity,
    risk_score: score,
    risk_level: level,
    summary,
    cached: false,
    data_age_seconds: 0,
  };

  // --- Cache write (non-blocking) ---
  c.executionCtx.waitUntil(cachePut(kv, chainId, address, response));

  const tTotal = Date.now() - t0;
  console.log(
    `[${requestId}] ${chainId}:${address} score=${score} level=${level} t_kv=${tKvRead}ms t_goplus=${tGoplus}ms t_total=${tTotal}ms`,
  );

  return c.json(response);
});

export { tokenRoutes };
