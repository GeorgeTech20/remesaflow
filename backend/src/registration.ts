/**
 * F11 — ERC-8004 registration file.
 *
 * Builds the agent metadata JSON (skill 8004 format, ARQUITECTURA §4.2) that
 * the Identity Registry's tokenURI points at. Served for free by the backend
 * at GET /agent-registration.json (and /.well-known/agent.json for A2A
 * discovery). No secrets: only the PUBLIC agent address ever appears here.
 */
import type { Address, AppConfig } from './config.js';

/** Shown while AGENT_PRIVATE_KEY is not configured (degraded mode). */
export const PLACEHOLDER_AGENT_ADDRESS: Address =
  '0x0000000000000000000000000000000000000000';

export interface AgentRegistration {
  type: 'Agent';
  name: string;
  description: string;
  endpoints: Array<
    | { type: 'api' | 'a2a'; url: string }
    | { type: 'wallet'; address: Address; chainId: number }
  >;
  capabilities: Array<{
    name: string;
    protocol: string;
    endpoint: string;
    price: string;
    corridors: string[];
  }>;
  supportedTrust: string[];
}

/**
 * @param corridors ISO codes of the destination currencies the live quote
 *   engine actually supports (e.g. ["KES", "PHP", ...]).
 */
export function buildAgentRegistration(
  config: AppConfig,
  agentAddress: Address | null,
  corridors: readonly string[],
): AgentRegistration {
  const base = config.apiBaseUrl;
  return {
    type: 'Agent',
    name: 'RemesaFlow',
    description:
      'Remittance agent on Celo: sells USD remittance quotes over x402 ' +
      '($0.01 USDC per quote) with delivery priced in local Mento stablecoins ' +
      '(Kenya, Philippines, Colombia, Nigeria, Brazil).',
    endpoints: [
      { type: 'api', url: `${base}/api/quote` },
      { type: 'a2a', url: `${base}/.well-known/agent.json` },
      {
        type: 'wallet',
        address: agentAddress ?? PLACEHOLDER_AGENT_ADDRESS,
        chainId: config.network.chainId,
      },
    ],
    capabilities: [
      {
        name: 'remittance-quote',
        protocol: 'x402',
        endpoint: '/api/quote',
        price: '0.01 USDC',
        corridors: corridors.map((code) => `USD-${code}`),
      },
    ],
    supportedTrust: ['reputation'],
  };
}
