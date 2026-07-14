/**
 * Quote engine selection.
 *
 * Rule (documented per task):
 * - QUOTE_ENGINE=mock  -> always the mock engine.
 * - QUOTE_ENGINE=mento -> try the Mento engine; if the RPC is unreachable or
 *   discovery finds no tradable pair, log a loud error and fall back to mock
 *   (the server must stay up for the demo).
 * - QUOTE_ENGINE=auto (default / unset) -> probe the RPC (eth_chainId with a
 *   3s timeout). Reachable + right chain -> mento; otherwise -> mock.
 */
import { createPublicClient, http } from 'viem';
import type { AppConfig } from './config.js';
import { MentoQuoteEngine } from './quote-mento.js';
import { MockQuoteEngine, type QuoteEngine } from './quote.js';

export type EngineMode = 'mock' | 'mento';

/** Pure resolution of the requested engine vs RPC reachability (testable). */
export function resolveEngineChoice(
  requested: AppConfig['quoteEngine'],
  rpcReachable: boolean,
): EngineMode {
  if (requested === 'mock') return 'mock';
  if (requested === 'mento') return 'mento';
  return rpcReachable ? 'mento' : 'mock';
}

/** True when the RPC answers eth_chainId with the expected chain id. */
export async function probeRpc(
  rpcUrl: string,
  expectedChainId: number,
  timeoutMs = 3_000,
): Promise<boolean> {
  try {
    const client = createPublicClient({
      transport: http(rpcUrl, { timeout: timeoutMs, retryCount: 0 }),
    });
    const chainId = await client.getChainId();
    if (chainId !== expectedChainId) {
      console.warn(`[engine] RPC ${rpcUrl} answered chainId=${chainId}, expected ${expectedChainId}`);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export interface EngineDeps {
  probe?: (rpcUrl: string, expectedChainId: number) => Promise<boolean>;
  createMento?: (config: AppConfig) => Promise<QuoteEngine>;
}

export interface SelectedEngine {
  engine: QuoteEngine;
  mode: EngineMode;
}

export async function createQuoteEngine(
  config: AppConfig,
  deps: EngineDeps = {},
): Promise<SelectedEngine> {
  const probe = deps.probe ?? probeRpc;
  const createMento = deps.createMento ?? ((cfg: AppConfig) => MentoQuoteEngine.create(cfg));

  let choice: EngineMode;
  if (config.quoteEngine === 'auto') {
    const reachable = await probe(config.network.rpcUrl, config.network.chainId);
    choice = resolveEngineChoice('auto', reachable);
    if (!reachable) {
      console.warn(`[engine] RPC ${config.network.rpcUrl} unreachable -> using mock engine`);
    }
  } else {
    choice = resolveEngineChoice(config.quoteEngine, true);
  }

  if (choice === 'mento') {
    try {
      const engine = await createMento(config);
      console.log(`[engine] quote engine: mento (${config.network.name})`);
      return { engine, mode: 'mento' };
    } catch (err) {
      console.error(
        `[engine] Mento engine init FAILED, falling back to mock: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  console.log('[engine] quote engine: mock');
  return { engine: new MockQuoteEngine(), mode: 'mock' };
}
