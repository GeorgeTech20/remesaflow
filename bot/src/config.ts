import path from "node:path";
import dotenv from "dotenv";

// Load the shared .env from the monorepo root.
// Works from both src/ (tsx) and dist/ (compiled): bot/{src,dist}/ -> ../../.env
dotenv.config({ path: path.resolve(__dirname, "..", "..", ".env") });

export const config = {
  /** Telegram token from @BotFather. Required to start the bot. */
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",

  /** RemesaFlow backend base URL. */
  apiBaseUrl: (process.env.API_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, ""),

  /** Landing page linked at the bottom of every quote. */
  landingUrl: process.env.LANDING_URL ?? "https://remesaflow.example",

  /**
   * Wallet key used to sign x402 payments (src/payment.ts).
   * Optional: without it the bot runs in degraded mode (plain fetch) and
   * only works against a backend with X402_ENABLED=false.
   */
  botPrivateKey: process.env.BOT_PRIVATE_KEY ?? "",

  /** Celo network for x402 payments: "celo-sepolia" (default) | "celo". */
  network: parseNetwork(process.env.NETWORK),

  /**
   * Safety cap: max x402 payment the bot will ever sign, in base units of the
   * asset (USDC = 6 decimals; default 100000 = $0.10; a quote costs $0.01).
   */
  maxPaymentBaseUnits: parseMaxPayment(process.env.BOT_MAX_PAYMENT_BASE_UNITS),
};

function parseNetwork(raw: string | undefined): "celo-sepolia" | "celo" {
  if (!raw || raw === "celo-sepolia") return "celo-sepolia";
  if (raw === "celo") return "celo";
  console.warn(`[config] Unknown NETWORK "${raw}" — falling back to celo-sepolia.`);
  return "celo-sepolia";
}

function parseMaxPayment(raw: string | undefined): bigint {
  const DEFAULT = 100_000n; // $0.10 USDC
  if (!raw) return DEFAULT;
  try {
    const v = BigInt(raw);
    if (v <= 0n) throw new Error("must be > 0");
    return v;
  } catch {
    console.warn(`[config] Invalid BOT_MAX_PAYMENT_BASE_UNITS "${raw}" — using ${DEFAULT}.`);
    return DEFAULT;
  }
}

/** Fails fast with a clear message when the bot cannot start. */
export function assertConfig(): void {
  if (!config.telegramBotToken) {
    console.error(
      [
        "FATAL: TELEGRAM_BOT_TOKEN is not set.",
        "",
        "The bot needs a Telegram token to start:",
        "  1. Create the bot with @BotFather on Telegram.",
        "  2. Paste the token into the root .env file (TELEGRAM_BOT_TOKEN=...).",
        "",
        "Create one with @BotFather on Telegram and set it in the root .env.",
      ].join("\n"),
    );
    process.exit(1);
  }
}
