# ARQUITECTURA — RemesaFlow (Celo Agentic Payments)

> Autor: ARQUI. Fuentes: skills oficiales celo-org (`~/.claude/skills/{x402,celo-stablecoins,8004,fee-abstraction,viem,celo-rpc}`), npm registry (verificado 2026-07-13), y sondeo en vivo de `https://api.x402.celo.org`.
> Todo el equipo trabaja contra este documento. Lo que diga **PENDIENTE VERIFICAR** no se hardcodea sin correr el comando indicado.

---

## 0. DECISIÓN CRÍTICA DE RED: Alfajores está MUERTO. La testnet es **Celo Sepolia**

Todos los skills oficiales y el tooling actual (viem, Mento SDK v3) usan **Celo Sepolia**, no Alfajores. El backlog de `PROGRESO.md` dice "Alfajores" — se corrige a Celo Sepolia.

| Red | Chain ID | RPC | Explorer |
|-----|----------|-----|----------|
| Celo Mainnet | `42220` | `https://forno.celo.org` | https://celoscan.io |
| **Celo Sepolia (testnet)** | `11142220` | `https://forno.celo-sepolia.celo-testnet.org` | https://celo-sepolia.blockscout.com / https://sepolia.celoscan.io |

- viem: `import { celo, celoSepolia } from "viem/chains"` (no existe soporte activo para alfajores en el flujo nuevo).
- Mento SDK v3 enum: `ChainId.CELO = 42220`, `ChainId.CELO_SEPOLIA = 11142220`. **No hay Alfajores en el enum** (verificado en `dist/core/constants/chainId.js` de `@mento-protocol/mento-sdk@3.2.8`).
- Faucet: https://faucet.celo.org → swap a stablecoins en https://app.mento.org

Forno es rate-limited/best-effort. Para la demo alcanza; si se satura: Ankr `https://rpc.ankr.com/celo`, dRPC `https://celo.drpc.org`, o Alchemy/Infura con key.

---

## 1. x402 — flujo de pago HTTP 402

### 1.1 Paquetes npm (DECISIÓN)

| Paquete | Versión | Rol |
|---------|---------|-----|
| `@x402/hono` | `2.18.0` (latest) | Middleware Hono (nuestro backend es Hono) |
| `@x402/core` | (peer, misma familia v2) | `HTTPFacilitatorClient`, `x402ResourceServer` |
| `@x402/evm` | (peer, misma familia v2) | `ExactEvmScheme` (server) y firma de pagos (client) |

- **`x402-hono` (sin scope) es v1 y está DEPRECADO** — su propio README dice "migrate to v2 (`@x402/hono`, `@x402/core`, `@x402/evm`)". NO usarlo.
- Alternativa completa si el flujo v2 manual falla: **thirdweb** (`npm install thirdweb`) con `settlePayment`/`facilitator` de `thirdweb/x402` — es la vía que documenta el skill oficial de Celo y soporta `celo` y `celoSepolia` de `thirdweb/chains`. Requiere `THIRDWEB_SECRET_KEY` + server wallet. La dejamos como **plan B** (y como plan A en testnet, ver 1.4).

### 1.2 Facilitador de Celo (VERIFICADO EN VIVO 2026-07-13)

Base URL: **`https://api.x402.celo.org`**

| Endpoint | Método | Estado verificado |
|----------|--------|-------------------|
| `/supported` | GET | Responde: `{"kinds":[{"x402Version":2,"scheme":"exact","network":"eip155:42220"},{"x402Version":1,"scheme":"exact","network":"celo"}],"signers":{"eip155:42220":["0x0d74D5Cefd2e7F24E623330ebE3d8D4cB45fFB48"]}}` |
| `/verify` | POST | Abierto (sin auth). Body: `{"paymentPayload": PaymentPayload, "paymentRequirements": PaymentRequirements}`. Con body vacío responde `{"isValid":false,"invalidReason":"unsupported_scheme",...}` |
| `/settle` | POST | **Requiere header `X-API-Key`** — con body vacío responde `{"error":"unauthorized","message":"Missing X-API-Key"}` |

Implicaciones duras:
1. El facilitador de Celo solo anuncia **mainnet** (`eip155:42220`). NO anuncia Celo Sepolia.
2. `settle` necesita API key que **no tenemos** → entrada en `ACCION_HUMANA_REQUERIDA.md` (buscar en docs.celo.org / canal del hackathon cómo emitirla). `verify` sí es libre.
3. Scheme soportado: **`exact`** (v2). Network en formato CAIP-2: `eip155:42220`.

