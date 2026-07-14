# RemesaFlow — frontend

Landing page for RemesaFlow (Celo Agentic Payments hackathon). React 18 + Vite + TypeScript + Tailwind CSS, single page, no component libraries.

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # output in dist/
```

## Config

- `VITE_API_BASE_URL` — backend base URL (default `http://localhost:3000`). See `.env.example`.
- If the API is unreachable, the page falls back to embedded mock data and shows a "demo mode" banner. The landing never looks broken.

## x402 payment flow (F8) — decision: B (server-paid demo)

The "Quote for $0.01" button uses `POST /api/demo/quote` (backend, behind
`DEMO_MODE=true`): the server pays its OWN x402-protected `GET /api/quote`
with `DEMO_PRIVATE_KEY`, so every demo quote is a real x402 payment
(402 → EIP-3009 signature → `PAYMENT-SIGNATURE` → facilitator verify/settle)
without asking the visitor for a wallet. Limit: 5 quotes per IP per 24h.

Widget states: quoting → paying $0.01 USDC → result with a "Paid via x402"
badge, remaining demo queries, and an explorer link when the settlement
returned a `txHash` (celoscan / blockscout picked from the backend network).
Fallbacks: demo route disabled → plain `GET /api/quote`; API down → embedded
mocks. Demo limit reached → friendly ES/EN error.

**Option A considered (embedded browser wallet, viem + `@x402/fetch`
client-side) and rejected**: a minified browser probe of
`@x402/fetch` + `@x402/evm` + `viem/accounts` measured **362 kB minified /
~108 kB gzip** extra (vs 52 kB gzip for the whole current bundle — a 3x
jump), and the UX requires visitors to generate and fund a wallet with
testnet USDC (faucet + Mento swap) while the Celo facilitator does not even
settle on Celo Sepolia. B gives judges real settlements with zero friction.
A can still be added later as a "pay with my wallet" tab.

## OG image note

`index.html` references `/og.png` (1200x630). The design source is `public/og.svg` — export it to PNG before shipping:

```bash
npx sharp-cli -i public/og.svg -o public/og.png   # or any SVG→PNG tool
```

Until then `/og.png` is a placeholder path (social cards will show no image, nothing else breaks).
