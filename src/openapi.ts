export const OPENAPI_SPEC = {
  openapi: "3.0.0",
  info: {
    title: "Polymarket Liquidity API",
    version: "1.0.0",
    description:
      "Real-time order book depth, spread analysis, and market efficiency scoring for any Polymarket prediction market. Returns structured data optimized for AI agent trading decisions via x402 micropayments.",
    contact: {
      url: "https://polymarket-liquidity-api.tatsu77.workers.dev/llms.txt",
    },
  },
  servers: [
    {
      url: "https://polymarket-liquidity-api.tatsu77.workers.dev",
      description: "Production (Base mainnet)",
    },
  ],
  paths: {
    "/api/v1/market/{conditionId}": {
      get: {
        summary: "Polymarket Order Book Analysis",
        description:
          "Returns order book depth, spread analysis, slippage estimation, and market efficiency score for a given Polymarket market. Requires x402 payment of $0.005 USDC on Base mainnet.",
        parameters: [
          {
            name: "conditionId",
            in: "path",
            required: true,
            description: "Polymarket market condition ID (0x...)",
            schema: {
              type: "string",
              example:
                "0x9c1a953fe92c8357f1b646ba25d983aa83e90c525992db14fb726fa895cb5763",
            },
          },
        ],
        responses: {
          "200": {
            description: "Market liquidity analysis result",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    conditionId: { type: "string" },
                    title: { type: "string" },
                    bids: {
                      type: "array",
                      description: "Buy orders sorted by price descending",
                      items: {
                        type: "object",
                        properties: {
                          price: { type: "number" },
                          size: { type: "number" },
                        },
                      },
                    },
                    asks: {
                      type: "array",
                      description: "Sell orders sorted by price ascending",
                      items: {
                        type: "object",
                        properties: {
                          price: { type: "number" },
                          size: { type: "number" },
                        },
                      },
                    },
                    spread: {
                      type: "number",
                      description: "Bid-ask spread (0-1)",
                    },
                    midpoint: {
                      type: "number",
                      description:
                        "Market midpoint price (0-1, represents probability)",
                    },
                    liquidity_usd: {
                      type: "number",
                      description: "Total liquidity in USD",
                    },
                    efficiency_score: {
                      type: "number",
                      description:
                        "Market efficiency score (0-1, higher is better)",
                    },
                    analyzedAt: {
                      type: "string",
                      format: "date-time",
                    },
                  },
                },
              },
            },
          },
          "402": {
            description:
              "Payment required. Include X-Payment header with x402 USDC payment proof.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    x402Version: { type: "integer" },
                    accepts: { type: "array" },
                    error: { type: "string" },
                  },
                },
              },
            },
          },
          "404": {
            description: "Market not found for the given conditionId",
          },
        },
        "x-x402": {
          price: "$0.005 USDC",
          network: "base",
          facilitator: "Coinbase CDP",
        },
      },
    },
  },
} as const;
