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

## OG image note

`index.html` references `/og.png` (1200x630). The design source is `public/og.svg` — export it to PNG before shipping:

```bash
npx sharp-cli -i public/og.svg -o public/og.png   # or any SVG→PNG tool
```

Until then `/og.png` is a placeholder path (social cards will show no image, nothing else breaks).
