/**
 * Environment + network configuration.
 *
 * Reads the repo-root .env (shared by backend/bot/frontend) via dotenv,
 * then validates everything at boot. No secrets live in this file.
 *
 * All addresses come from ARQUITECTURA.md (source of truth, verified against
 * @mento-protocol/mento-sdk@3.2.8 constants and the celo-org skills).
 * Testnet is Celo Sepolia (11142220) — Alfajores is deprecated.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// backend/src (dev) or backend/dist (build) -> two levels up = repo root.
loadDotenv({ path: path.resolve(HERE, '../../.env') });

export type Address = `0x${string}`;

export type NetworkName = 'celo-sepolia' | 'celo';

/** Quote engine selection (see engine.ts for the resolution rule). */
export type QuoteEngineChoice = 'mock' | 'mento' | 'auto';

export interface UsdcInfo {
  /** ERC-20 token address (6 decimals). */
  token: Address;
  /**
   * Fee-currency ADAPTER address. Rule of gold (ARQUITECTURA §3): 6-decimal
   * tokens use the adapter address in `feeCurrency`; 18-decimal tokens use
   * the token address directly.
   */
  adapter: Address;
  decimals: 6;
}

export interface X402NetworkInfo {
  facilitatorUrl: string;
  /** CAIP-2 network id, e.g. eip155:42220. */
  network: `eip155:${number}`;
}

/** ERC-8004 registries (ARQUITECTURA §4.1, from the official celo-org skill). */
export interface Erc8004Info {
  identityRegistry: Address;
  reputationRegistry: Address;
}

export interface NetworkProfile {
  name: NetworkName;
  isTestnet: boolean;
  rpcUrl: string;
  chainId: number;
  explorer: string;
  usdc: UsdcInfo;
  /** Mento Broker (debug/reads only; app code goes through the SDK). */
  mentoBroker: Address;
  /** Mento stablecoins (all 18 decimals), keyed by current `m`-suffix symbol. */
  stablecoins: Record<string, Address>;
  x402: X402NetworkInfo;
  erc8004: Erc8004Info;
}

// The Celo facilitator only announces mainnet (eip155:42220). We still carry
// the URL for testnet so verify-only experiments are possible; settle on
// testnet is expected to be rejected (ARQUITECTURA §1.2 / R3).
const X402_FACILITATOR_URL = 'https://api.x402.celo.org';

export const NETWORKS: Record<NetworkName, NetworkProfile> = {
  'celo-sepolia': {
    name: 'celo-sepolia',
    isTestnet: true,
    rpcUrl: 'https://forno.celo-sepolia.celo-testnet.org',
    chainId: 11142220,
    explorer: 'https://celo-sepolia.blockscout.com',
    usdc: {
      // VERIFIED ON-CHAIN 2026-07-14 (F11): the addresses the skills listed for
      // Sepolia (token 0x2F25deB3..., adapter 0x4822e58d...) are WRONG — the
      // token has no code on Sepolia and the adapter reverts with "Currency
      // not in the directory" (ARQUITECTURA R7/R8, now resolved). Real values
      // read from FeeCurrencyDirectory 0x9212Fb72...611BF: the adapter below
      // is listed, and its adaptedToken() -> this token (symbol USDC, 6 dec).
      token: '0x01C5C0122039549AD1493B8220cABEdD739BC44E',
      adapter: '0xbf1441Ea57f43f35f713431001f35742c88071c7',
      decimals: 6,
    },
    mentoBroker: '0xB9Ae2065142EB79b6c5EB1E8778F883fad6B07Ba',
    stablecoins: {
      USDm: '0xdE9e4C3ce781b4bA68120d6261cbad65ce0aB00b',
      KESm: '0xC7e4635651E3e3Af82b61d3E23c159438daE3BbF',
      PHPm: '0x0352976d940a2C3FBa0C3623198947Ee1d17869E',
      COPm: '0x5F8d55c3627d2dc0a2B4afa798f877242F382F67',
      NGNm: '0x3d5ae86F34E2a82771496D140daFAEf3789dF888',
      BRLm: '0x2294298942fdc79417DE9E0D740A4957E0e7783a',
    },
    x402: { facilitatorUrl: X402_FACILITATOR_URL, network: 'eip155:11142220' },
    erc8004: {
      identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
      reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
    },
  },
  celo: {
    name: 'celo',
    isTestnet: false,
    rpcUrl: 'https://forno.celo.org',
    chainId: 42220,
    explorer: 'https://celoscan.io',
    usdc: {
      token: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
      adapter: '0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B',
      decimals: 6,
    },
    mentoBroker: '0x777A8255cA72412f0d706dc03C9D1987306B4CaD',
    stablecoins: {
      USDm: '0x765de816845861e75a25fca122bb6898b8b1282a',
      KESm: '0x456a3D042C0DbD3db53D5489e98dFb038553B0d0',
      PHPm: '0x105d4A9306D2E55a71d2Eb95B81553AE1dC20d7B',
      COPm: '0x8a567e2ae79ca692bd748ab832081c45de4041ea',
      NGNm: '0xE2702Bd97ee33c88c8f6f92DA3B733608aa76F71',
      BRLm: '0xe8537a3d056da446677b9e9d6c5db704eaab4787',
    },
    x402: { facilitatorUrl: X402_FACILITATOR_URL, network: 'eip155:42220' },
    erc8004: {
      identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
      reputationRegistry: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
    },
  },
};

