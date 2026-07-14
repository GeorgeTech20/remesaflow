// RemesaFlow Telegram bot — remittance quotes over Celo/Mento.
// Bot copy is intentionally in Spanish (LatAm-first launch).
// TODO(i18n): add English strings once an i18n layer lands.
import { Bot, Context, InlineKeyboard } from "grammy";
import { config, assertConfig } from "./config";
import { payAndFetch, PaymentRequiredError } from "./payment";

assertConfig();

// ---------------------------------------------------------------------------
// API types + client
// ---------------------------------------------------------------------------

interface Currency {
  code: string;
  name: string;
  country: string;
  flag: string;
  stablecoin: string;
}

interface CurrenciesResponse {
  currencies: Currency[];
  network: string;
}

interface Quote {
  send: number;
  currency: string;
  receives: number;
  rate: number;
  celoFee: number;
  wuWouldCharge: number;
  wiseWouldCharge: number;
  savings: number;
  timestamp: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
let currenciesCache: { data: CurrenciesResponse; fetchedAt: number } | null = null;

async function getCurrencies(): Promise<CurrenciesResponse> {
  if (currenciesCache && Date.now() - currenciesCache.fetchedAt < CACHE_TTL_MS) {
    return currenciesCache.data;
  }
  const res = await fetch(`${config.apiBaseUrl}/api/currencies`);
  if (!res.ok) {
    throw new Error(`GET /api/currencies -> HTTP ${res.status}`);
  }
  const data = (await res.json()) as CurrenciesResponse;
  currenciesCache = { data, fetchedAt: Date.now() };
  return data;
}

async function getQuote(amount: number, to: string): Promise<Quote> {
  const url =
    `${config.apiBaseUrl}/api/quote` +
    `?amount=${encodeURIComponent(amount)}&to=${encodeURIComponent(to)}`;
  const res = await payAndFetch(url);
  if (!res.ok) {
    throw new Error(`GET /api/quote -> HTTP ${res.status}`);
  }
  return (await res.json()) as Quote;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const MIN_AMOUNT = 1;
const MAX_AMOUNT = 10_000;

function usd(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function local(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function findCurrency(currencies: Currency[], code: string): Currency | undefined {
  return currencies.find((c) => c.code.toUpperCase() === code.toUpperCase());
}

function formatQuote(q: Quote, cur: Currency | undefined): string {
  const flag = cur?.flag ?? "🌍";
  const country = cur?.country ? ` (${cur.country})` : "";
  return [
    `💸 *Cotización RemesaFlow*`,
    ``,
    `Enviás: *${usd(q.send)} USD*`,
    `Llega: *${flag} ${local(q.receives)} ${q.currency}*${country}`,
    `Tasa: 1 USD = ${q.rate.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${q.currency}`,
    ``,
    `📊 *Qué te cobrarían otros:*`,
    `• Western Union: ${usd(q.wuWouldCharge)}`,
    `• Wise: ${usd(q.wiseWouldCharge)}`,
    `• Vos pagaste: *$0.01* + fee de red Celo (~${usd(q.celoFee)})`,
    ``,
    `💰 *Ahorrás ${usd(q.savings)}*`,
    ``,
    `🔗 Más info: ${config.landingUrl}`,
  ].join("\n");
}

function pairsList(data: CurrenciesResponse): string {
  const lines = data.currencies.map(
    (c) => `• ${c.flag} *USD → ${c.code}* — ${c.country} (vía ${c.stablecoin})`,
  );
  return [
    `🌍 *Corredores disponibles* (red: ${data.network})`,
    ``,
    ...lines,
    ``,
    `Cotizá con /cotizar — ej: \`/cotizar 50 KES\``,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Keyboards
// ---------------------------------------------------------------------------

// Callback data formats (Telegram limit: 64 bytes — these stay well under):
//   q:<amount>:<CODE>  -> run a quote
//   amt:<amount>       -> guided flow: amount chosen, ask for currency
//   guide              -> guided flow: start (ask for amount)

function startKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("$50 → 🇰🇪 KES", "q:50:KES")
    .text("$100 → 🇵🇭 PHP", "q:100:PHP")
    .row()
    .text("$100 → 🇧🇷 BRL", "q:100:BRL")
    .text("$200 → 🇨🇴 COP", "q:200:COP")
    .row()
    .text("$50 → 🇳🇬 NGN", "q:50:NGN")
    .text("💱 Otra cotización", "guide");
}

function amountKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const amount of [20, 50, 100, 200]) {
    kb.text(`$${amount}`, `amt:${amount}`);
  }
  return kb;
}

function currencyKeyboard(currencies: Currency[], amount: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  currencies.forEach((c, i) => {
    kb.text(`${c.flag} ${c.code} — ${c.country}`, `q:${amount}:${c.code}`);
    if (i % 2 === 1) kb.row();
  });
  return kb;
}

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

const bot = new Bot(config.telegramBotToken);

const ERR_API_DOWN =
  "😕 No pude conectar con el servicio de cotizaciones. " +
  "Probá de nuevo en unos minutos.";

bot.command("start", async (ctx) => {
  await ctx.reply(
    [
      `👋 ¡Hola! Soy *RemesaFlow*.`,
      ``,
      `Te cotizo remesas *USD → Kenia, Filipinas, Brasil, Colombia y Nigeria* ` +
        `con tasas reales de *Mento* (blockchain Celo).`,
      `Cada consulta cuesta *$0.01* vía x402 — nada de comisiones ocultas.`,
      ``,
      `Comandos:`,
      `• /cotizar \`<monto> <moneda>\` — ej: \`/cotizar 50 KES\``,
      `• /pares — corredores disponibles`,
      ``,
      `O tocá un corredor frecuente 👇`,
    ].join("\n"),
    { parse_mode: "Markdown", reply_markup: startKeyboard() },
  );
});

bot.command("pares", async (ctx) => {
  try {
    const data = await getCurrencies();
    await ctx.reply(pairsList(data), { parse_mode: "Markdown" });
  } catch (err) {
    console.error("pares failed:", err);
    await ctx.reply(ERR_API_DOWN);
  }
});

bot.command("cotizar", async (ctx) => {
  const args = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
  const amount = parseAmount(args[0]);
  const code = args[1]?.toUpperCase();

  // No args or bad amount -> guided flow, step 1: pick an amount.
  if (amount === null) {
    await ctx.reply("💵 ¿Cuánto querés enviar (USD)?", {
      reply_markup: amountKeyboard(),
    });
    return;
  }

  // Amount OK but no/invalid currency -> guided flow, step 2: pick a country.
  if (!code) {
    await askCurrency(ctx, amount);
    return;
  }

  await sendQuote(ctx, amount, code);
});

// Guided flow start (from /start keyboard).
bot.callbackQuery("guide", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("💵 ¿Cuánto querés enviar (USD)?", {
    reply_markup: amountKeyboard(),
  });
});

// Guided flow: amount chosen -> ask for currency.
bot.callbackQuery(/^amt:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const amount = Number(ctx.match[1]);
  await askCurrency(ctx, amount);
});

// Quote button (from /start shortcuts or guided flow).
bot.callbackQuery(/^q:(\d+(?:\.\d+)?):([A-Za-z]{2,6})$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Cotizando… 💸" });
  const amount = Number(ctx.match[1]);
  const code = ctx.match[2].toUpperCase();
  await sendQuote(ctx, amount, code);
});

