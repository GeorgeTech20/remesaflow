/**
 * F2 — Agent wallet.
 *
 * - viem publicClient (reads) + walletClient (signing) for the active network.
 * - Degraded mode: without AGENT_PRIVATE_KEY the read-only endpoints keep
 *   working; anything that needs a signature throws WalletNotConfiguredError.
 * - Gas is always paid in USDC via the fee-currency ADAPTER (CIP-64); the
 *   agent never needs CELO (ARQUITECTURA §3).
 * - EVERY outgoing tx must go through sendWithTag(), which appends the
 *   ERC-8021 attribution suffix (@celo/attribution-tags).
 *
 * NOTE: nothing in this module signs or sends anything at import time; the
 * demo/tests never broadcast transactions.
 */
import { toDataSuffix } from '@celo/attribution-tags';
import {
  concat,
  createPublicClient,
  createWalletClient,
  http,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { celo, celoSepolia } from 'viem/chains';
import type { Address, AppConfig } from './config.js';

export class WalletNotConfiguredError extends Error {
  constructor() {
    super('AGENT_PRIVATE_KEY is not set: agent wallet is in read-only (degraded) mode');
    this.name = 'WalletNotConfiguredError';
  }
}

export class MissingAttributionTagError extends Error {
  constructor() {
    super(
      'ATTRIBUTION_TAG is not set. On mainnet every outgoing tx MUST carry the ' +
        'ERC-8021 attribution suffix — refusing to send. Set ATTRIBUTION_TAG in .env.',
    );
    this.name = 'MissingAttributionTagError';
  }
}

/** Minimal outgoing-tx shape accepted by sendWithTag. */
export interface OutgoingTx {
  to: Address;
  data?: Hex;
  value?: bigint;
  gas?: bigint;
}

/**
 * The subset of viem's WalletClient that AgentWallet uses. Kept minimal so
 * unit tests can inject a mock and assert on the exact tx passed down,
 * without touching the network.
 */
export interface MinimalWalletClient {
  account: { address: Address };
  sendTransaction(args: Record<string, unknown>): Promise<Hex>;
}

export interface AgentWalletOverrides {
  publicClient?: PublicClient;
  walletClient?: MinimalWalletClient;
}

function viemChainFor(config: AppConfig) {
  return config.network.name === 'celo' ? celo : celoSepolia;
}

export class AgentWallet {
  readonly publicClient: PublicClient;
  private readonly walletClient: MinimalWalletClient | null;

  constructor(
    private readonly config: AppConfig,
    overrides: AgentWalletOverrides = {},
  ) {
    const chain = viemChainFor(config);

    this.publicClient =
      overrides.publicClient ??
      (createPublicClient({
        chain,
        transport: http(config.network.rpcUrl),
      }) as PublicClient);

    if (overrides.walletClient) {
      this.walletClient = overrides.walletClient;
    } else if (config.agentPrivateKey) {
      const account = privateKeyToAccount(config.agentPrivateKey as Hex);
      this.walletClient = createWalletClient({
        account,
        chain,
        transport: http(config.network.rpcUrl),
      }) as unknown as MinimalWalletClient;
      console.log(`[wallet] agent wallet ready: ${account.address} (${config.network.name})`);
    } else {
      this.walletClient = null;
      console.warn(
        '[wallet] AGENT_PRIVATE_KEY not set -> DEGRADED MODE: on-chain reads work, ' +
          'signing/sending is disabled (x402 payTo unavailable).',
      );
    }
  }

  /** True when the wallet can sign (AGENT_PRIVATE_KEY was provided). */
  get canSign(): boolean {
    return this.walletClient !== null;
  }

  /** The x402 payTo address, or null in degraded mode. */
  getAgentAddress(): Address | null {
    return this.walletClient?.account.address ?? null;
  }

  /** Current block number (read-only; works in degraded mode). */
  async getBlockNumber(): Promise<bigint> {
    return this.publicClient.getBlockNumber();
  }

  /**
   * Sends an outgoing tx with the ERC-8021 attribution suffix appended to the
   * calldata and gas paid in USDC (fee-currency adapter).
   *
   * Tag policy (ARQUITECTURA §5):
   * - ATTRIBUTION_TAG set   -> append `toDataSuffix(tag)`.
   * - Missing on testnet    -> warn and send untagged.
   * - Missing on mainnet    -> throw MissingAttributionTagError (never send).
   */
  async sendWithTag(tx: OutgoingTx): Promise<Hex> {
    if (!this.walletClient) {
      throw new WalletNotConfiguredError();
    }

    const tag = this.config.attributionTag;
    let data: Hex | undefined = tx.data;
    if (tag) {
      const suffix = toDataSuffix(tag);
      data = tx.data ? concat([tx.data, suffix]) : suffix;
    } else if (this.config.network.isTestnet) {
      console.warn(
        '[wallet] ATTRIBUTION_TAG not set: sending UNTAGGED tx (allowed on testnet only)',
      );
    } else {
      throw new MissingAttributionTagError();
    }

    return this.walletClient.sendTransaction({
      ...tx,
      ...(data !== undefined ? { data } : {}),
      // 6-decimal token => adapter address (never the token) as feeCurrency.
      feeCurrency: this.config.network.usdc.adapter,
    });
  }
}

export function createAgentWallet(
  config: AppConfig,
  overrides?: AgentWalletOverrides,
): AgentWallet {
  return new AgentWallet(config, overrides);
}