export interface AppConfig {
  network: NetworkProfile;
  port: number;
  x402Enabled: boolean;
  /** Optional in mock mode. Never log or serialize this. */
  agentPrivateKey: string | undefined;
  /** Hackathon attribution tag (ERC-8021 code, e.g. "remesaflow"). */
  attributionTag: string | undefined;
  /** API key for POST /settle on api.x402.celo.org. Missing => verify-only. */
  x402FacilitatorApiKey: string | undefined;
  /** DEMO_MODE=true exposes POST /api/demo/quote (F8, judge-friendly flow). */
  demoMode: boolean;
  /**
   * Wallet used by the demo route to pay our OWN x402 endpoint (distinct from
   * the agent wallet, which RECEIVES the payment). Never log or serialize.
   */
  demoPrivateKey: string | undefined;
  /** QUOTE_ENGINE env: mock | mento | auto (default auto). */
  quoteEngine: QuoteEngineChoice;
  corsOrigin: string;
  /** Public backend URL (API_BASE_URL env), no trailing slash. */
  apiBaseUrl: string;
  /**
   * Public URL of the ERC-8004 registration file. Defaults to
   * `<apiBaseUrl>/agent-registration.json` (served by this backend); override
   * with AGENT_REGISTRATION_URL (e.g. an ipfs:// URI).
   */
  agentRegistrationUrl: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function isNetworkName(value: string): value is NetworkName {
  return value === 'celo-sepolia' || value === 'celo';
}

function isQuoteEngineChoice(value: string): value is QuoteEngineChoice {
  return value === 'mock' || value === 'mento' || value === 'auto';
}

/**
 * Builds and validates the app config from an env map (process.env by default).
 * Throws ConfigError on invalid values so the server fails fast at boot.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const networkRaw = env.NETWORK ?? 'celo-sepolia';
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

  const demoRaw = env.DEMO_MODE ?? 'false';
  if (demoRaw !== 'true' && demoRaw !== 'false') {
    throw new ConfigError(`Invalid DEMO_MODE "${demoRaw}". Expected "true" or "false".`);
  }

  const quoteEngineRaw = env.QUOTE_ENGINE ?? 'auto';
  if (!isQuoteEngineChoice(quoteEngineRaw)) {
    throw new ConfigError(
      `Invalid QUOTE_ENGINE "${quoteEngineRaw}". Expected "mock", "mento" or "auto".`,
    );
  }

  const profile = NETWORKS[networkRaw];
  // Optional RPC override (Forno is rate-limited; see ARQUITECTURA §0 / R10).
  const network: NetworkProfile = env.RPC_URL ? { ...profile, rpcUrl: env.RPC_URL } : profile;

  const apiBaseUrl = (env.API_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, '');
  const agentRegistrationUrl =
    env.AGENT_REGISTRATION_URL || `${apiBaseUrl}/agent-registration.json`;

  return {
    network,
    port,
    x402Enabled: x402Raw === 'true',
    agentPrivateKey: env.AGENT_PRIVATE_KEY || undefined,
    attributionTag: env.ATTRIBUTION_TAG || undefined,
    x402FacilitatorApiKey: env.X402_FACILITATOR_API_KEY || undefined,
    demoMode: demoRaw === 'true',
    demoPrivateKey: env.DEMO_PRIVATE_KEY || undefined,
    quoteEngine: quoteEngineRaw,
    corsOrigin: env.CORS_ORIGIN || '*',
    apiBaseUrl,
    agentRegistrationUrl,
  };
}
