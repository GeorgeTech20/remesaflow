/**
 * Engine selection tests (QUOTE_ENGINE=mock|mento|auto) — no network.
 */
import { describe, expect, it, vi } from 'vitest';
import { type AppConfig, loadConfig } from '../src/config.js';
import { createQuoteEngine, resolveEngineChoice } from '../src/engine.js';
import { MockQuoteEngine, type QuoteEngine } from '../src/quote.js';

function config(quoteEngine: AppConfig['quoteEngine']): AppConfig {
  return { ...loadConfig({}), quoteEngine };
}

const fakeMentoEngine: QuoteEngine = {
  getQuote: async () => {
    throw new Error('not used');
  },
  supportedCurrencies: () => ['KES'],
};

describe('resolveEngineChoice', () => {
  it('honors explicit choices and auto-detects from RPC reachability', () => {
    expect(resolveEngineChoice('mock', true)).toBe('mock');
    expect(resolveEngineChoice('mock', false)).toBe('mock');
    expect(resolveEngineChoice('mento', false)).toBe('mento');
    expect(resolveEngineChoice('auto', true)).toBe('mento');
    expect(resolveEngineChoice('auto', false)).toBe('mock');
  });
});

describe('createQuoteEngine', () => {
  it('QUOTE_ENGINE=mock never probes and returns the mock engine', async () => {
    const probe = vi.fn(async () => true);
    const createMento = vi.fn(async () => fakeMentoEngine);
    const { engine, mode } = await createQuoteEngine(config('mock'), { probe, createMento });

    expect(mode).toBe('mock');
    expect(engine).toBeInstanceOf(MockQuoteEngine);
    expect(probe).not.toHaveBeenCalled();
    expect(createMento).not.toHaveBeenCalled();
  });

  it('QUOTE_ENGINE=auto with unreachable RPC falls back to mock', async () => {
    const probe = vi.fn(async () => false);
    const createMento = vi.fn(async () => fakeMentoEngine);
    const { mode } = await createQuoteEngine(config('auto'), { probe, createMento });

    expect(mode).toBe('mock');
    expect(probe).toHaveBeenCalledTimes(1);
    expect(createMento).not.toHaveBeenCalled();
  });

  it('QUOTE_ENGINE=auto with reachable RPC selects mento', async () => {
    const probe = vi.fn(async () => true);
    const createMento = vi.fn(async () => fakeMentoEngine);
    const { engine, mode } = await createQuoteEngine(config('auto'), { probe, createMento });

    expect(mode).toBe('mento');
    expect(engine).toBe(fakeMentoEngine);
  });

  it('QUOTE_ENGINE=mento falls back to mock (loud error) if init fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const createMento = vi.fn(async () => {
        throw new Error('rpc down');
      });
      const { engine, mode } = await createQuoteEngine(config('mento'), { createMento });

      expect(mode).toBe('mock');
      expect(engine).toBeInstanceOf(MockQuoteEngine);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('falling back to mock'));
    } finally {
      error.mockRestore();
    }
  });
});
