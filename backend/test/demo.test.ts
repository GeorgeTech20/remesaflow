import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { type AppConfig, loadConfig } from '../src/config.js';
import { DEMO_LIMIT, txHashFromPaymentResponse } from '../src/demo.js';
import type { QueryLog } from '../src/logger.js';

const silentLog: QueryLog = { log: () => {} };

function demoApp(overrides: Partial<AppConfig> = {}) {
  const config: AppConfig = { ...loadConfig({}), demoMode: true, ...overrides };
  return createApp({ config, queryLog: silentLog });
}

function postDemo(app: ReturnType<typeof createApp>, body: unknown, ip = '1.2.3.4') {
  return app.request('/api/demo/quote', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

describe('POST /api/demo/quote', () => {
  it('does not exist when DEMO_MODE=false', async () => {
    const config: AppConfig = { ...loadConfig({}) }; // demoMode false by default
    const app = createApp({ config, queryLog: silentLog });
    const res = await postDemo(app, { amount: 50, to: 'KES' });
    expect(res.status).toBe(404);
  });

  it('returns the Quote shape plus demo fields (x402 off: txHash null)', async () => {
    const app = demoApp();
    const res = await postDemo(app, { amount: 50, to: 'KES' });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toMatchObject({
      send: 50,
      currency: 'KES',
      demo: true,
      txHash: null,
      remainingDemoQueries: DEMO_LIMIT - 1,
    });
    expect(typeof body.receives).toBe('number');
    expect(typeof body.rate).toBe('number');
  });

  it('forwards /api/quote validation errors without consuming the allowance', async () => {
    const app = demoApp();

    const badAmount = await postDemo(app, { amount: 'abc', to: 'KES' });
    expect(badAmount.status).toBe(400);
    expect((await badAmount.json()).error).toBe('invalid_amount');

    const badCurrency = await postDemo(app, { amount: 50, to: 'EUR' });
    expect(badCurrency.status).toBe(400);
    expect((await badCurrency.json()).error).toBe('unsupported_currency');

    // Allowance untouched: first success still reports LIMIT - 1 remaining.
    const ok = await postDemo(app, { amount: 50, to: 'KES' });
    expect((await ok.json()).remainingDemoQueries).toBe(DEMO_LIMIT - 1);
  });

  it(`caps at ${DEMO_LIMIT} successful quotes per IP`, async () => {
    const app = demoApp();
    for (let i = 1; i <= DEMO_LIMIT; i++) {
      const res = await postDemo(app, { amount: 10, to: 'KES' });
      expect(res.status).toBe(200);
      expect((await res.json()).remainingDemoQueries).toBe(DEMO_LIMIT - i);
    }

    const blocked = await postDemo(app, { amount: 10, to: 'KES' });
    expect(blocked.status).toBe(429);
    const body = await blocked.json();
    expect(body.error).toBe('demo_limit_reached');
    expect(body.remainingDemoQueries).toBe(0);

    // Another IP still has its own allowance.
    const other = await postDemo(app, { amount: 10, to: 'KES' }, '5.6.7.8');
    expect(other.status).toBe(200);
  });

  it('answers 503 when x402 is on but DEMO_PRIVATE_KEY is missing', async () => {
    // payTo required when x402 is enabled -> stub agent address via wallet-less
    // config is rejected, so build the app with x402 on and a fake wallet.
    const config: AppConfig = {
      ...loadConfig({}),
      demoMode: true,
      x402Enabled: true,
      demoPrivateKey: undefined,
    };
    const { createAgentWallet } = await import('../src/wallet.js');
    const agentWallet = createAgentWallet(config, {
      walletClient: {
        account: { address: '0x1111111111111111111111111111111111111111' },
        sendTransaction: async () => '0x00',
      },
    });
    const app = createApp({ config, queryLog: silentLog, agentWallet });

    const res = await postDemo(app, { amount: 50, to: 'KES' });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('demo_unavailable');
  });
});

describe('txHashFromPaymentResponse', () => {
  const encode = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64');

  it('extracts the transaction from a v2 PAYMENT-RESPONSE header', () => {
    const headers = new Headers({
      'PAYMENT-RESPONSE': encode({ success: true, transaction: '0xabc123', payer: '0xdef' }),
    });
    expect(txHashFromPaymentResponse(headers)).toBe('0xabc123');
  });

  it('falls back to the v1 X-PAYMENT-RESPONSE header', () => {
    const headers = new Headers({
      'X-PAYMENT-RESPONSE': encode({ success: true, transaction: '0xv1tx' }),
    });
    expect(txHashFromPaymentResponse(headers)).toBe('0xv1tx');
  });

  it('returns null for missing, empty or malformed receipts', () => {
    expect(txHashFromPaymentResponse(new Headers())).toBeNull();
    expect(
      txHashFromPaymentResponse(new Headers({ 'PAYMENT-RESPONSE': encode({ transaction: '' }) })),
    ).toBeNull();
    expect(
      txHashFromPaymentResponse(new Headers({ 'PAYMENT-RESPONSE': 'not-base64-json' })),
    ).toBeNull();
  });
});
