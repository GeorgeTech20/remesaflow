/**
 * F-EXEC — real remittance execution (the agent stops quoting and starts paying).
 *
 * ============================================================================
 * TRANSACTION DESIGN — READ THIS BEFORE CHANGING ANYTHING
 * ============================================================================
 * A remittance is AT MOST TWO transactions, and exactly ONE of them carries the
 * USD value:
 *
 *   tx A (conditional, $0 of value): ERC-20 `approve` USDC -> Mento Router.
 *          Sent only when the current allowance cannot cover amountIn. It moves
 *          no tokens; it only grants the router an allowance.
 *
 *   tx B (ALWAYS, carries the FULL USD amount): Mento Router
 *          `swapExactTokensForTokens(..., recipient)`. Inside this single tx:
 *            - amountIn USDC leaves the agent wallet (the agent is tx.from), and
 *            - the regional stablecoin (KESm/PHPm/...) is delivered STRAIGHT to
 *              the recipient, because the Mento SDK takes `recipient` as a
 *              parameter distinct from `owner`.
 *
 * Why this shape and not swap-then-transfer:
 *   - One atomic tx means the recipient either gets the money or nothing happens.
 *     A separate "swap, then ERC-20 transfer to the recipient" leaves a window
 *     where the swap succeeded but the delivery failed, stranding funds in the
 *     agent wallet and requiring manual recovery.
 *   - It also halves the gas and keeps the on-chain audit trail to a single hash
 *     per remittance, which is what /api/remit returns to the caller.
 *
 * Remittances are NEVER batched: one remittance = one user request = one tx.
 * There are no loops, crons or timers in this module by design — the agent only
 * moves money when a human asked it to, and every movement is individually
 * traceable.
 *
 * Every tx goes out through wallet.sendWithTag(), which appends the ERC-8021
 * attribution suffix and refuses to send on mainnet without ATTRIBUTION_TAG.
 * ============================================================================
 */
import {
  formatUnits,
  getAddress,
  isAddress,
  parseEventLogs,
  parseUnits,
  zeroAddress,
  type Hex,
} from 'viem';
import type { Address, AppConfig } from './config.js';
import { REMIT_MIN_USD } from './config.js';
import type { DiscoveredPair } from './quote-mento.js';
import { hashRecipient, type RemitLog, type RemitStatus } from './remit-log.js';
import type { AgentWallet } from './wallet.js';

// --------------------------------------------------------------------------
// Errors — each maps to the HTTP status the API contract promises.
// --------------------------------------------------------------------------

export type RemitErrorCode =
  | 'remit_disabled'
  | 'wallet_unavailable'
  | 'invalid_amount'
  | 'amount_over_limit'
  | 'unsupported_currency'
  | 'invalid_recipient'
  | 'self_dealing'
  | 'daily_cap_exceeded'
  | 'insufficient_funds'
  | 'quote_expired'
  | 'rate_moved'
  | 'swap_failed';

export class RemitError extends Error {
  constructor(
    readonly code: RemitErrorCode,
    readonly status: number,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'RemitError';
  }

  toJSON(): Record<string, unknown> {
    return { error: this.code, message: this.message, ...this.details };
  }
}

// --------------------------------------------------------------------------
// Mento surface we depend on (structural: tests inject a fake, no network).
// --------------------------------------------------------------------------

/** A ready-to-send call, as returned by the Mento SDK. */
export interface CallParamsLike {
  to: string;
  data: string;
  value?: bigint;
}

export interface SwapTransactionLike {
  /** null when the Router allowance already covers amountIn. */
  approval: CallParamsLike | null;
  swap: {
    params: CallParamsLike;
    amountIn: bigint;
    amountOutMin: bigint;
    expectedAmountOut: bigint;
  };
}

export interface MentoSwapLike {
  quotes: {
    getAmountOut(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<bigint>;
  };
  swap: {
    buildSwapTransaction(
      tokenIn: string,
      tokenOut: string,
      amountIn: bigint,
      recipient: string,
      owner: string,
      options: { slippageTolerance: number; deadline: bigint },
    ): Promise<SwapTransactionLike>;
  };
}

// --------------------------------------------------------------------------
// Quote registry — binds a shown quote to the rate the user agreed to.
// --------------------------------------------------------------------------

export interface RegisteredQuote {
  fiat: string;
  rate: number;
  amount: number;
  expiresAt: number;
}

/**
 * In-memory store of the quotes we handed out, so /api/remit can check the rate
 * the user actually SAW against the fresh on-chain rate. Bounded + TTL'd; a
 * lost entry (restart) just means the caller must re-quote.
 */
export class QuoteRegistry {
  private readonly quotes = new Map<string, RegisteredQuote>();

