/**
 * Exponential backoff with "full jitter" (AWS Architecture Blog): sleep = random(0, min(cap, base * 2^n)).
 * Full jitter de-synchronises retrying clients and avoids thundering herds after an outage.
 */
export interface RetryOptions {
  retries: number;
  baseMs?: number;
  maxMs?: number;
  isRetryable?: (err: unknown) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  /** Injected for deterministic tests. */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function backoffDelay(attempt: number, baseMs: number, maxMs: number, random = Math.random): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

export async function retry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const { retries, baseMs = 50, maxMs = 2_000, isRetryable = () => true, onRetry } = opts;
  const wait = opts.sleep ?? sleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      const delay = backoffDelay(attempt, baseMs, maxMs, opts.random);
      onRetry?.(err, attempt + 1, delay);
      await wait(delay);
    }
  }
}

/** Promise timeout for outbound calls; every network call must be bounded. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
