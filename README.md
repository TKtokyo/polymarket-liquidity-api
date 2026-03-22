# Polymarket Liquidity API

x402-powered paid API that returns real-time order book depth, spread analysis, and market efficiency scoring for any Polymarket prediction market.

**Live:** `https://polymarket-liquidity-api.tatsu77.workers.dev`

## How It Works

```
Client → GET /api/v1/market/{conditionId}
       ← 402 Payment Required (USDC via x402)
       → Payment header + retry
       ← 200 { market, orderbook, metrics, liquidity_rating, summary }
```

One HTTP request, one microtransaction ($0.005 USDC), one structured response.

## API

### `GET /api/v1/market/{conditionId}`

**Payment:** $0.005 USDC via x402 protocol (Base)

**Path parameters:**
| Parameter | Description |
|---|---|
| `conditionId` | Polymarket condition ID (`0x`-prefixed 64-char hex string) |

**Response (200):**

```json
{
  "market": {
    "condition_id": "0x9c1a953fe92c8357f1b646ba25d983aa83e90c525992db14fb726fa895cb5763",
    "question": "Russia-Ukraine Ceasefire before GTA VI?",
    "outcomes": ["Yes", "No"],
    "token_ids": ["8501497...", "2527312..."],
    "end_date": "2026-07-31"
  },
  "orderbook": {
    "best_bid": 0.55,
    "best_ask": 0.56,
    "midpoint": 0.555,
    "spread": 0.01,
    "tick_size": 0.01,
    "bid_levels": 51,
    "ask_levels": 29,
    "last_trade_price": 0.44
  },
  "metrics": {
    "spread_score": 100,
    "depth_imbalance": 0.42,
    "fill_probability": {
      "100":   { "bid": 1.0,  "ask": 1.0  },
      "1000":  { "bid": 1.0,  "ask": 1.0  },
      "10000": { "bid": 0.85, "ask": 0.62 }
    },
    "slippage_estimate": {
      "100":   { "bid": 0.0000, "ask": 0.0000 },
      "1000":  { "bid": 0.0018, "ask": 0.0045 },
      "10000": { "bid": 0.0120, "ask": 0.0310 }
    }
  },
  "liquidity_rating": "GOOD",
  "summary": "GOOD liquidity. Tight spread (1 tick). Moderate bid-side bias.",
  "cached": false,
  "data_age_seconds": 0
}
```

**Error responses:**

| Status | Error | Description |
|---|---|---|
| 400 | `invalid_condition_id` | Condition ID format invalid |
| 402 | Payment Required | x402 payment needed |
| 404 | `market_not_found` | No market for this condition ID |
| 429 | `upstream_throttled` | Polymarket rate limited (retry in 15s) |
| 503 | `upstream_error` | Upstream API unavailable |

### `GET /health`

Returns `{ "status": "ok", "version": "1.0.0" }`. No payment required.

### `GET /openapi.json`

OpenAPI 3.0 specification. No payment required.

https://polymarket-liquidity-api.tatsu77.workers.dev/openapi.json

## Scoring Logic

### Composite Rating

The `liquidity_rating` is a composite of three metrics:

```
composite = spread_score × 0.5 + balance_score × 0.3 + fill_score × 0.2
```

| Rating | Composite Score |
|---|---|
| **EXCELLENT** | 85+ |
| **GOOD** | 65-84 |
| **FAIR** | 40-64 |
| **POOR** | 15-39 |
| **DEAD** | 0-14 |

### Metrics

**spread_score** (0-100): Based on bid-ask spread in tick units.

| Spread (ticks) | Score |
|---|---|
| 1 | 100 |
| 2 | 90 |
| 3-5 | 70 |
| 6-10 | 50 |
| 11-20 | 25 |
| 20+ | `max(0, 100 - ticks × 5)` |

**depth_imbalance** (-1 to +1): Dollar-weighted bid vs ask depth. `(bidDepth - askDepth) / total`. Positive = bid-heavy, negative = ask-heavy.

**fill_probability**: Fraction of $100 / $1,000 / $10,000 order fillable from current depth (0.0 to 1.0 per side).

**slippage_estimate**: VWAP-based slippage vs midpoint for each tier. `null` if less than 50% fillable.

## Quick Start (Client)

```typescript
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";

const account = privateKeyToAccount("0xYOUR_PRIVATE_KEY");
const publicClient = createPublicClient({ chain: base, transport: http() });
const signer = toClientEvmSigner(account, publicClient);

const client = new x402Client();
registerExactEvmScheme(client, { signer });
const fetchWithPay = wrapFetchWithPayment(fetch, client);

const res = await fetchWithPay(
  "https://polymarket-liquidity-api.tatsu77.workers.dev/api/v1/market/0x9c1a953fe92c8357f1b646ba25d983aa83e90c525992db14fb726fa895cb5763"
);
const data = await res.json();
console.log(data.liquidity_rating, data.summary);
```

**Prerequisites:** USDC on Base from [Circle Faucet](https://faucet.circle.com) (testnet) or any exchange (mainnet).

## Development

```bash
# Install
npm install

# Local dev (uses .dev.vars for secrets)
npm run dev

# Deploy (testnet)
npx wrangler deploy

# Deploy (mainnet, requires CDP keys)
npx wrangler deploy --env production
```

### Environment Variables

Set via `wrangler secret put`:

| Variable | Required | Description |
|---|---|---|
| `PAY_TO_ADDRESS` | Yes | EOA address to receive USDC payments |
| `CDP_API_KEY_ID` | Production | Coinbase Developer Platform key ID |
| `CDP_API_KEY_SECRET` | Production | CDP key secret (for mainnet facilitator) |

## Architecture

```
Cloudflare Workers (Hono)
  ├── x402 Payment Middleware (@x402/hono)
  ├── Bazaar Discovery Extension (@x402/extensions/bazaar)
  ├── Cache Layer (Cloudflare KV, 5min TTL)
  ├── Polymarket CLOB API (upstream data)
  ├── Deterministic Liquidity Scoring (rule-based)
  ├── MCP Server (tool discovery)
  └── OpenAPI 3.0 Spec
```

## Discovery

- **OpenAPI:** https://polymarket-liquidity-api.tatsu77.workers.dev/openapi.json
- **llms.txt:** https://polymarket-liquidity-api.tatsu77.workers.dev/llms.txt
- **x402 metadata:** https://polymarket-liquidity-api.tatsu77.workers.dev/.well-known/x402
- **MCP endpoint:** `POST /mcp` (Streamable HTTP transport)

## License

MIT
