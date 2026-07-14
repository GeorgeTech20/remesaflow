/**
 * Hono app factory. Kept separate from index.ts so tests can build an app
 * (with injected config/engine/logger) without opening a socket.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { type AppConfig, loadConfig } from './config.js';
import { hashIp, JsonlQueryLogger, type QueryLog } from './logger.js';
import {
  CURRENCIES,
  MockQuoteEngine,
  type QuoteEngine,
  SUPPORTED_CURRENCIES,
  UnsupportedPairError,
} from './quote.js';
import { clientIp, rateLimit } from './ratelimit.js';
import { x402 } from './x402.js';

export interface AppOptions {
  config?: AppConfig;
  quoteEngine?: QuoteEngine;
  queryLog?: QueryLog;
}

export function createApp(options: AppOptions = {}): Hono {
  const config = options.config ?? loadConfig();
  const engine = options.quoteEngine ?? new MockQuoteEngine();
  const queryLog = options.queryLog ?? new JsonlQueryLogger();
  const stats = { quotesServed: 0, since: new Date().toISOString() };

  const app = new Hono();

  app.use('*', cors({ origin: config.corsOrigin }));
  app.use('/api/*', rateLimit());
  // Only the quote endpoint is paid; everything else stays free.
  app.use('/api/quote', x402(config.x402Enabled));

  app.get('/api/currencies', (c) =>
    c.json({
      currencies: CURRENCIES,
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
    if (!SUPPORTED_CURRENCIES.includes(to)) {
      return c.json(
        { error: 'unsupported_currency', requested: to, available: SUPPORTED_CURRENCIES },
        400,
      );
    }

    try {
      const quote = await engine.getQuote(amount, to);
      stats.quotesServed += 1;
      queryLog.log({
        timestamp: quote.timestamp,
        pair: `USD-${to}`,
        amount,
        txHash: null, // mock mode: no on-chain payment yet
        ipHash: hashIp(clientIp(c)),
      });
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

  app.get('/api/health', (c) =>
    c.json({
      status: 'ok',
      network: config.network.name,
      blockNumber: null, // mock mode: no RPC call yet
      mode: 'mock',
    }),
  );

  app.get('/api/stats', (c) =>
    c.json({
      quotesServed: stats.quotesServed,
      since: stats.since,
    }),
  );

  return app;
}
