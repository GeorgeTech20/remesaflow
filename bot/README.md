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
| `BOT_PRIVATE_KEY` | No (TODO) | Firmará pagos x402 cuando el backend devuelva 402 en prod. |

```bash
cd bot
npm install
npm run dev    # tsx watch
npm run build  # tsc -> dist/
npm start      # node dist/bot.js
```

## Comandos del bot

- `/start` — explica el producto + botones de corredores frecuentes
- `/cotizar <monto> <moneda>` — ej. `/cotizar 50 KES`; sin args entra en flujo guiado con botones
- `/pares` — corredores disponibles (desde `/api/currencies`)

## Estructura

- `src/config.ts` — env (lee `../.env` de la raíz), fail-fast sin token
- `src/payment.ts` — `payAndFetch(url)`: hoy fetch directo; TODO(ARQUI) firmar x402 con `BOT_PRIVATE_KEY` al recibir 402
- `src/bot.ts` — comandos, callbacks, formato de cotización

Textos del bot en español. TODO(i18n): versión EN.
