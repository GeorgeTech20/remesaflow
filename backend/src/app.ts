/**
 * Hono app factory. Kept separate from index.ts so tests can build an app
 * (with injected config/engine/logger/wallet) without opening a socket.
 */
import { randomUUID } from 'node:crypto';
import { type Context, Hono } from 'hono';
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
import { registerDemoRoutes } from './demo.js';
import { clientIp, rateLimit } from './ratelimit.js';
import { buildAgentRegistration } from './registration.js';
import { RemitError, type RemitService } from './remit.js';
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
  /**
   * F-EXEC. Absent (no Mento engine / no wallet) => POST /api/remit answers 503
   * instead of 404, so the failure is explained rather than mysterious.
   */
  remitService?: RemitService;
}

export function createApp(options: AppOptions = {}): Hono {
  const config = options.config ?? loadConfig();
  const engine = options.quoteEngine ?? new MockQuoteEngine();
  const engineMode = options.engineMode ?? 'mock';
  const queryLog = options.queryLog ?? new JsonlQueryLogger();
  const wallet = options.agentWallet;
  const remitService = options.remitService;
  const stats = { quotesServed: 0, remitsExecuted: 0, since: new Date().toISOString() };

  const supported = engine.supportedCurrencies?.() ?? SUPPORTED_CURRENCIES;

  const app = new Hono();

  app.use('*', cors({ origin: config.corsOrigin }));
  app.use('/api/*', rateLimit());

  // Paid endpoints: GET /api/quote and POST /api/remit (both $0.01 in USDC).
  // Everything else — including GET /api/remit/:txHash — stays free.
  const paymentGate = x402({
    enabled: config.x402Enabled,
    payTo: wallet?.getAgentAddress() ?? null,
    network: config.network.x402.network,
    facilitatorUrl: config.network.x402.facilitatorUrl,
    apiKey: config.x402FacilitatorApiKey,
    usdc: config.network.usdc,
    onSettled: (payment) => {
      // Settle happens AFTER the route handler; this is where the real
      // txHash lands in the query log (replaces the mock's null).
      if (payment.path !== '/api/quote') {
        // A paid remittance is audited in logs/remits.jsonl, not in the quote
        // log — recording it as a quote would corrupt the query stats.
        console.log(`[x402] settled ${payment.path}: tx=${payment.txHash ?? 'degraded'}`);
        return;
      }
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
  });
  app.use('/api/quote', paymentGate);
  app.use('/api/remit', paymentGate);

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

      // F-EXEC: hand out a quoteId so POST /api/remit can hold the execution to
      // the rate the user actually saw (slippage guard). Only meaningful when
      // execution is wired up; a plain quote client can ignore it.
      if (remitService) {
        const quoteId = randomUUID();
        remitService.quotes.register(quoteId, { fiat: to, rate: quote.rate, amount });
        return c.json({ ...quote, quoteId });
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

  // -------------------------------------------------------------------------
  // F-EXEC — execution. POST /api/remit moves REAL funds, so it is paid ($0.01
  // x402, same as a quote) and gated by every guardrail in remit.ts. One
  // request = one remittance = one value-carrying tx. No loops, no batching.
  // -------------------------------------------------------------------------

  /** Remittance execution is unavailable unless BOTH the Mento engine and a
   * signing wallet are wired. Says why, instead of 404ing. */
  const remitUnavailable = (c: Context) =>
    c.json(
      {
        error: 'remit_unavailable',
        message:
          'Remittance execution is not available on this deployment: it needs the Mento quote ' +
          'engine (a reachable Celo RPC with tradable routes) and an agent wallet ' +
          '(AGENT_PRIVATE_KEY). This agent is quote-only right now.',
      },
      503,
    );

  app.post('/api/remit', async (c) => {
    if (!remitService) return remitUnavailable(c);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: 'invalid_body', message: 'Expected a JSON body: { amount, to, recipient }.' },
        400,
      );
    }
    const { amount, to, recipient, quoteId } = (body ?? {}) as Record<string, unknown>;

    try {
      const result = await remitService.execute({
        amount: amount as number,
        to: String(to ?? ''),
        recipient: String(recipient ?? ''),
        quoteId: typeof quoteId === 'string' ? quoteId : undefined,
      });
      stats.remitsExecuted += 1;
      return c.json(result);
    } catch (err) {
      if (err instanceof RemitError) {
        // 4xx/5xx with a machine-readable code; nothing was executed unless the
        // code says otherwise (swap_failed carries the reverted txHash).
        return c.json(err.toJSON(), err.status as 400);
      }
      console.error('[remit] unexpected failure:', err);
      return c.json(
        {
          error: 'remit_failed',
          message:
            'The remittance could not be completed. If no txHash was returned, no funds left ' +
            'the agent wallet.',
        },
        500,
      );
    }
  });

  // Free: on-chain status of a remittance (also decodes its ERC-8021 tag).
  app.get('/api/remit/:txHash', async (c) => {
    if (!remitService) return remitUnavailable(c);
    try {
      return c.json(await remitService.getStatus(c.req.param('txHash')));
    } catch (err) {
      if (err instanceof RemitError) {
        return c.json(err.toJSON(), err.status as 400);
      }
      throw err;
    }
  });

  // F8 demo flow: the server pays its own /api/quote with DEMO_PRIVATE_KEY so
  // the landing can offer a no-wallet demo backed by real x402 settlements.
  if (config.demoMode) {
    registerDemoRoutes(app, {
      config,
      // Self-call stays in-process (no socket): the x402 middleware above
      // still runs on it, so demo requests go through the full 402 flow.
      selfFetch: async (input, init) => app.request(input, init),
    });
  }

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
      remitsExecuted: stats.remitsExecuted,
      since: stats.since,
      // Public, on purpose: the guardrails are a feature, and judges can see
      // the caps without reading our env.
      remit: {
        enabled: config.remit.enabled && remitService !== undefined,
        maxUsd: config.remit.maxUsd,
        dailyCapUsd: config.remit.dailyCapUsd,
        maxSlippagePct: config.remit.maxSlippagePct,
      },
    }),
  );

  // F11 — ERC-8004 registration file (free; the Identity Registry tokenURI
  // points here). Also exposed at the A2A well-known path for discovery.
  const agentRegistration = (c: Context) =>
    c.json(buildAgentRegistration(config, wallet?.getAgentAddress() ?? null, supported));
  app.get('/agent-registration.json', agentRegistration);
  app.get('/.well-known/agent.json', agentRegistration);

  return app;
}