  constructor(
    private readonly ttlMs = 120_000,
    private readonly maxEntries = 1_000,
    private readonly now: () => number = Date.now,
  ) {}

  register(id: string, quote: Omit<RegisteredQuote, 'expiresAt'>): void {
    if (this.quotes.size >= this.maxEntries) {
      this.evictExpired();
      if (this.quotes.size >= this.maxEntries) {
        // Still full: drop the oldest insertion (Map preserves insertion order).
        const oldest = this.quotes.keys().next();
        if (!oldest.done) this.quotes.delete(oldest.value);
      }
    }
    this.quotes.set(id, { ...quote, expiresAt: this.now() + this.ttlMs });
  }

  /** Returns the quote, or null when unknown/expired. */
  get(id: string): RegisteredQuote | null {
    const quote = this.quotes.get(id);
    if (!quote) return null;
    if (quote.expiresAt <= this.now()) {
      this.quotes.delete(id);
      return null;
    }
    return quote;
  }

  private evictExpired(): void {
    const now = this.now();
    for (const [id, quote] of this.quotes) {
      if (quote.expiresAt <= now) this.quotes.delete(id);
    }
  }
}

// --------------------------------------------------------------------------
// Public shapes
// --------------------------------------------------------------------------

export interface RemitInput {
  amount: number;
  to: string;
  recipient: string;
  quoteId?: string | undefined;
}

export interface PlanOptions {
  /**
   * DRY-RUN ONLY. Lets an unfunded wallet still produce a plan, so the smoke
   * script can print the exact tx it would broadcast. execute() never sets it.
   */
  skipBalanceCheck?: boolean;
}

/** Exactly what execute() would broadcast. Produced without signing anything. */
export interface RemitPlan {
  amountUsd: number;
  corridor: string;
  fiat: string;
  stablecoin: string;
  recipient: Address;
  tokenIn: Address;
  tokenInSymbol: string;
  amountIn: bigint;
  tokenOut: Address;
  expectedOut: bigint;
  /** On-chain floor: the swap reverts below this (slippage protection). */
  amountOutMin: bigint;
  /** Fresh on-chain rate (local currency per USD). */
  rate: number;
  /** Rate the user was quoted, when a quoteId was supplied. */
  quotedRate: number | null;
  expectedReceived: number;
  minReceived: number;
  slippagePct: number;
  /** The $0-value ERC-20 approve, when the Router allowance is short. */
  approvalTx: CallParamsLike | null;
  /** THE value-carrying tx: the Mento swap that also delivers to the recipient. */
  valueTx: CallParamsLike;
  attributionTag: string | null;
  /** Agent's tokenIn balance, for the dry-run report. */
  agentBalance: string;
  fundedEnough: boolean;
}

export interface RemitResult {
  txHash: Hex;
  explorerUrl: string;
  sent: number;
  received: number;
  rate: number;
  recipient: Address;
  currency: string;
  status: RemitStatus;
  /** Present only when an allowance top-up was needed. Carries no value. */
  approvalTxHash: Hex | null;
  minReceived: number;
}

export interface RemitStatusResult {
  txHash: string;
  status: RemitStatus | 'unknown';
  explorerUrl: string;
  blockNumber: number | null;
  /** ERC-8021 codes decoded from the tx calldata (proves attribution). */
  attributionCodes: string[] | null;
  /** Local audit record, when this backend is the one that sent it. */
  remit: {
    amount: number;
    corridor: string;
    rate: number;
    received: number;
    timestamp: string;
  } | null;
}

const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const;

/** Mento swap deadline: short, because we re-quote right before sending. */
const DEADLINE_MINUTES = 5;
const RECEIPT_TIMEOUT_MS = 90_000;

export interface RemitServiceDeps {
  config: AppConfig;
  wallet: AgentWallet;
  mento: MentoSwapLike;
  /** Corridors with a real on-chain route (from MentoQuoteEngine discovery). */
  pairs: DiscoveredPair[];
  remitLog: RemitLog;
  quotes?: QuoteRegistry;
  now?: () => Date;
}

export class RemitService {
  private readonly pairMap: Map<string, DiscoveredPair>;
  private readonly config: AppConfig;
  private readonly wallet: AgentWallet;
  private readonly mento: MentoSwapLike;
  private readonly remitLog: RemitLog;
  readonly quotes: QuoteRegistry;
  private readonly now: () => Date;

