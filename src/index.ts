import { Hono } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import {
  declareDiscoveryExtension,
  bazaarResourceServerExtension,
} from "@x402/extensions/bazaar";
import { createFacilitatorConfig } from "@coinbase/x402";
import type { RoutesConfig } from "@x402/core/server";
import type { FacilitatorConfig } from "@x402/core/http";
import type { Env } from "./types/index.js";
import { marketRoutes } from "./routes/market.js";
import { handleMcpRequest } from "./mcp/server.js";
import { OPENAPI_SPEC } from "./openapi.js";

// ─── Market route definition (single source of truth) ──────────────────────
//
// MARKET_ROUTE drives both the payment middleware and the .well-known/x402
// manifest, so the route URL, price, and discovery metadata cannot drift.
// `buildAccepts` produces the same PaymentRequirements that the @x402/hono
// middleware emits in the PAYMENT-REQUIRED header, ensuring x402scan and any
// other consumer sees identical accepts[] from both sources.

interface MarketRouteDef {
  method: "GET";
  middlewarePattern: string; // wildcard for paymentMiddleware (covers any conditionId)
  sampleConditionId: string; // concrete value embedded in manifest resource URL
  price: string; // USD form consumed by paymentMiddleware (e.g. "$0.005")
  resourceName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  inputExample: Record<string, unknown>;
  outputExample: unknown;
  outputSchema: Record<string, unknown>;
}

const MARKET_ROUTE: MarketRouteDef = {
  method: "GET",
  middlewarePattern: "GET /api/v1/market/*",
  // Active Polymarket market: "Will Bitcoin hit $150k by June 30, 2026?"
  // End date 2026-07-01. Refresh before then (see project memory).
  sampleConditionId:
    "0xa0f4c4924ea1a8b410b4ce821c2a9955fad21a1b19bdcfde90816732278b3dd5",
  price: "$0.005",
  resourceName: "Polymarket Orderbook Liquidity Report",
  description:
    "Orderbook depth, spread, slippage + liquidity rating for any Polymarket market",
  inputExample: {
    conditionId:
      "0xa0f4c4924ea1a8b410b4ce821c2a9955fad21a1b19bdcfde90816732278b3dd5",
  },
  inputSchema: {
    properties: {
      conditionId: {
        type: "string",
        pattern: "^0x[a-fA-F0-9]{64}$",
        description:
          "Polymarket market condition ID (0x-prefixed 64-char hex string)",
      },
    },
    required: ["conditionId"],
  },
  outputExample: {
    market: {
      condition_id:
        "0xa0f4c4924ea1a8b410b4ce821c2a9955fad21a1b19bdcfde90816732278b3dd5",
      question: "Will Bitcoin hit $150k by June 30, 2026?",
      outcomes: ["Yes", "No"],
      token_ids: ["8501497...", "2527312..."],
      end_date: "2026-07-01",
    },
    orderbook: {
      best_bid: 0.55,
      best_ask: 0.56,
      midpoint: 0.555,
      spread: 0.01,
      tick_size: 0.01,
      bid_levels: 51,
      ask_levels: 29,
      last_trade_price: 0.44,
    },
    metrics: {
      spread_score: 100,
      depth_imbalance: 0.42,
      fill_probability: { "1000": { bid: 1.0, ask: 1.0 } },
      slippage_estimate: { "1000": { bid: 0.0018, ask: 0.0045 } },
    },
    liquidity_rating: "GOOD",
    summary: "GOOD liquidity. Tight spread (1 tick). Moderate bid-side bias.",
    cached: false,
    data_age_seconds: 0,
  },
  outputSchema: {
    type: "object",
    properties: {
      market: { type: "object" },
      orderbook: { type: "object" },
      metrics: { type: "object" },
      liquidity_rating: {
        type: "string",
        enum: ["EXCELLENT", "GOOD", "FAIR", "POOR", "DEAD"],
      },
      summary: { type: "string" },
      cached: { type: "boolean" },
      data_age_seconds: { type: "number" },
    },
    required: [
      "market",
      "orderbook",
      "metrics",
      "liquidity_rating",
      "summary",
    ],
  },
};

interface UsdcInfo {
  address: string;
  name: string;
  version: string;
}

