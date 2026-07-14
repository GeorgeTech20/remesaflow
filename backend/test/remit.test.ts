/**
 * F-EXEC unit tests — every guardrail, plus the transaction shape.
 *
 * Nothing here touches the network or a real key: the Mento SDK, the wallet
 * client and the RPC are all fakes. The point of these tests is that a bug in
 * the guardrails would move REAL money, so they are the ones we care about most.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { toDataSuffix } from '@celo/attribution-tags';
import { formatUnits, pad, parseUnits, toHex } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { type Address, type AppConfig, loadConfig, NETWORKS } from '../src/config.js';
import type { QueryLog } from '../src/logger.js';
import type { DiscoveredPair } from '../src/quote-mento.js';
import { JsonlRemitLog, type RemitLog, type RemitLogEntry } from '../src/remit-log.js';
import { type MentoSwapLike, RemitError, RemitService } from '../src/remit.js';
import { AgentWallet, type MinimalWalletClient } from '../src/wallet.js';

const SEPOLIA = NETWORKS['celo-sepolia'];
const AGENT: Address = '0x1111111111111111111111111111111111111111';
const RECIPIENT: Address = '0x2222222222222222222222222222222222222222';
const ROUTER: Address = '0x8e4Fb12D86D5DF911086a9153e79CA27e0c96156';
const TAG = 'remesaflow';
const SUFFIX = toDataSuffix(TAG);

const SWAP_CALLDATA = '0xabcdef01';
const APPROVE_CALLDATA = '0x095ea7b3';
const SWAP_TX_HASH = `0x${'11'.repeat(32)}` as const;
const APPROVAL_TX_HASH = `0x${'22'.repeat(32)}` as const;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** KES corridor, paid in USDC (6 dec) -> KESm (18 dec). */
const KES_PAIR: DiscoveredPair = {
  fiat: 'KES',
  stablecoin: 'KESm',
  tokenIn: SEPOLIA.usdc.token,
  tokenInSymbol: 'USDC',
  tokenInDecimals: 6,
  tokenOut: SEPOLIA.stablecoins.KESm as Address,
};

const RATE = 129; // 1 USD = 129 KES

function cfg(overrides: Partial<AppConfig> = {}): AppConfig {
  const base = loadConfig({});
  return {
    ...base,
    attributionTag: TAG,
    ...overrides,
    remit: { ...base.remit, enabled: true, ...(overrides.remit ?? {}) },
  };
}

/**
 * In-memory ledger mirroring JsonlRemitLog's contract (commit() books by
 * txHash and does NOT touch the reservation; the caller releases exactly once).
 * The persistence itself is tested against the real JsonlRemitLog below.
 */
function memLog(cap = 100): RemitLog & { entries: RemitLogEntry[] } {
  let committed = 0;
  let reserved = 0;
  const counted = new Map<string, number>();
  const entries: RemitLogEntry[] = [];
  return {
    entries,
    reserve(amount) {
      if (committed + reserved + amount > cap) return false;
      reserved += amount;
      return true;
    },
    release(amount) {
      reserved = Math.max(0, reserved - amount);
    },
    commit(entry) {
      entries.push(entry);
      const key = entry.txHash?.toLowerCase();
      if (!key) return;
      const already = counted.get(key);
      if (already === undefined) {
        const amount = entry.status === 'failed' ? 0 : entry.amount;
        counted.set(key, amount);
        committed += amount;
      } else if (entry.status === 'failed' && already > 0) {
        committed -= already;
        counted.set(key, 0);
      }
    },
    spentToday: () => committed + reserved,
    remainingToday: () => Math.max(0, cap - committed - reserved),
    find: (txHash) =>
      [...entries].reverse().find((e) => e.txHash === txHash) ?? null,
  };
}

interface Fakes {
  rate?: number;
  needsApproval?: boolean;
  /** USDC balance of the agent, in whole USD. */
  balanceUsd?: number;
  receiptStatus?: 'success' | 'reverted';
  /** Emit a real Transfer(tokenOut -> recipient) log so `received` is decoded. */
  deliverLog?: number;
  receiptThrows?: boolean;
}

