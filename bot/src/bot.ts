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
  /** F-EXEC: binds /enviar to the rate the user actually saw. */
  quoteId?: string;
}

/** Successful POST /api/remit response. */
interface RemitResult {
  txHash: string;
  explorerUrl: string;
  sent: number;
  received: number;
  rate: number;
  recipient: string;
  currency: string;
  status: "success" | "pending" | "failed";
  minReceived: number;
}

/** Error body from POST /api/remit (guardrail rejections). */
interface RemitErrorBody {
  error: string;
  message: string;
  newRate?: number;
  quotedRate?: number;
  max?: number;
  dailyCapUsd?: number;
  remainingTodayUsd?: number;
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

/** Thrown when the backend refused the remittance (a guardrail, not a crash). */
class RemitRejected extends Error {
  constructor(readonly body: RemitErrorBody, readonly status: number) {
    super(`POST /api/remit -> ${status} ${body.error}`);
    this.name = "RemitRejected";
  }
}

/**
 * Executes a remittance. Pays $0.01 via x402 (same as a quote) and moves REAL
 * funds — only ever called from the explicit confirmation handler.
 */
async function postRemit(pending: Pending): Promise<RemitResult> {
  const res = await payAndFetch(`${config.apiBaseUrl}/api/remit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      amount: pending.amount,
      to: pending.code,
      recipient: pending.recipient,
      ...(pending.quoteId ? { quoteId: pending.quoteId } : {}),
    }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({
      error: "unknown",
      message: `HTTP ${res.status}`,
    }))) as RemitErrorBody;
    throw new RemitRejected(body, res.status);
  }
  return (await res.json()) as RemitResult;
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

function formatRemit(r: RemitResult): string {
  const pendingNote =
    r.status === "pending"
      ? "\n\n⏳ La tx ya está en la red pero todavía no confirmó. Seguila en el explorer."
      : "";
  return [
    `✅ *Remesa enviada*`,
    ``,
    `Enviaste: *${usd(r.sent)} USD*`,
    `Recibió: *${local(r.received)} ${r.currency}*`,
    `Tasa: 1 USD = ${r.rate.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${r.currency}`,
    ``,
    `Destinatario:`,
    `\`${r.recipient}\``,
    ``,
    `🔗 [Ver la transacción](${r.explorerUrl})`,
    `\`${r.txHash}\``,
  ].join("\n") + pendingNote;
}

/** Turns a backend guardrail rejection into copy a human can act on. */
function remitErrorMessage(err: RemitRejected): string {
  const { body } = err;
  switch (body.error) {
    case "remit_disabled":
    case "remit_unavailable":
      return (
        "🔒 Los envíos reales están *deshabilitados* en este servidor. " +
        "Por ahora solo cotizo (/cotizar)."
      );
    case "amount_over_limit":
      return `🚫 El monto supera el límite por remesa${body.max ? ` (*${usd(body.max)}*)` : ""}.`;
    case "daily_cap_exceeded":
      return (
        `🚫 El agente llegó a su *tope diario*` +
        (body.dailyCapUsd ? ` de ${usd(body.dailyCapUsd)}` : "") +
        `. Probá mañana.`
      );
    case "rate_moved":
      return (
        `⚠️ *La tasa se movió* mientras confirmabas — no ejecuté nada.\n\n` +
        (body.newRate ? `Nueva tasa: 1 USD = ${body.newRate.toFixed(4)}\n\n` : "") +
        `Pedí una cotización nueva con /enviar si te sirve.`
      );
    case "quote_expired":
      return "⌛ La cotización venció. Pedí una nueva con /enviar.";
    case "insufficient_funds":
      return (
        "😬 El agente no tiene fondos suficientes para esta remesa. " +
        "Avisale al admin que recargue la wallet."
      );
    case "self_dealing":
      return "🚫 No puedo enviar a la wallet del propio agente.";
    case "invalid_recipient":
      return "⚠️ La dirección del destinatario no es válida.";
    default:
      return `😕 No pude completar la remesa: ${body.message}`;
  }
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
// F-EXEC — pending confirmations
//
// A remittance moves real money, so it ALWAYS takes two steps: /enviar shows a
// quote, and only an explicit button press executes it. The pending intent
// lives here (Telegram callback_data caps at 64 bytes — an address alone eats
// 42 — so the button carries a short id, not the payload).
// ---------------------------------------------------------------------------

interface Pending {
  amount: number;
  code: string;
  recipient: string;
  quoteId?: string;
  /** Only the user who asked may confirm (matters in group chats). */
  userId: number;
  expiresAt: number;
}

/** Matches the backend's 120s quote TTL. */
const CONFIRM_TTL_MS = 120_000;

const pending = new Map<string, Pending>();

function putPending(intent: Omit<Pending, "expiresAt">): string {
  // Opportunistic sweep: this map only ever holds a handful of live intents.
  const now = Date.now();
  for (const [key, value] of pending) {
    if (value.expiresAt <= now) pending.delete(key);
  }
  const id = Math.random().toString(16).slice(2, 10);
  pending.set(id, { ...intent, expiresAt: now + CONFIRM_TTL_MS });
  return id;
}

/**
 * Takes the intent and REMOVES it in one step. Single-use by construction: a
 * double-tap on "Confirmar" finds nothing the second time, so it cannot
 * double-send. Returns null when unknown/expired.
 */
function takePending(id: string): Pending | null {
  const intent = pending.get(id);
  if (!intent) return null;
  pending.delete(id);
  if (intent.expiresAt <= Date.now()) return null;
  return intent;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

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

/** The only path to a real transfer: an explicit, human button press. */
function confirmKeyboard(id: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Confirmar envío", `send:${id}`)
    .text("❌ Cancelar", `cancel:${id}`);
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
      `• /enviar \`<monto> <moneda> <direccion>\` — enviar de verdad (te pido confirmación)`,
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

// ---------------------------------------------------------------------------
// F-EXEC — /enviar <monto> <moneda> <direccion>
//
// Step 1 of 2. This command NEVER sends: it quotes, then asks. The transfer
// only happens in the `send:` callback below, after a human presses the button.
// ---------------------------------------------------------------------------

bot.command("enviar", async (ctx) => {
  const args = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
  const amount = parseAmount(args[0]);
  const code = args[1]?.toUpperCase();
  const recipient = args[2];

  if (amount === null || !code || !recipient) {
    await ctx.reply(
      [
        "📤 *Enviar una remesa real*",
        "",
        "Uso: `/enviar <monto> <moneda> <direccion>`",
        "Ej: `/enviar 10 KES 0x1234...abcd`",
        "",
        "La dirección es la wallet del destinatario (recibe la stablecoin local).",
        "Te muestro la cotización y *vos confirmás* antes de que se mueva un centavo.",
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
    return;
  }

  if (!EVM_ADDRESS.test(recipient)) {
    await ctx.reply(
      "⚠️ Esa no es una dirección EVM válida (debe ser `0x` + 40 caracteres hex).",
      { parse_mode: "Markdown" },
    );
    return;
  }

  // Quote first (costs $0.01 via x402) so the user sees the rate BEFORE deciding.
  let quote: Quote;
  try {
    quote = await getQuote(amount, code);
  } catch (err) {
    if (err instanceof PaymentRequiredError) {
      console.error(err.message);
      await ctx.reply(err.userMessage);
      return;
    }
    console.error("enviar/quote failed:", err);
    await ctx.reply(ERR_API_DOWN);
    return;
  }

  const id = putPending({
    amount,
    code,
    recipient,
    ...(quote.quoteId ? { quoteId: quote.quoteId } : {}),
    userId: ctx.from?.id ?? 0,
  });

  await ctx.reply(
    [
      "📤 *Confirmá el envío*",
      "",
      `Enviás: *${usd(quote.send)} USD*`,
      `Llega: *${local(quote.receives)} ${quote.currency}*`,
      `Tasa: 1 USD = ${quote.rate.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${quote.currency}`,
      "",
      `Destinatario:`,
      `\`${recipient}\``,
      "",
      "⚠️ Esto mueve *fondos reales* on-chain. Revisá la dirección: " +
        "una transferencia en blockchain *no se puede revertir*.",
      "",
      `_La cotización vence en 2 minutos._`,
    ].join("\n"),
    { parse_mode: "Markdown", reply_markup: confirmKeyboard(id) },
  );
});

bot.callbackQuery(/^cancel:([0-9a-f]{1,16})$/, async (ctx) => {
  takePending(ctx.match[1]);
  await ctx.answerCallbackQuery({ text: "Cancelado" });
  await ctx.editMessageText("❌ Envío cancelado. No se movió nada.");
});

// Step 2 of 2 — the ONLY place the bot triggers a real transfer.
bot.callbackQuery(/^send:([0-9a-f]{1,16})$/, async (ctx) => {
  // Consume the intent FIRST: single-use, so a double-tap cannot double-send.
  const intent = takePending(ctx.match[1]);

  if (!intent) {
    await ctx.answerCallbackQuery({ text: "Cotización vencida" });
    await ctx.editMessageText(
      "⌛ Esa cotización venció o ya se usó. Pedí una nueva con /enviar.",
    );
    return;
  }
  // In a group, only the person who ran /enviar may confirm.
  if (intent.userId && ctx.from?.id !== intent.userId) {
    await ctx.answerCallbackQuery({
      text: "Solo quien pidió el envío puede confirmarlo.",
      show_alert: true,
    });
    pending.set(ctx.match[1], intent); // not ours to consume: put it back
    return;
  }

  await ctx.answerCallbackQuery({ text: "Enviando… 🚀" });
  await ctx.editMessageText("⏳ Ejecutando la remesa on-chain… (puede tardar unos segundos)");

  try {
    const result = await postRemit(intent);
    await ctx.editMessageText(formatRemit(result), {
      parse_mode: "Markdown",
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    if (err instanceof RemitRejected) {
      await ctx.editMessageText(remitErrorMessage(err), { parse_mode: "Markdown" });
      return;
    }
    if (err instanceof PaymentRequiredError) {
      console.error(err.message);
      await ctx.editMessageText(err.userMessage);
      return;
    }
    console.error("remit failed:", err);
    await ctx.editMessageText(
      "😕 No pude completar la remesa. Si no ves un txHash, *no se movió nada*. " +
        "Probá de nuevo en unos minutos.",
      { parse_mode: "Markdown" },
    );
  }
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
    { command: "enviar", description: "Enviar de verdad: /enviar 10 KES 0x..." },
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
