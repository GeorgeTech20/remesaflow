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
| `GET /api/quote?amount=50&to=KES` | x402 | Quote with WU/Wise comparison |
| `GET /api/health` | no | Status + network + engine mode + block number |
| `GET /api/stats` | no | In-memory quote counter |

## Build / test / Docker

```bash
npm run build      # tsc -> dist/
npm start          # node dist/index.js
npm test           # vitest run (offline-safe)
RUN_ONCHAIN_TESTS=1 npm test   # + live read-only Mento discovery/quote
docker build -t remesaflow-backend .
docker run -p 3000:3000 -e NETWORK=celo-sepolia remesaflow-backend
```

## Notes

- Rates cached 60s per pair (both engines), behind the `QuoteEngine` interface.
- Paid queries are logged to `logs/queries.jsonl` (IPs stored as sha256 12-char
  hash; `txHash` filled in from the x402 settle receipt).
- Rate limit: 50 req/min per IP, in-memory.
- The backend never signs or broadcasts transactions on its own; Mento is used
  read-only (quotes/routes).