function build(fakes: Fakes = {}, config: AppConfig = cfg()) {
  const rate = fakes.rate ?? RATE;
  const balanceUsd = fakes.balanceUsd ?? 1_000;

  // Real swaps get distinct hashes; the first one keeps the well-known constant
  // so the assertions below stay readable. (A constant hash for every swap would
  // make the ledger's txHash-keyed dedupe treat N remittances as one.)
  let swaps = 0;
  const sendTransaction = vi.fn(async (args: Record<string, unknown>) => {
    if ((args.data as string).startsWith(APPROVE_CALLDATA)) return APPROVAL_TX_HASH;
    swaps += 1;
    return swaps === 1
      ? SWAP_TX_HASH
      : (`0x${swaps.toString(16).padStart(64, '0')}` as `0x${string}`);
  });
  const walletClient: MinimalWalletClient = { account: { address: AGENT }, sendTransaction };

  const logs =
    fakes.deliverLog !== undefined
      ? [
          {
            address: KES_PAIR.tokenOut,
            topics: [TRANSFER_TOPIC, pad(ROUTER), pad(RECIPIENT)],
            data: pad(toHex(parseUnits(String(fakes.deliverLog), 18))),
          },
        ]
      : [];

  const waitForTransactionReceipt = vi.fn(async ({ hash }: { hash: string }) => {
    if (fakes.receiptThrows) throw new Error('timeout waiting for receipt');
    return {
      status: hash === APPROVAL_TX_HASH ? 'success' : (fakes.receiptStatus ?? 'success'),
      blockNumber: 999n,
      logs,
    };
  });

  const publicClient = {
    readContract: vi.fn(async () => parseUnits(String(balanceUsd), KES_PAIR.tokenInDecimals)),
    waitForTransactionReceipt,
    getTransactionReceipt: vi.fn(async () => ({ status: 'success', blockNumber: 999n, logs })),
  };

  const wallet = new AgentWallet(config, {
    walletClient,
    publicClient: publicClient as never,
  });

  const buildSwapTransaction = vi.fn(
    async (
      _tokenIn: string,
      _tokenOut: string,
      amountIn: bigint,
      _recipient: string,
      _owner: string,
      options: { slippageTolerance: number },
    ) => {
      const amountUsd = Number(formatUnits(amountIn, KES_PAIR.tokenInDecimals));
      const expected = parseUnits(String(amountUsd * rate), 18);
      const min = (expected * BigInt(Math.round((100 - options.slippageTolerance) * 100))) / 10_000n;
      return {
        approval: fakes.needsApproval ? { to: KES_PAIR.tokenIn, data: APPROVE_CALLDATA } : null,
        swap: {
          params: { to: ROUTER, data: SWAP_CALLDATA },
          amountIn,
          amountOutMin: min,
          expectedAmountOut: expected,
        },
      };
    },
  );

  const mento: MentoSwapLike = {
    quotes: {
      getAmountOut: vi.fn(async (_in: string, _out: string, amountIn: bigint) => {
        const amountUsd = Number(formatUnits(amountIn, KES_PAIR.tokenInDecimals));
        return parseUnits(String(amountUsd * rate), 18);
      }),
    },
    swap: { buildSwapTransaction },
  };

  const remitLog = memLog(config.remit.dailyCapUsd);
  const service = new RemitService({
    config,
    wallet,
    mento,
    pairs: [KES_PAIR],
    remitLog,
  });

  return { service, sendTransaction, buildSwapTransaction, remitLog, publicClient, mento, config };
}

const good = { amount: 10, to: 'KES', recipient: RECIPIENT };

async function expectRemitError(promise: Promise<unknown>, code: string, status: number) {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(RemitError);
  const remitErr = err as RemitError;
  expect(remitErr.code).toBe(code);
  expect(remitErr.status).toBe(status);
  return remitErr;
}

