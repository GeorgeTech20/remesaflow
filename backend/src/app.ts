/**
 * Hono app factory. Kept separate from index.ts so tests can build an app
 * (with injected config/engine/logger/wallet) without opening a socket.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { type AppConfig, loadConfig } from './config.js';
import type { EngineMode } from './engine.js';
import { hashIp, JsonlQueryLogger, type QueryLog } from './logger.js';
import {
  CURRENCIES,
  MockQuoteEngine,
  type QuoteEngine,
  SUPPORTED_CURRENCIES,
  UnsupportedPairError,
} from './quote.js';
import { clientIp, rateLimit } from './ratelimit.js';
import type { AgentWallet } from './wallet.js';
import { x402 } from './x402.js';

export interface AppOptions {
  config?: AppConfig;
  quoteEngine?: QuoteEngine;
  /** Which engine is live ("mock" | "mento"), reported by /api/health. */
  engineMode?: EngineMode;
  queryLog?: QueryLog;
  /** Needed for x402 payTo and /api/health blockNumber. */
  agentWallet?: AgentWallet;
}

export function createApp(options: AppOptions = {}): Hono {
  const config = options.config ?? loadConfig();
  const engine = options.quoteEngine ?? new MockQuoteEngine();
  const engineMode = options.engineMode ?? 'mock';
  const queryLog = options.queryLog ?? new JsonlQueryLogger();
  const wallet = options.agentWallet;
  const stats = { quotesServed: 0, since: new Date().toISOString() };

  const supported = engine.supportedCurrencies?.() ?? SUPPORTED_CURRENCIES;

  const app = new Hono();

  app.use('*', cors({ origin: config.corsOrigin }));
  app.use('/api/*', rateLimit());
  // Only the quote endpoint is paid; everything else stays free.
  app.use(
    '/api/quote',
    x402({
      enabled: config.x402Enabled,
      payTo: wallet?.getAgentAddress() ?? null,
      network: config.network.x402.network,
      facilitatorUrl: config.network.x402.facilitatorUrl,
      apiKey: config.x402FacilitatorApiKey,
      usdc: config.network.usdc,
      onSettled: (payment) => {
        // Settle happens AFTER the route handler; this is where the real
        // txHash lands in the query log (replaces the mock's null).
        const to = String(payment.query.to ?? '').toUpperCase();
        const amount = Number(payment.query.amount ?? 0);
        queryLog.log({
          timestamp: new Date().toISOString(),
          pair: `USD-${to}`,
          amount,
          txHash: payment.txHash,
          ipHash: hashIp(payment.ip ?? 'unknown'),
        });
      },
    }),
  );

  app.get('/api/currencies', (c) =>
    c.json({
      currencies: CURRENCIES.filter((cur) => supported.includes(cur.code)),
      network: config.network.name,
    }),
  );

  app.get('/api/quote', async (c) => {
    const amountRaw = c.req.query('amount');
    const to = (c.req.query('to') ?? '').toUpperCase();

    const amount = Number(amountRaw);
    if (amountRaw === undefined || amountRaw === '' || !Number.isFinite(amount) || amount < 1 || amount > 10000) {
      return c.json(
        { error: 'invalid_amount', message: 'amount must be a number between 1 and 10000' },
        400,
      );
    }
    if (!supported.includes(to)) {
      return c.json(
        { error: 'unsupported_currency', requested: to, available: supported },
        400,
      );
    }

    try {
      const quote = await engine.getQuote(amount, to);
      stats.quotesServed += 1;
      if (!config.x402Enabled) {
        // Paid mode logs from the x402 onSettled hook (with the real txHash).
        queryLog.log({
          timestamp: quote.timestamp,
          pair: `USD-${to}`,
          amount,
          txHash: null, // dev mode: no on-chain payment
          ipHash: hashIp(clientIp(c)),
        });
      }
      return c.json(quote);
    } catch (err) {
      if (err instanceof UnsupportedPairError) {
        return c.json(
          { error: 'unsupported_currency', requested: err.requested, available: err.available },
          400,
        );
      }
      throw err;
    }
  });

  app.get('/api/health', async (c) => {
    let blockNumber: number | null = null;
    if (wallet) {
      try {
        blockNumber = Number(await wallet.getBlockNumber());
      } catch {
        blockNumber = null; // RPC unreachable: health stays green, block null
      }
    }
    return c.json({
      status: 'ok',
      network: config.network.name,
      blockNumber,
      mode: engineMode,
    });
  });

  app.get('/api/stats', (c) =>
    c.json({
      quotesServed: stats.quotesServed,
      since: stats.since,
    }),
  );

  return app;
}
