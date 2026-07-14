export interface Currency {
  code: string;
  name: string;
  country: string;
  flag: string;
  stablecoin: string;
}

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

const API_BASE: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:3000';

const FETCH_TIMEOUT_MS = 5000;
/** The demo call includes a server-side x402 payment (sign + verify + settle). */
const DEMO_TIMEOUT_MS = 30_000;

/** Explorer base URL per backend network name (from GET /api/currencies). */
export const EXPLORERS: Record<string, string> = {
  celo: 'https://celoscan.io',
  'celo-sepolia': 'https://celo-sepolia.blockscout.com',
};

// ---------------------------------------------------------------------------
// Embedded mock data (same shape as the API) — used when backend is offline
// so the landing never looks broken.
// ---------------------------------------------------------------------------

export const MOCK_CURRENCIES: Currency[] = [
  { code: 'KES', name: 'Kenyan Shilling', country: 'Kenya', flag: '🇰🇪', stablecoin: 'cKES' },
  { code: 'PHP', name: 'Philippine Peso', country: 'Philippines', flag: '🇵🇭', stablecoin: 'PUSO' },
  { code: 'BRL', name: 'Brazilian Real', country: 'Brazil', flag: '🇧🇷', stablecoin: 'cREAL' },
  { code: 'COP', name: 'Colombian Peso', country: 'Colombia', flag: '🇨🇴', stablecoin: 'cCOP' },
  { code: 'NGN', name: 'Nigerian Naira', country: 'Nigeria', flag: '🇳🇬', stablecoin: 'cNGN' },
];

const MOCK_RATES: Record<string, number> = {
  KES: 128.41,
  PHP: 58.72,
  BRL: 5.43,
  COP: 4102.35,
  NGN: 1534.2,
};

function mockQuote(amount: number, to: string): Quote {
  const rate = MOCK_RATES[to] ?? 1;
  const wu = Math.max(2.99, amount * 0.06);
  const wise = Math.max(0.75, amount * 0.015);
  const celoFee = 0.02;
  return {
    send: amount,
    currency: to,
    receives: Math.round(amount * rate * 100) / 100,
    rate,
    celoFee,
    wuWouldCharge: Math.round(wu * 100) / 100,
    wiseWouldCharge: Math.round(wise * 100) / 100,
    savings: Math.round((wu - celoFee) * 100) / 100,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Fetch helpers — every call resolves; `demo: true` means mock fallback used.
// ---------------------------------------------------------------------------

export interface ApiResult<T> {
  data: T;
  demo: boolean;
}

async function fetchJson<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}${path}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export interface CurrenciesResult extends ApiResult<Currency[]> {
  /** Backend network name ("celo" | "celo-sepolia"), null when using mocks. */
  network: string | null;
}

export async function getCurrencies(): Promise<CurrenciesResult> {
  try {
    const json = await fetchJson<{ currencies: Currency[]; network?: string }>('/api/currencies');
    if (!Array.isArray(json.currencies) || json.currencies.length === 0) throw new Error('empty');
    return { data: json.currencies, demo: false, network: json.network ?? null };
  } catch {
    return { data: MOCK_CURRENCIES, demo: true, network: null };
  }
}

export async function getQuote(amount: number, to: string): Promise<ApiResult<Quote>> {
  try {
    const json = await fetchJson<Quote>(
      `/api/quote?amount=${encodeURIComponent(amount)}&to=${encodeURIComponent(to)}`,
    );
    if (typeof json.receives !== 'number') throw new Error('bad shape');
    return { data: json, demo: false };
  } catch {
    return { data: mockQuote(amount, to), demo: true };
  }
}

// ---------------------------------------------------------------------------
// F8 — demo x402 flow: POST /api/demo/quote. The backend pays its own paid
// endpoint with a server demo wallet, so each demo quote is a real x402
// payment without asking the visitor for a wallet. 5 quotes per IP per 24h.
// ---------------------------------------------------------------------------

export interface DemoQuote extends Quote {
  /** On-chain settlement tx, null in dev/degraded (verify-only) mode. */
  txHash: string | null;
  demo: true;
  remainingDemoQueries: number;
}

export type DemoQuoteResult =
  | { status: 'ok'; quote: DemoQuote }
  /** 429: this IP used its 5 demo quotes. */
  | { status: 'limit'; retryAfterSeconds?: number }
  /** Demo route missing/disabled/broken — caller should fall back. */
  | { status: 'unavailable' }
  /** 400 from the quote validation (bad amount/currency). */
  | { status: 'invalid' };

export async function getDemoQuote(amount: number, to: string): Promise<DemoQuoteResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEMO_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/api/demo/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount, to }),
      signal: controller.signal,
    });
    if (res.status === 429) {
      const body = (await res.json().catch(() => null)) as { retryAfterSeconds?: number } | null;
      return { status: 'limit', retryAfterSeconds: body?.retryAfterSeconds };
    }
    if (res.status === 400) return { status: 'invalid' };
    if (!res.ok) return { status: 'unavailable' };
    const json = (await res.json()) as DemoQuote;
    if (typeof json.receives !== 'number' || json.demo !== true) return { status: 'unavailable' };
    return { status: 'ok', quote: json };
  } catch {
    return { status: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
}

export { API_BASE };