  constructor(deps: RemitServiceDeps) {
    this.config = deps.config;
    this.wallet = deps.wallet;
    this.mento = deps.mento;
    this.remitLog = deps.remitLog;
    this.quotes = deps.quotes ?? new QuoteRegistry();
    this.now = deps.now ?? (() => new Date());
    this.pairMap = new Map(deps.pairs.map((p) => [p.fiat, p]));
  }

  supportedCurrencies(): string[] {
    return [...this.pairMap.keys()];
  }

  // ------------------------------------------------------------------------
  // Validation — pure, no network. Runs before anything is built or signed.
  // ------------------------------------------------------------------------

  /**
   * GUARDRAIL 1: the endpoint is dead unless REMIT_ENABLED=true.
   * Fails closed so a fresh deploy can never move money by accident.
   */
  private assertEnabled(): void {
    if (!this.config.remit.enabled) {
      throw new RemitError(
        'remit_disabled',
        503,
        'Remittance execution is disabled. This agent only quotes until REMIT_ENABLED=true ' +
          'is set on the server (it moves real funds, so it is opt-in by design).',
        { hint: 'Set REMIT_ENABLED=true in the backend environment to enable POST /api/remit.' },
      );
    }
    if (!this.wallet.canSign) {
      throw new RemitError(
        'wallet_unavailable',
        503,
        'The agent wallet is in read-only mode (AGENT_PRIVATE_KEY is not set): cannot sign a ' +
          'remittance.',
      );
    }
  }

  /** GUARDRAIL 2: per-remittance USD limit. */
  private validateAmount(amount: unknown): number {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      throw new RemitError('invalid_amount', 400, 'amount must be a positive number of USD.');
    }
    if (amount < REMIT_MIN_USD) {
      throw new RemitError(
        'invalid_amount',
        400,
        `amount must be at least ${REMIT_MIN_USD} USD (below that, gas dominates the transfer).`,
        { min: REMIT_MIN_USD },
      );
    }
    if (amount > this.config.remit.maxUsd) {
      throw new RemitError(
        'amount_over_limit',
        400,
        `amount ${amount} USD exceeds the per-remittance limit of ${this.config.remit.maxUsd} USD.`,
        { max: this.config.remit.maxUsd },
      );
    }
    return amount;
  }

  private validateCorridor(to: unknown): DiscoveredPair {
    const fiat = String(to ?? '').toUpperCase();
    const pair = this.pairMap.get(fiat);
    if (!pair) {
      throw new RemitError(
        'unsupported_currency',
        400,
        `No executable corridor for "${fiat}".`,
        { requested: fiat, available: this.supportedCurrencies() },
      );
    }
    return pair;
  }

  /**
   * GUARDRAIL 3: strict recipient validation. A valid EVM address that is
   * neither the burn address nor the agent's own wallet. A remittance to the
   * agent itself is not a remittance — it is self-dealing, and it is refused.
   */
  private validateRecipient(recipient: unknown): Address {
    if (typeof recipient !== 'string' || !isAddress(recipient, { strict: false })) {
      throw new RemitError(
        'invalid_recipient',
        400,
        'recipient must be a valid EVM address (0x + 40 hex chars).',
      );
    }
    const address = getAddress(recipient);

    if (address === getAddress(zeroAddress)) {
      throw new RemitError(
        'invalid_recipient',
        400,
        'recipient cannot be the zero address: that would burn the funds.',
      );
    }

    const agent = this.wallet.getAgentAddress();
    if (agent && address === getAddress(agent)) {
      throw new RemitError(
        'self_dealing',
        400,
        'recipient cannot be the agent wallet itself. Sending funds to our own address is ' +
          'wash trading, not a remittance — refusing.',
      );
    }
    return address;
  }

