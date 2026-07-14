/**
 * F2 unit tests — sendWithTag with a mocked walletClient (no network, no keys).
 */
import { toDataSuffix } from '@celo/attribution-tags';
import { describe, expect, it, vi } from 'vitest';
import { type AppConfig, loadConfig, NETWORKS } from '../src/config.js';
import {
  AgentWallet,
  MissingAttributionTagError,
  type MinimalWalletClient,
  WalletNotConfiguredError,
} from '../src/wallet.js';

const AGENT = '0x1111111111111111111111111111111111111111' as const;
const TO = '0x2222222222222222222222222222222222222222' as const;
const TAG = 'remesaflow';
const SUFFIX = toDataSuffix(TAG);

function mockWalletClient() {
  const sendTransaction = vi.fn(async () => '0xdeadbeef' as const);
  const client: MinimalWalletClient = { account: { address: AGENT }, sendTransaction };
  return { client, sendTransaction };
}

function cfg(overrides: Partial<AppConfig> = {}): AppConfig {
  return { ...loadConfig({}), ...overrides };
}

describe('AgentWallet.sendWithTag', () => {
  it('appends the ERC-8021 suffix to existing calldata and pays gas in USDC', async () => {
    const { client, sendTransaction } = mockWalletClient();
    const wallet = new AgentWallet(cfg({ attributionTag: TAG }), { walletClient: client });

    await wallet.sendWithTag({ to: TO, data: '0x1234' });

    expect(sendTransaction).toHaveBeenCalledTimes(1);
    const args = sendTransaction.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.data).toBe(`0x1234${SUFFIX.slice(2)}`);
    // 6-decimal USDC => fee currency is the ADAPTER address (Celo Sepolia).
    expect(args.feeCurrency).toBe(NETWORKS['celo-sepolia'].usdc.adapter);
    expect(args.to).toBe(TO);
  });

  it('uses the bare suffix as calldata when the tx has none', async () => {
    const { client, sendTransaction } = mockWalletClient();
    const wallet = new AgentWallet(cfg({ attributionTag: TAG }), { walletClient: client });

    await wallet.sendWithTag({ to: TO, value: 1n });

    const args = sendTransaction.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.data).toBe(SUFFIX);
  });

  it('warns and sends untagged on testnet when ATTRIBUTION_TAG is missing', async () => {
    const { client, sendTransaction } = mockWalletClient();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const wallet = new AgentWallet(cfg({ attributionTag: undefined }), { walletClient: client });
      await wallet.sendWithTag({ to: TO, data: '0x1234' });

      expect(sendTransaction).toHaveBeenCalledTimes(1);
      const args = sendTransaction.mock.calls[0]![0] as Record<string, unknown>;
      expect(args.data).toBe('0x1234'); // untagged
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('UNTAGGED'));
    } finally {
      warn.mockRestore();
    }
  });

  it('REJECTS on mainnet when ATTRIBUTION_TAG is missing', async () => {
    const { client, sendTransaction } = mockWalletClient();
    const mainnet = cfg({ network: NETWORKS.celo, attributionTag: undefined });
    const wallet = new AgentWallet(mainnet, { walletClient: client });

    await expect(wallet.sendWithTag({ to: TO, data: '0x1234' })).rejects.toBeInstanceOf(
      MissingAttributionTagError,
    );
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('degraded mode: no AGENT_PRIVATE_KEY -> reads ok, signing throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const wallet = new AgentWallet(cfg({ agentPrivateKey: undefined }));
      expect(wallet.canSign).toBe(false);
      expect(wallet.getAgentAddress()).toBeNull();
      await expect(wallet.sendWithTag({ to: TO })).rejects.toBeInstanceOf(
        WalletNotConfiguredError,
      );
    } finally {
      warn.mockRestore();
    }
  });
});