// USDC contract metadata per supported network. Values must match what
// @x402/hono resolves on-chain, so the manifest's accepts[] is byte-identical
// to the middleware-emitted PAYMENT-REQUIRED payload.
const USDC_BY_NETWORK: Record<string, UsdcInfo> = {
  "eip155:8453": {
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    name: "USD Coin",
    version: "2",
  },
  "eip155:84532": {
    address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    name: "USDC",
    version: "2",
  },
};

// "$0.005" -> "5000" (USDC has 6 decimals). BigInt-based so no float drift.
function usdToUsdcBaseUnits(price: string): string {
  const match = /^\$(\d+)(?:\.(\d{1,6}))?$/.exec(price);
  if (!match) throw new Error(`Invalid price format: ${price}`);
  const whole = BigInt(match[1]);
  const frac = (match[2] ?? "").padEnd(6, "0");
  return (whole * 1_000_000n + BigInt(frac || "0")).toString();
}

interface PaymentRequirement {
  scheme: "exact";
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
}

function buildAccepts(price: string, env: Env): PaymentRequirement[] {
  const usdc = USDC_BY_NETWORK[env.X402_NETWORK];
  if (!usdc) {
    throw new Error(`Unsupported X402_NETWORK: ${env.X402_NETWORK}`);
  }
  return [
    {
      scheme: "exact",
      network: env.X402_NETWORK,
      amount: usdToUsdcBaseUnits(price),
      asset: usdc.address,
      payTo: env.PAY_TO_ADDRESS,
      maxTimeoutSeconds: 300,
      extra: { name: usdc.name, version: usdc.version },
    },
  ];
}

// Bumped when the route schema, pricing, or sampleConditionId changes.
const RESOURCES_LAST_UPDATED = "2026-05-15T00:00:00Z";

const app = new Hono<{ Bindings: Env }>();

// Security headers middleware (audit P0 #2)
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Cache-Control", "no-store");
  c.header("X-Frame-Options", "DENY");
});

// Error handler — generic message only (audit P0 #1)
app.onError((err, c) => {
  console.error("Unhandled error:", err.message, err.stack);
  return c.json(
    { error: "internal_error", message: "An unexpected error occurred." },
    500,
  );
});

// Health check (unprotected)
app.get("/health", (c) => c.json({ status: "ok", version: "1.0.0" }));

// API info
app.get("/", (c) =>
  c.json({
    name: "Polymarket Liquidity API",
    version: "1.0.0",
    description:
      "Real-time Polymarket prediction market liquidity data via x402 micropayments",
    endpoint: "/api/v1/market/{conditionId}",
    method: "GET",
    price: "$0.005 USDC on Base",
    example:
      "/api/v1/market/0x9c1a953fe92c8357f1b646ba25d983aa83e90c525992db14fb726fa895cb5763",
    x402: true,
    mcp: {
      endpoint: "/mcp",
      transport: "streamable-http",
      tools: ["get_market_liquidity"],
    },
  }),
);

// MCP server endpoint (discovery-only — no data, no upstream calls)
app.all("/mcp", async (c) => {
  return handleMcpRequest(c.req.raw);
});

