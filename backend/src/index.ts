import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = createApp({ config });

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(
    `RemesaFlow backend listening on http://localhost:${info.port} ` +
      `(network=${config.network.name}, chainId=${config.network.chainId}, ` +
      `x402=${config.x402Enabled ? 'enabled' : 'disabled'}, mode=mock)`,
  );
});
