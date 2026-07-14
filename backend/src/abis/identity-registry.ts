/**
 * ERC-8004 Identity Registry — MINIMAL ABI (only what RemesaFlow uses).
 *
 * Source: ~/.claude/skills/8004/references/identity-registry-abi.json
 * (official celo-org skill). Full ABI lives there; keep this file to the
 * functions/events the register script actually calls.
 *
 * NOTE: `balanceOf` is NOT in the skill's reference ABI but the registry is a
 * standard ERC-721 (register() mints an NFT — ARQUITECTURA §4.3), so
 * balanceOf(owner) is guaranteed by the standard. We use it as the cheap
 * "is this wallet already registered?" check.
 */
/** Registered(uint256 indexed agentId, string agentURI, address indexed owner) */
export const registeredEvent = {
  anonymous: false,
  inputs: [
    { indexed: true, internalType: 'uint256', name: 'agentId', type: 'uint256' },
    { indexed: false, internalType: 'string', name: 'agentURI', type: 'string' },
    { indexed: true, internalType: 'address', name: 'owner', type: 'address' },
  ],
  name: 'Registered',
  type: 'event',
} as const;

export const identityRegistryAbi = [
  {
    inputs: [{ internalType: 'string', name: 'agentURI', type: 'string' }],
    name: 'register',
    outputs: [{ internalType: 'uint256', name: 'agentId', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'owner', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'tokenId', type: 'uint256' }],
    name: 'tokenURI',
    outputs: [{ internalType: 'string', name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
  registeredEvent,
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'address', name: 'from', type: 'address' },
      { indexed: true, internalType: 'address', name: 'to', type: 'address' },
      { indexed: true, internalType: 'uint256', name: 'tokenId', type: 'uint256' },
    ],
    name: 'Transfer',
    type: 'event',
  },
] as const;
