import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { type Address, type AppConfig, loadConfig } from '../src/config.js';
import type { QueryLog } from '../src/logger.js';
import { createAgentWallet, type MinimalWalletClient } from '../src/wallet.js';

const silentLog: QueryLog = { log: () => {} };

/** Fresh app per test with defaults (celo-sepolia, x402 off) + optional overrides. */
function testApp(overrides: Partial<AppConfig> = {}) {
  const config: AppConfig = { ...loadConfig({}), ...overrides };
  return createApp({ config, queryLog: silentLog });
}

// Fake signer so tests never touch a real private key or the network.
const AGENT_ADDRESS: Address = '0x1111111111111111111111111111111111111111';
const stubWalletClient: MinimalWalletClient = {
  account: { address: AGENT_ADDRESS },
  sendTransaction: async () => '0x00',
};

describe('GET /api/currencies', () => {
  it('returns the supported currency list', async () => {
    const app = testApp();
    const res = await app.request('/api/currencies');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.network).toBe('celo-sepolia');
    expect(body.currencies).toHaveLength(5);
    const codes = body.currencies.map((c: { code: string }) => c.code);
    expect(codes).toEqual(expect.arrayContaining(['KES', 'PHP', 'BRL', 'COP', 'NGN']));
    for (const currency of body.currencies) {
      expect(currency).toMatchObject({
        code: expect.any(String),
        name: expect.any(String),
        country: expect.any(String),
        flag: expect.any(String),
        stablecoin: expect.any(String),
      });
    }
  });
});

describe('GET /api/quote', () => {
  it('returns a well-shaped quote for a valid pair', async () => {
    const app = testApp();
    const res = await app.request('/api/quote?amount=50&to=KES');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toMatchObject({
      send: 50,
      currency: 'KES',
      celoFee: 0.02,
      wuWouldCharge: 3,
      wiseWouldCharge: 0.75,
      savings: 2.98,
    });
    // Mock rate: mid-market 129 with up to 1% spread below.
    expect(body.rate).toBeGreaterThan(127);
    expect(body.rate).toBeLessThanOrEqual(129);
    expect(body.receives).toBeCloseTo(body.rate * 50, 0);
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });

  it('rejects an unsupported currency with the available list', async () => {
    const app = testApp();
    const res = await app.request('/api/quote?amount=50&to=EUR');
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toBe('unsupported_currency');
    expect(body.available).toEqual(expect.arrayContaining(['KES', 'PHP', 'BRL', 'COP', 'NGN']));
  });

  it('rejects invalid amounts', async () => {
    const app = testApp();
    for (const amount of ['abc', '0', '10001', '']) {
      const res = await app.request(`/api/quote?amount=${amount}&to=KES`);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid_amount');
    }
  });

  it('counts served quotes in /api/stats', async () => {
    const app = testApp();
    await app.request('/api/quote?amount=50&to=KES');
    await app.request('/api/quote?amount=20&to=BRL');
    const res = await app.request('/api/stats');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quotesServed).toBe(2);
    expect(typeof body.since).toBe('string');
  });
});

describe('rate limiting', () => {
  it('returns 429 after 50 requests in a minute from the same IP', async () => {
    const app = testApp();
    for (let i = 0; i < 50; i++) {
      const res = await app.request('/api/health');
      expect(res.status).toBe(200);
    }
    const res = await app.request('/api/health');
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe('rate_limited');
  });
});

describe('x402 middleware (real, @x402/hono v2)', () => {
  function paidApp() {
    const config: AppConfig = { ...loadConfig({}), x402Enabled: true };
    const agentWallet = createAgentWallet(config, { walletClient: stubWalletClient });
    return createApp({ config, queryLog: silentLog, agentWallet });
  }

  it('returns 402 with a PAYMENT-REQUIRED header (v2) on the paid endpoint', async () => {
    const app = paidApp();
    const res = await app.request('/api/quote?amount=50&to=KES');
    expect(res.status).toBe(402);

    const header = res.headers.get('PAYMENT-REQUIRED');
    expect(header).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(header as string, 'base64').toString('utf8'));
    expect(decoded.x402Version).toBe(2);
    const accepts = decoded.accepts;
    expect(Array.isArray(accepts)).toBe(true);
    expect(accepts[0]).toMatchObject({
      scheme: 'exact',
      network: 'eip155:11142220',
      payTo: AGENT_ADDRESS,
      amount: '10000', // $0.01 USDC (6 decimals)
    });
  });

  it('keeps free endpoints open when X402_ENABLED=true', async () => {
    const config: AppConfig = { ...loadConfig({}), x402Enabled: true };
    const agentWallet = createAgentWallet(config, { walletClient: stubWalletClient });
    const app = createApp({ config, queryLog: silentLog, agentWallet });
    const res = await app.request('/api/currencies');
    expect(res.status).toBe(200);
  });

  it('refuses to enable x402 without an agent wallet (payTo unknown)', () => {
    const config: AppConfig = { ...loadConfig({}), x402Enabled: true };
    expect(() => createApp({ config, queryLog: silentLog })).toThrow(/AGENT_PRIVATE_KEY/);
  });
});

describe('GET /api/health', () => {
  it('reports engine mode and network', async () => {
    const app = testApp();
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      status: 'ok',
      network: 'celo-sepolia',
      blockNumber: null,
      mode: 'mock',
    });
  });
});
