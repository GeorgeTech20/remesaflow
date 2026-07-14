import { useEffect, useMemo, useRef, useState } from 'react';
import {
  API_BASE,
  Currency,
  MOCK_CURRENCIES,
  Quote,
  getCurrencies,
  getQuote,
} from './api';
import { Lang, dict, getInitialLang, persistLang } from './i18n';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatLocal(amount: number, currency: string, lang: Lang): string {
  try {
    return new Intl.NumberFormat(lang === 'es' ? 'es-419' : 'en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

const CURL_SNIPPET = `# 1. Call the API with no payment attached
curl -i "${API_BASE}/api/quote?amount=50&to=KES"

# <- HTTP/1.1 402 Payment Required
# <- {"accepts":[{"scheme":"exact","network":"celo",
#      "asset":"USDC","maxAmountRequired":"10000",
#      "payTo":"0xRemesaFlow...","resource":"/api/quote"}]}

# 2. Sign the payment with your agent wallet, retry
curl "${API_BASE}/api/quote?amount=50&to=KES" \\
  -H "X-PAYMENT: eyJzY2hlbWUiOiJleGFjdCIsIm5ldHdvcmsiOiJjZWxvIi4uLg=="

# <- HTTP/1.1 200 OK
# <- {"send":50,"currency":"KES","receives":6420.50,"rate":128.41,
#     "celoFee":0.02,"wuWouldCharge":3.00,"savings":2.98}`;

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

interface BarProps {
  label: string;
  arrives: string;
  fraction: number; // 0..1 relative to best route
  best?: boolean;
  extra?: string;
}

function CompareBar({ label, arrives, fraction, best, extra }: BarProps) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
        <span className={best ? 'font-bold text-celo' : 'text-neutral-300'}>{label}</span>
        <span className={best ? 'font-bold text-white' : 'text-neutral-400'}>
          {arrives}
          {extra && <span className="ml-2 font-semibold text-green-400">{extra}</span>}
        </span>
      </div>
      <div className="h-3 w-full overflow-hidden rounded-full bg-neutral-800">
        <div
          className={`bar-grow h-full rounded-full ${best ? 'bg-celo' : 'bg-neutral-500'}`}
          style={{ width: `${Math.max(4, fraction * 100)}%` }}
        />
      </div>
    </div>
  );
}

function StepCard({ icon, title, desc }: { icon: string; title: string; desc: string }) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-neutral-800 bg-neutral-900/60 p-6">
      <span className="text-3xl" aria-hidden="true">
        {icon}
      </span>
      <h3 className="text-lg font-bold">{title}</h3>
      <p className="text-sm leading-relaxed text-neutral-400">{desc}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App() {
  const [lang, setLang] = useState<Lang>(getInitialLang);
  const t = dict[lang];

  const [currencies, setCurrencies] = useState<Currency[]>(MOCK_CURRENCIES);
  const [amount, setAmount] = useState('50');
  const [to, setTo] = useState('KES');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [loading, setLoading] = useState(false);
  const [demoMode, setDemoMode] = useState(false);
  const [copied, setCopied] = useState(false);
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    getCurrencies().then(({ data, demo }) => {
      if (!alive) return;
      setCurrencies(data);
      if (demo) setDemoMode(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  function toggleLang() {
    const next: Lang = lang === 'es' ? 'en' : 'es';
    setLang(next);
    persistLang(next);
  }

  async function handleQuote() {
    const parsed = parseFloat(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    setLoading(true);
    const { data, demo } = await getQuote(parsed, to);
    setQuote(data);
    setDemoMode(demo);
    setLoading(false);
    requestAnimationFrame(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  }

  async function copySnippet() {
    try {
      await navigator.clipboard.writeText(CURL_SNIPPET);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  }

  const selected = useMemo(
    () => currencies.find((c) => c.code === to) ?? currencies[0],
    [currencies, to],
  );

  const comparison = useMemo(() => {
    if (!quote) return null;
    const wuArrives = Math.max(0, (quote.send - quote.wuWouldCharge) * quote.rate);
    const wiseArrives = Math.max(0, (quote.send - quote.wiseWouldCharge) * quote.rate);
    const celoArrives = quote.receives;
    const max = Math.max(wuArrives, wiseArrives, celoArrives, 1);
    return { wuArrives, wiseArrives, celoArrives, max };
  }, [quote]);

  return (
    <div className="min-h-screen font-sans">
      {/* Demo mode banner */}
      {demoMode && (
        <div className="bg-celo px-4 py-2 text-center text-xs font-bold text-black">
          {t.demoBanner}
        </div>
      )}

      {/* Header */}
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-5">
        <span className="text-lg font-black tracking-tight">
          Remesa<span className="text-celo">Flow</span>
        </span>
        <button
          onClick={toggleLang}
          className="rounded-full border border-neutral-700 px-4 py-1.5 text-sm font-semibold text-neutral-300 transition hover:border-celo hover:text-celo"
          aria-label="Switch language"
        >
          {lang === 'es' ? 'EN' : 'ES'}
        </button>
      </header>

      {/* 1. Hero */}
      <section className="mx-auto w-full max-w-5xl px-4 pb-12 pt-8 text-center sm:pt-16">
        <span className="inline-block rounded-full border border-celo/40 bg-celo/10 px-4 py-1 text-xs font-semibold text-celo">
          {t.heroBadge}
        </span>
        <h1 className="mx-auto mt-6 max-w-3xl text-4xl font-black leading-tight tracking-tight sm:text-6xl">
          {t.heroTitle}
        </h1>
        <p className="mx-auto mt-5 max-w-xl text-lg text-neutral-400 sm:text-xl">{t.heroSub}</p>
      </section>

      {/* 2. Quote widget */}
      <section className="mx-auto w-full max-w-5xl px-4">
        <div className="mx-auto max-w-lg rounded-3xl border border-neutral-800 bg-neutral-900/70 p-6 shadow-[0_0_60px_-20px_rgba(252,255,82,0.25)] sm:p-8">
          <h2 className="text-xl font-bold">{t.widgetTitle}</h2>
          <div className="mt-5 space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-sm font-semibold text-neutral-400">
                {t.amountLabel}
              </span>
              <div className="relative">
                <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-lg font-bold text-neutral-500">
                  $
                </span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleQuote()}
                  className="w-full rounded-xl border border-neutral-700 bg-ink py-3 pl-9 pr-4 text-lg font-bold text-white outline-none transition focus:border-celo"
                />
              </div>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-sm font-semibold text-neutral-400">
                {t.countryLabel}
              </span>
              <select
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="w-full appearance-none rounded-xl border border-neutral-700 bg-ink px-4 py-3 text-lg font-bold text-white outline-none transition focus:border-celo"
              >
                {currencies.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.flag} {c.country} — {c.code}
                  </option>
                ))}
              </select>
            </label>
            <button
              onClick={handleQuote}
              disabled={loading}
              className="w-full rounded-xl bg-celo py-4 text-lg font-black text-black transition hover:brightness-110 active:scale-[0.99] disabled:opacity-60"
            >
              {loading ? t.quoting : t.quoteBtn}
            </button>
          </div>
        </div>
      </section>

      {/* 3. Result */}
      <section ref={resultRef} className="mx-auto w-full max-w-5xl px-4 pt-10">
        {quote && comparison && selected && (
          <div className="fade-up mx-auto max-w-2xl rounded-3xl border border-celo/30 bg-neutral-900/70 p-6 sm:p-10">
            <p className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
              {t.resultArrives} {selected.flag}
            </p>
            <p className="mt-2 text-4xl font-black text-celo sm:text-6xl">
              {formatLocal(quote.receives, quote.currency, lang)}
            </p>
            <p className="mt-3 text-sm text-neutral-400">
              {t.resultRate}: 1 USD = {quote.rate.toLocaleString(lang === 'es' ? 'es-419' : 'en-US')}{' '}
              {quote.currency} · {t.resultFee}: {formatUsd(quote.celoFee)} · {t.resultVia} (
              {selected.stablecoin})
            </p>

            <h3 className="mt-8 text-lg font-bold">{t.compareTitle}</h3>
            <div className="mt-4 space-y-5">
              <CompareBar
                label="Western Union"
                arrives={`${t.compareArrive} ${formatLocal(comparison.wuArrives, quote.currency, lang)}`}
                fraction={comparison.wuArrives / comparison.max}
              />
              <CompareBar
                label="Wise"
                arrives={`${t.compareArrive} ${formatLocal(comparison.wiseArrives, quote.currency, lang)}`}
                fraction={comparison.wiseArrives / comparison.max}
              />
              <CompareBar
                label={`Celo / Mento — ${t.compareBest}`}
                arrives={`${t.compareArrive} ${formatLocal(comparison.celoArrives, quote.currency, lang)}`}
                fraction={comparison.celoArrives / comparison.max}
                best
                extra={`${t.compareSave} ${formatUsd(quote.savings)}`}
              />
            </div>
          </div>
        )}
      </section>

      {/* 4. How it works */}
      <section className="mx-auto w-full max-w-5xl px-4 py-20">
        <h2 className="text-center text-3xl font-black sm:text-4xl">{t.howTitle}</h2>
        <div className="mt-10 grid gap-5 sm:grid-cols-3">
          <StepCard icon="🪙" title={t.how1Title} desc={t.how1Desc} />
          <StepCard icon="⛓️" title={t.how2Title} desc={t.how2Desc} />
          <StepCard icon="🏁" title={t.how3Title} desc={t.how3Desc} />
        </div>
      </section>

      {/* 5. For agents */}
      <section className="border-y border-neutral-800 bg-neutral-900/40">
        <div className="mx-auto w-full max-w-5xl px-4 py-20">
          <h2 className="text-3xl font-black sm:text-4xl">
            {t.agentsTitle} <span className="text-celo">🤖</span>
          </h2>
          <p className="mt-4 max-w-2xl text-neutral-400">{t.agentsDesc}</p>
          <p className="mt-2 text-sm font-semibold text-celo">{t.agentsCta}</p>
          <div className="relative mt-6 overflow-hidden rounded-2xl border border-neutral-800 bg-black">
            <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2.5">
              <span className="text-xs font-semibold text-neutral-500">x402 · curl</span>
              <button
                onClick={copySnippet}
                className="rounded-md border border-neutral-700 px-3 py-1 text-xs font-bold text-neutral-300 transition hover:border-celo hover:text-celo"
              >
                {copied ? t.copiedBtn : t.copyBtn}
              </button>
            </div>
            <pre className="overflow-x-auto p-4 text-xs leading-relaxed text-neutral-300 sm:text-sm">
              <code>{CURL_SNIPPET}</code>
            </pre>
          </div>
        </div>
      </section>

      {/* 6. Footer */}
      <footer className="mx-auto w-full max-w-5xl px-4 py-12">
        <div className="flex flex-col items-center gap-6 sm:flex-row sm:justify-between">
          <div className="text-center sm:text-left">
            <p className="font-black">
              Remesa<span className="text-celo">Flow</span>
            </p>
            <p className="mt-1 text-sm text-neutral-500">{t.footerTagline}</p>
          </div>
          <nav className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-neutral-400">
            <a href="https://github.com" className="transition hover:text-celo">
              {t.footerGithub}
            </a>
            <a href="https://t.me" className="transition hover:text-celo">
              {t.footerTelegram}
            </a>
            <a href="#" className="transition hover:text-celo">
              {t.footerErc}
            </a>
          </nav>
          <span className="rounded-full border border-celo/40 bg-celo/10 px-4 py-1.5 text-xs font-bold text-celo">
            {t.footerBuilt}
          </span>
        </div>
      </footer>
    </div>
  );
}
