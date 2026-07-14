/**
 * F4 — Real x402 payment middleware (@x402/hono v2 + Celo facilitator).
 *
 * - X402_ENABLED=false (default): passthrough for local dev.
 * - Enabled: HTTP 402 flow (scheme "exact", $0.01 USDC) against the Celo
 *   facilitator https://api.x402.celo.org. payTo = the agent wallet address.
 * - X402_FACILITATOR_API_KEY missing -> DEGRADED "verify-only" mode: /verify
 *   is open on the facilitator, but POST /settle requires an X-API-Key
 *   (ARQUITECTURA §1.2). We recover from the settle failure so the paid
 *   response still goes out, and log the query with txHash=null.
 * - Settle OK -> the facilitator broadcasts the tx; we log its txHash.
 *
 * The Celo facilitator only announces mainnet (eip155:42220); on Celo Sepolia
 * verify/settle are expected to be rejected — dev should keep X402_ENABLED=false
 * (ARQUITECTURA §1.4, R3).
 */
import type { MiddlewareHandler } from 'hono';
import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
import { HTTPFacilitatorClient, type RoutesConfig } from '@x402/core/server';
import type { SupportedResponse } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import type { Address, UsdcInfo } from './config.js';

/**
 * HTTPFacilitatorClient with a STATIC /supported response. The resource
 * server refuses to build payment requirements until it knows the facilitator
 * supports the scheme+network; fetching that at boot would break offline
 * dev/tests, so we declare it locally (mirrors the live answer of
 * api.x402.celo.org: x402Version 2, scheme "exact"). verify/settle still hit
 * the real facilitator per-request.
 */
class StaticSupportFacilitatorClient extends HTTPFacilitatorClient {
  constructor(
    config: ConstructorParameters<typeof HTTPFacilitatorClient>[0],
    private readonly staticNetwork: `eip155:${number}`,
  ) {
    super(config);
  }

  override async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: [{ x402Version: 2, scheme: 'exact', network: this.staticNetwork }],
      extensions: [],
      signers: {},
    };
  }
}

/** $0.01 in USDC base units (6 decimals). */
const PRICE_USDC_BASE_UNITS = '10000';

/** Info handed to the app whenever a payment settles (or degrades). */
export interface SettledPayment {
  /** On-chain tx hash from the facilitator, or null in degraded mode. */
  txHash: string | null;
  payer: string | null;
  /** Request path that was paid for, e.g. "/api/quote" or "/api/remit". */
  path: string;
  /** Query params of the paid request (amount, to, ...). */
  query: Record<string, string | string[]>;
  /** Best-effort client ip (x-forwarded-for). */
  ip: string | null;
}

export interface X402Options {
  enabled: boolean;
  /** Agent wallet address (getAgentAddress()). Required when enabled. */
  payTo: Address | null;
  /** CAIP-2 id, e.g. "eip155:42220". */
  network: `eip155:${number}`;
  facilitatorUrl: string;
  /** X-API-Key for POST /settle. Missing => verify-only degraded mode. */
  apiKey?: string | undefined;
  usdc: UsdcInfo;
  /** Called after settle (real or degraded) so the app can log the query. */
  onSettled?: (payment: SettledPayment) => void;
}

interface AdapterLike {
  getPath(): string;
  getQueryParams(): Record<string, string | string[]>;
  getHeader(name: string): string | undefined;
}

/** Pulls request info back out of the x402 transport context (Hono adapter). */
function requestInfo(transportContext: unknown): Pick<SettledPayment, 'query' | 'ip' | 'path'> {
  const request = (transportContext as { request?: { adapter?: AdapterLike } } | undefined)
    ?.request;
  const adapter = request?.adapter;
  if (!adapter) {
    return { query: {}, ip: null, path: '' };
  }
  const forwarded = adapter.getHeader('x-forwarded-for');
  return {
    path: adapter.getPath(),
    query: adapter.getQueryParams(),
    ip: forwarded ? (forwarded.split(',')[0]?.trim() ?? null) : null,
  };
}

/**
 * Builds the payment middleware for the paid route(s).
 * When disabled: passthrough. When enabled: full x402 v2 flow.
 */
export function x402(options: X402Options): MiddlewareHandler {
  if (!options.enabled) {
    console.log('x402 disabled - dev mode');
    return async (_c, next) => {
      await next();
    };
  }

  if (!options.payTo) {
    throw new Error(
      'X402_ENABLED=true requires AGENT_PRIVATE_KEY: payTo is the agent wallet address',
    );
  }
  const payTo = options.payTo;

  const facilitatorClient = new StaticSupportFacilitatorClient(
    {
      url: options.facilitatorUrl,
      ...(options.apiKey
        ? {
            createAuthHeaders: async () => ({
              verify: {},
              supported: {},
              settle: { 'X-API-Key': options.apiKey as string },
            }),
          }
        : {}),
    },
    options.network,
  );

  const server = new x402ResourceServer(facilitatorClient).register(
    options.network,
    new ExactEvmScheme(),
  );

  server.onAfterSettle(async (ctx) => {
    // Degraded recoveries come through onSettleFailure with an empty tx.
    if (!ctx.result.transaction) return;
    const info = requestInfo(ctx.transportContext);
    console.log(`[x402] settled: tx=${ctx.result.transaction} payer=${ctx.result.payer ?? '?'}`);
    options.onSettled?.({
      txHash: ctx.result.transaction,
      payer: ctx.result.payer ?? null,
      ...info,
    });
  });

  if (!options.apiKey) {
    console.warn(
      '[x402] X402_FACILITATOR_API_KEY not set -> DEGRADED verify-only mode: ' +
        'payments are verified but NOT settled on-chain (facilitator /settle needs an API key).',
    );
    server.onSettleFailure(async (ctx) => {
      console.warn(`[x402] settle failed (degraded mode, serving anyway): ${ctx.error.message}`);
      const info = requestInfo(ctx.transportContext);
      options.onSettled?.({ txHash: null, payer: null, ...info });
      return {
        recovered: true as const,
        result: {
          success: true,
          transaction: '',
          network: options.network,
          errorReason: 'degraded_no_facilitator_api_key',
        },
      };
    });
  }

  // Explicit AssetAmount: Celo is not in @x402/evm's default-stablecoin
  // registry, so a "$0.01" Money price would not parse. USDC, 6 decimals.
  const price = {
    asset: options.usdc.token,
    amount: PRICE_USDC_BASE_UNITS,
    extra: { name: 'USDC', version: '2' },
  };
  const accepts = {
    scheme: 'exact' as const,
    network: options.network,
    payTo,
    price,
    maxTimeoutSeconds: 60,
  };

  const routes: RoutesConfig = {
    'GET /api/quote': {
      accepts,
      description: 'Remittance quote USD -> local currency',
      mimeType: 'application/json',
    },
    // F-EXEC. Same $0.01 fee as a quote: the agent's revenue is the x402 fee,
    // NOT a spread on the remittance. The remitted value itself goes to the
    // recipient in full. GET /api/remit/:txHash (status) stays free.
    'POST /api/remit': {
      accepts,
      description: 'Execute a remittance: swap USD -> local stablecoin and deliver to recipient',
      mimeType: 'application/json',
    },
  };

  // syncFacilitatorOnStart=true is offline-safe here because getSupported()
  // is static (see StaticSupportFacilitatorClient); without the sync the
  // resource server refuses to build payment requirements.
  return paymentMiddleware(routes, server, undefined, undefined, true);
}