  // ------------------------------------------------------------------------
  // plan() — full validation + on-chain re-quote + built txs. Signs NOTHING.
  // Used by execute() and by the dry-run script.
  // ------------------------------------------------------------------------

  async plan(input: RemitInput, options: PlanOptions = {}): Promise<RemitPlan> {
    this.assertEnabled();
    const amount = this.validateAmount(input.amount);
    const pair = this.validateCorridor(input.to);
    const recipient = this.validateRecipient(input.recipient);
    const agent = this.wallet.getAgentAddress();
    if (!agent) {
      throw new RemitError('wallet_unavailable', 503, 'The agent wallet cannot sign.');
    }

    // GUARDRAIL 4: daily cap (read-only check here; execute() re-checks
    // atomically via reserve() to close the concurrency window).
    if (amount > this.remitLog.remainingToday()) {
      throw new RemitError(
        'daily_cap_exceeded',
        429,
        `This remittance (${amount} USD) would exceed the agent's daily cap of ` +
          `${this.config.remit.dailyCapUsd} USD. Spent today: ` +
          `${this.remitLog.spentToday().toFixed(2)} USD.`,
        {
          dailyCapUsd: this.config.remit.dailyCapUsd,
          spentTodayUsd: Number(this.remitLog.spentToday().toFixed(2)),
          remainingTodayUsd: Number(this.remitLog.remainingToday().toFixed(2)),
        },
      );
    }

    const amountIn = parseUnits(amount.toString(), pair.tokenInDecimals);

    // GUARDRAIL 5: the agent must actually hold the funds.
    const balance = await this.wallet.publicClient.readContract({
      address: pair.tokenIn,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [agent],
    });
    // skipBalanceCheck exists ONLY for the offline dry-run (scripts/remit-dryrun.ts),
    // so it can show the tx it would build from an unfunded wallet. execute()
    // always calls plan() with no options, so the sending path can never skip it.
    if (!options.skipBalanceCheck && balance < amountIn) {
      throw new RemitError(
        'insufficient_funds',
        503,
        `The agent wallet holds ${formatUnits(balance, pair.tokenInDecimals)} ` +
          `${pair.tokenInSymbol} but needs ${amount} to send this remittance. ` +
          'Fund the agent wallet and retry.',
        {
          balance: formatUnits(balance, pair.tokenInDecimals),
          required: amount,
          token: pair.tokenInSymbol,
        },
      );
    }

    // Fresh on-chain re-quote: the rate at execution time, not at quote time.
    const expectedOut = await this.mento.quotes.getAmountOut(pair.tokenIn, pair.tokenOut, amountIn);
    // Regional Mento stablecoins are 18-dec and 1 token == 1 fiat unit.
    const expectedReceived = Number(formatUnits(expectedOut, 18));
    const rate = expectedReceived / amount;

    // GUARDRAIL 6: slippage vs the rate the user actually agreed to. If the
    // market moved against them beyond tolerance, abort WITHOUT executing and
    // hand back the new rate so they can decide again.
    const quotedRate = this.resolveQuotedRate(input.quoteId, pair.fiat);
    if (quotedRate !== null) {
      const driftPct = ((quotedRate - rate) / quotedRate) * 100;
      if (driftPct > this.config.remit.maxSlippagePct) {
        throw new RemitError(
          'rate_moved',
          409,
          `The rate moved ${driftPct.toFixed(2)}% against the recipient since your quote ` +
            `(max allowed: ${this.config.remit.maxSlippagePct}%). Nothing was executed. ` +
            'Re-quote and retry if the new rate works for you.',
          {
            quotedRate,
            newRate: rate,
            driftPct: Number(driftPct.toFixed(4)),
            maxSlippagePct: this.config.remit.maxSlippagePct,
          },
        );
      }
    }

    // Build (not send) the txs. `recipient` != `owner` is what lets the swap
    // deliver straight to the beneficiary — the whole one-value-tx design.
    const deadline = BigInt(
      Math.floor(this.now().getTime() / 1000) + DEADLINE_MINUTES * 60,
    );
    const built = await this.mento.swap.buildSwapTransaction(
      pair.tokenIn,
      pair.tokenOut,
      amountIn,
      recipient,
      agent,
      { slippageTolerance: this.config.remit.maxSlippagePct, deadline },
    );

    return {
      amountUsd: amount,
      corridor: `USD-${pair.fiat}`,
      fiat: pair.fiat,
      stablecoin: pair.stablecoin,
      recipient,
      tokenIn: pair.tokenIn,
      tokenInSymbol: pair.tokenInSymbol,
      amountIn,
      tokenOut: pair.tokenOut,
      expectedOut,
      amountOutMin: built.swap.amountOutMin,
      rate,
      quotedRate,
      expectedReceived,
      minReceived: Number(formatUnits(built.swap.amountOutMin, 18)),
      slippagePct: this.config.remit.maxSlippagePct,
      approvalTx: built.approval,
      valueTx: built.swap.params,
      attributionTag: this.config.attributionTag ?? null,
      agentBalance: formatUnits(balance, pair.tokenInDecimals),
      fundedEnough: balance >= amountIn,
    };
  }