### 1.3 Formato del flujo (x402 v2, scheme `exact`)

1. Cliente hace `GET /api/quote` sin pago → servidor responde **HTTP 402** con header **`PAYMENT-REQUIRED`** (base64) + JSON de requisitos:

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "accepts": [{
    "scheme": "exact",
    "network": "eip155:42220",
    "maxAmountRequired": "10000",
    "resource": "https://remesaflow.example/api/quote",
    "description": "Cotización de remesa",
    "mimeType": "application/json",
    "payTo": "0x<WALLET_TESORERIA>",
    "maxTimeoutSeconds": 60,
    "asset": "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
    "extra": { "name": "USDC", "version": "2" }
  }]
}
```
(`maxAmountRequired` en unidades base del asset: USDC = 6 decimales, `"10000"` = $0.01. Estructura según spec x402 de coinbase/x402; los nombres `paymentPayload`/`paymentRequirements` confirmados contra `/verify` del facilitador.)

2. Cliente firma autorización EIP-3009 (`transferWithAuthorization`) del asset y reintenta con header **`PAYMENT-SIGNATURE`** (payload JSON base64). **CORREGIDO 2026-07-14 (verificado en @x402/core@2.18.0 instalado):** `PAYMENT-SIGNATURE` es el header v2; `X-PAYMENT` es v1 (el server `@x402/hono` lo acepta como fallback de compatibilidad, pero los clientes v2 como `@x402/fetch` mandan `PAYMENT-SIGNATURE`).
3. Servidor → `POST https://api.x402.celo.org/verify` con `{paymentPayload, paymentRequirements}` → `{"isValid":true, "payer":"0x..."}`.
4. Servidor ejecuta la lógica, luego `POST /settle` (con `X-API-Key`) → el facilitador manda la tx on-chain.
5. Respuesta 200 con header **`PAYMENT-RESPONSE`** (receipt base64; en v1 era `X-PAYMENT-RESPONSE` — los clientes v2 leen ambos) — el middleware `@x402/hono` hace 402/verify/settle/headers solo.

### 1.4 Middleware Hono (esqueleto de referencia, del README oficial de `@x402/hono@2.18.0`)

```typescript
import { Hono } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

const facilitatorClient = new HTTPFacilitatorClient({
  url: "https://api.x402.celo.org",
  // createAuthHeaders: () => ({ settle: { "X-API-Key": process.env.X402_API_KEY } })  // PENDIENTE: firma exacta del hook de auth — ver riesgo R2
});
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register("eip155:42220", new ExactEvmScheme());

const app = new Hono();
app.use(paymentMiddleware(
  {
    "GET /api/quote": {
      accepts: {
        scheme: "exact",
        price: "$0.01",
        network: "eip155:42220",
        payTo: "0x<WALLET_TESORERIA>",
        maxTimeoutSeconds: 60,
      },
      description: "Cotización de remesa USD → moneda local",
    },
  },
  resourceServer,
));
```

**DECISIÓN por red:**
- **Mainnet (demo final):** `@x402/hono` + facilitador `https://api.x402.celo.org`, network `eip155:42220`, asset **USDC**.
- **Celo Sepolia (dev):** el facilitador de Celo no la anuncia. Opciones en orden: (a) thirdweb facilitator (`settlePayment` con `celoSepolia`), (b) modo mock del middleware (verify local sin settle), (c) probar igual `eip155:11142220` contra api.x402.celo.org y confirmar el rechazo. NO bloquear el sprint por esto: F5 arranca con mock.

### 1.5 Stablecoin del pago x402 (DECISIÓN)

**USDC** — `0xcebA9300f2b948710d2653dD7B07f33A8B32118C` (mainnet, 6 decimales). Razones: listado por el skill como token de pago x402, soporta EIP-3009 (requisito del scheme `exact`), y además tiene adapter de gas (sección 3).
- Testnet (Celo Sepolia) USDC: `0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B` (ojo: coincide con la dirección del *adapter* de USDC en mainnet; es así en la fuente, no es typo nuestro).
- Alternativas listadas por el skill: USDT `0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e` (6 dec), USDm `0x765DE816845861e75A25fCA122bb6898B8B1282a` (18 dec). No las usamos en v1.

