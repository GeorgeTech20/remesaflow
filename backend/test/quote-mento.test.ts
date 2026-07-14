/**
 * F3 unit tests — MentoQuoteEngine with a mocked SDK (no network calls).
 */
import { describe, expect, it, vi } from 'vitest';
import { type AppConfig, loadConfig, NETWORKS } from '../src/config.js';
import { MentoInitError, type MentoLike, MentoQuoteEngine } from '../src/quote-mento.js';
import { UnsupportedPairError } from '../src/quote.js';

const SEPOLIA = NETWORKS['celo-sepolia'];
const USDC = SEPOLIA.usdc.token;
const USDM = SEPOLIA.stablecoins.USDm as string;
const KESM = SEPOLIA.stablecoins.KESm as string;
const PHPM = SEPOLIA.stablecoins.PHPm as string;

function config(): AppConfig {
  return loadConfig({});
}

/**
 * Fake SDK: USDC->KESm has a direct route at 129 KES/USD; USDm->PHPm exists
 * at 56 PHP/USD (so PHP must be discovered via the USDm fallback); everything
 * else has no route.
 */
function fakeMento() {
  const routes = new Set([`${USDC}->${KESM}`, `${USDM}->${PHPM}`]);
  const findRoute = vi.fn(async (tin: string, tout: string) => {
    if (routes.has(`${tin}->${tout}`)) return { path: [] };
    throw new Error('no route');
  });
  const isPairTradable = vi.fn(async () => true);
  const getAmountOut = vi.fn(async (tin: string, _tout: string, amountIn: bigint) => {
    if (tin === USDC) return amountIn * 129n * 10n ** 12n; // 6 -> 18 decimals
    return amountIn * 56n; // USDm is already 18 decimals
  });
  const mento: MentoLike = {
    routes: { findRoute },
    trading: { isPairTradable },
    quotes: { getAmountOut },
  };
  return { mento, findRoute, isPairTradable, getAmountOut };
}

describe('MentoQuoteEngine discovery', () => {
  it('exposes only pairs with a real on-chain route (USDC first, USDm fallback)', async () => {
    const { mento } = fakeMento();
    const engine = await MentoQuoteEngine.create(config(), mento);

    expect(engine.supportedCurrencies().sort()).toEqual(['KES', 'PHP']);
    const byFiat = new Map(engine.pairs.map((p) => [p.fiat, p]));
    expect(byFiat.get('KES')).toMatchObject({ tokenInSymbol: 'USDC', tokenInDecimals: 6 });
    expect(byFiat.get('PHP')).toMatchObject({ tokenInSymbol: 'USDm', tokenInDecimals: 18 });
  });

  it('skips pairs whose circuit breaker is closed', async () => {
    const { mento } = fakeMento();
    mento.trading.isPairTradable = vi.fn(async () => false);
    await expect(MentoQuoteEngine.create(config(), mento)).rejects.toBeInstanceOf(MentoInitError);
  });

  it('throws MentoInitError when no route exists at all', async () => {
    const { mento } = fakeMento();
    mento.routes.findRoute = vi.fn(async () => {
      throw new Error('no route');
    });
    await expect(MentoQuoteEngine.create(config(), mento)).rejects.toBeInstanceOf(MentoInitError);
  });
});

describe('MentoQuoteEngine.getQuote', () => {
  it('computes receives/rate from on-chain amountOut with the shared formula', async () => {
    const { mento } = fakeMento();
    const engine = await MentoQuoteEngine.create(config(), mento);

    const quote = await engine.getQuote(50, 'KES');
    expect(quote).toMatchObject({
      send: 50,
      currency: 'KES',
      receives: 6450, // 50 * 129 (1 KESm == 1 KES assumption)
      rate: 129,
      celoFee: 0.02,
      wuWouldCharge: 3,
      wiseWouldCharge: 0.75,
      savings: 2.98,
    });
  });

  it('quotes 18-decimal inputs (USDm fallback) correctly', async () => {
    const { mento } = fakeMento();
    const engine = await MentoQuoteEngine.create(config(), mento);

    const quote = await engine.getQuote(100, 'PHP');
    expect(quote.rate).toBe(56);
    expect(quote.receives).toBe(5600);
  });

  it('caches the rate for 60s (one getAmountOut per pair)', async () => {
    const { mento, getAmountOut } = fakeMento();
    const engine = await MentoQuoteEngine.create(config(), mento);

    await engine.getQuote(50, 'KES');
    await engine.getQuote(200, 'KES'); // different amount, same cached rate
    expect(getAmountOut).toHaveBeenCalledTimes(1);

    const quote = await engine.getQuote(200, 'KES');
    expect(quote.receives).toBe(200 * 129);
  });

  it('rejects currencies without a discovered route', async () => {
    const { mento } = fakeMento();
    const engine = await MentoQuoteEngine.create(config(), mento);

    await expect(engine.getQuote(50, 'BRL')).rejects.toBeInstanceOf(UnsupportedPairError);
  });
});

/**
 * On-chain integration (read-only). Runs ONLY when RUN_ONCHAIN_TESTS=1 so
 * offline CI never breaks. Discovers real routes on the configured network
 * and fetches one live quote.
 */
describe.skipIf(process.env.RUN_ONCHAIN_TESTS !== '1')('MentoQuoteEngine on-chain (live RPC)', () => {
  it('discovers real routes and serves a live quote', async () => {
    const engine = await MentoQuoteEngine.create(config());
    const supported = engine.supportedCurrencies();
    console.log('[onchain] discovered pairs:', engine.pairs);
    expect(supported.length).toBeGreaterThan(0);

    const target = supported[0] as string;
    const quote = await engine.getQuote(10, target);
    console.log('[onchain] live quote:', quote);
    expect(quote.receives).toBeGreaterThan(0);
    expect(quote.rate).toBeGreaterThan(0);
  }, 180_000); // Forno is rate-limited; discovery can be slow
});
