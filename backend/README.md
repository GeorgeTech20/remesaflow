# RemesaFlow Backend

Mock quote API for Celo remittances (Hono + TypeScript, no database).

## Run

```bash
npm install
npm run dev        # tsx watch, http://localhost:3000
```

Env vars are read from the **repo-root** `.env` (see `../.env.example`).
Defaults: `NETWORK=alfajores`, `PORT=3000`, `X402_ENABLED=false`.

## Endpoints

| Route | Paid | Description |
|-------|------|-------------|
| `GET /api/currencies` | no | Supported corridors (KES, PHP, BRL, COP, NGN) |
| `GET /api/quote?amount=50&to=KES` | x402 | Quote with WU/Wise comparison |
| `GET /api/health` | no | Status + network |
| `GET /api/stats` | no | In-memory quote counter |

## Build / test

```bash
npm run build      # tsc -> dist/
npm start          # node dist/index.js
npm test           # vitest run
```

## Notes

- Quote rates are **mock** (July 2026 approx), cached 60s per pair, behind the
  `QuoteEngine` interface — swap in the real Mento engine without touching routes.
- `x402` middleware is a stub: passthrough when disabled, plain 402 when enabled.
  TODO(ARQUI): real facilitator + contract addresses in `src/config.ts`.
- Paid queries are logged to `logs/queries.jsonl` (IPs stored as sha256 12-char hash).
- Rate limit: 50 req/min per IP, in-memory.
