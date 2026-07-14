/**
 * F3 — Real quote engine backed by the Mento protocol
 * (@mento-protocol/mento-sdk@3.2.8, read-only: quotes only, never swaps).
 *
 * Boot-time discovery: for every corridor (KES, PHP, COP, NGN, BRL) we look
 * for a real on-chain route, preferring USDC -> <token> and falling back to
 * USDm -> <token> (treating USDC ~= USDm ~= 1 USD; see assumption below).
 * Only pairs with a route that is currently tradable (circuit breaker check)
 * are exposed.
 *
 * ASSUMPTION (documented per task): Mento regional stablecoins are treated as
 * 1 token == 1 unit of the local fiat currency (1 KESm == 1 KES). The
 * on-chain amountOut of <stablecoin>m therefore IS the fiat amount received.
 * Rates are quoted against USD (USDC/USDm both treated as $1).
 */
import { createRequire } from 'node:module';
import { formatUnits, parseUnits } from 'viem';
import type { Address, AppConfig } from './config.js';
import { buildQuote, type Quote, type QuoteEngine, UnsupportedPairError } from './quote.js';

/**
 * The tiny slice of the Mento SDK we use. Tests inject a fake; production
 * passes the real `Mento` instance (structurally compatible).
 */
export interface MentoLike {
  routes: { findRoute(tokenIn: string, tokenOut: string): Promise<unknown> };
  trading: { isPairTradable(tokenIn: string, tokenOut: string): Promise<boolean> };
  quotes: { getAmountOut(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<bigint> };
}

export interface DiscoveredPair {
  /** Fiat code exposed by the API, e.g. "KES". */
  fiat: string;
  /** Mento stablecoin symbol, e.g. "KESm". */
  stablecoin: string;
  tokenIn: Address;
  tokenInSymbol: 'USDC' | 'USDm';
  tokenInDecimals: number;
  tokenOut: Address;
}

/** Corridors we attempt to discover (fiat code -> stablecoin symbol). */
const CORRIDORS: ReadonlyArray<{ fiat: string; stablecoin: string }> = [
  { fiat: 'KES', stablecoin: 'KESm' },
  { fiat: 'PHP', stablecoin: 'PHPm' },
  { fiat: 'COP', stablecoin: 'COPm' },
  { fiat: 'NGN', stablecoin: 'NGNm' },
  { fiat: 'BRL', stablecoin: 'BRLm' },
];

interface CachedRate {
  rate: number;
  expiresAt: number;
}

export class MentoInitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MentoInitError';
  }
}

export class MentoQuoteEngine implements QuoteEngine {
  private readonly pairMap: Map<string, DiscoveredPair>;
  private readonly cache = new Map<string, CachedRate>();

  private constructor(
    private readonly mento: MentoLike,
    pairs: DiscoveredPair[],
    private readonly cacheTtlMs = 60_000,
  ) {
    this.pairMap = new Map(pairs.map((p) => [p.fiat, p]));
  }

