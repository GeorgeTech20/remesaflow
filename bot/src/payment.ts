/**
 * x402-aware fetch for the RemesaFlow API.
 *
 * Today (v1 / dev): the backend serves /api/quote directly with
 * X402_ENABLED=false, so this is a plain fetch.
 *
 * TODO(ARQUI): when the backend starts answering 402 Payment Required
 * in prod, this module must:
 *   1. Parse the x402 payment requirements from the 402 response body/headers.
 *   2. Build and sign the payment payload with BOT_PRIVATE_KEY
 *      (see config.botPrivateKey) against Celo.
 *   3. Retry the request with the X-PAYMENT header attached.
 * The public interface (payAndFetch) must NOT change, so bot.ts stays intact.
 */

/** Thrown when the API demands payment and x402 signing is not wired up yet. */
export class PaymentRequiredError extends Error {
  constructor(url: string) {
    super(
      `402 Payment Required for ${url} — x402 signing not implemented yet (TODO ARQUI)`,
    );
    this.name = "PaymentRequiredError";
  }
}

/**
 * Fetches a protected API endpoint, paying via x402 when required.
 * Drop-in replacement for fetch() from the bot's point of view.
 */
export async function payAndFetch(url: string): Promise<Response> {
  const res = await fetch(url);

  if (res.status === 402) {
    // TODO(ARQUI): sign the x402 payment with BOT_PRIVATE_KEY and retry
    // the request with the X-PAYMENT header instead of throwing.
    throw new PaymentRequiredError(url);
  }

  return res;
}
