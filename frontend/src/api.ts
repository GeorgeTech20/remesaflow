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

export async function getCurrencies(): Promise<ApiResult<Currency[]>> {
  try {
    const json = await fetchJson<{ currencies: Currency[] }>('/api/currencies');
    if (!Array.isArray(json.currencies) || json.currencies.length === 0) throw new Error('empty');
    return { data: json.currencies, demo: false };
  } catch {
    return { data: MOCK_CURRENCIES, demo: true };
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

export { API_BASE };