// ---------------------------------------------------------------------------
// The transaction design — the thing the leaderboard actually scores.
// ---------------------------------------------------------------------------

describe('remit tx design (ONE value tx, never batched)', () => {
  it('sends the whole USD amount in a SINGLE tagged swap tx that pays the recipient', async () => {
    const { service, sendTransaction, buildSwapTransaction } = build();

    const result = await service.execute(good);

    // Exactly one tx: no approval needed, so the swap is the only broadcast.
    expect(sendTransaction).toHaveBeenCalledTimes(1);
    const tx = sendTransaction.mock.calls[0]![0] as Record<string, unknown>;

    // It is the swap, it is tagged (ERC-8021), and gas is paid in USDC.
    expect(tx.to).toBe(ROUTER);
    expect(tx.data).toBe(`${SWAP_CALLDATA}${SUFFIX.slice(2)}`);
    expect(tx.feeCurrency).toBe(SEPOLIA.usdc.adapter);

    // The swap delivers straight to the beneficiary: recipient != owner. This
    // is what keeps the remittance in ONE value tx.
    const [, , amountIn, recipient, owner] = buildSwapTransaction.mock.calls[0]!;
    expect(recipient).toBe(RECIPIENT);
    expect(owner).toBe(AGENT);
    // The FULL USD amount rides in this one tx — never split, never batched.
    expect(amountIn).toBe(parseUnits('10', 6));

    expect(result).toMatchObject({
      txHash: SWAP_TX_HASH,
      sent: 10,
      recipient: RECIPIENT,
      currency: 'KES',
      status: 'success',
      approvalTxHash: null,
    });
    expect(result.explorerUrl).toBe(`${SEPOLIA.explorer}/tx/${SWAP_TX_HASH}`);
  });

  it('approval (when needed) is a separate $0-value tx; the swap still carries the USD', async () => {
    const { service, sendTransaction } = build({ needsApproval: true });

    const result = await service.execute(good);

    expect(sendTransaction).toHaveBeenCalledTimes(2);
    const [approveTx, swapTx] = sendTransaction.mock.calls.map(
      (c) => c[0] as Record<string, unknown>,
    );
    // tx A: approve, to the TOKEN, moves no value. Tagged anyway.
    expect(approveTx!.to).toBe(KES_PAIR.tokenIn);
    expect(approveTx!.data).toBe(`${APPROVE_CALLDATA}${SUFFIX.slice(2)}`);
    // tx B: the swap, to the ROUTER — the one that carries the USD.
    expect(swapTx!.to).toBe(ROUTER);

    expect(result.approvalTxHash).toBe(APPROVAL_TX_HASH);
    expect(result.txHash).toBe(SWAP_TX_HASH); // the value tx is the one reported
  });

  it('reports the REAL delivered amount decoded from the receipt', async () => {
    const { service } = build({ deliverLog: 1287.5 });
    const result = await service.execute(good);
    expect(result.received).toBe(1287.5);
    expect(result.rate).toBeCloseTo(128.75, 6);
  });

  it('falls back to the expected amount when the receipt has no decodable transfer', async () => {
    const { service } = build();
    const result = await service.execute(good);
    expect(result.received).toBe(1290);
  });
});

// ---------------------------------------------------------------------------
// Guardrails.
// ---------------------------------------------------------------------------