  /**
   * The rate the user agreed to. An explicit quoteId that we do not recognise
   * (expired, or from another process) is an ERROR, not a silent skip: the user
   * asked to execute at a rate we can no longer prove.
   */
  private resolveQuotedRate(quoteId: string | undefined, fiat: string): number | null {
    if (!quoteId) return null; // no quote binding: on-chain amountOutMin still guards us
    const quote = this.quotes.get(quoteId);
    if (!quote) {
      throw new RemitError(
        'quote_expired',
        409,
        'That quoteId is unknown or expired. Request a fresh quote and retry.',
        { quoteId },
      );
    }
    if (quote.fiat !== fiat) {
      throw new RemitError(
        'quote_expired',
        409,
        `That quote is for USD-${quote.fiat}, not USD-${fiat}.`,
        { quoteId },
      );
    }
    return quote.rate;
  }

  // ------------------------------------------------------------------------
  // execute() — the only method that broadcasts.
  // ------------------------------------------------------------------------

  async execute(input: RemitInput): Promise<RemitResult> {
    const plan = await this.plan(input);

    // Atomically book the amount BEFORE broadcasting: two concurrent requests
    // can never both slip under the daily cap.
    if (!this.remitLog.reserve(plan.amountUsd)) {
      throw new RemitError(
        'daily_cap_exceeded',
        429,
        `This remittance (${plan.amountUsd} USD) would exceed the agent's daily cap of ` +
          `${this.config.remit.dailyCapUsd} USD.`,
        {
          dailyCapUsd: this.config.remit.dailyCapUsd,
          spentTodayUsd: Number(this.remitLog.spentToday().toFixed(2)),
        },
      );
    }

    let approvalTxHash: Hex | null = null;
    try {
      // tx A — allowance top-up. Moves NO value; tagged all the same.
      if (plan.approvalTx) {
        approvalTxHash = await this.wallet.sendWithTag({
          to: getAddress(plan.approvalTx.to),
          data: plan.approvalTx.data as Hex,
        });
        console.log(`[remit] approval sent (0 value): ${approvalTxHash}`);
        // Must confirm before the swap, or the swap reverts on allowance.
        const approvalReceipt = await this.wallet.publicClient.waitForTransactionReceipt({
          hash: approvalTxHash,
          timeout: RECEIPT_TIMEOUT_MS,
        });
        if (approvalReceipt.status !== 'success') {
          throw new RemitError(
            'swap_failed',
            502,
            'The USDC approval transaction reverted. No funds were moved.',
            { approvalTxHash },
          );
        }
      }

      // tx B — THE remittance. One tx: USDC out of the agent, local stablecoin
      // into the recipient. This is the tx that carries the USD volume.
      const txHash = await this.wallet.sendWithTag({
        to: getAddress(plan.valueTx.to),
        data: plan.valueTx.data as Hex,
      });
      console.log(
        `[remit] VALUE TX sent: ${txHash} (${plan.amountUsd} USD -> ${plan.fiat}, ` +
          `recipient=${plan.recipient})`,
      );

      const audit = (status: RemitStatus, received: number, rate: number) =>
        this.remitLog.commit({
          timestamp: this.now().toISOString(),
          amount: plan.amountUsd,
          corridor: plan.corridor,
          recipientHash: hashRecipient(plan.recipient),
          txHash,
          approvalTxHash,
          rate,
          received,
          tag: plan.attributionTag,
          network: this.config.network.name,
          status,
        });

      // Persist IMMEDIATELY, before waiting for the receipt: the funds are
      // already moving. If we crashed during the wait, this line is what stops
      // a restart from forgetting the spend and handing back the daily budget.
      // The final write below corrects it (keyed by txHash, so no double-count).
      audit('pending', plan.expectedReceived, plan.rate);

      const receipt = await this.wallet.publicClient
        .waitForTransactionReceipt({ hash: txHash, timeout: RECEIPT_TIMEOUT_MS })
        .catch(() => null); // broadcast but not mined in time -> pending, not failed

      const status: RemitStatus =
        receipt === null ? 'pending' : receipt.status === 'success' ? 'success' : 'failed';

      // Prefer the REAL delivered amount decoded from the receipt over our estimate.
      const delivered =
        receipt && status === 'success'
          ? this.deliveredAmount(receipt.logs, plan.tokenOut, plan.recipient)
          : null;
      const received = delivered ?? plan.expectedReceived;
      const rate = received / plan.amountUsd;

      if (receipt !== null) {
        // Correction write: 'failed' here gives the daily budget back.
        audit(status, received, rate);
      }

      if (status === 'failed') {
        throw new RemitError(
          'swap_failed',
          502,
          'The swap transaction reverted on-chain. No funds left the agent wallet.',
          { txHash, explorerUrl: this.explorerUrl(txHash) },
        );
      }

      return {
        txHash,
        explorerUrl: this.explorerUrl(txHash),
        sent: plan.amountUsd,
        received,
        rate,
        recipient: plan.recipient,
        currency: plan.fiat,
        status,
        approvalTxHash,
        minReceived: plan.minReceived,
      };
    } finally {
      // Exactly once, on every path. The spend itself is tracked by commit()
      // (keyed by txHash); this only frees the in-flight booking. Releasing it
      // twice would hand back a CONCURRENT request's reservation.
      this.remitLog.release(plan.amountUsd);
    }
  }

