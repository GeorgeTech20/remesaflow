import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createQuoteEngine } from './engine.js';
import { createAgentWallet } from './wallet.js';

const config = loadConfig();
// Wallet first: logs degraded mode early if AGENT_PRIVATE_KEY is missing.
const agentWallet = createAgentWallet(config);
const { engine, mode } = await createQuoteEngine(config);
const app = createApp({ config, quoteEngine: engine, engineMode: mode, agentWallet });

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(
    `RemesaFlow backend listening on http://localhost:${info.port} ` +
      `(network=${config.network.name}, chainId=${config.network.chainId}, ` +
      `x402=${config.x402Enabled ? 'enabled' : 'disabled'}, engine=${mode}, ` +
      `agent=${agentWallet.getAgentAddress() ?? 'read-only'})`,
  );
});
