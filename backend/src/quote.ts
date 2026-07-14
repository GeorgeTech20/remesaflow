/**
 * Quote engine. The MockQuoteEngine sits behind the QuoteEngine interface;
 * MentoQuoteEngine (quote-mento.ts) implements the same interface with
 * on-chain rates. Both share the exact same comparison formula (buildQuote).
 */

export interface Quote {
  send: number;
  currency: string;
  receives: number;
  rate: number;
  celoFee: number;
  wuWouldCharge: number;
  wiseWouldCharge: number;
  savings: number;
  timestamp: string;
}

export interface QuoteEngine {
  getQuote(amountUSD: number, target: string): Promise<Quote>;
  /** Engines with on-chain discovery expose only pairs with a real route. */
  supportedCurrencies?(): string[];
}

export interface CurrencyInfo {
  code: string;
  name: string;
  country: string;
  flag: string;
  stablecoin: string;
}

// Current Mento naming: `m` suffix (KESm, PHPm, ...) — the old cKES/PUSO/cREAL
// names are the same contracts renamed (ARQUITECTURA §2.3).
export const CURRENCIES: CurrencyInfo[] = [
  { code: 'KES', name: 'Kenyan Shilling', country: 'Kenya', flag: '🇰🇪', stablecoin: 'KESm' },
  { code: 'PHP', name: 'Philippine Peso', country: 'Philippines', flag: '🇵🇭', stablecoin: 'PHPm' },
  { code: 'BRL', name: 'Brazilian Real', country: 'Brazil', flag: '🇧🇷', stablecoin: 'BRLm' },
  { code: 'COP', name: 'Colombian Peso', country: 'Colombia', flag: '🇨🇴', stablecoin: 'COPm' },
  { code: 'NGN', name: 'Nigerian Naira', country: 'Nigeria', flag: '🇳🇬', stablecoin: 'NGNm' },
];

/** Mid-market mock rates (approx. July 2026), USD -> target. */
const BASE_RATES: Record<string, number> = {
  KES: 129,
  PHP: 56,
  BRL: 5.4,
  COP: 4100,
  NGN: 1550,
};

export const SUPPORTED_CURRENCIES: string[] = Object.keys(BASE_RATES);

/** Flat estimated on-chain fee in USD (CIP-64 tx paid in USDC is ~<$0.01;
 * we keep a conservative 2-cent estimate for the comparison). */
export const CELO_FEE_USD = 0.02;
/** Western Union: ~6% of the sent amount. */
export const WU_FEE_PCT = 0.06;
/** Wise: ~1.5% of the sent amount. */
export const WISE_FEE_PCT = 0.015;

export const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Shared quote formula: given a USD->target rate, computes receives + the
 * Western Union / Wise comparison. Used by both mock and Mento engines.
 */
export function buildQuote(amountUSD: number, currency: string, rate: number): Quote {
  const wuWouldCharge = round2(amountUSD * WU_FEE_PCT);
  return {
    send: amountUSD,
    currency,
    receives: round2(amountUSD * rate),
    rate,
    celoFee: CELO_FEE_USD,
    wuWouldCharge,
    wiseWouldCharge: round2(amountUSD * WISE_FEE_PCT),
    savings: round2(wuWouldCharge - CELO_FEE_USD),
    timestamp: new Date().toISOString(),
  };
}

export class UnsupportedPairError extends Error {
  readonly code = 'UNSUPPORTED_PAIR';
  constructor(
    readonly requested: string,
    readonly available: string[],
  ) {
    super(`Unsupported currency "${requested}". Available: ${available.join(', ')}`);
    this.name = 'UnsupportedPairError';
  }
}

interface CachedRate {
  rate: number;
  expiresAt: number;
}

export class MockQuoteEngine implements QuoteEngine {
  private readonly cache = new Map<string, CachedRate>();

  constructor(private readonly cacheTtlMs = 60_000) {}

  supportedCurrencies(): string[] {
    return [...SUPPORTED_CURRENCIES];
  }

  async getQuote(amountUSD: number, target: string): Promise<Quote> {
    return buildQuote(amountUSD, target, this.getRate(target));
  }

  /** Rate per pair is cached for cacheTtlMs (60s by default). */
  private getRate(currency: string): number {
    const base = BASE_RATES[currency];
    if (base === undefined) {
      throw new UnsupportedPairError(currency, SUPPORTED_CURRENCIES);
    }
    const now = Date.now();
    const cached = this.cache.get(currency);
    if (cached && cached.expiresAt > now) {
      return cached.rate;
    }
    // Simulate an on-chain spread: 0-1% below mid-market.
    const rate = round2(base * (1 - Math.random() * 0.01));
    this.cache.set(currency, { rate, expiresAt: now + this.cacheTtlMs });
    return rate;
  }
}