---

## 2. Mento — cotización on-chain USD → moneda local

### 2.1 SDK (DECISIÓN)

`@mento-protocol/mento-sdk@3.2.8` (latest, verificado npm) + `viem` como peer dep. **No** escribir llamadas manuales al Broker en v1: el SDK resuelve direcciones, rutas multi-hop y circuit breakers.

```typescript
import { Mento, ChainId, deadlineFromMinutes } from "@mento-protocol/mento-sdk";
import { parseUnits } from "viem";

const mento = await Mento.create(ChainId.CELO_SEPOLIA, "https://forno.celo-sepolia.celo-testnet.org");
// mainnet: Mento.create(ChainId.CELO, publicClient)

// Cotizar: cuánta KESm sale por 100 USDm
const out = await mento.quotes.getAmountOut(USDm, KESm, parseUnits("100", 18));

// Ruta (directa o multi-hop) y tradabilidad (circuit breaker)
const route = await mento.routes.findRoute(USDm, KESm);
const ok = await mento.trading.isPairTradable(USDm, KESm);

// Swap (approval + swap listos para walletClient.sendTransaction)
const { approval, swap } = await mento.swap.buildSwapTransaction(
  USDm, KESm, amountIn, recipient, owner,
  { slippageTolerance: 0.5, deadline: deadlineFromMinutes(5) }
);
```

### 2.2 Direcciones núcleo Mento (extraídas de `@mento-protocol/mento-sdk@3.2.8` `dist/core/constants/addresses.js`)

| Contrato | Celo Mainnet (42220) | Celo Sepolia (11142220) |
|----------|----------------------|--------------------------|
| **Broker** | `0x777A8255cA72412f0d706dc03C9D1987306B4CaD` | `0xB9Ae2065142EB79b6c5EB1E8778F883fad6B07Ba` |
| **BiPoolManager** | `0x22d9db95E6Ae61c104A7B6F6C78D7993B94ec901` | `0xeCB3C656C131fCd9bB8D1d80898716bD684feb78` |
| MentoRouter | `0xbe729350f8cdfc19db6866e8579841188ee57f67` | `0x8e4Fb12D86D5DF911086a9153e79CA27e0c96156` |
| SortedOracles | `0xefB84935239dAcdecF7c5bA76d8dE40b077B7b33` | `0xfaa7Ca2B056E60F6733aE75AA0709140a6eAfD20` |
| Reserve | `0x9380fA34Fd9e4Fd14c06305fd7B6199089eD4eb9` | `0x2bC2D48735842924C508468C5A02580aD4F6d99A` |

(Solo para debugging/lectura directa; el código de la app va por el SDK.)

### 2.3 Stablecoins regionales que EXISTEN (naming actual: sufijo `m`, no prefijo `c`)

El skill oficial usa la nomenclatura nueva: **USDm, KESm, PHPm, COPm, NGNm, BRLm...** (los viejos cUSD/cKES/cREAL son los mismos contratos renombrados; los docs de fee-abstraction aún dicen cUSD/cEUR/cREAL). Todas con **18 decimales**.

Corredores candidatos para RemesaFlow (mainnet / Celo Sepolia):

| Token | Moneda | Mainnet | Celo Sepolia |
|-------|--------|---------|--------------|
| USDm | USD | `0x765de816845861e75a25fca122bb6898b8b1282a` | `0xdE9e4C3ce781b4bA68120d6261cbad65ce0aB00b` |
| KESm | Chelín keniano | `0x456a3D042C0DbD3db53D5489e98dFb038553B0d0` | `0xC7e4635651E3e3Af82b61d3E23c159438daE3BbF` |
| PHPm | Peso filipino | `0x105d4A9306D2E55a71d2Eb95B81553AE1dC20d7B` | `0x0352976d940a2C3FBa0C3623198947Ee1d17869E` |
| COPm | Peso colombiano | `0x8a567e2ae79ca692bd748ab832081c45de4041ea` | `0x5F8d55c3627d2dc0a2B4afa798f877242F382F67` |
| NGNm | Naira nigeriana | `0xE2702Bd97ee33c88c8f6f92DA3B733608aa76F71` | `0x3d5ae86F34E2a82771496D140daFAEf3789dF888` |
| BRLm | Real brasileño | `0xe8537a3d056da446677b9e9d6c5db704eaab4787` | `0x2294298942fdc79417DE9E0D740A4957E0e7783a` |
| XOFm | Franco CFA | `0x73F93dcc49cB8A239e2032663e9475dd5ef29A08` | `0x5505b70207aE3B826c1A7607F19F3Bf73444A082` |
| GHSm | Cedi ghanés | `0xfAeA5F3404bbA20D3cc2f8C4B0A888F55a3c7313` | `0x5e94B8C872bD47BC4255E60ECBF44D5E66e7401C` |
| ZARm | Rand sudafricano | `0x4c35853A3B4e647fD266f4de678dCc8fEC410BF6` | `0x10CCfB235b0E1Ed394bACE4560C3ed016697687e` |