describe('guardrail: REMIT_ENABLED', () => {
  it('refuses to execute (503) when REMIT_ENABLED=false, without touching the chain', async () => {
    const config = cfg({ remit: { ...loadConfig({}).remit, enabled: false } });
    const { service, sendTransaction, mento } = build({}, config);

    await expectRemitError(service.execute(good), 'remit_disabled', 503);
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(mento.quotes.getAmountOut).not.toHaveBeenCalled();
  });

  it('defaults to DISABLED when the env var is absent', () => {
    expect(loadConfig({}).remit.enabled).toBe(false);
  });

  it('treats an EMPTY env var as unset (REMIT_ENABLED= must not crash the boot)', () => {
    // `FOO=` in a .env is how people leave a var unset; it must fall back to
    // false (execution off), never throw.
    expect(loadConfig({ REMIT_ENABLED: '' }).remit.enabled).toBe(false);
    expect(loadConfig({ REMIT_ENABLED: 'true' }).remit.enabled).toBe(true);
    expect(() => loadConfig({ REMIT_ENABLED: 'yes' })).toThrow(/Expected "true" or "false"/);
  });

  it('rejects a config where a single remit could never clear the daily cap', () => {
    expect(() => loadConfig({ REMIT_MAX_USD: '200', REMIT_DAILY_CAP_USD: '100' })).toThrow(
      /above REMIT_DAILY_CAP_USD/,
    );
  });

  it('rejects nonsensical money limits', () => {
    expect(() => loadConfig({ REMIT_MAX_USD: '-5' })).toThrow(/greater than 0/);
    expect(() => loadConfig({ REMIT_MAX_SLIPPAGE_PCT: '50' })).toThrow(/above 20/);
  });
});

