/**
 * x402 self-payment test script for Polymarket Liquidity Intelligence API
 *
 * Usage:
 *   PRIVATE_KEY=0x... npx tsx test/client.ts
 *
 * Prerequisites:
 *   - wrangler dev running on localhost:8787
 *   - Test USDC on Base Sepolia (from Circle faucet)
 */
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error("ERROR: Set PRIVATE_KEY env var");
  console.error("  PRIVATE_KEY=0x... npx tsx test/client.ts");
  process.exit(1);
}

const API_BASE = process.env.API_BASE || "http://localhost:8787";

// --- Setup ---
const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(),
});
const signer = toClientEvmSigner(account, publicClient);
const client = new x402Client();
registerExactEvmScheme(client, { signer });
const fetchWithPay = wrapFetchWithPayment(fetch, client);

// --- Test cases ---
interface TestCase {
  name: string;
  url: string;
  expectStatus: number;
  validate?: (data: Record<string, unknown>) => { ok: boolean; msg: string };
}

// Known active high-liquidity market (Russia-Ukraine Ceasefire before GTA VI)
const ACTIVE_CONDITION_ID =
  "0x9c1a953fe92c8357f1b646ba25d983aa83e90c525992db14fb726fa895cb5763";

const tests: TestCase[] = [
  {
    name: "Active high-liquidity market — expect 200 + valid metrics",
    url: `${API_BASE}/api/v1/market/${ACTIVE_CONDITION_ID}`,
    expectStatus: 200,
    validate: (data) => {
      const metrics = data.metrics as Record<string, unknown> | undefined;
      if (!metrics) return { ok: false, msg: "Missing metrics" };

      const ss = metrics.spread_score as number;
      if (typeof ss !== "number" || ss < 0 || ss > 100)
        return { ok: false, msg: `spread_score out of range: ${ss}` };

      const di = metrics.depth_imbalance as number;
      if (typeof di !== "number" || di < -1 || di > 1)
        return { ok: false, msg: `depth_imbalance out of range: ${di}` };

      const fp = metrics.fill_probability as Record<string, unknown>;
      if (!fp || !fp["100"] || !fp["1000"] || !fp["10000"])
        return { ok: false, msg: "fill_probability missing tiers" };

      const se = metrics.slippage_estimate as Record<string, unknown>;
      if (!se || !se["100"] || !se["1000"] || !se["10000"])
        return { ok: false, msg: "slippage_estimate missing tiers" };

      const rating = data.liquidity_rating as string;
      const validRatings = ["EXCELLENT", "GOOD", "FAIR", "POOR", "DEAD"];
      if (!validRatings.includes(rating))
        return { ok: false, msg: `Invalid rating: ${rating}` };

      return { ok: true, msg: "All metrics valid" };
    },
  },
  {
    name: "Invalid conditionId format — expect 400",
    url: `${API_BASE}/api/v1/market/not-a-hex-string`,
    expectStatus: 400,
  },
  {
    name: "Nonexistent market — expect 404",
    url: `${API_BASE}/api/v1/market/0x0000000000000000000000000000000000000000000000000000000000000001`,
    expectStatus: 404,
  },
];

async function main() {
  console.log("=== Polymarket Liquidity API — x402 E2E Tests ===");
  console.log(`Wallet: ${account.address}\n`);

  let passed = 0;
  let failed = 0;

  for (const t of tests) {
    console.log(`--- ${t.name} ---`);
    const start = Date.now();

    try {
      const res = await fetchWithPay(t.url);
      const elapsed = Date.now() - start;
      const data = (await res.json()) as Record<string, unknown>;
      let ok = res.status === t.expectStatus;

      console.log(
        `  Status: ${res.status} (expected ${t.expectStatus}) ${ok ? "\u2713" : "\u2717 MISMATCH"}`,
      );
      console.log(`  Time:   ${elapsed}ms`);

      if (res.status === 200) {
        const market = data.market as Record<string, unknown>;
        console.log(`  Market: ${market?.question}`);
        console.log(`  Rating: ${data.liquidity_rating}`);
        console.log(`  Summary: ${data.summary}`);

        const metrics = data.metrics as Record<string, unknown>;
        console.log(`  spread_score: ${metrics?.spread_score}`);
        console.log(`  depth_imbalance: ${metrics?.depth_imbalance}`);

        // Run validation
        if (t.validate) {
          const result = t.validate(data);
          console.log(`  Validation: ${result.msg} ${result.ok ? "\u2713" : "\u2717"}`);
          if (!result.ok) ok = false;
        }
      } else {
        console.log(`  Body: ${JSON.stringify(data)}`);
      }

      if (ok) passed++;
      else failed++;
    } catch (err) {
      console.log(`  ERROR: ${err}`);
      failed++;
    }
    console.log("");
  }

  // --- Cache test: repeat same request, expect cached=true ---
  console.log("--- Cache test: same market again (expect cached=true) ---");
  const cacheUrl = `${API_BASE}/api/v1/market/${ACTIVE_CONDITION_ID}`;
  const cStart = Date.now();
  const cRes = await fetchWithPay(cacheUrl);
  const cElapsed = Date.now() - cStart;
  const cData = (await cRes.json()) as Record<string, unknown>;
  const isCached = cData.cached === true;
  const ageOk =
    typeof cData.data_age_seconds === "number" &&
    (cData.data_age_seconds as number) >= 0;

  console.log(`  Status: ${cRes.status} ${cRes.status === 200 ? "\u2713" : "\u2717"}`);
  console.log(`  Time:   ${cElapsed}ms`);
  console.log(
    `  Cached: ${cData.cached} ${isCached ? "\u2713" : "\u2717 expected true"}`,
  );
  console.log(
    `  Age:    ${cData.data_age_seconds}s ${ageOk ? "\u2713" : "\u2717"}`,
  );

  if (isCached && ageOk) passed++;
  else failed++;
  console.log("");

  console.log(`=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