También existen: EURm, GBPm, CADm, AUDm, JPYm, CHFm (ver skill `celo-stablecoins/references/token-addresses.md`). **No inventar otros pares** (no hay INRm, MXNm, etc.).

### 2.4 Corredor de la demo (DECISIÓN + verificación obligatoria)

**Pago x402 en USDC → cotizar/swap a KESm** (Kenia = narrativa remesas fuerte). Ruta esperada: `USDC → USDm → KESm` (multi-hop; el SDK la resuelve con `routes.findRoute`).

**PENDIENTE VERIFICAR** (F3, primer paso, en ambas redes):
```typescript
const route = await mento.routes.findRoute(USDC, KESm);   // ¿existe ruta desde USDC?
const ok = await mento.trading.isPairTradable(USDC, KESm);
```
Si NO hay ruta desde USDC: cobrar x402 en USDC y cotizar `USDm → KESm` (par núcleo Mento, casi seguro existe), tratando USDC≈USDm 1:1 solo para el monto de la demo, con nota explícita en el README. Fallback de corredor: `USDm → PHPm` o `USDm → COPm`.

---

## 3. viem + feeCurrency (gas en stablecoin)

Solo **viem** soporta `feeCurrency` (ethers.js y web3.js NO). Tx tipo CIP-64 (`0x7b`), ~+50.000 gas de overhead. Sin `feeCurrency` se paga en CELO.

**Regla de oro:** tokens de 6 decimales (USDC/USDT) usan la dirección del **ADAPTER** en `feeCurrency`; tokens de 18 decimales (cUSD/USDm, cEUR, cREAL) usan la dirección del **token** directo.

| feeCurrency | Mainnet (42220) | Celo Sepolia (11142220) |
|-------------|-----------------|--------------------------|
| USDC (adapter) | `0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B` | `0x4822e58de6f5e485eF90df51C41CE01721331dC0` |
| USDT (adapter) | `0x0e2a3e05bc9a16f5292a6170456a710cb89c6f72` | — (no listado) |
| cUSD/USDm (token directo) | `0x765DE816845861e75A25fCA122bb6898B8B1282a` | PENDIENTE VERIFICAR si es fee currency en Sepolia (comando abajo) |
| CELO | omitir el campo | omitir el campo |

```typescript
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celoSepolia } from "viem/chains";   // mainnet: celo

const account = privateKeyToAccount(process.env.AGENT_PK as `0x${string}`);
const walletClient = createWalletClient({
  account,
  chain: celoSepolia,
  transport: http("https://forno.celo-sepolia.celo-testnet.org"),
});

const hash = await walletClient.writeContract({
  address: TOKEN,
  abi: ERC20_ABI,
  functionName: "transfer",
  args: [to, amount],
  feeCurrency: "0x4822e58de6f5e485eF90df51C41CE01721331dC0", // USDC adapter Sepolia
});
```

Gas price en la fee currency: `publicClient.request({ method: "eth_gasPrice", params: [ADAPTER] })`.

Lista viva de fee currencies permitidas — contrato `FeeCurrencyDirectory` `0x9212Fb72ae65367A7c887eC4Ad9bE310BAC611BF` (misma dirección en ambas redes según el skill):
```bash
cast call 0x9212Fb72ae65367A7c887eC4Ad9bE310BAC611BF "getCurrencies()(address[])" --rpc-url https://forno.celo-sepolia.celo-testnet.org
```

**DECISIÓN:** la wallet del agente paga gas con **USDC adapter** → no necesita CELO nunca. (Nota UX frontend: MetaMask NO soporta feeCurrency; solo MiniPay/Valora o tx firmadas server-side. Nuestro agente firma server-side con viem, así que no nos afecta.)

