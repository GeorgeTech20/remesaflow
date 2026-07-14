# DEPLOY — RemesaFlow

## Backend (Railway o Render)

**Railway** (preferido): crear proyecto → "Deploy from GitHub repo" → root directory `backend/` (detecta el Dockerfile solo). Variables: copiar de `.env.example`; secrets (`AGENT_PRIVATE_KEY`, `DEMO_PRIVATE_KEY`, `ATTRIBUTION_TAG`, `X402_FACILITATOR_API_KEY`, `TELEGRAM_BOT_TOKEN` si el bot corre junto) van en el dashboard, nunca en git. Exponer puerto `3000`.

**Render**: `render.yaml` en la raíz es un blueprint listo — "New → Blueprint" apuntando al repo. Secrets se piden en el dashboard (marcados `sync: false`).

Producción típica:
```
NETWORK=celo            # mainnet
QUOTE_ENGINE=mento
X402_ENABLED=true       # requiere AGENT_PRIVATE_KEY
DEMO_MODE=true          # requiere DEMO_PRIVATE_KEY fondeada
CORS_ORIGIN=https://<dominio-landing>
```

## Bot (mismo host que el backend o servicio aparte)

Servicio worker con root `bot/` (`npm run build && npm start`). Necesita `TELEGRAM_BOT_TOKEN`, `BOT_PRIVATE_KEY`, `API_BASE_URL` apuntando al backend público.

## Frontend (Vercel)

`frontend/vercel.json` ya configura framework/build/SPA. Importar repo en Vercel con root directory `frontend/`. Variable: `VITE_API_BASE_URL=https://<backend-público>`. La landing degrada a modo demo (mocks) si la API no responde — nunca se ve rota.

## Checklist post-deploy

1. `GET /api/health` → `{"status":"ok","network":...,"mode":"mento"}`
2. `GET /api/currencies` → 5 corredores
3. `GET /api/quote?...` sin pago → 402 con header `PAYMENT-REQUIRED` (si `X402_ENABLED=true`)
4. Landing carga y el botón demo devuelve cotización con badge de pago
5. `GET /agent-registration.json` → datos del agente con la wallet real
6. Bot responde `/start` y `/cotizar 50 KES`