// Fallback for plain text: nudge towards /cotizar.
bot.on("message:text", async (ctx) => {
  await ctx.reply(
    "No entendí 🤔 Usá /cotizar `<monto> <moneda>` (ej: `/cotizar 50 KES`) o /pares.",
    { parse_mode: "Markdown" },
  );
});

bot.catch((err) => {
  console.error("Unhandled bot error:", err.error);
});

// ---------------------------------------------------------------------------
// Shared handlers
// ---------------------------------------------------------------------------

function parseAmount(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw.replace(/^\$/, ""));
  if (!Number.isFinite(n) || n < MIN_AMOUNT || n > MAX_AMOUNT) return null;
  return n;
}

async function askCurrency(ctx: Context, amount: number): Promise<void> {
  try {
    const data = await getCurrencies();
    await ctx.reply(`🌍 ¿A qué país enviás *$${amount} USD*?`, {
      parse_mode: "Markdown",
      reply_markup: currencyKeyboard(data.currencies, amount),
    });
  } catch (err) {
    console.error("askCurrency failed:", err);
    await ctx.reply(ERR_API_DOWN);
  }
}

async function sendQuote(ctx: Context, amount: number, code: string): Promise<void> {
  if (amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
    await ctx.reply(
      `El monto debe estar entre $${MIN_AMOUNT} y $${MAX_AMOUNT.toLocaleString("en-US")} USD.`,
    );
    return;
  }

  let currencies: Currency[] | null = null;
  try {
    currencies = (await getCurrencies()).currencies;
  } catch {
    // Not fatal: the quote endpoint validates the pair anyway.
  }

  // Invalid pair -> show the valid list instead of hitting the API.
  if (currencies && !findCurrency(currencies, code)) {
    const valid = currencies.map((c) => `${c.flag} ${c.code}`).join(", ");
    await ctx.reply(
      `⚠️ *${code}* no es un corredor disponible.\n\nProbá con: ${valid}\nEj: \`/cotizar ${amount} ${currencies[0].code}\``,
      { parse_mode: "Markdown" },
    );
    return;
  }

  try {
    const quote = await getQuote(amount, code);
    const cur = currencies ? findCurrency(currencies, code) : undefined;
    await ctx.reply(formatQuote(quote, cur), {
      parse_mode: "Markdown",
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    if (err instanceof PaymentRequiredError) {
      console.error(err.message);
      await ctx.reply(err.userMessage);
      return;
    }
    console.error("sendQuote failed:", err);
    await ctx.reply(ERR_API_DOWN);
  }
}

// ---------------------------------------------------------------------------
// Startup (long polling — v1, no webhook)
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await bot.api.setMyCommands([
    { command: "start", description: "Qué hace RemesaFlow" },
    { command: "cotizar", description: "Cotizar una remesa: /cotizar 50 KES" },
    { command: "pares", description: "Corredores disponibles" },
  ]);

  console.log(`RemesaFlow bot starting (API: ${config.apiBaseUrl})…`);
  await bot.start({
    onStart: (me) => console.log(`Long polling as @${me.username}`),
  });
}

main().catch((err) => {
  console.error("Bot failed to start:", err);
  process.exit(1);
});
