/**
 * F-EXEC DRY RUN — prints the EXACT transactions a remittance would broadcast,
 * and broadcasts NOTHING.
 *
 *   npx tsx scripts/remit-dryrun.ts [--amount 5] [--to KES] [--recipient 0x...]
 *
 * Read-only: it hits the RPC for route discovery, a fresh Mento quote, the
 * agent's balance and the Router allowance — then STOPS before signing. The
 * wallet client it hands the service physically cannot send: sendTransaction
 * throws. That is the safety property this script is built around, not a
 * promise in a comment.
 *
 * Use it to prove the execution path on Celo Sepolia without funds or keys.
 */
import { formatUnits } from 'viem';
import { loadConfig } from '../src/config.js';
import { MentoQuoteEngine } from '../src/quote-mento.js';
import { JsonlRemitLog } from '../src/remit-log.js';
import { type MentoSwapLike, RemitError, RemitService } from '../src/remit.js';
import { AgentWallet, type MinimalWalletClient } from '../src/wallet.js';
import type { Address } from '../src/config.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}

const amount = Number(arg('amount', '5'));
const to = arg('to', 'KES').toUpperCase();
const recipient = arg('recipient', '0x000000000000000000000000000000000000dEaD') as Address;

/** A wallet client that REFUSES to send. The dry run cannot broadcast, by construction. */
const NO_SEND: MinimalWalletClient = {
  // Address only matters for balance/allowance reads. Override with DRYRUN_AGENT.
  account: {
    address: (process.env.DRYRUN_AGENT ??
      '0x0000000000000000000000000000000000000001') as Address,
  },
  sendTransaction: async () => {
    throw new Error('DRY RUN: sendTransaction is disabled. Nothing may be broadcast.');
  },
};

const line = (n = 78) => console.log('-'.repeat(n));

