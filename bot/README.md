# RemesaFlow — Telegram bot

Bot de Telegram que cotiza remesas USD → KES/PHP/BRL/COP/NGN con datos de Mento (Celo). Consume la API del backend; cada cotización cuesta $0.01 vía x402 (en dev el backend la sirve gratis con `X402_ENABLED=false`).

## Stack

Node 20+, TypeScript, [grammY](https://grammy.dev). Long polling (v1, sin webhook).

## Setup

Las variables viven en el `.env` de la **raíz del monorepo** (ver `.env.example`):

| Variable | Requerida | Descripción |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Sí | Token de @BotFather. Sin él, el bot sale con error claro. |
| `API_BASE_URL` | No | Backend RemesaFlow. Default `http://localhost:3000`. |
| `LANDING_URL` | No | Link en las cotizaciones. Default `https://remesaflow.example`. |
| `BOT_PRIVATE_KEY` | No* | Key (0x…) de la wallet que firma pagos x402. Sin ella el bot degrada a fetch directo (solo sirve contra backend con `X402_ENABLED=false`). **Nunca commitear.** |
| `NETWORK` | No | `celo-sepolia` (default) o `celo`. Define en qué red firma pagos el bot. |
| `BOT_MAX_PAYMENT_BASE_UNITS` | No | Tope de seguridad por pago, en unidades base del asset (USDC = 6 decimales). Default `100000` = $0.10; una cotización cuesta `10000` = $0.01. |

```bash
cd bot
npm install
npm run dev    # tsx watch
npm run build  # tsc -> dist/
npm start      # node dist/bot.js
npm test       # tests unitarios de payment.ts (sin red, key efímera)
```

## Wallet del bot (x402)

El bot paga cada cotización firmando una autorización **EIP-3009** de USDC
(`transferWithAuthorization`, x402 v2 scheme `exact`). La firma es local (viem);
quien mueve los fondos on-chain es el facilitador vía el backend, así que la
wallet del bot **no necesita CELO para gas** — solo saldo USDC.

Cómo fondearla (Celo Sepolia, testnet):

1. Generar una wallet nueva (ej. `cast wallet new`) y poner la key en `BOT_PRIVATE_KEY` del `.env` raíz.
2. Pedir CELO de testnet en https://faucet.celo.org (sirve para swaps).
3. Conseguir USDC de testnet: swap en https://app.mento.org o faucet de Circle (https://faucet.circle.com, seleccionar Celo Sepolia si está disponible).
4. Verificar saldo: USDC Sepolia es `0x01C5C0122039549AD1493B8220cABEdD739BC44E` (verificado on-chain; la dirección que listan los skills oficiales está mal).

En mainnet (`NETWORK=celo`): transferir USDC real (`0xcebA9300f2b948710d2653dD7B07f33A8B32118C`) a la dirección del bot. Con $1 alcanzan 100 cotizaciones.

Al arrancar, el bot loguea la dirección de la wallet y la red, o un warning claro si corre en modo degradado.

## Comandos del bot

- `/start` — explica el producto + botones de corredores frecuentes
- `/cotizar <monto> <moneda>` — ej. `/cotizar 50 KES`; sin args entra en flujo guiado con botones
- `/pares` — corredores disponibles (desde `/api/currencies`)

## Estructura

- `src/config.ts` — env (lee `../.env` de la raíz), fail-fast sin token
- `src/payment.ts` — `payAndFetch(url)`: cliente x402 v2 real (`@x402/fetch` + `@x402/evm` + viem). 402 → firma EIP-3009 → retry con `PAYMENT-SIGNATURE`. Sin `BOT_PRIVATE_KEY` degrada a fetch directo.
- `src/payment.test.ts` — tests unitarios (fetch mockeado, key efímera, sin red)
- `src/bot.ts` — comandos, callbacks, formato de cotización

Textos del bot en español. TODO(i18n): versión EN.
