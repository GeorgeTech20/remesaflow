/**
 * Environment + network configuration.
 *
 * Reads the repo-root .env (shared by backend/bot/frontend) via dotenv,
 * then validates everything at boot. No secrets live in this file.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// backend/src (dev) or backend/dist (build) -> two levels up = repo root.
loadDotenv({ path: path.resolve(HERE, '../../.env') });

export type Address = `0x${string}`;

export type NetworkName = 'alfajores' | 'celo';

export interface ContractAddresses {
  /** Mento broker contract. TODO(ARQUI): fill real address per network. */
  mentoBroker: Address | null;
  /** Stablecoin token addresses keyed by symbol. TODO(ARQUI): fill real addresses. */
  stablecoins: Record<string, Address | null>;
}

export interface NetworkProfile {
  name: NetworkName;
  rpcUrl: string;
  chainId: number;
  contracts: ContractAddresses;
}

// NOTE(ARQUI): stablecoin symbol set to be confirmed (PUSO vs cPHP, etc.).
const EMPTY_STABLECOINS: Record<string, Address | null> = {
  cKES: null,
  PUSO: null,
  cREAL: null,
  cCOP: null,
  cNGN: null,
};

export const NETWORKS: Record<NetworkName, NetworkProfile> = {
  alfajores: {
    name: 'alfajores',
    rpcUrl: 'https://alfajores-forno.celo-testnet.org',
    chainId: 44787,
    contracts: {
      mentoBroker: null, // TODO(ARQUI)
      stablecoins: { ...EMPTY_STABLECOINS },
    },
  },
  celo: {
    name: 'celo',
    rpcUrl: 'https://forno.celo.org',
    chainId: 42220,
    contracts: {
      mentoBroker: null, // TODO(ARQUI)
      stablecoins: { ...EMPTY_STABLECOINS },
    },
  },
};

export interface AppConfig {
  network: NetworkProfile;
  port: number;
  x402Enabled: boolean;
  /** Optional in mock mode. Never log or serialize this. */
  agentPrivateKey: string | undefined;
  /** Hackathon attribution tag (celobuilders.xyz). */
  attributionTag: string | undefined;
  corsOrigin: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function isNetworkName(value: string): value is NetworkName {
  return value === 'alfajores' || value === 'celo';
}

/**
 * Builds and validates the app config from an env map (process.env by default).
 * Throws ConfigError on invalid values so the server fails fast at boot.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const networkRaw = env.NETWORK ?? 'alfajores';
  if (!isNetworkName(networkRaw)) {
    throw new ConfigError(
      `Invalid NETWORK "${networkRaw}". Expected one of: ${Object.keys(NETWORKS).join(', ')}`,
    );
  }

  const portRaw = env.PORT ?? '3000';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`Invalid PORT "${portRaw}". Expected an integer between 1 and 65535.`);
  }

  const x402Raw = env.X402_ENABLED ?? 'false';
  if (x402Raw !== 'true' && x402Raw !== 'false') {
    throw new ConfigError(`Invalid X402_ENABLED "${x402Raw}". Expected "true" or "false".`);
  }

  return {
    network: NETWORKS[networkRaw],
    port,
    x402Enabled: x402Raw === 'true',
    agentPrivateKey: env.AGENT_PRIVATE_KEY || undefined,
    attributionTag: env.ATTRIBUTION_TAG || undefined,
    corsOrigin: env.CORS_ORIGIN || '*',
  };
}