describe('guardrail: amount', () => {
  it.each([
    ['zero', 0],
    ['negative', -5],
    ['NaN', Number.NaN],
    ['below the 1 USD minimum', 0.5],
  ])('rejects %s (400) and sends nothing', async (_label, amount) => {
    const { service, sendTransaction } = build();
    await expectRemitError(service.execute({ ...good, amount }), 'invalid_amount', 400);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('rejects an amount over REMIT_MAX_USD (400)', async () => {
    const { service, sendTransaction } = build(); // default max 25
    const err = await expectRemitError(
      service.execute({ ...good, amount: 26 }),
      'amount_over_limit',
      400,
    );
    expect(err.details.max).toBe(25);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('accepts exactly REMIT_MAX_USD (boundary)', async () => {
    const { service } = build();
    await expect(service.execute({ ...good, amount: 25 })).resolves.toMatchObject({ sent: 25 });
  });
});

describe('guardrail: recipient', () => {
  it.each([
    ['not an address', 'not-an-address'],
    ['too short', '0x1234'],
    ['empty', ''],
  ])('rejects a recipient that is %s (400)', async (_label, recipient) => {
    const { service, sendTransaction } = build();
    await expectRemitError(service.execute({ ...good, recipient }), 'invalid_recipient', 400);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('rejects the zero address (400): that would burn the funds', async () => {
    const { service } = build();
    await expectRemitError(
      service.execute({ ...good, recipient: `0x${'0'.repeat(40)}` }),
      'invalid_recipient',
      400,
    );
  });

  it('REJECTS the agent wallet itself (self-dealing / wash trading)', async () => {
    const { service, sendTransaction } = build();
    const err = await expectRemitError(
      service.execute({ ...good, recipient: AGENT }),
      'self_dealing',
      400,
    );
    expect(err.message).toMatch(/wash trading/i);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('rejects the agent wallet in a different case (checksum-insensitive)', async () => {
    const { service } = build();
    await expectRemitError(
      service.execute({ ...good, recipient: AGENT.toUpperCase().replace('0X', '0x') }),
      'self_dealing',
      400,
    );
  });
});

describe('guardrail: corridor', () => {
  it('rejects a currency with no executable route (400)', async () => {
    const { service, sendTransaction } = build();
    const err = await expectRemitError(
      service.execute({ ...good, to: 'PHP' }),
      'unsupported_currency',
      400,
    );
    expect(err.details.available).toEqual(['KES']);
    expect(sendTransaction).not.toHaveBeenCalled();
  });
});

describe('guardrail: daily cap', () => {
  it('rejects (429) once the cumulative daily cap would be exceeded', async () => {
    // cap 100, max 25 => 4 remittances of 25 fit, the 5th must not.
    const { service, sendTransaction } = build();

    for (let i = 0; i < 4; i += 1) {
      await service.execute({ ...good, amount: 25 });
    }
    expect(sendTransaction).toHaveBeenCalledTimes(4);

    const err = await expectRemitError(
      service.execute({ ...good, amount: 25 }),
      'daily_cap_exceeded',
      429,
    );
    expect(err.details.dailyCapUsd).toBe(100);
    expect(sendTransaction).toHaveBeenCalledTimes(4); // nothing new was sent
  });

  it('gives the budget back when the swap reverts, so the cap is not consumed', async () => {
    const { service, remitLog } = build({ receiptStatus: 'reverted' });

    await expectRemitError(service.execute({ ...good, amount: 25 }), 'swap_failed', 502);

    // Logged as pending at broadcast, then corrected to failed on the receipt.
    expect(remitLog.entries.map((e) => e.status)).toEqual(['pending', 'failed']);
    // A reverted tx moved no value => it must not eat the daily budget.
    expect(remitLog.spentToday()).toBe(0);
  });

  it('books the spend the moment the tx is broadcast (crash-safe), not on receipt', async () => {
    // The receipt never arrives: the funds are moving anyway, so the money must
    // stay booked against the cap rather than silently freeing budget.
    const { service, remitLog } = build({ receiptThrows: true });

    const result = await service.execute({ ...good, amount: 25 });

    expect(result.status).toBe('pending');
    expect(remitLog.spentToday()).toBe(25);
    expect(remitLog.entries).toHaveLength(1);
    expect(remitLog.entries[0]).toMatchObject({ status: 'pending', amount: 25 });
  });

  it('a failed remittance does not release a CONCURRENT request\'s reservation', async () => {
    // Regression: commit() used to also release(), so the catch path released
    // twice — handing back another in-flight request's booking and letting a
    // later remittance slip past the daily cap.
    const { service, remitLog } = build({ receiptStatus: 'reverted' });

    await Promise.allSettled([
      service.execute({ ...good, amount: 25 }),
      service.execute({ ...good, amount: 25 }),
    ]);

    // Both reverted => nothing spent, and no reservation leaked or stolen.
    expect(remitLog.spentToday()).toBe(0);
    expect(remitLog.remainingToday()).toBe(100);
  });

  it('does not let two concurrent remittances both slip under the cap', async () => {
    // cap 100 with 4 parallel x 25 => all fit; a 5th parallel must be rejected.
    const { service, sendTransaction } = build();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => service.execute({ ...good, amount: 25 })),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(ok).toHaveLength(4);
    expect(rejected).toHaveLength(1);
    expect(sendTransaction).toHaveBeenCalledTimes(4);
  });
});

describe('guardrail: balance', () => {
  it('refuses (503) when the agent cannot cover the remittance', async () => {
    const { service, sendTransaction } = build({ balanceUsd: 5 });
    const err = await expectRemitError(
      service.execute({ ...good, amount: 10 }),
      'insufficient_funds',
      503,
    );
    expect(err.details).toMatchObject({ required: 10, token: 'USDC' });
    expect(sendTransaction).not.toHaveBeenCalled();
  });
});

describe('guardrail: slippage', () => {
  it('ABORTS (409) without executing when the rate moved beyond tolerance', async () => {
    const { service, sendTransaction } = build({ rate: 120 }); // quoted 129 -> now 120 (-7%)
    const quoteId = 'q-1';
    service.quotes.register(quoteId, { fiat: 'KES', rate: 129, amount: 10 });

    const err = await expectRemitError(
      service.execute({ ...good, quoteId }),
      'rate_moved',
      409,
    );
    // The caller gets the NEW rate so they can decide again.
    expect(err.details).toMatchObject({ quotedRate: 129, newRate: 120 });
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('executes when the drift is within tolerance', async () => {
    const { service } = build({ rate: 128.5 }); // -0.39% vs 129, under the 1% default
    const quoteId = 'q-2';
    service.quotes.register(quoteId, { fiat: 'KES', rate: 129, amount: 10 });

    await expect(service.execute({ ...good, quoteId })).resolves.toMatchObject({ status: 'success' });
  });

  it('executes when the rate moved in the RECIPIENT\'s favour', async () => {
    const { service } = build({ rate: 140 }); // recipient gets more: never blocked
    const quoteId = 'q-3';
    service.quotes.register(quoteId, { fiat: 'KES', rate: 129, amount: 10 });

    await expect(service.execute({ ...good, quoteId })).resolves.toMatchObject({ received: 1400 });
  });

  it('rejects (409) an unknown/expired quoteId instead of silently re-pricing', async () => {
    const { service, sendTransaction } = build();
    await expectRemitError(
      service.execute({ ...good, quoteId: 'nope' }),
      'quote_expired',
      409,
    );
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('passes REMIT_MAX_SLIPPAGE_PCT down as the on-chain amountOutMin floor', async () => {
    const { service, buildSwapTransaction } = build();
    const result = await service.execute(good);

    const options = buildSwapTransaction.mock.calls[0]![5] as { slippageTolerance: number };
    expect(options.slippageTolerance).toBe(1);
    // 1290 KESm expected, 1% floor => the swap reverts below 1277.1 on-chain.
    expect(result.minReceived).toBeCloseTo(1277.1, 4);
  });
});

// ---------------------------------------------------------------------------
// Persistence: the daily cap must survive a restart.
// ---------------------------------------------------------------------------

describe('JsonlRemitLog', () => {
  let file: string;

  beforeEach(() => {
    file = path.join(mkdtempSync(path.join(tmpdir(), 'remesaflow-')), 'remits.jsonl');
  });

  const entry = (overrides: Partial<RemitLogEntry> = {}): RemitLogEntry => ({
    timestamp: new Date().toISOString(),
    amount: 20,
    corridor: 'USD-KES',
    recipientHash: 'abc123',
    txHash: SWAP_TX_HASH,
    approvalTxHash: null,
    rate: 129,
    received: 2580,
    tag: TAG,
    network: 'celo-sepolia',
    status: 'success',
    ...overrides,
  });

  it('persists entries and rebuilds today\'s spend after a restart', () => {
    const first = new JsonlRemitLog(100, file);
    expect(first.reserve(20)).toBe(true);
    first.commit(entry());
    first.release(20);
    expect(first.spentToday()).toBe(20);

    // Restart: a fresh instance must NOT hand out a clean slate.
    const restarted = new JsonlRemitLog(100, file);
    expect(restarted.spentToday()).toBe(20);
    expect(restarted.remainingToday()).toBe(80);
  });

  it('counts a pending->success pair ONCE (the correction is not a double-count)', () => {
    const log = new JsonlRemitLog(100, file);
    log.reserve(20);
    log.commit(entry({ status: 'pending' }));
    log.commit(entry({ status: 'success' }));
    log.release(20);

    expect(log.spentToday()).toBe(20);
    expect(new JsonlRemitLog(100, file).spentToday()).toBe(20);
  });

  it('does not count reverted remittances against the cap after a restart', () => {
    const log = new JsonlRemitLog(100, file);
    log.reserve(20);
    log.commit(entry({ status: 'pending' }));
    log.commit(entry({ status: 'failed' })); // correction: budget given back
    log.release(20);

    expect(log.spentToday()).toBe(0);
    expect(new JsonlRemitLog(100, file).spentToday()).toBe(0);
  });

  it('still counts a tx we only ever logged as pending (crashed before the receipt)', () => {
    const log = new JsonlRemitLog(100, file);
    log.reserve(20);
    log.commit(entry({ status: 'pending' }));
    // Process dies here — no correction line is ever written.

    // The funds were broadcast, so the restart must NOT give the budget back.
    expect(new JsonlRemitLog(100, file).spentToday()).toBe(20);
  });

  it('ignores entries from previous days', () => {
    const log = new JsonlRemitLog(100, file);
    log.reserve(20);
    log.commit(entry({ timestamp: '2020-01-01T00:00:00.000Z' }));

    expect(new JsonlRemitLog(100, file).spentToday()).toBe(0);
  });

  it('refuses a reservation that would break the cap', () => {
    const log = new JsonlRemitLog(100, file);
    expect(log.reserve(60)).toBe(true);
    expect(log.reserve(60)).toBe(false); // 120 > 100
    log.release(60);
    expect(log.reserve(60)).toBe(true);
  });

  it('survives a corrupt line without crashing (and warns)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      writeFileSync(file, `${JSON.stringify(entry())}\n{ not json\n`, 'utf8');
      expect(new JsonlRemitLog(100, file).spentToday()).toBe(20);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('corrupt'));
    } finally {
      warn.mockRestore();
    }
  });

  it('writes an auditable line: tx, corridor, rate, tag, hashed recipient', () => {
    const log = new JsonlRemitLog(100, file);
    log.reserve(20);
    log.commit(entry());

    const written = JSON.parse(readFileSync(file, 'utf8').trim()) as RemitLogEntry;
    expect(written).toMatchObject({
      amount: 20,
      corridor: 'USD-KES',
      txHash: SWAP_TX_HASH,
      rate: 129,
      tag: TAG,
      recipientHash: 'abc123',
      network: 'celo-sepolia',
    });
    // The raw recipient address must never hit the log.
    expect(readFileSync(file, 'utf8')).not.toContain(RECIPIENT);
  });

  it('finds an entry by txHash (for GET /api/remit/:txHash)', () => {
    const log = new JsonlRemitLog(100, file);
    log.reserve(20);
    log.commit(entry());
    expect(log.find(SWAP_TX_HASH)).toMatchObject({ amount: 20, corridor: 'USD-KES' });
    expect(log.find(`0x${'99'.repeat(32)}`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HTTP surface.
// ---------------------------------------------------------------------------

describe('POST /api/remit', () => {
  const silentLog: QueryLog = { log: () => {} };

  it('returns 503 with an explanation when execution is not wired at all', async () => {
    const app = createApp({ config: cfg(), queryLog: silentLog });
    const res = await app.request('/api/remit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(good),
    });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('remit_unavailable');
  });

  it('returns 503 when REMIT_ENABLED=false', async () => {
    const config = cfg({ remit: { ...loadConfig({}).remit, enabled: false } });
    const { service } = build({}, config);
    const app = createApp({ config, queryLog: silentLog, remitService: service });

    const res = await app.request('/api/remit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(good),
    });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('remit_disabled');
    expect(body.message).toMatch(/REMIT_ENABLED/);
  });

  it('executes and returns the tx receipt shape', async () => {
    const { service, config } = build();
    const app = createApp({ config, queryLog: silentLog, remitService: service });

    const res = await app.request('/api/remit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(good),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      txHash: SWAP_TX_HASH,
      explorerUrl: `${SEPOLIA.explorer}/tx/${SWAP_TX_HASH}`,
      sent: 10,
      received: 1290,
      rate: 129,
      recipient: RECIPIENT,
      currency: 'KES',
    });
  });

  it('maps guardrail failures to their HTTP status', async () => {
    const { service, config } = build();
    const app = createApp({ config, queryLog: silentLog, remitService: service });

    const post = (body: unknown) =>
      app.request('/api/remit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    expect((await post({ ...good, amount: 999 })).status).toBe(400);
    expect((await post({ ...good, recipient: AGENT })).status).toBe(400);
    expect((await post({ ...good, to: 'XXX' })).status).toBe(400);
    expect((await post({ ...good, quoteId: 'stale' })).status).toBe(409);
  });

  it('rejects a malformed body (400)', async () => {
    const { service, config } = build();
    const app = createApp({ config, queryLog: silentLog, remitService: service });

    const res = await app.request('/api/remit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_body');
  });

  it('binds a quoteId issued by GET /api/quote to the execution', async () => {
    const { service, config } = build();
    const app = createApp({ config, queryLog: silentLog, remitService: service });

    const quoteRes = await app.request('/api/quote?amount=10&to=KES');
    const quote = await quoteRes.json();
    expect(quote.quoteId).toEqual(expect.any(String));

    // The mock quote engine's rate differs from the Mento fake's 129, but the
    // drift here is well within tolerance in the recipient's favour.
    const res = await app.request('/api/remit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...good, quoteId: quote.quoteId }),
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// On-chain integration (READ-ONLY). Runs only with RUN_ONCHAIN_TESTS=1.
// It plans a real remittance against the live network and asserts the tx SHAPE,
// but never signs or broadcasts: the wallet client throws on sendTransaction.
// ---------------------------------------------------------------------------

describe.skipIf(process.env.RUN_ONCHAIN_TESTS !== '1')('RemitService on-chain (live RPC)', () => {
  it('builds ONE value-carrying swap tx that pays the recipient directly', async () => {
    const { MentoQuoteEngine } = await import('../src/quote-mento.js');
    const config = cfg();

    const noSend: MinimalWalletClient = {
      account: { address: AGENT },
      sendTransaction: async () => {
        throw new Error('on-chain test must never broadcast');
      },
    };
    const wallet = new AgentWallet(config, { walletClient: noSend });
    const engine = await MentoQuoteEngine.create(config);

    const service = new RemitService({
      config,
      wallet,
      mento: engine.client as unknown as MentoSwapLike,
      pairs: engine.pairs,
      remitLog: memLog(),
    });

    const fiat = service.supportedCurrencies()[0] as string;
    // skipBalanceCheck: the test wallet is unfunded; we assert the tx SHAPE.
    const plan = await service.plan(
      { amount: 5, to: fiat, recipient: RECIPIENT },
      { skipBalanceCheck: true },
    );

    console.log('[onchain] plan:', {
      corridor: plan.corridor,
      rate: plan.rate,
      valueTxTo: plan.valueTx.to,
      calldataBytes: (plan.valueTx.data.length - 2) / 2,
      needsApproval: plan.approvalTx !== null,
    });

    // A real, live rate and a real swap built against the deployed Router.
    expect(plan.rate).toBeGreaterThan(0);
    expect(plan.expectedReceived).toBeGreaterThan(0);
    // The floor is strictly below the expectation (slippage protection is real).
    expect(plan.amountOutMin).toBeLessThan(plan.expectedOut);
    expect(plan.amountOutMin).toBeGreaterThan(0n);
    // ONE value tx, to the Router, with real calldata.
    expect(plan.valueTx.data.startsWith('0x')).toBe(true);
    expect(plan.valueTx.data.length).toBeGreaterThan(10);
    // The recipient is encoded in the swap calldata: the swap itself delivers.
    expect(plan.valueTx.data.toLowerCase()).toContain(RECIPIENT.slice(2).toLowerCase());
  }, 180_000); // Forno is rate-limited; discovery can be slow
});

describe('GET /api/remit/:txHash', () => {
  const silentLog: QueryLog = { log: () => {} };

  it('reads the remittance status on-chain and joins the local audit record', async () => {
    const { service, config } = build();
    const app = createApp({ config, queryLog: silentLog, remitService: service });

    await service.execute(good);

    const res = await app.request(`/api/remit/${SWAP_TX_HASH}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      txHash: SWAP_TX_HASH,
      status: 'success',
      blockNumber: 999,
      explorerUrl: `${SEPOLIA.explorer}/tx/${SWAP_TX_HASH}`,
    });
    expect(body.remit).toMatchObject({ amount: 10, corridor: 'USD-KES' });
  });

  it('rejects a malformed tx hash (400)', async () => {
    const { service, config } = build();
    const app = createApp({ config, queryLog: silentLog, remitService: service });

    const res = await app.request('/api/remit/0xnope');
    expect(res.status).toBe(400);
  });
});