---

## 4. ERC-8004 — identidad del agente

### 4.1 Direcciones (del skill oficial `8004`)

| Contrato | Celo Mainnet (42220) | Celo Sepolia (11142220) |
|----------|----------------------|--------------------------|
| Identity Registry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| Reputation Registry | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |

ABIs listos en `~/.claude/skills/8004/references/identity-registry-abi.json` y `reputation-registry-abi.json` → **copiarlos a `backend/src/abis/`**.

### 4.2 Registration file (JSON hosteado en HTTPS o IPFS)

```json
{
  "type": "Agent",
  "name": "RemesaFlow Agent",
  "description": "Agente de remesas: cobra vía x402 y cotiza/entrega stablecoins locales vía Mento",
  "image": "ipfs://...",
  "endpoints": [
    { "type": "a2a", "url": "https://<backend>/.well-known/agent.json" },
    { "type": "wallet", "address": "0x<WALLET_AGENTE>", "chainId": 42220 }
  ],
  "supportedTrust": ["reputation"]
}
```
Para la demo alcanza hostearlo como ruta estática del backend Hono (`/.well-known/agent.json` + URI https). IPFS opcional.

### 4.3 Pasos de registro (F11)

1. `walletClient.writeContract({ address: IDENTITY_REGISTRY, abi, functionName: "register", args: ["https://<backend>/registration.json"] })` — es un mint ERC-721.
2. `agentId` sale del receipt: log Transfer (el de 4 topics), `agentId = BigInt(log.topics[3])`.
3. Guardar `agentId` en config. Lecturas: `tokenURI(agentId)`, `getAgentWallet(agentId)`, `ownerOf(agentId)`.
4. Opcional demo: mostrar reputación con `getSummary(agentId, clients, '', '')` (ojo: `clients` no puede ser vacío; obtener con `getClients(agentId)`). Self-feedback está bloqueado por contrato — el feedback demo debe venir de una segunda wallet.

---

## 5. Attribution tags (ERC-8021)

### 5.1 Paquete (VERIFICADO en npm 2026-07-13)

**`@celo/attribution-tags@0.3.0`** existe, mantenido por cLabs. `viem` es peer dep opcional (solo para `verifyTx`).

```bash
pnpm add @celo/attribution-tags
```

API completa:
```typescript
toDataSuffix(code: string | readonly string[]): Hex      // genera el sufijo
fromDataSuffix(data: Hex): { codes: string[]; schemaId: number } | null  // decodifica (acepta calldata completa)
verifyTx({ client, hash }): Promise<{ codes; schemaId } | null>  // verifica tx on-chain, nunca lanza
codeFromHostname(hostname: string): string                // "celo_" + 12 hex
ERC_8021_MARKER: "0x80218021802180218021802180218021"
```
Reglas del código: `[a-z0-9_]`, ≤32 bytes, sin mayúsculas/espacios/comas. Wire format: Schema 0 → `[code][length:1][schema:1=0x00][marker:16]` al final de la calldata.

### 5.2 Cómo taguear CADA tx del agente (DECISIÓN)

- Tx simple (transfer nativo / sin calldata): `data: toDataSuffix(CODE)`.
- Llamada a contrato con viem: usar el parámetro **`dataSuffix`** de `writeContract`/`sendTransaction` — viem lo concatena al final de la calldata:

```typescript
import { toDataSuffix } from "@celo/attribution-tags";
const SUFFIX = toDataSuffix("remesaflow");   // código provisional válido

await walletClient.writeContract({
  address: TOKEN, abi, functionName: "transfer", args: [to, amount],
  feeCurrency: USDC_ADAPTER,
  dataSuffix: SUFFIX,
});
```
- Tx del SDK Mento (`swap.params`): `sendTransaction({ ...swap.params, data: concat([swap.params.data, SUFFIX]) })` (usar `concat` de viem).
- Multi-code (`toDataSuffix(["a","b"])`) existe pero cada capa añade SOLO su código (el nuestro; `minipay`/plataforma los añade la wallet, no nosotros).
- QA: `verifyTx({ client, hash })` debe devolver `{ codes: ["remesaflow"], schemaId: 0 }`.

**PENDIENTE VERIFICAR:** si el hackathon/Proof of Ship emite un código oficial `celo_xxxxxxxx` para el proyecto, reemplazar `"remesaflow"` por ese código (una constante `ATTRIBUTION_CODE` en config). Mientras tanto `"remesaflow"` es válido según las reglas del paquete.

