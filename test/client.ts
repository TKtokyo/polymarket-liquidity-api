/**
 * x402 self-payment test script
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
}

interface ExpectScoring {
  minScore?: number;
  maxScore?: number;
  expectLevel?: string;
}

const tests: (TestCase & { scoring?: ExpectScoring })[] = [
  {
    name: "USDC (Ethereum) — expect LOW risk",
    url: `${API_BASE}/api/v1/token/1/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`,
    expectStatus: 200,
    scoring: { minScore: 50 },
  },
  {
    name: "PEPE (Ethereum) — expect LOW/MODERATE risk",
    url: `${API_BASE}/api/v1/token/1/0x6982508145454Ce325dDbE47a25d4ec3d2311933`,
    expectStatus: 200,
    scoring: { minScore: 50 },
  },
  {
    name: "Honeypot (DokiDokiAzuki) — expect CRITICAL score=0",
    url: `${API_BASE}/api/v1/token/1/0x910524678C0B1B23FFB9285a81f99C29C11CBaEd`,
    expectStatus: 200,
    scoring: { maxScore: 0, expectLevel: "CRITICAL" },
  },
  {
    name: "Nonexistent token — expect 404",
    url: `${API_BASE}/api/v1/token/1/0x0000000000000000000000000000000000000001`,
    expectStatus: 404,
  },
];

async function main() {
  console.log("=== x402 E2E Tests ===");
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
        `  Status: ${res.status} (expected ${t.expectStatus}) ${ok ? "✓" : "✗ MISMATCH"}`,
      );
      console.log(`  Time:   ${elapsed}ms`);

      if (res.status === 200) {
        const token = data.token as Record<string, string>;
        console.log(`  Token:  ${token?.name} (${token?.symbol})`);
        console.log(`  Score:  ${data.risk_score} ${data.risk_level}`);
        console.log(`  Summary: ${data.summary}`);

        // Validate scoring expectations
        if (t.scoring) {
          const score = data.risk_score as number;
          const level = data.risk_level as string;
          if (t.scoring.minScore !== undefined && score < t.scoring.minScore) {
            console.log(`  ✗ Score ${score} < expected min ${t.scoring.minScore}`);
            ok = false;
          }
          if (t.scoring.maxScore !== undefined && score > t.scoring.maxScore) {
            console.log(`  ✗ Score ${score} > expected max ${t.scoring.maxScore}`);
            ok = false;
          }
          if (t.scoring.expectLevel && level !== t.scoring.expectLevel) {
            console.log(`  ✗ Level "${level}" ≠ expected "${t.scoring.expectLevel}"`);
            ok = false;
          }
          if (!ok) {
            console.log(`  Scoring check: FAILED`);
          } else {
            console.log(`  Scoring check: ✓`);
          }
        }
      } else {
        console.log(`  Body:   ${JSON.stringify(data)}`);
      }

      if (ok) passed++;
      else failed++;
    } catch (err) {
      console.log(`  ERROR: ${err}`);
      failed++;
    }
    console.log("");
  }

  // --- Cache test: repeat USDC request, expect cached=true ---
  console.log("--- Cache test: USDC again (expect cached=true) ---");
  const cacheUrl = `${API_BASE}/api/v1/token/1/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`;
  const cStart = Date.now();
  const cRes = await fetchWithPay(cacheUrl);
  const cElapsed = Date.now() - cStart;
  const cData = (await cRes.json()) as Record<string, unknown>;
  const isCached = cData.cached === true;
  const ageOk =
    typeof cData.data_age_seconds === "number" && cData.data_age_seconds >= 0;

  console.log(`  Status: ${cRes.status} ${cRes.status === 200 ? "✓" : "✗"}`);
  console.log(`  Time:   ${cElapsed}ms`);
  console.log(
    `  Cached: ${cData.cached} ${isCached ? "✓" : "✗ expected true"}`,
  );
  console.log(
    `  Age:    ${cData.data_age_seconds}s ${ageOk ? "✓" : "✗"}`,
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
