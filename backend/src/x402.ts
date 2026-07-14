/**
 * x402 payment middleware - STUB.
 *
 * TODO(ARQUI): plug the real x402 facilitator here. The middleware factory
 * takes an optional X402Facilitator; when the real spec lands, implement it
 * and pass it from index.ts. Routes never need to change.
 */
import type { MiddlewareHandler } from 'hono';

/** Contract for the real payment verifier. TODO(ARQUI): define final shape. */
export interface X402Facilitator {
  /** Verifies the payment header of an incoming request. */
  verifyPayment(paymentHeader: string | undefined): Promise<{ ok: boolean; txHash: string | null }>;
}

/**
 * When disabled (X402_ENABLED=false, the default): passthrough for local dev.
 * When enabled: always replies 402 with a placeholder body until ARQUI ships
 * the real facilitator.
 */
export function x402(enabled: boolean, _facilitator?: X402Facilitator): MiddlewareHandler {
  if (!enabled) {
    console.log('x402 disabled - dev mode');
    return async (_c, next) => {
      await next();
    };
  }

  // TODO(ARQUI): verify payment via facilitator, attach txHash to context,
  // and fall through to the route on success.
  return async (c) =>
    c.json(
      {
        error: 'payment_required',
        note: 'pending ARQUI spec',
      },
      402,
    );
}
