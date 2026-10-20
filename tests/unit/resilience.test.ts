import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { backoffDelay, retry } from '../../src/lib/retry.js';
import { Metrics } from '../../src/infra/metrics.js';
import {
  GatewayError,
  ResilientPaymentGateway,
  signWebhook,
  verifyWebhookSignature,
  type PaymentGateway,
} from '../../src/modules/payments/gateway.js';

describe('retry with full-jitter exponential backoff', () => {
  it('caps delays and spreads them across [0, min(cap, base*2^n))', () => {
    expect(backoffDelay(0, 100, 1000, () => 0.999)).toBe(99);
    expect(backoffDelay(3, 100, 1000, () => 0.999)).toBe(799);
    expect(backoffDelay(10, 100, 1000, () => 0.999)).toBe(999);
    expect(backoffDelay(5, 100, 1000, () => 0)).toBe(0);
  });

  it('retries retryable errors and gives up on non-retryable ones', async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls++;
          if (calls < 3) throw new Error('transient');
          return 'ok';
        },
        { retries: 5, sleep },
      ),
    ).resolves.toBe('ok');
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);

    let fatal = 0;
    await expect(
      retry(
        async () => {
          fatal++;
          throw new Error('fatal');
        },
        { retries: 5, sleep, isRetryable: () => false },
      ),
    ).rejects.toThrow('fatal');
    expect(fatal).toBe(1);
  });
});

describe('payment gateway resilience', () => {
  const deps = { logger: pino({ level: 'silent' }), metrics: new Metrics('test') };

  it('retries transient provider errors but not declines', async () => {
    let n = 0;
    const flaky: PaymentGateway = {
      name: 'flaky',
      createOrder: async () => {
        if (++n < 3) throw new GatewayError('503', true);
        return { orderId: 'order_1' };
      },
      refund: async () => {
        throw new GatewayError('declined', false);
      },
    };
    const gw = new ResilientPaymentGateway(flaky, deps, { timeoutMs: 1000, retries: 3 });
    await expect(
      gw.createOrder({ amountPaise: 1, currency: 'INR', receipt: 'r', idempotencyKey: 'k' }),
    ).resolves.toEqual({ orderId: 'order_1' });
    expect(n).toBe(3);
    await expect(gw.refund({ orderId: 'o', amountPaise: 1, idempotencyKey: 'k' })).rejects.toThrow(
      'declined',
    );
  });

  it('times out hung calls', async () => {
    const hung: PaymentGateway = {
      name: 'hung',
      createOrder: () => new Promise(() => {}),
      refund: () => new Promise(() => {}),
    };
    const gw = new ResilientPaymentGateway(hung, deps, { timeoutMs: 20, retries: 0 });
    await expect(
      gw.createOrder({ amountPaise: 1, currency: 'INR', receipt: 'r', idempotencyKey: 'k' }),
    ).rejects.toThrow(/timed out/);
  });
});

describe('webhook signatures', () => {
  const secret = 'x'.repeat(40);
  it('accepts a valid signature and rejects tampering, wrong secret and replays', () => {
    const now = 1_800_000_000;
    const body = '{"id":"evt_1"}';
    const sig = signWebhook(secret, body, now);
    expect(verifyWebhookSignature(secret, body, sig, now)).toBe(true);
    expect(verifyWebhookSignature(secret, body + ' ', sig, now)).toBe(false);
    expect(verifyWebhookSignature('y'.repeat(40), body, sig, now)).toBe(false);
    expect(verifyWebhookSignature(secret, body, sig, now + 301)).toBe(false);
    expect(verifyWebhookSignature(secret, body, undefined, now)).toBe(false);
  });
});
