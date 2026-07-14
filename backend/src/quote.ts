/**
 * Quote engine. The MockQuoteEngine sits behind the QuoteEngine interface so
 * ARQUI can swap in a real Mento-based implementation without touching routes.
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
}

export interface CurrencyInfo {
  code: string;
  name: string;
  country: string;
  flag: string;
  stablecoin: string;
}

// NOTE(ARQUI): confirm real Mento stablecoin symbols (esp. PUSO vs cPHP).
export const CURRENCIES: CurrencyInfo[] = [
  { code: 'KES', name: 'Kenyan Shilling', country: 'Kenya', flag: '🇰🇪', stablecoin: 'cKES' },
  { code: 'PHP', name: 'Philippine Peso', country: 'Philippines', flag: '🇵🇭', stablecoin: 'PUSO' },
  { code: 'BRL', name: 'Brazilian Real', country: 'Brazil', flag: '🇧🇷', stablecoin: 'cREAL' },
  { code: 'COP', name: 'Colombian Peso', country: 'Colombia', flag: '🇨🇴', stablecoin: 'cCOP' },
  { code: 'NGN', name: 'Nigerian Naira', country: 'Nigeria', flag: '🇳🇬', stablecoin: 'cNGN' },
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

/** Flat mock on-chain fee in USD. */
const CELO_FEE_USD = 0.02;
/** Western Union: ~6% of the sent amount. */
const WU_FEE_PCT = 0.06;
/** Wise: ~1.5% of the sent amount. */
const WISE_FEE_PCT = 0.015;

const round2 = (n: number): number => Math.round(n * 100) / 100;

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

  async getQuote(amountUSD: number, target: string): Promise<Quote> {
    const rate = this.getRate(target);
    const wuWouldCharge = round2(amountUSD * WU_FEE_PCT);
    return {
      send: amountUSD,
      currency: target,
      receives: round2(amountUSD * rate),
      rate,
      celoFee: CELO_FEE_USD,
      wuWouldCharge,
      wiseWouldCharge: round2(amountUSD * WISE_FEE_PCT),
      savings: round2(wuWouldCharge - CELO_FEE_USD),
      timestamp: new Date().toISOString(),
    };
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