  /**
   * GET /api/remit/:txHash — on-chain state of a remittance, plus our own audit
   * record when we are the sender. The attribution codes are decoded from the
   * real calldata (verifyTx), so a judge can confirm the tag without trusting
   * our logs.
   */
  async getStatus(txHash: string): Promise<RemitStatusResult> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      throw new RemitError('invalid_amount', 400, 'txHash must be a 32-byte hex hash (0x + 64 hex).');
    }
    const hash = txHash as Hex;

    let status: RemitStatus | 'unknown' = 'unknown';
    let blockNumber: number | null = null;
    try {
      const receipt = await this.wallet.publicClient.getTransactionReceipt({ hash });
      status = receipt.status === 'success' ? 'success' : 'failed';
      blockNumber = Number(receipt.blockNumber);
    } catch {
      // No receipt yet: either still in the mempool, or unknown to this RPC.
      status = 'pending';
    }

    // verifyTx never throws (RPC errors -> null), per @celo/attribution-tags.
    const { verifyTx } = await import('@celo/attribution-tags');
    const decoded = await verifyTx({
      client: this.wallet.publicClient as never,
      hash,
    }).catch(() => null);

    const entry = this.remitLog.find(hash);

    return {
      txHash: hash,
      status,
      explorerUrl: this.explorerUrl(hash),
      blockNumber,
      attributionCodes: decoded?.codes ?? null,
      remit: entry
        ? {
            amount: entry.amount,
            corridor: entry.corridor,
            rate: entry.rate,
            received: entry.received,
            timestamp: entry.timestamp,
          }
        : null,
    };
  }

  /** Sums the tokenOut Transfer events that landed on the recipient in this tx. */
  private deliveredAmount(
    logs: readonly unknown[],
    tokenOut: Address,
    recipient: Address,
  ): number | null {
    try {
      const events = parseEventLogs({
        abi: ERC20_ABI,
        eventName: 'Transfer',
        logs: logs as never,
      });
      const total = events
        .filter(
          (e) =>
            getAddress(e.address) === getAddress(tokenOut) &&
            getAddress(e.args.to) === getAddress(recipient),
        )
        .reduce((sum, e) => sum + e.args.value, 0n);
      return total > 0n ? Number(formatUnits(total, 18)) : null;
    } catch {
      return null; // never let log-decoding break a successful remittance
    }
  }

  private explorerUrl(txHash: string): string {
    return `${this.config.network.explorer}/tx/${txHash}`;
  }
}
