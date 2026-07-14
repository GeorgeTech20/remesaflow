# RemesaFlow Backend

Quote API for Celo remittances (Hono + TypeScript, no database). Quotes come
from the **Mento protocol on-chain** (or a mock engine for offline dev), the
paid endpoint is gated by **x402 v2**, and the agent wallet pays gas in USDC.

## Run

```bash
npm install
npm run dev        # tsx watch, http://localhost:3000
```

Env vars are read from the **repo-root** `.env` (see `../.env.example`).
Defaults: `NETWORK=celo-sepolia`, `PORT=3000`, `X402_ENABLED=false`,
`QUOTE_ENGINE=auto`.

## Networks

Testnet is **Celo Sepolia** (chainId `11142220`, RPC
`https://forno.celo-sepolia.celo-testnet.org`) — **Alfajores is deprecated**.
Mainnet is `celo` (chainId `42220`). All contract addresses live in
`src/config.ts` and come from `../ARQUITECTURA.md`. `RPC_URL` overrides the
default Forno endpoint (rate-limited; Ankr/dRPC work as fallbacks).

## Quote engine selection (`QUOTE_ENGINE`)

| Value | Behavior |
|-------|----------|
| `mock` | Always the mock engine (offline-safe, July-2026 approx rates). |
| `mento` | Real Mento engine; if RPC/discovery fails it logs an error and falls back to mock so the server stays up. |
| `auto` (default) | Probes the RPC (`eth_chainId`, 3s timeout). Reachable + correct chain → `mento`; otherwise → `mock`. |

At boot the Mento engine discovers routes on-chain for USD → KES/PHP/COP/NGN/BRL,
preferring `USDC -> <token>m` and falling back to `USDm -> <token>m`
(USDC ≈ USDm ≈ $1). Only pairs with a live, tradable route are exposed by
`/api/currencies` and `/api/quote`.

**Assumption:** 1 regional Mento stablecoin (KESm, PHPm, ...) = 1 unit of the
local fiat currency; rates are quoted against USD.

## x402 (paid quotes)

- `X402_ENABLED=false` (default): passthrough for dev.
- `X402_ENABLED=true`: real x402 **v2** flow via `@x402/hono@2.18.0` against
  the Celo facilitator `https://api.x402.celo.org`. Price **$0.01 USDC**
  (`amount: "10000"`, 6 decimals), scheme `exact`, `payTo` = agent wallet
  (`AGENT_PRIVATE_KEY` is therefore required when enabled).
- v2 headers: the 402 carries `PAYMENT-REQUIRED` (base64), the client retries
  with `PAYMENT-SIGNATURE`, the paid 200 carries `PAYMENT-RESPONSE`.
  (`X-PAYMENT` is v1; the server still accepts it as a fallback.)
- `X402_FACILITATOR_API_KEY` unlocks `POST /settle`. **Without it the server
  runs in degraded verify-only mode**: payments are verified but not settled
  on-chain (the response still goes out; the query is logged with
  `txHash: null`). On settle success the facilitator's tx hash is logged to
  `logs/queries.jsonl`.
- The Celo facilitator only announces **mainnet** (`eip155:42220`). On Celo
  Sepolia verify/settle are expected to be rejected — keep `X402_ENABLED=false`
  in dev, enable on mainnet for the demo.

## Agent wallet

`src/wallet.ts`. Without `AGENT_PRIVATE_KEY` the server boots in **degraded
mode**: on-chain reads work, signing (and x402) is disabled. Every outgoing tx
goes through `sendWithTag()`, which appends the ERC-8021 attribution suffix
(`ATTRIBUTION_TAG`) and pays gas with the **USDC fee-currency adapter**
(CIP-64) — the agent never needs CELO. Missing tag: testnet sends untagged
with a warning; **mainnet refuses to send**.

## Endpoints

