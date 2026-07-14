/**
 * x402-aware fetch for the RemesaFlow API.
 *
 * Real x402 v2 client (same package family as the backend's @x402/hono):
 *   - @x402/fetch  -> wrapFetchWithPaymentFromConfig (402 -> sign -> retry)
 *   - @x402/evm    -> ExactEvmScheme (EIP-3009 transferWithAuthorization,
 *                     signed locally with viem, no RPC needed to sign)
 *
 * Flow: fetch -> 402 -> parse PaymentRequired -> sign USDC authorization
 * with BOT_PRIVATE_KEY -> retry with PAYMENT-SIGNATURE header -> response.
 *
 * Degraded mode: without BOT_PRIVATE_KEY this is a plain fetch (dev, backend
 * with X402_ENABLED=false). A 402 then surfaces as PaymentRequiredError with
 * reason "wallet-not-configured".
 */
import { wrapFetchWithPaymentFromConfig, type PaymentPolicy } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "./config";

// CAIP-2 ids per ARQUITECTURA.md section 0 (Alfajores is dead; testnet = Celo Sepolia).
const NETWORKS = {
  "celo-sepolia": "eip155:11142220",
  celo: "eip155:42220",
} as const;

export type NetworkName = keyof typeof NETWORKS;

/** Whole quote call (initial request + signing + paid retry) must fit in this. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Marker thrown by the cap policy so we can classify it after the wrapper re-wraps it. */
const OVER_CAP_MARKER = "X402_AMOUNT_OVER_CAP";

export type PaymentFailureReason =
  /** Backend demands payment but the bot has no BOT_PRIVATE_KEY configured. */
  | "wallet-not-configured"
  /** Server asked for more than our safety cap (BOT_MAX_PAYMENT_BASE_UNITS). */
  | "amount-over-cap"
  /** Bot wallet cannot cover the payment. */
  | "insufficient-funds"
  /** Payment was built/sent but the server/facilitator did not accept it. */
  | "payment-rejected";

const USER_MESSAGES: Record<PaymentFailureReason, string> = {
  "wallet-not-configured":
    "🔒 El servicio requiere pago x402 y este bot no tiene wallet configurada. " +
    "Avisale al admin (falta BOT_PRIVATE_KEY).",
  "amount-over-cap":
    "🚫 El servicio pidió un pago mayor al límite de seguridad del bot. " +
    "No pagué nada — avisale al admin.",
  "insufficient-funds":
    "😬 La wallet del bot se quedó sin fondos para pagar la consulta ($0.01 USDC). " +
    "Avisale al admin que la recargue.",
  "payment-rejected":
    "🚫 El pago x402 fue rechazado por el servicio. Probá de nuevo en unos minutos.",
};

/** Thrown when the request failed for payment reasons (API itself is up). */
export class PaymentRequiredError extends Error {
  readonly reason: PaymentFailureReason;
  /** Ready-to-send Spanish copy for the Telegram user. */
  readonly userMessage: string;

  constructor(url: string, reason: PaymentFailureReason, detail?: string) {
    super(`x402 payment failed (${reason}) for ${url}${detail ? ` — ${detail}` : ""}`);
    this.name = "PaymentRequiredError";
    this.reason = reason;
    this.userMessage = USER_MESSAGES[reason];
  }
}

