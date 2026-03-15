import type { MarketLiquidityResponse } from "../types/index.js";

/** Positive cache TTL: 60 seconds (orderbook data is volatile) */
const CACHE_TTL_SECONDS = 60;

/** Negative cache TTL: 15 seconds */
const NEGATIVE_CACHE_TTL_SECONDS = 15;

/** Circuit breaker TTL: 15 seconds */
const CIRCUIT_BREAKER_TTL_SECONDS = 15;

/** Circuit breaker threshold: errors before tripping */
const CIRCUIT_BREAKER_THRESHOLD = 3;

/** Circuit breaker KV key */
const CIRCUIT_KEY = "circuit:polymarket";

/** Cache key format: market:{normalizedConditionId} */
function cacheKey(conditionId: string): string {
  return `market:${conditionId}`;
}

// --- Stored cache entry types ---

interface PositiveCacheEntry {
  type: "ok";
  data: MarketLiquidityResponse;
  storedAt: number; // epoch ms
}

interface NegativeCacheEntry {
  type: "upstream_degraded";
  reason: string;
  storedAt: number;
}

type CacheEntry = PositiveCacheEntry | NegativeCacheEntry;

interface CircuitBreakerState {
  errorCount: number;
  firstErrorAt: number;
}

// --- Public API ---

export interface CacheHit {
  hit: true;
  entry: PositiveCacheEntry;
  ageSeconds: number;
}

export interface CacheNegativeHit {
  hit: true;
  negative: true;
  reason: string;
}

export interface CacheMiss {
  hit: false;
}

export type CacheResult = CacheHit | CacheNegativeHit | CacheMiss;

/**
 * Read from KV cache.
 * Checks circuit breaker first, then per-key cache. (audit P1 #7)
 */
export async function cacheGet(
  kv: KVNamespace,
  conditionId: string,
): Promise<CacheResult> {
  // Check circuit breaker first
  const circuitTripped = await isCircuitBreakerTripped(kv);
  if (circuitTripped) {
    return { hit: true, negative: true, reason: "circuit_breaker_open" };
  }

  const key = cacheKey(conditionId);
  const raw = await kv.get(key, "text");

  if (!raw) {
    return { hit: false };
  }

  let entry: CacheEntry;
  try {
    entry = JSON.parse(raw) as CacheEntry;
  } catch {
    // Corrupted cache entry — treat as miss
    return { hit: false };
  }

  if (entry.type === "upstream_degraded") {
    return { hit: true, negative: true, reason: entry.reason };
  }

  const ageSeconds = Math.floor((Date.now() - entry.storedAt) / 1000);
  return { hit: true, entry, ageSeconds };
}

/**
 * Store a successful response in KV cache (TTL 60s).
 */
export async function cachePut(
  kv: KVNamespace,
  conditionId: string,
  data: MarketLiquidityResponse,
): Promise<void> {
  const key = cacheKey(conditionId);
  const entry: PositiveCacheEntry = {
    type: "ok",
    data,
    storedAt: Date.now(),
  };

  await kv.put(key, JSON.stringify(entry), {
    expirationTtl: CACHE_TTL_SECONDS,
  });
}

/**
 * Store a negative cache entry (TTL 15s).
 * Prevents hammering upstream on repeated requests for same market.
 */
export async function cacheNegativePut(
  kv: KVNamespace,
  conditionId: string,
  reason: string,
): Promise<void> {
  const key = cacheKey(conditionId);
  const entry: NegativeCacheEntry = {
    type: "upstream_degraded",
    reason,
    storedAt: Date.now(),
  };

  await kv.put(key, JSON.stringify(entry), {
    expirationTtl: NEGATIVE_CACHE_TTL_SECONDS,
  });
}

/**
 * Record an upstream error and potentially trip the circuit breaker. (audit P1 #7)
 */
export async function recordUpstreamError(kv: KVNamespace): Promise<void> {
  const raw = await kv.get(CIRCUIT_KEY, "text");
  let state: CircuitBreakerState;

  if (raw) {
    try {
      state = JSON.parse(raw) as CircuitBreakerState;
      state.errorCount++;
    } catch {
      state = { errorCount: 1, firstErrorAt: Date.now() };
    }
  } else {
    state = { errorCount: 1, firstErrorAt: Date.now() };
  }

  await kv.put(CIRCUIT_KEY, JSON.stringify(state), {
    expirationTtl: CIRCUIT_BREAKER_TTL_SECONDS,
  });
}

/**
 * Check if circuit breaker is tripped (3+ errors in 15s window).
 */
async function isCircuitBreakerTripped(kv: KVNamespace): Promise<boolean> {
  const raw = await kv.get(CIRCUIT_KEY, "text");
  if (!raw) return false;

  try {
    const state = JSON.parse(raw) as CircuitBreakerState;
    return state.errorCount >= CIRCUIT_BREAKER_THRESHOLD;
  } catch {
    return false;
  }
}
