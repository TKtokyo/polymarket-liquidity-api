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
app.get("/health", (c) => c.json({ status: "ok", version: "0.1.0" }));

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

  const routes: RoutesConfig = {
    "GET /api/v1/market/*": {
      accepts: {
        scheme: "exact",
        network: c.env.X402_NETWORK as `eip155:${string}`,
        price: "$0.005",
        payTo: c.env.PAY_TO_ADDRESS as `0x${string}`,
      },
      resource: "Polymarket Orderbook Liquidity Report",
      description:
        "Orderbook depth, spread, slippage + liquidity rating for any Polymarket market",
      mimeType: "application/json",
      extensions: {
        ...declareDiscoveryExtension({
          input: {
            conditionId:
              "0x9c1a953fe92c8357f1b646ba25d983aa83e90c525992db14fb726fa895cb5763",
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
          output: {
            example: {
              market: {
                condition_id:
                  "0x9c1a953fe92c8357f1b646ba25d983aa83e90c525992db14fb726fa895cb5763",
                question: "Russia-Ukraine Ceasefire before GTA VI?",
                outcomes: ["Yes", "No"],
                token_ids: ["8501497...", "2527312..."],
                end_date: "2026-07-31",
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
                fill_probability: {
                  "1000": { bid: 1.0, ask: 1.0 },
                },
                slippage_estimate: {
                  "1000": { bid: 0.0018, ask: 0.0045 },
                },
              },
              liquidity_rating: "GOOD",
              summary:
                "GOOD liquidity. Tight spread (1 tick). Moderate bid-side bias.",
              cached: false,
              data_age_seconds: 0,
            },
            schema: {
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
          },
        }),
      },
    },
  };

  const middleware = paymentMiddleware(routes, server);
  return middleware(c, next);
});

// Protected route
app.route("/api/v1/market", marketRoutes);

export default app;
