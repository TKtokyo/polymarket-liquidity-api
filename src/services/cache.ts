import type { TokenIntelResponse } from "../types/index.js";

/** Positive cache TTL: 5 minutes */
const CACHE_TTL_SECONDS = 300;

/** Negative cache TTL: 30 seconds (GoPlus 429/5xx) */
const NEGATIVE_CACHE_TTL_SECONDS = 30;

/** Cache key format: token:{chainId}:{normalizedAddress} */
function cacheKey(chainId: string, address: string): string {
  return `token:${chainId}:${address}`;
}

// --- Stored cache entry types ---

interface PositiveCacheEntry {
  type: "ok";
  data: TokenIntelResponse;
  storedAt: number; // epoch ms
}

interface NegativeCacheEntry {
  type: "upstream_degraded";
  reason: string;
  storedAt: number;
}

type CacheEntry = PositiveCacheEntry | NegativeCacheEntry;

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
 * Returns hit with data + age, negative hit, or miss.
 */
export async function cacheGet(
  kv: KVNamespace,
  chainId: string,
  address: string,
): Promise<CacheResult> {
  const key = cacheKey(chainId, address);
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
 * Store a successful response in KV cache (TTL 5min).
 */
export async function cachePut(
  kv: KVNamespace,
  chainId: string,
  address: string,
  data: TokenIntelResponse,
): Promise<void> {
  const key = cacheKey(chainId, address);
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
 * Store a negative cache entry (TTL 30s).
 * Used when GoPlus returns 429/5xx to prevent hammering.
 */
export async function cacheNegativePut(
  kv: KVNamespace,
  chainId: string,
  address: string,
  reason: string,
): Promise<void> {
  const key = cacheKey(chainId, address);
  const entry: NegativeCacheEntry = {
    type: "upstream_degraded",
    reason,
    storedAt: Date.now(),
  };

  await kv.put(key, JSON.stringify(entry), {
    expirationTtl: NEGATIVE_CACHE_TTL_SECONDS,
  });
}
