/**
 * In-memory rate limiting per client IP. Good enough for a single-instance
 * hackathon deployment; swap for Redis if the backend ever scales out.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';

export interface RateLimitOptions {
  /** Max requests per window. Default 50. */
  limit?: number;
  /** Window size in ms. Default 60_000 (1 minute). */
  windowMs?: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/** Best-effort client IP: x-forwarded-for first, then the socket address. */
export function clientIp(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0]!.trim();
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    // No socket info (e.g. app.request() in tests).
    return 'unknown';
  }
}

export function rateLimit(options: RateLimitOptions = {}): MiddlewareHandler {
  const limit = options.limit ?? 50;
  const windowMs = options.windowMs ?? 60_000;
  const buckets = new Map<string, Bucket>();

  return async (c, next) => {
    const ip = clientIp(c);
    const now = Date.now();

    let bucket = buckets.get(ip);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(ip, bucket);
    }
    bucket.count += 1;

    if (bucket.count > limit) {
      return c.json(
        {
          error: 'rate_limited',
          message: `Max ${limit} requests per minute`,
          retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000),
        },
        429,
      );
    }

    await next();
  };
}
