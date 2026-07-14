# RemesaFlow 🟡

**An AI agent that answers one question the world asks 200 billion dollars' worth of times a year: "How much actually arrives if I send $X home?"**

Built for the **Celo Agentic Payments & DeFAI Hackathon** — Tracks 1 (Attribution), 2 (x402 Payments), 3 (Askbots), 4 (Aigora feedback).

[Live demo](<LANDING_URL>) · [Telegram bot](<BOT_LINK>) · [Agent registered on ERC-8004](<ERC8004_LINK>)

---

## The problem

Sending money across borders is still absurdly expensive:

- The global average cost of sending $200 is **6.36%** of the amount sent (World Bank, *Remittance Prices Worldwide*, Issue 54, Q3 2025 — [remittanceprices.worldbank.org](https://remittanceprices.worldbank.org/), [full report PDF](https://remittanceprices.worldbank.org/sites/default/files/2026-04/RPW_main_report_and_annex_Q325.pdf)).
- Banks average **14.99%**; even digital-only services average **4.59%** (same report).
- The UN SDG target is 3% by 2030. We are nowhere near it.

Worse: pricing is opaque. Fees, FX spreads, and receive-side charges are scattered across fine print. Most senders never know what the recipient actually gets until it lands.

## What RemesaFlow does

RemesaFlow is a **quote agent**. You ask:

> "How much arrives if I send $200 to Kenya?"

It answers with:

1. **A real on-chain rate** from [Mento](https://www.mento.org/), Celo's stablecoin AMM (USD → cKES, PUSO, cREAL, cCOP, cNGN).
2. **A side-by-side comparison** against Western Union (~6%) and Wise (~1.5%) baselines — see [Fee baselines](#fee-baselines--sources) below for how those numbers are sourced.
3. **Your savings**, in dollars, per transfer.

Each query costs **$0.01 USD in stablecoin**, paid machine-to-machine over **[x402](https://docs.celo.org/build-on-celo/build-with-ai/x402)** (HTTP 402 micropayments). No signup, no API key, no credit card — any human or agent with a Celo wallet can pay per call.

**v1 corridors:** USD → 🇰🇪 KES · 🇵🇭 PHP · 🇧🇷 BRL · 🇨🇴 COP · 🇳🇬 NGN

### Hackathon integrations

| Track | What we do |
|---|---|
| 1 — Attribution | Every transaction the agent sends carries the attribution tag (ERC-8021 suffix): `<ATTRIBUTION_TAG>` |
| 2 — x402 | The quote API is gated by an x402 middleware; $0.01 per query in stablecoin on Celo |
| 3 — Askbots | RemesaFlow registers as a judge/feedback agent — see [`growth/askbots-plan.md`](growth/askbots-plan.md) |
| 4 — Aigora | Technical feedback from building against the platform — see [`growth/aigora-feedback.md`](growth/aigora-feedback.md) |
| Identity | Agent registered in the ERC-8004 Identity Registry → [<ERC8004_LINK>](<ERC8004_LINK>) |

## Demo

![RemesaFlow demo](docs/demo.gif)

*(demo GIF placeholder — recorded per `growth/DEMO_SCRIPT.md`)*

## Architecture

```
                 ┌────────────────────────────────────────────────┐
                 │                    CELO L2                     │
                 │                                                │
                 │  Mento AMM          ERC-8004         x402      │
                 │  (USD→cKES,         Identity         payment   │
                 │   PUSO, cREAL,      Registry         settle    │
                 │   cCOP, cNGN)          ▲               ▲       │
                 └──────▲─────────────────┼───────────────┼───────┘
                        │ on-chain rate   │ registered    │ $0.01/query
                        │ (viem)          │ agent         │ (+ ERC-8021 tag
                        │                 │               │  on agent txs)
                 ┌──────┴─────────────────┴───────────────┴───────┐
                 │            BACKEND — Hono + viem               │
                 │                                                │
                 │  x402 middleware ─► quote engine ─► JSON quote │
                 │  (402 until paid)   (Mento rate,               │
                 │                      WU/Wise compare)          │
                 └──────▲──────────────────────────────▲──────────┘
                        │ GET /api/quote               │
             ┌──────────┴──────────┐        ┌──────────┴──────────┐
             │  LANDING            │        │  TELEGRAM BOT       │
             │  React + Vite       │        │  grammY             │
             │  (demo: server pays │        │  (bot wallet pays)  │
             │   x402 for you)     │        │                     │
             └──────────▲──────────┘        └──────────▲──────────┘
                        │                              │
                     humans                    humans & agents
```

## Run it locally

Requirements: Node.js ≥ 20, npm.

```bash
git clone <REPO_URL> remesaflow
cd remesaflow
cp .env.example .env        # fill in your keys (see below)

# each package installs and runs independently
cd backend  && npm install && npm run dev    # API on :3000
cd frontend && npm install && npm run dev    # landing (Vite)
cd bot      && npm install && npm run dev    # Telegram bot
```

`.env` variables (see `.env.example`):

| Var | What |
|---|---|
| `NETWORK` | `celo-sepolia` (testnet, default) or `celo` (mainnet) — Alfajores is deprecated |
| `AGENT_PRIVATE_KEY` | Agent server wallet — never commit |
| `BOT_PRIVATE_KEY` | Telegram bot wallet (separate from agent) |
| `ATTRIBUTION_TAG` | Hackathon attribution tag from celobuilders.xyz |
| `TELEGRAM_BOT_TOKEN` | From @BotFather |
| `API_BASE_URL` | Public backend URL (default `http://localhost:3000`) |

## Public API — pay-per-quote over x402

Anyone (human or agent) can consume the API. The flow is standard x402:

**1. Ask without paying → HTTP 402 with payment requirements**

```bash
curl -i "https://<API_HOST>/api/quote?amount=200&to=KES"
# HTTP/1.1 402 Payment Required
# PAYMENT-REQUIRED: <base64 payment requirements — x402 v2>
#   (decoded: scheme "exact", network eip155:42220, $0.01 USDC, payTo <PAYTO_ADDRESS>)
```

**2. Sign the payment (EIP-3009), retry with the signature header → quote**

The `@x402/fetch` client does this automatically ([bot/src/payment.ts](bot/src/payment.ts) is a working example):

```bash
curl "https://<API_HOST>/api/quote?amount=200&to=KES" \
  -H "PAYMENT-SIGNATURE: <base64-signed-payment-payload>"
# {
#   "send": 200,
#   "currency": "KES",
#   "receives": 25742.12,
#   "rate": 128.71,
#   "celoFee": 0.02,
#   "wuWouldCharge": 12.00,
#   "wiseWouldCharge": 3.00,
#   "savings": 11.98,
#   "timestamp": "2026-07-13T18:00:00.000Z"
# }
```

Other endpoints:

```bash
curl "https://<API_HOST>/api/currencies"   # free — list of supported corridors
```

Payment settlement address: `<PAYTO_ADDRESS>` · every agent transaction is tagged with `<ATTRIBUTION_TAG>` (ERC-8021).

## Fee baselines & sources

Zero smoke — here is where every comparison number comes from:

| Number | Status | Source |
|---|---|---|
| **6.36%** global average cost (sending $200) | Measured | [World Bank Remittance Prices Worldwide, Issue 54, Q3 2025](https://remittanceprices.worldbank.org/sites/default/files/2026-04/RPW_main_report_and_annex_Q325.pdf) |
| **14.99%** bank average, **4.59%** digital average | Measured | Same World Bank report |
| **Western Union ~6%** | **Estimate** — WU pricing varies by corridor, payout method, and promo. We use ~6% as a proxy consistent with the World Bank global MTO average. Per-corridor prices: [RPW corridor comparison tool](https://remittanceprices.worldbank.org/) | World Bank RPW |
| **Wise ~1.5%** | **Conservative estimate.** Wise self-reports a 0.53% *global average* fee ([Wise fee review, Dec 2025](https://wise.com/us/blog/december-fee-review-2025); [pricing](https://wise.com/us/pricing/)) — but USD→KES/NGN/COP exotic corridors typically price above the average once fixed fees are included on a $200 transfer. We use ~1.5% to avoid overstating our advantage. |
| **$0.02** on-chain fee shown in quotes | Estimate (v1) | Flat mock; real Celo gas + Mento spread is computed on-chain in the live version |

If a number in our UI is an estimate, it is labeled as one.

## Project layout

```
backend/    Hono + viem — quote engine, x402 middleware, anti-sybil rate limit
frontend/   React + Vite + Tailwind — landing with live quote + 402 pay flow
bot/        grammY — Telegram bot, pays x402 with its own wallet
growth/     hackathon submission materials
```

---

## 🇪🇸 Resumen en español

**RemesaFlow** es un agente que cotiza remesas: preguntás *"¿cuánto llega si mando $200 a Colombia?"* y responde con la tasa real on-chain de **Mento** (el AMM de stablecoins de Celo), comparada contra Western Union (~6%) y Wise (~1.5%). Cada consulta cuesta **$0.01 USD en stablecoin**, cobrado por **x402** (micropagos HTTP 402) — sin registro, sin tarjeta: cualquier persona o agente con wallet en Celo paga por llamada.

- **Corredores v1:** USD → Kenia (KES), Filipinas (PHP), Brasil (BRL), Colombia (COP), Nigeria (NGN).
- **Por qué importa:** enviar $200 cuesta en promedio **6.36%** a nivel global ([Banco Mundial, Remittance Prices Worldwide Q3 2025](https://remittanceprices.worldbank.org/)). La meta ODS es 3% para 2030.
- **Cómo correrlo:** `git clone` → `cp .env.example .env` → `npm install && npm run dev` en `backend/`, `frontend/` y `bot/`.
- **Hackathon:** agente registrado en ERC-8004 (<ERC8004_LINK>), toda transacción lleva attribution tag ERC-8021, API pagable por x402, participación en Askbots y feedback a Aigora.

---

*Built on [Celo](https://celo.org) · Rates by [Mento](https://www.mento.org/) · Payments by [x402](https://docs.celo.org/build-on-celo/build-with-ai/x402)*
