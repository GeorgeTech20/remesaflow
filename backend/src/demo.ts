/**
 * F8 — Demo mode (decision B): POST /api/demo/quote
 *
 * Judge-friendly, frictionless flow for the landing: the server consumes its
 * OWN x402-protected GET /api/quote using DEMO_PRIVATE_KEY, so every demo
 * query still produces a real x402 payment (402 -> sign EIP-3009 -> retry
 * with PAYMENT-SIGNATURE -> facilitator verify/settle) — the visitor just
 * never has to hold a wallet. Same payAndFetch pattern as bot/src/payment.ts.
 *
 * - Enabled behind DEMO_MODE=true (see config.ts). Otherwise the route
 *   simply does not exist (404).
 * - Limited to DEMO_LIMIT (5) successful quotes per IP per 24h.
 * - X402_ENABLED=false (dev): the internal call is a plain fetch, txHash null.
 * - X402_ENABLED=true without DEMO_PRIVATE_KEY: route answers 503
 *   demo_unavailable (we cannot pay ourselves without a key).
 *
 * Response shape: the /api/quote Quote JSON plus
 *   { txHash: string | null, demo: true, remainingDemoQueries: number }.
 */
import { ExactEvmScheme } from '@x402/evm';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import type { Hono } from 'hono';
import { privateKeyToAccount } from 'viem/accounts';
import type { AppConfig } from './config.js';
import { clientIp } from './ratelimit.js';

/** Max successful demo quotes per IP per window. */
export const DEMO_LIMIT = 5;
const DEMO_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Dummy origin for the internal self-call (never leaves the process). */
const SELF_ORIGIN = 'http://demo.internal';

/** Minimal fetch-like signature satisfied by both fetch and Hono app.request. */
export type SelfFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface DemoOptions {
  config: AppConfig;
  /** How the demo route reaches its own paid endpoint (app.request in app.ts). */
  selfFetch: SelfFetch;
  /** Test seams. */
  limit?: number;
  windowMs?: number;
}

/**
 * Extracts the on-chain tx hash from the x402 receipt header
 * (PAYMENT-RESPONSE in v2, X-PAYMENT-RESPONSE in v1): base64 JSON with a
 * `transaction` field. Degraded/dev responses have no header or an empty
 * transaction -> null. Exported for tests.
 */
export function txHashFromPaymentResponse(headers: Headers): string | null {
  const raw = headers.get('PAYMENT-RESPONSE') ?? headers.get('X-PAYMENT-RESPONSE');
  if (!raw) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    const tx = (decoded as { transaction?: unknown } | null)?.transaction;
    return typeof tx === 'string' && tx.length > 0 ? tx : null;
  } catch {
    return null;
  }
}

/** Builds the fetch that pays our own endpoint (or plain fetch in dev). */
function buildPaidFetch(config: AppConfig, selfFetch: SelfFetch): SelfFetch | null {
  if (!config.x402Enabled) {
    // Dev: /api/quote is free, plain self-call is enough.
    return selfFetch;
  }
  if (!config.demoPrivateKey) {
    console.warn(
      '[demo] DEMO_MODE=true with X402_ENABLED=true but DEMO_PRIVATE_KEY is missing -> ' +
        'POST /api/demo/quote will answer 503 demo_unavailable.',
    );
    return null;
  }
  const account = privateKeyToAccount(config.demoPrivateKey as `0x${string}`);
  console.log(`[demo] x402 demo payer enabled — wallet ${account.address}`);
  return wrapFetchWithPaymentFromConfig(selfFetch as typeof fetch, {
    // Only our configured network — never pay on anything else.
    schemes: [{ network: config.network.x402.network, client: new ExactEvmScheme(account) }],
  }) as SelfFetch;
}

/** Registers POST /api/demo/quote on the app. Call only when DEMO_MODE=true. */
export function registerDemoRoutes(app: Hono, options: DemoOptions): void {
  const limit = options.limit ?? DEMO_LIMIT;
  const windowMs = options.windowMs ?? DEMO_WINDOW_MS;
  const paidFetch = buildPaidFetch(options.config, options.selfFetch);
  const buckets = new Map<string, { count: number; resetAt: number }>();

  app.post('/api/demo/quote', async (c) => {
    if (!paidFetch) {
      return c.json(
        {
          error: 'demo_unavailable',
          message: 'Demo mode is enabled but the server has no demo wallet configured',
        },
        503,
      );
    }

    const ip = clientIp(c);
    const now = Date.now();
    let bucket = buckets.get(ip);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(ip, bucket);
    }
    if (bucket.count >= limit) {
      return c.json(
        {
          error: 'demo_limit_reached',
          message: `Max ${limit} demo quotes per IP per 24h`,
          remainingDemoQueries: 0,
          retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000),
        },
        429,
      );
    }

    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const amount = Number((body as { amount?: unknown }).amount);
    const to = String((body as { to?: unknown }).to ?? '').toUpperCase();

    // Validation happens in /api/quote; we just forward its 4xx untouched.
    let inner: Response;
    try {
      inner = await paidFetch(
        `${SELF_ORIGIN}/api/quote?amount=${encodeURIComponent(amount)}&to=${encodeURIComponent(to)}`,
      );
    } catch (err) {
      // Signing/facilitator failure: never leak details beyond the log.
      console.error(`[demo] internal paid call failed: ${err instanceof Error ? err.message : err}`);
      return c.json(
        { error: 'demo_payment_failed', message: 'Demo payment could not be completed' },
        502,
      );
    }

    if (inner.status === 402) {
      // We tried to pay our own endpoint and it still wants money.
      return c.json(
        { error: 'demo_unavailable', message: 'Demo payment was rejected by the x402 layer' },
        503,
      );
    }

    const json = (await inner.json().catch(() => null)) as Record<string, unknown> | null;
    if (!inner.ok || json === null) {
      return c.json(json ?? { error: 'upstream_error' }, inner.status as 400);
    }

    bucket.count += 1; // Only successful quotes consume the demo allowance.
    return c.json({
      ...json,
      txHash: txHashFromPaymentResponse(inner.headers),
      demo: true,
      remainingDemoQueries: limit - bucket.count,
    });
  });
}
