import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createQuoteEngine } from './engine.js';
import { MentoQuoteEngine } from './quote-mento.js';
import { JsonlRemitLog } from './remit-log.js';
import { type MentoSwapLike, RemitService } from './remit.js';
import { createAgentWallet } from './wallet.js';

const config = loadConfig();
// Wallet first: logs degraded mode early if AGENT_PRIVATE_KEY is missing.
const agentWallet = createAgentWallet(config);
const { engine, mode } = await createQuoteEngine(config);

/**
 * F-EXEC wiring. Execution needs BOTH:
 *   - the Mento engine (real on-chain routes: the mock cannot swap), and
 *   - a wallet that can sign.
 * Anything missing => no RemitService => POST /api/remit answers 503 with the
 * reason. REMIT_ENABLED is checked per-request inside the service, so the
 * endpoint explains itself instead of vanishing.
 */
const remitService =
  engine instanceof MentoQuoteEngine && agentWallet.canSign
    ? new RemitService({
        config,
        wallet: agentWallet,
        // Same SDK instance that discovered the routes; `swap` is present on the
        // real client (the quote path only ever touches `quotes`/`routes`).
        mento: engine.client as unknown as MentoSwapLike,
        pairs: engine.pairs,
        remitLog: new JsonlRemitLog(config.remit.dailyCapUsd),
      })
    : undefined;

if (remitService) {
  console.log(
    `[remit] F-EXEC ready (enabled=${config.remit.enabled}, max=$${config.remit.maxUsd}/remit, ` +
      `dailyCap=$${config.remit.dailyCapUsd}, maxSlippage=${config.remit.maxSlippagePct}%, ` +
      `corridors=${remitService.supportedCurrencies().join(',') || 'none'})`,
  );
  if (!config.remit.enabled) {
    console.warn('[remit] REMIT_ENABLED=false -> POST /api/remit returns 503 (quote-only mode).');
  }
} else {
  console.warn(
    `[remit] F-EXEC unavailable (engine=${mode}, canSign=${agentWallet.canSign}): ` +
      'POST /api/remit returns 503. Needs the Mento engine + AGENT_PRIVATE_KEY.',
  );
}

const app = createApp({
  config,
  quoteEngine: engine,
  engineMode: mode,
  agentWallet,
  ...(remitService ? { remitService } : {}),
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(
    `RemesaFlow backend listening on http://localhost:${info.port} ` +
      `(network=${config.network.name}, chainId=${config.network.chainId}, ` +
      `x402=${config.x402Enabled ? 'enabled' : 'disabled'}, engine=${mode}, ` +
      `remit=${config.remit.enabled && remitService ? 'ENABLED' : 'disabled'}, ` +
      `agent=${agentWallet.getAgentAddress() ?? 'read-only'})`,
  );
});