  /**
   * Creates the engine and runs on-chain route discovery. Throws
   * MentoInitError when the RPC is unreachable or no pair has a route
   * (caller falls back to the mock engine — see engine.ts).
   */
  static async create(
    config: AppConfig,
    mentoOverride?: MentoLike,
    cacheTtlMs = 60_000,
  ): Promise<MentoQuoteEngine> {
    let mento: MentoLike;
    if (mentoOverride) {
      mento = mentoOverride;
    } else {
      try {
        // The SDK's ESM build ships extensionless imports under
        // "type": "commonjs" — unloadable by Node ESM. Load the (working)
        // CJS build lazily instead; tests inject a fake and never reach this.
        const require = createRequire(import.meta.url);
        const { Mento } =
          require('@mento-protocol/mento-sdk') as typeof import('@mento-protocol/mento-sdk');
        mento = (await Mento.create(
          config.network.chainId,
          config.network.rpcUrl,
        )) as unknown as MentoLike;
      } catch (err) {
        throw new MentoInitError(
          `Mento SDK init failed on ${config.network.name} (${config.network.rpcUrl}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    const pairs = await MentoQuoteEngine.discoverPairs(config, mento);
    if (pairs.length === 0) {
      throw new MentoInitError(
        `No tradable Mento routes discovered on ${config.network.name} — ` +
          'falling back to mock is expected on networks without regional pools.',
      );
    }
    console.log(
      `[mento] discovered pairs on ${config.network.name}: ` +
        pairs.map((p) => `${p.tokenInSymbol}->${p.stablecoin}`).join(', '),
    );
    return new MentoQuoteEngine(mento, pairs, cacheTtlMs);
  }

  /**
   * For each corridor, keep the first input token with a real, currently
   * tradable route: USDC first (what x402 collects), USDm as fallback
   * (USDC ~= USDm 1:1 assumption, ARQUITECTURA §2.4).
   */
  private static async discoverPairs(
    config: AppConfig,
    mento: MentoLike,
  ): Promise<DiscoveredPair[]> {
    const usdc = config.network.usdc;
    const usdm = config.network.stablecoins.USDm;
    const candidates: Array<{ symbol: 'USDC' | 'USDm'; address: Address; decimals: number }> = [
      { symbol: 'USDC', address: usdc.token, decimals: usdc.decimals },
    ];
    if (usdm) {
      candidates.push({ symbol: 'USDm', address: usdm, decimals: 18 });
    }

    const pairs: DiscoveredPair[] = [];
    for (const corridor of CORRIDORS) {
      const tokenOut = config.network.stablecoins[corridor.stablecoin];
      if (!tokenOut) continue;

      for (const input of candidates) {
        try {
          await mento.routes.findRoute(input.address, tokenOut);
          const tradable = await mento.trading.isPairTradable(input.address, tokenOut);
          if (!tradable) {
            console.warn(
              `[mento] ${input.symbol}->${corridor.stablecoin}: route exists but circuit ` +
                'breaker is closed, skipping',
            );
            continue;
          }
          pairs.push({
            fiat: corridor.fiat,
            stablecoin: corridor.stablecoin,
            tokenIn: input.address,
            tokenInSymbol: input.symbol,
            tokenInDecimals: input.decimals,
            tokenOut,
          });
          break; // corridor resolved; do not try the fallback input
        } catch {
          // No route for this input token — try the next candidate.
        }
      }
    }
    return pairs;
  }

  get pairs(): DiscoveredPair[] {
    return [...this.pairMap.values()];
  }

  /**
   * The underlying Mento client, so F-EXEC (remit.ts) can build swaps against
   * the SAME instance that discovered these routes instead of re-initialising
   * the SDK. Read-only from this class's point of view: the quote engine never
   * swaps.
   */
  get client(): MentoLike {
    return this.mento;
  }

  supportedCurrencies(): string[] {
    return [...this.pairMap.keys()];
  }

  async getQuote(amountUSD: number, target: string): Promise<Quote> {
    const pair = this.pairMap.get(target);
    if (!pair) {
      throw new UnsupportedPairError(target, this.supportedCurrencies());
    }
    const rate = await this.getRate(pair, amountUSD);
    return buildQuote(amountUSD, target, rate);
  }

  /**
   * On-chain rate per pair, cached 60s. The rate is derived from a real
   * `getAmountOut` for the requested amount on cache miss and reused for
   * subsequent amounts within the TTL (same semantics as the mock engine).
   */
  private async getRate(pair: DiscoveredPair, amountUSD: number): Promise<number> {
    const now = Date.now();
    const cached = this.cache.get(pair.fiat);
    if (cached && cached.expiresAt > now) {
      return cached.rate;
    }

    const amountIn = parseUnits(amountUSD.toString(), pair.tokenInDecimals);
    const amountOut = await this.mento.quotes.getAmountOut(pair.tokenIn, pair.tokenOut, amountIn);
    // 1 regional stablecoin == 1 fiat unit (documented assumption above).
    const receives = Number(formatUnits(amountOut, 18));
    const rate = receives / amountUSD;

    this.cache.set(pair.fiat, { rate, expiresAt: now + this.cacheTtlMs });
    return rate;
  }
}
