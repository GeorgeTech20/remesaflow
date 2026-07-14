export type Lang = 'es' | 'en';

export const LANG_STORAGE_KEY = 'remesaflow-lang';

export function getInitialLang(): Lang {
  try {
    const stored = localStorage.getItem(LANG_STORAGE_KEY);
    if (stored === 'es' || stored === 'en') return stored;
  } catch {
    /* localStorage unavailable */
  }
  return navigator.language?.toLowerCase().startsWith('es') ? 'es' : 'en';
}

export function persistLang(lang: Lang): void {
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    /* ignore */
  }
}

const es = {
  demoBanner: 'Modo demo — la API no responde, mostrando datos de ejemplo',
  heroTitle: '¿Cuánto llega realmente cuando mandás plata a casa?',
  heroSub: 'Cotización real on-chain en 5 segundos. Cuesta 1 centavo.',
  heroBadge: 'Datos en vivo de Mento · Celo',

  widgetTitle: 'Cotizá tu remesa',
  amountLabel: 'Enviás (USD)',
  countryLabel: 'País destino',
  quoteBtn: 'Cotizar por $0.01',
  quoting: 'Consultando Mento…',
  quoteError: 'No se pudo cotizar. Probá de nuevo.',

  resultArrives: 'Llega a destino',
  resultRate: 'Tasa',
  resultVia: 'vía Mento en Celo',
  resultFee: 'Fee de red',
  compareTitle: '¿Y si lo mandaras por…?',
  compareArrive: 'llegan',
  compareSave: 'ahorrás',
  compareBest: 'Mejor ruta',

  howTitle: 'Cómo funciona',
  how1Title: 'Pagás 1 centavo',
  how1Desc: 'Micropago x402 en USDC sobre Celo. Sin cuenta, sin tarjeta, sin suscripción.',
  how2Title: 'Consultamos Mento on-chain',
  how2Desc: 'Leemos las tasas reales del protocolo Mento en el momento. Nada de spreads escondidos.',
  how3Title: 'Ves la ruta más barata',
  how3Desc: 'Comparamos contra Western Union y Wise y te mostramos cuánto ahorrás.',

  agentsTitle: 'Para agentes',
  agentsDesc:
    'RemesaFlow es una API x402: cualquier agente con una wallet puede pagar $0.01 y cotizar. Sin API keys, sin registro. Si estás construyendo un agente de pagos, consumila.',
  agentsCta: 'Flujo completo: request → 402 → pago firmado → respuesta.',
  copyBtn: 'Copiar',
  copiedBtn: 'Copiado ✓',

  footerGithub: 'GitHub',
  footerTelegram: 'Bot de Telegram',
  footerErc: 'Registro ERC-8004',
  footerBuilt: 'Built on Celo 🟡',
  footerTagline: 'Remesas cotizadas on-chain, un centavo a la vez.',
};

const en: typeof es = {
  demoBanner: 'Demo mode — API unreachable, showing sample data',
  heroTitle: 'How much actually arrives when you send money home?',
  heroSub: 'Real on-chain quote in 5 seconds. Costs 1 cent.',
  heroBadge: 'Live Mento data · Celo',

  widgetTitle: 'Quote your remittance',
  amountLabel: 'You send (USD)',
  countryLabel: 'Destination country',
  quoteBtn: 'Quote for $0.01',
  quoting: 'Querying Mento…',
  quoteError: 'Quote failed. Please try again.',

  resultArrives: 'Arrives at destination',
  resultRate: 'Rate',
  resultVia: 'via Mento on Celo',
  resultFee: 'Network fee',
  compareTitle: 'What if you sent it via…?',
  compareArrive: 'arrives',
  compareSave: 'you save',
  compareBest: 'Best route',

  howTitle: 'How it works',
  how1Title: 'You pay 1 cent',
  how1Desc: 'x402 micropayment in USDC on Celo. No account, no card, no subscription.',
  how2Title: 'We query Mento on-chain',
  how2Desc: 'We read real Mento protocol rates at that moment. No hidden spreads.',
  how3Title: 'You see the cheapest route',
  how3Desc: 'We compare against Western Union and Wise and show you how much you save.',

  agentsTitle: 'For agents',
  agentsDesc:
    'RemesaFlow is an x402 API: any agent with a wallet can pay $0.01 and get a quote. No API keys, no signup. If you are building a payments agent, consume it.',
  agentsCta: 'Full flow: request → 402 → signed payment → response.',
  copyBtn: 'Copy',
  copiedBtn: 'Copied ✓',

  footerGithub: 'GitHub',
  footerTelegram: 'Telegram bot',
  footerErc: 'ERC-8004 registry',
  footerBuilt: 'Built on Celo 🟡',
  footerTagline: 'Remittances quoted on-chain, one cent at a time.',
};

export const dict: Record<Lang, typeof es> = { es, en };
