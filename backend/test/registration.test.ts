import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { type Address, type AppConfig, loadConfig } from '../src/config.js';
import type { QueryLog } from '../src/logger.js';
import { PLACEHOLDER_AGENT_ADDRESS } from '../src/registration.js';
import { createAgentWallet, type MinimalWalletClient } from '../src/wallet.js';

const silentLog: QueryLog = { log: () => {} };

const AGENT_ADDRESS: Address = '0x1111111111111111111111111111111111111111';
const stubWalletClient: MinimalWalletClient = {
  account: { address: AGENT_ADDRESS },
  sendTransaction: async () => '0x00',
};

describe('config: agent registration URL', () => {
  it('defaults to <apiBaseUrl>/agent-registration.json', () => {
    const config = loadConfig({});
    expect(config.apiBaseUrl).toBe('http://localhost:3000');
    expect(config.agentRegistrationUrl).toBe('http://localhost:3000/agent-registration.json');
  });

  it('derives from API_BASE_URL (trailing slash stripped) and honors the explicit override', () => {
    const derived = loadConfig({ API_BASE_URL: 'https://api.remesaflow.xyz/' });
    expect(derived.agentRegistrationUrl).toBe(
      'https://api.remesaflow.xyz/agent-registration.json',
    );
    const explicit = loadConfig({ AGENT_REGISTRATION_URL: 'ipfs://QmRegistration' });
    expect(explicit.agentRegistrationUrl).toBe('ipfs://QmRegistration');
  });
});

describe('GET /agent-registration.json', () => {
  it('serves the ERC-8004 registration file with a placeholder wallet in degraded mode', async () => {
    const app = createApp({ config: loadConfig({}), queryLog: silentLog });
    const res = await app.request('/agent-registration.json');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.type).toBe('Agent');
    expect(body.name).toBe('RemesaFlow');
    expect(body.supportedTrust).toContain('reputation');

    const walletEndpoint = body.endpoints.find((e: { type: string }) => e.type === 'wallet');
    expect(walletEndpoint).toMatchObject({
      address: PLACEHOLDER_AGENT_ADDRESS,
      chainId: 11142220, // celo-sepolia default
    });

    const api = body.endpoints.find((e: { type: string }) => e.type === 'api');
    expect(api.url).toBe('http://localhost:3000/api/quote');

    expect(body.capabilities[0].protocol).toBe('x402');
    expect(body.capabilities[0].corridors).toContain('USD-KES');
  });

  it('uses the real agent address when the wallet can sign', async () => {
    const config: AppConfig = loadConfig({});
    const agentWallet = createAgentWallet(config, { walletClient: stubWalletClient });
    const app = createApp({ config, queryLog: silentLog, agentWallet });

    const res = await app.request('/agent-registration.json');
    const body = await res.json();
    const walletEndpoint = body.endpoints.find((e: { type: string }) => e.type === 'wallet');
    expect(walletEndpoint.address).toBe(AGENT_ADDRESS);
  });

  it('serves the same document at the A2A well-known path', async () => {
    const app = createApp({ config: loadConfig({}), queryLog: silentLog });
    const [a, b] = await Promise.all([
      app.request('/agent-registration.json'),
      app.request('/.well-known/agent.json'),
    ]);
    expect(b.status).toBe(200);
    expect(await b.json()).toEqual(await a.json());
  });
});