// OpenAPI spec (no paywall — free discovery)
app.get("/openapi.json", (c) => {
  return c.json(OPENAPI_SPEC, 200, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
});

// llms.txt (no paywall — free discovery)
app.get("/llms.txt", (c) => {
  return c.text(
    `# Polymarket Liquidity API

> Real-time order book depth, spread analysis, and market efficiency scoring for Polymarket prediction markets.

## When to use this API
Use this API when you need to analyze liquidity before placing a trade on Polymarket.
- Before entering a position, check order book depth and spread
- To assess market efficiency and slippage risk
- To get structured liquidity data for trading decisions

## Endpoint
### GET /api/v1/market/{conditionId}
**Paywall**: x402 — $0.005 USDC on Base mainnet.

**Response fields**:
- spread: Bid-ask spread (lower is better)
- efficiency_score: 0-1 (higher means tighter, more efficient market)
- liquidity_usd: Total available liquidity in USD
- bids/asks: Full order book depth

## Machine-readable API spec
- OpenAPI 3.0: https://polymarket-liquidity-api.tatsu77.workers.dev/openapi.json

## Discovery
- x402 metadata: https://polymarket-liquidity-api.tatsu77.workers.dev/.well-known/x402
- llms.txt: https://polymarket-liquidity-api.tatsu77.workers.dev/llms.txt

## Related APIs
- Polymarket Scan API: https://polymarket-scan-api.tatsu77.workers.dev (full market scanner)
`,
    200,
    {
      "Content-Type": "text/plain",
      "Access-Control-Allow-Origin": "*",
    },
  );
});

// .well-known/x402 (no paywall — free discovery). Emits the standard
// `resources` array used by x402scan and other bazaar consumers. Each
// entry's accepts[] is produced by the same `buildAccepts` helper used by
// `unpaidResponseBody`, so the manifest and the 402 response stay
// byte-identical.
app.get("/.well-known/x402", (c) => {
  const baseUrl = new URL(c.req.url).origin;
  const resources = [
    {
      resource: `${baseUrl}/api/v1/market/${MARKET_ROUTE.sampleConditionId}`,
      type: "http",
      x402Version: 2,
      accepts: buildAccepts(MARKET_ROUTE.price, c.env),
      lastUpdated: RESOURCES_LAST_UPDATED,
      metadata: {
        method: MARKET_ROUTE.method,
        name: MARKET_ROUTE.resourceName,
        description: MARKET_ROUTE.description,
        inputSchema: MARKET_ROUTE.inputSchema,
        outputExample: MARKET_ROUTE.outputExample,
      },
    },
  ];

  return c.json(
    {
      x402Version: 1,
      resourceServer: baseUrl,
      facilitator: c.env.FACILITATOR_URL,
      network: c.env.X402_NETWORK,
      openapi: `${baseUrl}/openapi.json`,
      llms_txt: `${baseUrl}/llms.txt`,
      resources,
    },
    200,
    {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  );
});

// x402 payment middleware — wraps protected routes
app.use("/api/v1/*", async (c, next) => {
  // Use CDP facilitator config when keys are available (mainnet),
  // otherwise use simple URL config (testnet)
  let facilitatorConfig: FacilitatorConfig;
  if (c.env.CDP_API_KEY_ID && c.env.CDP_API_KEY_SECRET) {
    facilitatorConfig = createFacilitatorConfig(
      c.env.CDP_API_KEY_ID,
      c.env.CDP_API_KEY_SECRET,
    );
  } else {
    facilitatorConfig = { url: c.env.FACILITATOR_URL };
  }
  const facilitatorClient = new HTTPFacilitatorClient(facilitatorConfig);

  const server = new x402ResourceServer(facilitatorClient);
  registerExactEvmScheme(server);
  server.registerExtension(bazaarResourceServerExtension);

  const accepts = buildAccepts(MARKET_ROUTE.price, c.env);
  const routes: RoutesConfig = {
    [MARKET_ROUTE.middlewarePattern]: {
      accepts: {
        scheme: "exact",
        network: c.env.X402_NETWORK as `eip155:${string}`,
        price: MARKET_ROUTE.price,
        payTo: c.env.PAY_TO_ADDRESS as `0x${string}`,
      },
      resource: MARKET_ROUTE.resourceName,
      description: MARKET_ROUTE.description,
      mimeType: "application/json",
      extensions: {
        ...declareDiscoveryExtension({
          input: MARKET_ROUTE.inputExample,
          inputSchema: MARKET_ROUTE.inputSchema,
          output: {
            example: MARKET_ROUTE.outputExample,
            schema: MARKET_ROUTE.outputSchema,
          },
        }),
      },
      // Mirror accepts[] into the 402 body so callers that only read JSON
      // (e.g. x402scan validators, naive curl checks) see the same payment
      // requirements they would otherwise pull from PAYMENT-REQUIRED header.
      unpaidResponseBody: () => ({
        contentType: "application/json",
        body: {
          x402Version: 1,
          accepts,
          error: "X-PAYMENT header is required",
        },
      }),
    },
  };

  const middleware = paymentMiddleware(routes, server);
  return middleware(c, next);
});

// Protected route
app.route("/api/v1/market", marketRoutes);

export default app;
