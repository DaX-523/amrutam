import CircuitBreaker from 'opossum';
import { hmacSha256Hex, safeEqual, sha256Hex } from '../../infra/crypto.js';
import type { Logger } from '../../infra/logger.js';
import type { Metrics } from '../../infra/metrics.js';
import { retry, sleep, withTimeout } from '../../lib/retry.js';

/**
 * Payment provider port. Real adapters (Razorpay/Stripe) would implement this; the
 * assessment ships a deterministic mock so everything runs locally at zero cost.
 */
export interface PaymentGateway {
  readonly name: string;
  createOrder(input: {
    amountPaise: number;
    currency: string;
    receipt: string;
    idempotencyKey: string;
  }): Promise<{ orderId: string }>;
  refund(input: {
    orderId: string;
    amountPaise: number;
    idempotencyKey: string;
  }): Promise<{ refundId: string }>;
}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

/** Provider-side idempotency: the same key always maps to the same order/refund id. */
export class MockPaymentGateway implements PaymentGateway {
  readonly name = 'mockpay';

  constructor(private readonly opts: { failureRate: number; latencyMs: number }) {}

  private async simulate(): Promise<void> {
    if (this.opts.latencyMs) await sleep(this.opts.latencyMs);
    if (Math.random() < this.opts.failureRate) throw new GatewayError('mockpay: upstream 503', true);
  }

  async createOrder(input: { idempotencyKey: string }) {
    await this.simulate();
    return { orderId: `order_${sha256Hex(`order:${input.idempotencyKey}`).slice(0, 20)}` };
  }

  async refund(input: { idempotencyKey: string }) {
    await this.simulate();
    return { refundId: `rfnd_${sha256Hex(`refund:${input.idempotencyKey}`).slice(0, 20)}` };
  }
}

/**
 * Resilience decorator: per-attempt timeout -> retry with jittered exponential backoff
 * (only for retryable errors) -> circuit breaker that fails fast while the provider is down,
 * protecting our latency SLO and the provider during recovery.
 */
export class ResilientPaymentGateway implements PaymentGateway {
  readonly name: string;
  private readonly breaker: CircuitBreaker<[() => Promise<unknown>], unknown>;

  constructor(
    private readonly inner: PaymentGateway,
    private readonly deps: { logger: Logger; metrics: Metrics },
    private readonly opts = { timeoutMs: 2_000, retries: 2 },
  ) {
    this.name = inner.name;
    this.breaker = new CircuitBreaker((op: () => Promise<unknown>) => op(), {
      timeout: false, // handled per attempt below
      errorThresholdPercentage: 50,
      volumeThreshold: 10,
      rollingCountTimeout: 30_000,
      resetTimeout: 15_000,
    });
    const gauge = deps.metrics.circuitState.labels({ name: `payment:${inner.name}` });
    gauge.set(0);
    this.breaker.on('open', () => {
      gauge.set(1);
      deps.logger.error({ gateway: inner.name }, 'payment gateway circuit OPEN');
    });
    this.breaker.on('halfOpen', () =>
      deps.logger.warn({ gateway: inner.name }, 'payment gateway circuit half-open'),
    );
    this.breaker.on('close', () => {
      gauge.set(0);
      deps.logger.info({ gateway: inner.name }, 'payment gateway circuit closed');
    });
  }

  private call<T>(label: string, op: () => Promise<T>): Promise<T> {
    return this.breaker.fire(() =>
      retry(() => withTimeout(op(), this.opts.timeoutMs, label), {
        retries: this.opts.retries,
        baseMs: 100,
        maxMs: 1_000,
        isRetryable: (err) => !(err instanceof GatewayError) || err.retryable,
        onRetry: (err, attempt, delay) =>
          this.deps.logger.warn({ err, attempt, delay, label }, 'retrying gateway call'),
      }),
    ) as Promise<T>;
  }

  createOrder(input: Parameters<PaymentGateway['createOrder']>[0]) {
    return this.call('createOrder', () => this.inner.createOrder(input));
  }

  refund(input: Parameters<PaymentGateway['refund']>[0]) {
    return this.call('refund', () => this.inner.refund(input));
  }
}

// ───────────────────────── webhook signatures ─────────────────────────

export const WEBHOOK_SIGNATURE_HEADER = 'x-mockpay-signature';
const WEBHOOK_TOLERANCE_SEC = 300;

/** Stripe-style `t=<unix>,v1=<hmac(t.body)>`: authenticity + replay window. */
export function signWebhook(
  secret: string,
  rawBody: string,
  timestamp = Math.floor(Date.now() / 1000),
): string {
  return `t=${timestamp},v1=${hmacSha256Hex(secret, `${timestamp}.${rawBody}`)}`;
}

export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  header: string | undefined,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=', 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1 || Math.abs(nowSec - t) > WEBHOOK_TOLERANCE_SEC) return false;
  return safeEqual(hmacSha256Hex(secret, `${t}.${rawBody}`), parts.v1);
}