---

## 6. Config de red centralizada (contrato para BACK)

Una sola fuente de verdad `config/networks.ts` con este shape (valores de las secciones 1-5):

```
{ chainId, viemChain, rpcUrl, explorer,
  usdc: { token, adapter, decimals: 6 },
  usdm, kesm, ...,                       // 18 decimals
  x402: { facilitatorUrl, network: "eip155:<id>", payTo, asset },
  mento: { chainId: ChainId.CELO | ChainId.CELO_SEPOLIA },
  erc8004: { identityRegistry, reputationRegistry },
  attributionCode }
```

---

## 7. Riesgos e incógnitas (lo que los skills NO aclaran)

| # | Riesgo | Mitigación / comando de verificación |
|---|--------|--------------------------------------|
| R1 | `POST /settle` de api.x402.celo.org exige `X-API-Key` y no sabemos dónde se emite | → `ACCION_HUMANA_REQUERIDA.md`. Buscar en docs.celo.org/x402 y el Discord del hackathon. Mientras: `verify` (libre) + settle vía thirdweb facilitator como plan B |
| R2 | Firma exacta del hook de auth en `HTTPFacilitatorClient` (`createAuthHeaders`) no verificada | Leer `node_modules/@x402/core` al instalar; el tipo en v1 era `CreateHeaders` |
| R3 | El facilitador de Celo NO anuncia testnet (`/supported` solo `eip155:42220`) | Dev en Sepolia con mock o thirdweb; demo de settle real solo en mainnet |
| R4 | No sabemos qué assets acepta el facilitador (USDC seguro es el candidato; ¿USDT? ¿USDm?) | Probar `POST /verify` con PaymentRequirements de cada asset y ver si devuelve `isValid` vs `invalidReason` |
| R5 | Ruta Mento `USDC → KESm` no garantizada | `mento.routes.findRoute(USDC, KESm)` en ambas redes ANTES de codear F3 (ver 2.4, con fallback definido) |
| R6 | ¿USDm/cUSD soporta EIP-3009 (`transferWithAuthorization`) para scheme `exact`? | Irrelevante si nos quedamos en USDC (sí lo soporta). Verificar solo si R4 nos empuja a USDm |
| R7 | USDC en Sepolia (`0x2F25de...`) coincide con el adapter de mainnet — raro pero es lo que dicen dos skills | Confirmar: `cast call 0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B "symbol()(string)" --rpc-url https://forno.celo-sepolia.celo-testnet.org` |
| R8 | Fee currencies reales habilitadas en Sepolia (skill solo lista USDC) | `cast call 0x9212Fb72ae65367A7c887eC4Ad9bE310BAC611BF "getCurrencies()(address[])" --rpc-url https://forno.celo-sepolia.celo-testnet.org` |
| R9 | Liquidez/slippage de pools regionales en testnet puede ser nula | Si `getAmountOut` revierte en Sepolia, cotizar contra mainnet (solo lectura, gratis) y ejecutar swap demo en Sepolia con par que sí tenga pool |
| R10 | Forno rate-limited | Retry + fallback Ankr/dRPC en el transport de viem (`fallback([http(a), http(b)])`) |

---

## Resumen ejecutivo (para PROGRESO.md)

- Testnet = **Celo Sepolia (11142220)**, no Alfajores.
- x402: **@x402/hono v2** + facilitador `https://api.x402.celo.org` (mainnet), pago en **USDC**; settle necesita API key (acción humana); testnet vía thirdweb/mock.
- Mento: **@mento-protocol/mento-sdk@3.2.8**; corredor demo **USDC/USDm → KESm** (verificar ruta primero). Broker mainnet `0x777A8255cA72412f0d706dc03C9D1987306B4CaD`, Sepolia `0xB9Ae2065142EB79b6c5EB1E8778F883fad6B07Ba`.
- Gas: viem `feeCurrency` = USDC adapter (`0x2F25deB3...` mainnet / `0x4822e58d...` Sepolia).
- Identidad: ERC-8004 Identity Registry `0x8004A169...` (main) / `0x8004A818...` (Sepolia).
- Attribution: **@celo/attribution-tags@0.3.0**, `dataSuffix: toDataSuffix(CODE)` en toda tx.
