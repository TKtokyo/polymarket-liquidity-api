import {
  GammaResponseSchema,
  CLOBBookSchema,
  type GammaMarket,
  type CLOBOrderbook,
  type PolymarketFetchResult,
  type MarketInfo,
  type OrderbookSummary,
} from "../types/index.js";

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";

/**
 * Fetch market metadata from Gamma API + orderbooks from CLOB API.
 * Returns a discriminated union matching the Token Intel API pattern.
 */
export async function fetchMarketData(
  conditionId: string,
): Promise<PolymarketFetchResult> {
  // Step 1: Resolve conditionId via Gamma API
  let gammaResponse: Response;
  try {
    gammaResponse = await fetch(
      `${GAMMA_BASE}/markets?conditionID=${conditionId}`,
    );
  } catch (err) {
    return { status: "error", httpStatus: 0, message: "Gamma API network error" };
  }

  if (gammaResponse.status === 429) {
    return { status: "rate_limited", retryAfter: 30 };
  }

  if (!gammaResponse.ok) {
    return { status: "error", httpStatus: gammaResponse.status };
  }

  // Validate content-type before parsing (audit P1 #14)
  const contentType = gammaResponse.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return { status: "error", httpStatus: 502, message: "Gamma API returned non-JSON response" };
  }

  let gammaRaw: unknown;
  try {
    gammaRaw = await gammaResponse.json();
  } catch {
    return { status: "error", httpStatus: 502, message: "Gamma API returned invalid JSON" };
  }

  // Zod validation (audit P1 #5)
  const gammaResult = GammaResponseSchema.safeParse(gammaRaw);
  if (!gammaResult.success) {
    return { status: "error", httpStatus: 502, message: "Gamma API response shape mismatch" };
  }

  if (gammaResult.data.length === 0) {
    return { status: "not_found" };
  }

  const market = gammaResult.data[0];

  // Parse JSON-encoded clobTokenIds
  let tokenIds: string[];
  try {
    tokenIds = JSON.parse(market.clobTokenIds);
    if (!Array.isArray(tokenIds) || tokenIds.length === 0) {
      return { status: "not_found" };
    }
  } catch {
    return { status: "error", httpStatus: 502, message: "Invalid clobTokenIds format" };
  }

  // Step 2: Fetch orderbooks for each token ID in parallel
  const bookResults = await Promise.allSettled(
    tokenIds.map(async (tokenId) => {
      const resp = await fetch(`${CLOB_BASE}/book?token_id=${tokenId}`);

      if (resp.status === 429) {
        throw new CLOBError("rate_limited", 429);
      }
      if (!resp.ok) {
        throw new CLOBError("error", resp.status);
      }

      const raw = await resp.json();
      const parsed = CLOBBookSchema.safeParse(raw);
      if (!parsed.success) {
        throw new CLOBError("validation_error", 502);
      }

      return parsed.data;
    }),
  );

  // Check for failures
  for (const result of bookResults) {
    if (result.status === "rejected") {
      const err = result.reason;
      if (err instanceof CLOBError) {
        if (err.type === "rate_limited") {
          return { status: "rate_limited", retryAfter: 30 };
        }
        return { status: "error", httpStatus: err.httpStatus };
      }
      return { status: "error", httpStatus: 0, message: "CLOB API network error" };
    }
  }

  const books = bookResults
    .filter((r): r is PromiseFulfilledResult<CLOBOrderbook> => r.status === "fulfilled")
    .map((r) => r.value);

  if (books.length === 0) {
    return { status: "error", httpStatus: 502, message: "No orderbooks returned" };
  }

  return { status: "ok", market, books };
}

/** Internal error class for CLOB fetch failures */
class CLOBError extends Error {
  constructor(
    public readonly type: string,
    public readonly httpStatus: number,
  ) {
    super(`CLOB error: ${type} (${httpStatus})`);
  }
}

// --- Field mappers (parallel to GoPlus mappers) ---

/**
 * Map Gamma market metadata to clean MarketInfo.
 */
export function mapMarketInfo(market: GammaMarket): MarketInfo {
  let outcomes: string[];
  try {
    outcomes = JSON.parse(market.outcomes);
  } catch {
    outcomes = [];
  }

  let tokenIds: string[];
  try {
    tokenIds = JSON.parse(market.clobTokenIds);
  } catch {
    tokenIds = [];
  }

  return {
    condition_id: market.conditionId,
    question: market.question,
    outcomes,
    token_ids: tokenIds,
    end_date: market.endDateIso ?? null,
  };
}

/**
 * Map raw CLOB orderbook to clean OrderbookSummary.
 */
export function mapOrderbookSummary(book: CLOBOrderbook): OrderbookSummary {
  // Bids are sorted high→low in the response, asks are sorted low→high
  // But CLOB API actually returns bids sorted ascending by price, last element is best bid
  const bids = book.bids;
  const asks = book.asks;

  const bestBid = bids.length > 0 ? parseFloat(bids[bids.length - 1].price) : 0;
  const bestAsk = asks.length > 0 ? parseFloat(asks[asks.length - 1].price) : 0;

  // Find actual best ask (lowest price in asks)
  let actualBestAsk = Infinity;
  for (const ask of asks) {
    const p = parseFloat(ask.price);
    if (p < actualBestAsk) actualBestAsk = p;
  }
  if (!isFinite(actualBestAsk)) actualBestAsk = 0;

  // Find actual best bid (highest price in bids)
  let actualBestBid = 0;
  for (const bid of bids) {
    const p = parseFloat(bid.price);
    if (p > actualBestBid) actualBestBid = p;
  }

  const midpoint =
    actualBestBid > 0 && actualBestAsk > 0
      ? (actualBestBid + actualBestAsk) / 2
      : 0;
  const spread =
    actualBestBid > 0 && actualBestAsk > 0
      ? actualBestAsk - actualBestBid
      : 0;

  const tickSize = parseFloat(book.tick_size) || 0.01;

  // Convert epoch ms timestamp to ISO
  const ts = parseInt(book.timestamp, 10);
  const timestamp = isNaN(ts)
    ? new Date().toISOString()
    : new Date(ts).toISOString();

  return {
    best_bid: actualBestBid,
    best_ask: actualBestAsk,
    midpoint: Math.round(midpoint * 10000) / 10000,
    spread: Math.round(spread * 10000) / 10000,
    tick_size: tickSize,
    bid_levels: bids.length,
    ask_levels: asks.length,
    last_trade_price: parseFloat(book.last_trade_price) || 0,
    timestamp,
  };
}