| Route | Paid | Description |
|-------|------|-------------|
| `GET /api/currencies` | no | Corridors with a live route (subset of KES, PHP, BRL, COP, NGN) |
| `GET /api/quote?amount=50&to=KES` | x402 | Quote with WU/Wise comparison (+ a `quoteId` for `/api/remit`) |
| **`POST /api/remit`** | **x402** | **F-EXEC: executes a real remittance. See below.** |
| `GET /api/remit/:txHash` | no | On-chain status of a remittance + its decoded ERC-8021 tag |
| `GET /api/health` | no | Status + network + engine mode + block number |
| `GET /api/stats` | no | Quote/remit counters + the active remit guardrails |
| `GET /agent-registration.json` | no | ERC-8004 registration file (also at `/.well-known/agent.json`) |

## F-EXEC — executing real remittances (`POST /api/remit`)

The agent stops *quoting* and starts *paying*. Same $0.01 x402 fee as a quote —
the revenue is the fee, **not** a spread: the remitted value reaches the
recipient in full.

```bash
curl -X POST http://localhost:3000/api/remit \
  -H 'content-type: application/json' \
  -d '{"amount":10,"to":"KES","recipient":"0xabc...","quoteId":"<from /api/quote>"}'
```

```jsonc
// 200
{ "txHash": "0x…", "explorerUrl": "https://…/tx/0x…", "sent": 10,
  "received": 1278.67, "rate": 127.867, "recipient": "0xabc…",
  "currency": "KES", "status": "success", "approvalTxHash": null,
  "minReceived": 1265.88 }
```

Flow: validate → **re-quote on-chain** (fresh rate, not the cached one) →
slippage check → swap USDC → regional Mento stablecoin → **delivered straight to
the recipient**.

### Transaction design — one value tx per remittance

A remittance is **at most two txs, and exactly one carries the USD**:

| tx | What | Value moved |
|----|------|-------------|
| A (only when the allowance is short) | ERC-20 `approve` USDC → Mento Router | **$0** |
| B (always) | Mento Router `swapExactTokensForTokens(..., recipient)` | **the full amount** |

The Mento SDK takes `recipient` separately from `owner`, so tx B does the swap
**and** the delivery: the USDC leaves the agent wallet and the KESm/PHPm/… lands
on the beneficiary inside a **single transaction**.

Why it matters:

- **Atomicity.** Splitting it (swap, then a separate transfer to the recipient)
  leaves a window where the swap landed but the delivery failed — funds stranded
  in the agent wallet, manual recovery needed. One tx: the recipient gets the
  money, or nothing happened.
- **Auditability.** One hash per remittance is what `/api/remit` hands back to
  the caller, and what the recipient can check on the explorer.
- **One remittance = one user request = one tx.** Remittances are never batched
  and there are no loops, crons or timers in the execution path: the agent moves
  money only when a human asked it to.

Every tx — including the $0 approval — goes out through `sendWithTag()`
(ERC-8021 attribution + gas in USDC). **On mainnet without `ATTRIBUTION_TAG`,
the wallet refuses to send.**

### Guardrails (this moves real money — all non-negotiable)

| Guardrail | Env | Default | Breach |
|-----------|-----|---------|--------|
| **Kill switch** — the endpoint is dead unless explicitly enabled | `REMIT_ENABLED` | **`false`** | `503` |
| Max per remittance | `REMIT_MAX_USD` | `25` | `400` |
| Cumulative daily cap (UTC), **survives restart** | `REMIT_DAILY_CAP_USD` | `100` | `429` |
| Max adverse rate move vs the quote | `REMIT_MAX_SLIPPAGE_PCT` | `1` | `409` (aborts **before** executing, returns the new rate) |
| Recipient must be a valid EVM address, not `address(0)`, **not the agent itself** (self-dealing / wash trading) | — | — | `400` |
| Agent must hold the funds (balance checked pre-flight) | — | — | `503` |
| Corridor must have a live on-chain route | — | — | `400` |

