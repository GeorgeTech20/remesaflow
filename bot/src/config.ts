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
   * Wallet key used to sign x402 payments.
   * TODO(ARQUI): consumed by src/payment.ts once the backend enforces
   * HTTP 402 in prod. Optional for now (dev serves quotes for free).
   */
  botPrivateKey: process.env.BOT_PRIVATE_KEY ?? "",
};

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
        "See ACCION_HUMANA_REQUERIDA.md (item 3) at the repo root.",
      ].join("\n"),
    );
    process.exit(1);
  }
}
