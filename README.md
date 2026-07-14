<div align="center">

# 🟡 RemesaFlow

### The remittance agent that answers *"how much actually arrives?"* — and then sends it.

**Real on-chain quotes from Mento · $0.01 per query over x402 · Executes the transfer itself**

Built for the [Celo Agentic Payments & DeFAI Hackathon](https://celo.org)

</div>

---

## The problem

Sending $200 home costs **$12.72 on average** — a 6.36% fee ([World Bank, Remittance Prices Worldwide, Q3 2025](https://remittanceprices.worldbank.org/)). For the corridors that matter most (US→Kenya, US→Philippines, US→Nigeria), the people paying that 6% are the ones who can least afford it.

The rails to fix it already exist on Celo. What's missing is something that **tells you the truth in five seconds and then acts on it**.

## What RemesaFlow does

Ask it in plain language — on a web page, or in Telegram:

> *"How much arrives if I send $200 to Kenya?"*

It queries **Mento** (Celo's stablecoin AMM) on-chain for the real rate, compares it against what Western Union and Wise would charge you, and charges **$0.01 in USDC via x402** for the answer.

Then, if you want, it **executes the remittance**: swaps USDC → KESm on Mento and delivers it to the recipient's address — in a single transaction, tagged on-chain.

**Corridors (v1):** 🇰🇪 KES · 🇵🇭 PHP · 🇧🇷 BRL · 🇨🇴 COP · 🇳🇬 NGN — every route verified on-chain at boot; no hardcoded pairs.

## Architecture

```
                    ┌────────────────────────────────────────────────┐
                    │  BACKEND (Hono + viem)                         │
                    │                                                │
   GET /api/quote ─►│  x402 middleware ──► Mento quote engine        │──► Mento (on-chain)
   ($0.01 USDC)     │  (402 until paid)    (real rate, WU/Wise diff) │    real rates
                    │                                                │
  POST /api/remit ─►│  guardrails ──► swap + deliver in ONE tx ──────│──► recipient wallet
   ($0.01 USDC)     │  (caps, slippage,    (sendWithTag: ERC-8021)   │    (tagged tx)
                    │   kill switch)                                 │
                    └──────▲──────────────────────────────▲──────────┘
                           │                              │
                ┌──────────┴──────────┐        ┌──────────┴──────────┐
                │  LANDING            │        │  TELEGRAM BOT       │
                │  React + Vite       │        │  grammY             │
                │  52 kB gzip, ES/EN  │        │  bot wallet pays    │
                └─────────────────────┘        └─────────────────────┘
```

**Every outgoing transaction goes through `sendWithTag()`** — no transaction leaves the agent wallet without its ERC-8021 attribution suffix. Gas is paid in USDC via `feeCurrency`; the agent never needs to hold CELO.

## Public API — pay-per-use over x402

Any human or agent can consume this API. Free endpoints need no payment:

```bash
curl https://<API_HOST>/api/currencies   # supported corridors
curl https://<API_HOST>/api/health       # status, network, block number
curl https://<API_HOST>/api/stats        # queries served, guardrail settings
```

The quote endpoint is paid. Standard x402 v2 flow:

```bash
# 1. Ask without paying → 402 with payment requirements
curl -i "https://<API_HOST>/api/quote?amount=200&to=KES"
# HTTP/1.1 402 Payment Required
# PAYMENT-REQUIRED: <base64 requirements — scheme "exact", $0.01 USDC, eip155:42220>

# 2. Sign (EIP-3009) and retry → the quote
curl "https://<API_HOST>/api/quote?amount=200&to=KES" \
  -H "PAYMENT-SIGNATURE: <base64 signed payload>"
```

```json
{
  "send": 200, "currency": "KES",
  "receives": 25742.12, "rate": 128.71,
  "celoFee": 0.02,
  "wuWouldCharge": 12.00, "wiseWouldCharge": 3.00,
  "savings": 11.98,
  "timestamp": "2026-07-14T12:00:00.000Z"
}
```

Clients don't hand-roll this — `@x402/fetch` does it in one wrapper. A working example lives in [bot/src/payment.ts](bot/src/payment.ts).

**Baselines:** Western Union ≈ 6% and Wise ≈ 1.5% are conservative estimates, not live scrapes. World Bank RPW puts the global average at 6.36%; Wise self-reports 0.53% average. We deliberately use a *pessimistic* number for ourselves.

## Executing a remittance

```bash
curl -X POST "https://<API_HOST>/api/remit" \
  -H "PAYMENT-SIGNATURE: <...>" \
  -d '{"amount": 20, "to": "KES", "recipient": "0x..."}'
```

The agent swaps USDC → KESm on Mento and delivers to `recipient` **inside a single transaction** — the Mento router takes the recipient separately from the owner, so the swap and the delivery are one atomic action.

### This moves real money, so every guardrail fails closed

| Guardrail | Default | Behaviour |
|---|---|---|
| `REMIT_ENABLED` | **false** | Endpoint answers `503` until explicitly enabled |
| `REMIT_MAX_USD` | 25 | Larger remittance → `400` |
| `REMIT_DAILY_CAP_USD` | 100 | Cap survives restarts (rebuilt from the log), reserved atomically before broadcast → `429` |
| `REMIT_MAX_SLIPPAGE_PCT` | 1 | Rate drifted → **aborts without sending**, returns `409` with the new rate |
| Recipient validation | — | Must be a valid EVM address, not `address(0)`, **not the agent itself** (self-dealing rejected) |
| Balance pre-flight | — | Insufficient funds → `503`, nothing broadcast |

**There are no loops, crons or timers anywhere in the execution path.** One remittance is one user request. The Telegram bot requires an explicit confirmation tap before anything moves.

## Honest disclosure: demo mode

The landing page has a **"try it free"** button so judges and visitors can see a real x402 settlement without funding a wallet first. Here's exactly what it does, because on-chain it deserves an explanation:

`POST /api/demo/quote` makes the **server pay its own x402 endpoint** using a separate demo wallet (`DEMO_PRIVATE_KEY` → agent wallet). It is rate-limited to **5 queries per IP per 24h**, and **one settlement always corresponds to one human click** — there is no automation behind it.

On-chain this looks like two of our own wallets transacting at a fixed amount, and we'd rather say so plainly than have someone find it. It exists to remove friction for first-time visitors, not to inflate a counter. It can be turned off entirely with `DEMO_MODE=false`, and the real signal we care about is **payments from external wallets** — the Telegram bot pays from its own separate wallet, and any third party can pay from theirs.

## Run it locally

Requires Node.js ≥ 20.

```bash
git clone <REPO_URL> remesaflow && cd remesaflow
cp .env.example .env          # fill in what you need (see below)

cd backend  && npm install && npm run dev   # API on :3000
cd frontend && npm install && npm run dev   # landing
cd bot      && npm install && npm run dev   # Telegram bot
```

Nothing is required to get a working quote — with no keys at all the backend runs a mock engine and the landing falls back to embedded data with a "demo mode" banner. It never renders broken.

| Variable | What it does |
|---|---|
| `NETWORK` | `celo-sepolia` (testnet, default) or `celo` (mainnet) |
| `QUOTE_ENGINE` | `mock` · `mento` · `auto` (default: probes the RPC, falls back to mock) |
| `AGENT_PRIVATE_KEY` | Agent wallet — receives x402 payments, sends remittances |
| `ATTRIBUTION_TAG` | ERC-8021 tag. **Required on mainnet** — the wallet refuses to send untagged |
| `X402_ENABLED` | Charge $0.01 for quotes (needs `AGENT_PRIVATE_KEY`) |
| `X402_FACILITATOR_API_KEY` | Enables `/settle`. Without it: verify-only |
| `REMIT_ENABLED` | Master switch for real remittance execution. **Off by default** |
| `TELEGRAM_BOT_TOKEN` | From @BotFather |

Full list in [.env.example](.env.example). **No secret is ever committed** — `.env` has been gitignored since the first commit.

## Engineering notes

Three things the official docs and skills got wrong, which we verified on-chain and fixed:

1. **Alfajores is deprecated.** Testnet is **Celo Sepolia** (chainId `11142220`).
2. **The Sepolia USDC addresses published in the skills don't exist.** The token has no code and the adapter reverts with *"Currency not in the directory"*. Real values read from the `FeeCurrencyDirectory`: token `0x01C5C012…`, adapter `0xbf1441Ea…`.
3. **x402 v2 uses `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` headers**, not v1's `X-PAYMENT`. Celo also runs a **separate facilitator per network** (`api.x402.sepolia.celo.org` for testnet).

Test coverage: **90 backend tests + 5 bot tests**, all green. On-chain integration tests are gated behind `RUN_ONCHAIN_TESTS=1` so CI stays green offline. Architecture decisions are documented in [ARQUITECTURA.md](ARQUITECTURA.md); the pre-flight audit is in [QA_REPORT.md](QA_REPORT.md).

## Links

| | |
|---|---|
| 🌐 Landing | `<LANDING_URL>` |
| 🤖 Telegram bot | `<BOT_LINK>` |
| 🪪 ERC-8004 agent | `<ERC8004_LINK>` |
| 💸 payTo wallet (x402) | `<PAYTO_ADDRESS>` |
| 🏷️ Attribution tag | `<ATTRIBUTION_TAG>` |

## Stack

Hono · viem · @mento-protocol/mento-sdk · @x402/hono + @x402/fetch · @celo/attribution-tags · React + Vite + Tailwind · grammY · TypeScript throughout

---

<div align="center">

**Built on Celo 🟡**

</div>