Plus:
- The slippage tolerance is also enforced **on-chain** as the swap's
  `amountOutMin` floor — if the pool moves mid-flight, the tx reverts rather
  than shortchanging the recipient.
- The daily cap is **reserved atomically** before broadcasting, so two
  concurrent requests can never both slip under it. A reverted swap releases the
  reservation (no value moved → no budget consumed).
- `REMIT_ENABLED=true` alone is not enough: execution also needs the **Mento
  engine** (a reachable RPC with tradable routes) and a **signing wallet**. Any
  of those missing → `503` with the reason, never a silent no-op.

### Audit log

Every executed remittance is appended to `logs/remits.jsonl`: timestamp, USD
amount, corridor, **hashed** recipient (the plaintext address is already public
in the tx itself), txHash, approval txHash, rate, delivered amount, the
attribution tag used, network and status. The daily-cap counter is rebuilt from
this file at boot, so **restarting the server cannot reset the spending limit**.

### Dry run (proves the path without sending anything)

```bash
npx tsx scripts/remit-dryrun.ts --amount 5 --to KES --recipient 0x…
```

Read-only against the live network: discovers routes, re-quotes, reads the
balance, builds the real calldata — then prints the exact txs it *would*
broadcast and stops. The wallet client it uses **throws on `sendTransaction`**,
so the dry run cannot broadcast by construction, not by promise.

## ERC-8004 (agent identity)

The agent registers itself in the on-chain **Identity Registry** (an ERC-721
mint; addresses per network in `src/config.ts`, minimal ABI in
`src/abis/identity-registry.ts`). The token URI points at the registration
file this backend serves for free at `GET /agent-registration.json`
(name, description, x402 capability + corridors, agent wallet address —
placeholder zero-address until `AGENT_PRIVATE_KEY` is set). Override the URI
with `AGENT_REGISTRATION_URL`; it defaults to
`<API_BASE_URL>/agent-registration.json`.

```bash
npm run register:8004                # dry-run: checks registration, prints the tx plan. Signs NOTHING.
npm run register:8004 -- --execute   # sends the real register() tx (funded AGENT_PRIVATE_KEY required)
```

The dry-run works without a key (read-only, placeholder sender). The real tx
goes through `sendWithTag()` (ERC-8021 attribution + gas in USDC) and prints
the explorer link + `agentId` (from the mint's Transfer log) — that link goes
in the hackathon tweet.

## Build / test / Docker

```bash
npm run build      # tsc -> dist/
npm start          # node dist/index.js
npm test           # vitest run (offline-safe: no network, no keys, no txs)
npm run remit:dryrun -- --amount 5 --to KES   # F-EXEC dry run (sends NOTHING)
RUN_ONCHAIN_TESTS=1 npm test   # + live read-only Mento discovery/quote/remit-plan
docker build -t remesaflow-backend .
docker run -p 3000:3000 -e NETWORK=celo-sepolia remesaflow-backend
```

The on-chain tests are **read-only**: they plan a remittance against the live
network and assert the tx shape, but the wallet client they use throws on
`sendTransaction`. No test can broadcast.

## Notes

- Rates cached 60s per pair (both engines), behind the `QuoteEngine` interface.
  `POST /api/remit` ignores that cache and **always re-quotes on-chain** before
  moving funds.
- Paid queries are logged to `logs/queries.jsonl` (IPs stored as sha256 12-char
  hash; `txHash` filled in from the x402 settle receipt). Executed remittances
  go to `logs/remits.jsonl` instead (see F-EXEC above).
- Rate limit: 50 req/min per IP, in-memory.
- **The only path that signs and broadcasts is `POST /api/remit`** (F-EXEC), and
  only with `REMIT_ENABLED=true` + a funded wallet. Quotes, routes and status
  reads are strictly read-only. Nothing in the backend moves funds on a timer:
  a transaction only ever exists because a user asked for one.