async function main(): Promise<void> {
  const base = loadConfig();
  // Force the guardrail ON in memory only: we want to exercise the full plan()
  // path. Nothing can be sent regardless (see NO_SEND above), and the real
  // REMIT_ENABLED in .env is untouched.
  const config = { ...base, remit: { ...base.remit, enabled: true } };

  console.log('\n=== RemesaFlow F-EXEC — DRY RUN (no transaction will be sent) ===\n');
  console.log(`network        : ${config.network.name} (chainId ${config.network.chainId})`);
  console.log(`rpc            : ${config.network.rpcUrl}`);
  console.log(`attribution tag: ${config.attributionTag ?? 'NOT SET'}`);
  console.log(
    `guardrails     : REMIT_ENABLED=${base.remit.enabled} (forced true for this dry run), ` +
      `max=$${config.remit.maxUsd}/remit, dailyCap=$${config.remit.dailyCapUsd}, ` +
      `maxSlippage=${config.remit.maxSlippagePct}%`,
  );
  console.log(`request        : ${amount} USD -> ${to}, recipient ${recipient}\n`);

  if (!config.attributionTag && !config.network.isTestnet) {
    console.error('MAINNET + no ATTRIBUTION_TAG: sendWithTag() would refuse to send. Aborting.');
    process.exit(1);
  }

  line();
  console.log('1. Discovering Mento routes on-chain...');
  const engine = await MentoQuoteEngine.create(config);
  console.log(`   corridors with a real route: ${engine.supportedCurrencies().join(', ')}`);

  const wallet = new AgentWallet(config, { walletClient: NO_SEND });
  const agent = wallet.getAgentAddress();
  console.log(`   agent (read-only, cannot sign): ${agent}`);

  const service = new RemitService({
    config,
    wallet,
    mento: engine.client as unknown as MentoSwapLike,
    pairs: engine.pairs,
    // A throwaway ledger: the dry run must never touch the real audit log.
    remitLog: new JsonlRemitLog(config.remit.dailyCapUsd, '/dev/null'),
  });

  line();
  console.log('2. Planning (validations + fresh on-chain re-quote + tx build)...\n');

  let plan;
  try {
    // skipBalanceCheck: the dry-run wallet is unfunded on purpose; we still
    // want to see the tx it WOULD build. execute() never skips this check.
    plan = await service.plan({ amount, to, recipient }, { skipBalanceCheck: true });
  } catch (err) {
    if (err instanceof RemitError) {
      console.error(`   BLOCKED by guardrail [${err.code}] (HTTP ${err.status}):`);
      console.error(`   ${err.message}`);
      console.error('\n   Nothing was sent. That is the guardrail working.\n');
      process.exit(0);
    }
    throw err;
  }

  console.log(`   corridor        : ${plan.corridor} (via ${plan.stablecoin})`);
  console.log(`   fresh rate      : 1 USD = ${plan.rate.toFixed(4)} ${plan.fiat}`);
  console.log(
    `   amount in       : ${formatUnits(plan.amountIn, 6)} ${plan.tokenInSymbol} ` +
      `(${plan.amountIn} base units)`,
  );
  console.log(`   expected out    : ${plan.expectedReceived.toFixed(2)} ${plan.stablecoin}`);
  console.log(
    `   min out (floor) : ${plan.minReceived.toFixed(2)} ${plan.stablecoin} ` +
      `(${plan.slippagePct}% slippage — the swap REVERTS below this)`,
  );
  console.log(
    `   agent balance   : ${plan.agentBalance} ${plan.tokenInSymbol} ` +
      `-> ${plan.fundedEnough ? 'sufficient' : 'INSUFFICIENT (execute() would 503 here)'}`,
  );

  line();
  console.log('3. Transactions that WOULD be broadcast:\n');

  let n = 0;
  if (plan.approvalTx) {
    n += 1;
    console.log(`   tx ${n} — ERC-20 approve  [carries $0 of value]`);
    console.log(`        to    : ${plan.approvalTx.to}  (${plan.tokenInSymbol} token)`);
    console.log(`        data  : ${plan.approvalTx.data.slice(0, 42)}... (+ ERC-8021 tag suffix)`);
    console.log('        why   : the Mento Router allowance does not cover amountIn yet.\n');
  } else {
    console.log('   (no approval tx needed: the Router allowance already covers amountIn)\n');
  }

  n += 1;
  console.log(`   tx ${n} — Mento swap  <<< THIS TX CARRIES THE FULL ${amount} USD >>>`);
  console.log(`        to    : ${plan.valueTx.to}  (Mento Router)`);
  console.log(`        data  : ${plan.valueTx.data.slice(0, 42)}... (+ ERC-8021 tag suffix)`);
  console.log(`        bytes : ${(plan.valueTx.data.length - 2) / 2} calldata bytes`);
  console.log(`        effect: ${amount} ${plan.tokenInSymbol} leaves ${agent}`);
  console.log(
    `                ${plan.expectedReceived.toFixed(2)} ${plan.stablecoin} is delivered ` +
      `to ${plan.recipient}`,
  );
  console.log('                ...both inside this ONE transaction.\n');

  line();
  console.log('4. Leaderboard accounting (research/01-celobuilders-tracks.md):\n');
  console.log(
    `   Track 1 counts max(amount_usd) over the legs where transfer.from = tx sender.\n` +
      `   In tx ${n} that leg is the ${plan.tokenInSymbol} leaving the agent => $${amount} scored,\n` +
      `   once, in a single tx. Not batched (batching would score max(), not sum).`,
  );
  console.log(
    `   Track 2 counts the x402 settlement for this request separately (by wallet).\n`,
  );

  line();
  console.log(`TAG    : ${plan.attributionTag ?? 'none (testnet only)'} — appended by sendWithTag()`);
  console.log('RESULT : DRY RUN COMPLETE. 0 transactions sent. 0 funds moved.\n');
}

main().catch((err) => {
  console.error('\nDry run failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