export interface PayAndFetchOptions {
  /** 0x-prefixed private key. Empty/undefined -> degraded plain-fetch mode. */
  privateKey?: string;
  network?: NetworkName;
  /** Refuse to pay more than this (base units of the asset, e.g. USDC 6 dec). */
  maxPaymentBaseUnits?: bigint;
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export type PayAndFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Builds a payAndFetch. Exported for tests; app code uses the default export below. */
export function createPayAndFetch(opts: PayAndFetchOptions): PayAndFetch {
  const fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const network = opts.network ?? "celo-sepolia";
  const maxPay = opts.maxPaymentBaseUnits ?? 100_000n; // $0.10 in USDC base units

  const withTimeout = (init?: RequestInit): RequestInit => ({
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
  });

  // --- Degraded mode: no wallet -------------------------------------------
  if (!opts.privateKey) {
    console.warn(
      "[payment] BOT_PRIVATE_KEY not set — x402 signing disabled. " +
        "Quotes only work against a backend with X402_ENABLED=false.",
    );
    return async (url, init) => {
      const res = await fetchImpl(url, withTimeout(init));
      if (res.status === 402) {
        throw new PaymentRequiredError(url, "wallet-not-configured");
      }
      return res;
    };
  }

  // --- Real mode: viem account + x402 client -------------------------------
  let account;
  try {
    account = privateKeyToAccount(opts.privateKey as `0x${string}`);
  } catch (err) {
    throw new Error(
      `BOT_PRIVATE_KEY is set but invalid (expected 0x + 64 hex chars): ${
        err instanceof Error ? err.message : err
      }`,
    );
  }

  // Safety cap: never sign an authorization above maxPay, no matter what the
  // server's 402 asks for.
  const capPolicy: PaymentPolicy = (_version, requirements) => {
    const affordable = requirements.filter((r) => {
      try {
        return BigInt(r.amount) <= maxPay;
      } catch {
        return false; // malformed amount -> never pay it
      }
    });
    if (requirements.length > 0 && affordable.length === 0) {
      throw new Error(
        `${OVER_CAP_MARKER}: server asked for ${requirements[0].amount} base units, cap is ${maxPay}`,
      );
    }
    return affordable;
  };

  const paidFetch = wrapFetchWithPaymentFromConfig(fetchImpl, {
    // Only the configured network: the bot must never pay on a chain we did
    // not expect, even if the server offers it.
    schemes: [{ network: NETWORKS[network], client: new ExactEvmScheme(account) }],
    policies: [capPolicy],
  });

  console.log(`[payment] x402 signing enabled — wallet ${account.address} on ${network}`);

  return async (url, init) => {
    let res: Response;
    try {
      res = await paidFetch(url, withTimeout(init));
    } catch (err) {
      throw classifyPaymentError(url, err);
    }
    if (res.status === 402) {
      // We paid (or tried to) and the server still says 402: rejected payment
      // (facilitator verify failed, wallet without funds, expired auth, ...).
      const detail = await res.text().then((t) => t.slice(0, 300)).catch(() => "");
      const reason: PaymentFailureReason = /insufficient|balance|funds/i.test(detail)
        ? "insufficient-funds"
        : "payment-rejected";
      throw new PaymentRequiredError(url, reason, detail);
    }
    return res;
  };
}

/**
 * Maps wrapper/signing failures to PaymentRequiredError; network-level errors
 * (timeout, connection refused) are re-thrown untouched so bot.ts keeps
 * showing its "API down" message for them.
 */
function classifyPaymentError(url: string, err: unknown): Error {
  if (!(err instanceof Error)) return new Error(String(err));

  // AbortError (timeout) / undici TypeError (network) -> not a payment problem.
  if (err.name === "AbortError" || err.name === "TimeoutError" || err.name === "TypeError") {
    return err;
  }
  const msg = err.message;
  if (msg.includes(OVER_CAP_MARKER)) {
    return new PaymentRequiredError(url, "amount-over-cap", msg);
  }
  if (/insufficient|balance|funds/i.test(msg)) {
    return new PaymentRequiredError(url, "insufficient-funds", msg);
  }
  if (/payment|scheme|requirements|402/i.test(msg)) {
    return new PaymentRequiredError(url, "payment-rejected", msg);
  }
  return err;
}

/**
 * Fetches a protected API endpoint, paying via x402 when required.
 * Drop-in replacement for fetch() from the bot's point of view.
 */
export const payAndFetch: PayAndFetch = createPayAndFetch({
  privateKey: config.botPrivateKey || undefined,
  network: config.network,
  maxPaymentBaseUnits: config.maxPaymentBaseUnits,
});
