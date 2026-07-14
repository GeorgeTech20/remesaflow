/**
 * F11 — ERC-8004 agent registration CLI.
 *
 *   npm run register:8004                # DRY-RUN (default): reads + plan, signs NOTHING
 *   npm run register:8004 -- --execute   # sends the real register() tx (needs funded key)
 *
 * - Network from NETWORK env (celo-sepolia default), addresses from config.ts
 *   (ARQUITECTURA §4.1 / official 8004 skill).
 * - Reuses AgentWallet: the tx goes through sendWithTag(), so the ERC-8021
 *   attribution suffix is appended and gas is paid in USDC (adapter).
 * - Without AGENT_PRIVATE_KEY it still runs: read-only dry-run with a
 *   placeholder sender and a clear message.
 * - register(agentURI) mints an ERC-721; agentId comes from the Transfer log
 *   (the 4-topic one) in the receipt (ARQUITECTURA §4.3).
 */
import { encodeFunctionData, formatUnits, type Hex } from 'viem';
import { identityRegistryAbi, registeredEvent } from '../src/abis/identity-registry.js';
import { loadConfig, type Address } from '../src/config.js';
import { createAgentWallet } from '../src/wallet.js';

/** Non-zero placeholder so gas estimation (an ERC-721 mint) can simulate. */
const PLACEHOLDER_SENDER: Address = '0x000000000000000000000000000000000000dEaD';

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');
  const config = loadConfig();
  const wallet = createAgentWallet(config);
  const registry = config.network.erc8004.identityRegistry;
  const registrationUrl = config.agentRegistrationUrl;
  const agentAddress = wallet.getAgentAddress();

  console.log('=== ERC-8004 agent registration (F11) ===');
  console.log(`mode:              ${execute ? 'EXECUTE (will send a real tx)' : 'DRY-RUN (nothing is signed or sent)'}`);
  console.log(`network:           ${config.network.name} (chainId ${config.network.chainId})`);
  console.log(`rpc:               ${config.network.rpcUrl}`);
  console.log(`identity registry: ${registry}`);
  console.log(`registration URL:  ${registrationUrl}`);
  if (agentAddress) {
    console.log(`agent wallet:      ${agentAddress}`);
  } else {
    console.log(`agent wallet:      ${PLACEHOLDER_SENDER} (PLACEHOLDER)`);
    console.log(
      '                   AGENT_PRIVATE_KEY is not set -> read-only dry-run only.\n' +
        '                   Set it in the repo-root .env to plan/execute with the real wallet.',
    );
  }
  console.log('');

  // ---- Step 1: already registered? (free on-chain reads) -------------------
  if (agentAddress) {
    let balance: bigint | null = null;
    try {
      balance = await wallet.publicClient.readContract({
        address: registry,
        abi: identityRegistryAbi,
        functionName: 'balanceOf',
        args: [agentAddress],
      });
    } catch (err) {
      console.warn(`[check] balanceOf failed (RPC problem?): ${(err as Error).message}`);
      console.warn('[check] Could not verify prior registration; continuing with the plan.');
    }

    if (balance !== null && balance > 0n) {
      console.log(`[check] ALREADY REGISTERED: wallet holds ${balance} identity NFT(s).`);
      try {
        const logs = await wallet.publicClient.getLogs({
          address: registry,
          event: registeredEvent,
          args: { owner: agentAddress },
          fromBlock: 'earliest',
        });
        for (const log of logs) {
          const agentId = log.args.agentId;
          if (agentId === undefined) continue;
          const uri = await wallet.publicClient.readContract({
            address: registry,
            abi: identityRegistryAbi,
            functionName: 'tokenURI',
            args: [agentId],
          });
          console.log(`[check] agentId ${agentId} -> tokenURI ${uri}`);
          console.log(`[check] explorer: ${config.network.explorer}/address/${registry}`);
        }
      } catch {
        console.log(
          '[check] Could not recover agentId via logs (RPC range limits); ' +
            `look up the Registered event at ${config.network.explorer}/address/${registry}`,
        );
      }
      console.log('[check] Nothing to do.');
      return;
    }
    if (balance === 0n) console.log('[check] Not registered yet.');
  } else {
    console.log('[check] No agent key -> skipping the "already registered" lookup.');
  }
  console.log('');

  // ---- Step 2: plan the register(agentURI) tx ------------------------------
  const data: Hex = encodeFunctionData({
    abi: identityRegistryAbi,
    functionName: 'register',
    args: [registrationUrl],
  });

  console.log('[plan] tx that will be sent (via sendWithTag):');
  console.log(`[plan]   to:       ${registry}`);
  console.log(`[plan]   from:     ${agentAddress ?? `${PLACEHOLDER_SENDER} (placeholder)`}`);
  console.log(`[plan]   calldata: ${data}`);
  if (config.attributionTag) {
    console.log(`[plan]   + ERC-8021 attribution suffix for tag "${config.attributionTag}" (appended by sendWithTag)`);
  } else {
    console.log(
      `[plan]   ATTRIBUTION_TAG not set: ${config.network.isTestnet ? 'tx would go out UNTAGGED (testnet only)' : 'sendWithTag will REFUSE to send on mainnet'}`,
    );
  }
  console.log(`[plan]   feeCurrency: ${config.network.usdc.adapter} (USDC adapter — gas paid in USDC)`);

  let gas: bigint | null = null;
  try {
    gas = await wallet.publicClient.estimateGas({
      account: agentAddress ?? PLACEHOLDER_SENDER,
      to: registry,
      data,
    });
    console.log(`[plan]   estimated gas: ${gas}`);
  } catch (err) {
    console.log(`[plan]   estimated gas: n/a (${(err as Error).message.split('\n')[0]})`);
  }
  if (gas !== null) {
    try {
      // Gas price denominated in the fee currency via the adapter (18 decimals).
      const gasPrice = BigInt(
        await wallet.publicClient.request({
          // Celo-specific overload: eth_gasPrice(feeCurrency) — ARQUITECTURA §3.
          method: 'eth_gasPrice' as never,
          params: [config.network.usdc.adapter] as never,
        }),
      );
      console.log(`[plan]   estimated cost: ~${formatUnits(gas * gasPrice, 18)} USDC (gas x adapter gasPrice)`);
    } catch (err) {
      console.log(`[plan]   estimated cost: n/a — adapter gasPrice failed (${(err as Error).message.split('\n')[0]})`);
    }
  }
  console.log('');

  if (!execute) {
    console.log('[dry-run] No transaction was signed or sent.');
    console.log('[dry-run] After funding the agent wallet (see ACCION_HUMANA_REQUERIDA.md), run:');
    console.log('[dry-run]   cd backend && npm run register:8004 -- --execute');
    return;
  }

  // ---- Execute (only with --execute) ----------------------------------------
  if (!wallet.canSign) {
    console.error('[execute] Cannot execute: AGENT_PRIVATE_KEY is not set.');
    process.exitCode = 1;
    return;
  }
  console.log('[execute] Sending register() tx...');
  const hash = await wallet.sendWithTag({ to: registry, data });
  console.log(`[execute] tx sent: ${config.network.explorer}/tx/${hash}`);

  const receipt = await wallet.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    console.error('[execute] Transaction REVERTED. Check funding (USDC for gas) and try again.');
    process.exitCode = 1;
    return;
  }
  // agentId = tokenId of the ERC-721 mint: the 4-topic Transfer log.
  const transferLog = receipt.logs.find(
    (log) => log.address.toLowerCase() === registry.toLowerCase() && log.topics.length === 4,
  );
  const agentId = transferLog?.topics[3] ? BigInt(transferLog.topics[3]) : null;

  console.log('[execute] REGISTERED.');
  console.log(`[execute]   agentId:  ${agentId ?? 'not found in logs — check the explorer'}`);
  console.log(`[execute]   tx:       ${config.network.explorer}/tx/${hash}`);
  console.log(`[execute]   registry: ${config.network.explorer}/address/${registry}`);
  console.log('[execute] NEXT: paste the tx link into growth/tweet.md (the tweet must include the ERC-8004 link).');
}

main().catch((err) => {
  console.error(`[fatal] ${(err as Error).message}`);
  process.exitCode = 1;
});
