/**
 * Unit tests for payAndFetch — no network, no real funds.
 * The x402 flow is exercised against a mocked fetch; payment signing uses an
 * ephemeral private key generated per test run.
 *
 * Run: npm test  (tsx --test)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createPayAndFetch, PaymentRequiredError } from "./payment";

const QUOTE_URL = "http://localhost:3000/api/quote?amount=50&to=KES";
// Celo Sepolia USDC (verified on-chain vs FeeCurrencyDirectory — the address
// the official skills list is wrong; see ARQUITECTURA.md 1.5), 6 decimals.
const USDC_SEPOLIA = "0x01C5C0122039549AD1493B8220cABEdD739BC44E";
const PAY_TO = "0x1111111111111111111111111111111111111111";

function paymentRequiredBody(amount = "10000") {
  return {
    x402Version: 2,
    error: "PAYMENT-SIGNATURE header is required",
    resource: { url: "http://localhost:3000/api/quote" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:11142220",
        amount,
        payTo: PAY_TO,
        maxTimeoutSeconds: 60,
        asset: USDC_SEPOLIA,
        extra: { name: "USDC", version: "2" },
      },
    ],
  };
}

function res402(amount?: string): Response {
  const body = paymentRequiredBody(amount);
  // x402 v2 transports the PaymentRequired object in the PAYMENT-REQUIRED
  // header (base64 JSON); the JSON body alone is only honored for v1.
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: {
      "content-type": "application/json",
      "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(body), "utf8").toString("base64"),
    },
  });
}

function res200(): Response {
  return new Response(JSON.stringify({ send: 50, currency: "KES", receives: 6450 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** fetch mock that replays queued responses and records the requests it saw. */
function mockFetch(responses: Response[]) {
  const seen: Request[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Request(input, init));
    const next = responses.shift();
    if (!next) throw new Error("mockFetch: no more queued responses");
    return next;
  }) as typeof fetch;
  return { impl, seen };
}

test("degraded mode (no key): 402 -> PaymentRequiredError(wallet-not-configured)", async () => {
  const { impl } = mockFetch([res402()]);
  const payAndFetch = createPayAndFetch({ fetchImpl: impl });

  await assert.rejects(
    () => payAndFetch(QUOTE_URL),
    (err: unknown) =>
      err instanceof PaymentRequiredError && err.reason === "wallet-not-configured",
  );
});

test("degraded mode (no key): non-402 passes through", async () => {
  const { impl } = mockFetch([res200()]);
  const payAndFetch = createPayAndFetch({ fetchImpl: impl });

  const res = await payAndFetch(QUOTE_URL);
  assert.equal(res.status, 200);
});

test("402 -> signs EIP-3009 payload with ephemeral key -> retries with PAYMENT-SIGNATURE", async () => {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const { impl, seen } = mockFetch([res402(), res200()]);

  const payAndFetch = createPayAndFetch({
    privateKey,
    network: "celo-sepolia",
    fetchImpl: impl,
  });

  const res = await payAndFetch(QUOTE_URL);
  assert.equal(res.status, 200);
  assert.equal(seen.length, 2, "expected initial request + paid retry");

  // First request: no payment header.
  assert.equal(seen[0].headers.get("PAYMENT-SIGNATURE"), null);

  // Retry: signed x402 v2 payload in PAYMENT-SIGNATURE (base64 JSON).
  const header = seen[1].headers.get("PAYMENT-SIGNATURE");
  assert.ok(header, "retry must carry PAYMENT-SIGNATURE header");
  const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));

  assert.equal(decoded.x402Version, 2);
  assert.equal(decoded.accepted.scheme, "exact");
  assert.equal(decoded.accepted.network, "eip155:11142220");
  assert.equal(decoded.accepted.asset, USDC_SEPOLIA);

  const { signature, authorization } = decoded.payload;
  assert.match(signature, /^0x[0-9a-fA-F]{130}$/, "65-byte hex signature");
  assert.equal(authorization.from.toLowerCase(), account.address.toLowerCase());
  assert.equal(authorization.to.toLowerCase(), PAY_TO.toLowerCase());
  assert.equal(authorization.value, "10000");
});

test("server asks above the cap -> amount-over-cap, nothing signed or sent", async () => {
  const { impl, seen } = mockFetch([res402("999999999")]);
  const payAndFetch = createPayAndFetch({
    privateKey: generatePrivateKey(),
    maxPaymentBaseUnits: 100_000n,
    fetchImpl: impl,
  });

  await assert.rejects(
    () => payAndFetch(QUOTE_URL),
    (err: unknown) => err instanceof PaymentRequiredError && err.reason === "amount-over-cap",
  );
  assert.equal(seen.length, 1, "must not retry with a payment when over cap");
});

test("payment sent but still 402 -> payment-rejected", async () => {
  const { impl } = mockFetch([res402(), res402()]);
  const payAndFetch = createPayAndFetch({
    privateKey: generatePrivateKey(),
    fetchImpl: impl,
  });

  await assert.rejects(
    () => payAndFetch(QUOTE_URL),
    (err: unknown) => err instanceof PaymentRequiredError && err.reason === "payment-rejected",
  );
});
