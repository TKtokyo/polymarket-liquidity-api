import { z } from "zod";

// --- Environment bindings ---

export interface Env {
  FACILITATOR_URL: string;
  X402_NETWORK: string;
  PAY_TO_ADDRESS: string;
  MARKET_CACHE: KVNamespace;
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
}

// --- Zod schemas for upstream API validation (audit P1 #5) ---

export const GammaMarketSchema = z.object({
  conditionId: z.string(),
  question: z.string(),
  outcomes: z.string(), // JSON-encoded: '["Yes","No"]'
  clobTokenIds: z.string(), // JSON-encoded: '["123...","456..."]'
  endDateIso: z.string().optional(),
  active: z.boolean().optional(),
  slug: z.string().optional(),
});

export const GammaResponseSchema = z.array(GammaMarketSchema);

export type GammaMarket = z.infer<typeof GammaMarketSchema>;

const OrderLevelSchema = z.object({
  price: z.string(),
  size: z.string(),
});

export const CLOBBookSchema = z.object({
  market: z.string(),
  asset_id: z.string(),
  timestamp: z.string(),
  bids: z.array(OrderLevelSchema),
  asks: z.array(OrderLevelSchema),
  tick_size: z.string(),
  min_order_size: z.string(),
  neg_risk: z.boolean(),
  last_trade_price: z.string(),
});

export type CLOBOrderbook = z.infer<typeof CLOBBookSchema>;

// --- Fetch result discriminated union ---

export type PolymarketFetchResult =
  | { status: "ok"; market: GammaMarket; books: CLOBOrderbook[] }
  | { status: "not_found" }
  | { status: "rate_limited"; retryAfter: number }
  | { status: "error"; httpStatus: number; message?: string };

// --- Response types ---

export interface MarketInfo {
  condition_id: string;
  question: string;
  outcomes: string[];
  token_ids: string[];
  end_date: string | null;
}

export interface OrderbookSummary {
  best_bid: number;
  best_ask: number;
  midpoint: number;
  spread: number;
  tick_size: number;
  bid_levels: number;
  ask_levels: number;
  last_trade_price: number;
  timestamp: string;
}

export interface FillProbability {
  bid: number;
  ask: number;
}

export interface SlippageEstimate {
  bid: number | null;
  ask: number | null;
}

export interface LiquidityMetrics {
  spread_score: number;
  depth_imbalance: number;
  fill_probability: Record<string, FillProbability>;
  slippage_estimate: Record<string, SlippageEstimate>;
}

export type LiquidityRating = "EXCELLENT" | "GOOD" | "FAIR" | "POOR" | "DEAD";

export interface LiquidityRatingResult {
  rating: LiquidityRating;
  metrics: LiquidityMetrics;
  factors: string[];
}

export interface MarketLiquidityResponse {
  market: MarketInfo;
  orderbook: OrderbookSummary;
  metrics: LiquidityMetrics;
  liquidity_rating: LiquidityRating;
  summary: string;
  cached: boolean;
  data_age_seconds: number;
}
