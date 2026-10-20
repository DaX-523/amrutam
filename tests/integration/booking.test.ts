import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expireHolds } from '../../src/jobs/hold-expiry.js';
import { relayOutbox } from '../../src/jobs/outbox-relay.js';
import { GatewayError, type PaymentGateway } from '../../src/modules/payments/gateway.js';
import {
  book,
  createDoctor,
  createSlot,
  createUser,
  idemKey,
  payViaWebhook,
  setupApp,
  type TestCtx,
} from './helpers.js';

describe('booking saga', () => {
  let t: TestCtx;
  beforeAll(async () => {
    t = await setupApp();
  });
  afterAll(() => t.close());

  it('lets exactly one of 50 concurrent patients book the same slot', async () => {
    const doctor = await createDoctor(t.c);
    const slot = await createSlot(t.c, doctor.id, 180);
    const patients = await Promise.all(Array.from({ length: 50 }, () => createUser(t.c, 'patient')));

    const responses = await Promise.all(patients.map((p) => book(t, p.auth, slot.id)));
    const statuses = responses.map((r) => r.statusCode);

    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(49);
    for (const r of responses.filter((x) => x.statusCode === 409))
      expect(r.json().code).toBe('SLOT_UNAVAILABLE');

    const live = await sql<{
      n: string;
    }>`SELECT count(*) AS n FROM consultations WHERE slot_id = ${slot.id} AND status <> 'cancelled'`.execute(
      t.c.db.writer,
    );
    expect(Number(live.rows[0]!.n)).toBe(1);
    const s = await t.c.db.writer
      .selectFrom('availability_slots')
      .selectAll()
      .where('id', '=', slot.id)
      .executeTakeFirstOrThrow();
    expect(s.status).toBe('held');
  });

  it('replays the original response for a retried Idempotency-Key and never double-books', async () => {
    const doctor = await createDoctor(t.c);
    const slot = await createSlot(t.c, doctor.id, 200);
    const patient = await createUser(t.c, 'patient');
    const key = idemKey();

    const first = await book(t, patient.auth, slot.id, key);
    const retry = await book(t, patient.auth, slot.id, key);

    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.json()).toEqual(first.json());
    const n = await sql<{
      n: string;
    }>`SELECT count(*) AS n FROM consultations WHERE patient_id = ${patient.id}`.execute(t.c.db.writer);
    expect(Number(n.rows[0]!.n)).toBe(1);
  });

  it('rejects reuse of a key with a different payload (422) and requires a key (400)', async () => {
    const doctor = await createDoctor(t.c);
    const [s1, s2] = [await createSlot(t.c, doctor.id, 220), await createSlot(t.c, doctor.id, 240)];
    const patient = await createUser(t.c, 'patient');
    const key = idemKey();
    expect((await book(t, patient.auth, s1.id, key)).statusCode).toBe(201);
    const reused = await book(t, patient.auth, s2.id, key);
    expect(reused.statusCode).toBe(422);
    expect(reused.json().code).toBe('IDEMPOTENCY_KEY_REUSED');

    const missing = await t.app.inject({
      method: 'POST',
      url: '/v1/bookings',
      headers: patient.auth,
      payload: { slotId: s2.id },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('serialises concurrent requests carrying the same key: one executes, the other gets 409 or the replay', async () => {
    const doctor = await createDoctor(t.c);
    const slot = await createSlot(t.c, doctor.id, 260);
    const patient = await createUser(t.c, 'patient');
    const key = idemKey();
    const [a, b] = await Promise.all([
      book(t, patient.auth, slot.id, key),
      book(t, patient.auth, slot.id, key),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes[0]).toBe(201);
    expect([201, 409]).toContain(codes[1]);
    if (codes[1] === 409)
      expect([a, b].find((r) => r.statusCode === 409)!.json().code).toBe('IDEMPOTENCY_REQUEST_IN_PROGRESS');
  });

  it('confirms the booking on a signed webhook and ignores duplicate deliveries', async () => {
    const doctor = await createDoctor(t.c);
    const slot = await createSlot(t.c, doctor.id, 280);
    const patient = await createUser(t.c, 'patient');
    const booked = (await book(t, patient.auth, slot.id)).json();

    const p = await t.c.db.writer
      .selectFrom('payments')
      .selectAll()
      .where('id', '=', booked.payment.id)
      .executeTakeFirstOrThrow();
    const { body, signature } = t.c.payments.buildMockWebhook(
      p.provider_order_id!,
      p.amount_paise,
      'success',
    );
    const send = () =>
      t.app.inject({
        method: 'POST',
        url: '/v1/payments/webhook',
        headers: { 'content-type': 'application/json', 'x-mockpay-signature': signature },
        payload: body,
      });

    expect((await send()).json()).toEqual({ outcome: 'confirmed' });
    expect((await send()).json()).toEqual({ outcome: 'duplicate' });

    const c = await t.c.db.writer
      .selectFrom('consultations')
      .selectAll()
      .where('id', '=', booked.consultation.id)
      .executeTakeFirstOrThrow();
    const s = await t.c.db.writer
      .selectFrom('availability_slots')
      .selectAll()
      .where('id', '=', slot.id)
      .executeTakeFirstOrThrow();
    expect(c.status).toBe('confirmed');
    expect(s.status).toBe('booked');
    expect(s.hold_expires_at).toBeNull();

    // Outbox -> queue fan-out happened transactionally with the confirmation.
    const ev = await t.c.db.writer
      .selectFrom('outbox_events')
      .select('event_type')
      .where('aggregate_id', '=', c.id)
      .execute();
    expect(ev.map((e) => e.event_type)).toEqual(
      expect.arrayContaining(['booking.held', 'booking.confirmed']),
    );
    expect(await relayOutbox(t.c)).toBeGreaterThan(0);
  });

  it('rejects forged or stale webhook signatures', async () => {
    const body = JSON.stringify({
      id: 'evt_x',
      type: 'payment.captured',
      data: { orderId: 'order_x', amountPaise: 100 },
    });
    const forged = await t.app.inject({
      method: 'POST',
      url: '/v1/payments/webhook',
      headers: { 'content-type': 'application/json', 'x-mockpay-signature': 't=1,v1=deadbeef' },
      payload: body,
    });
    expect(forged.statusCode).toBe(401);
    expect(forged.json().code).toBe('INVALID_SIGNATURE');
  });

  it('cancels the consultation and frees the slot when the payment fails', async () => {
    const doctor = await createDoctor(t.c);
    const slot = await createSlot(t.c, doctor.id, 300);
    const patient = await createUser(t.c, 'patient');
    const booked = (await book(t, patient.auth, slot.id)).json();
    expect((await payViaWebhook(t, booked.payment.id, 'failure')).json()).toEqual({ outcome: 'failed' });

    const s = await t.c.db.writer
      .selectFrom('availability_slots')
      .select('status')
      .where('id', '=', slot.id)
      .executeTakeFirstOrThrow();
    const c = await t.c.db.writer
      .selectFrom('consultations')
      .select(['status', 'cancel_reason'])
      .where('id', '=', booked.consultation.id)
      .executeTakeFirstOrThrow();
    expect(s.status).toBe('available');
    expect(c).toEqual({ status: 'cancelled', cancel_reason: 'payment_failed' });
  });

  it('expires unpaid holds (saga timeout) and refunds a capture that arrives too late', async () => {
    const doctor = await createDoctor(t.c);
    const slot = await createSlot(t.c, doctor.id, 320);
    const patient = await createUser(t.c, 'patient');
    const booked = (await book(t, patient.auth, slot.id)).json();

    await t.c.db.writer
      .updateTable('availability_slots')
      .set({ hold_expires_at: new Date(Date.now() - 1000) })
      .where('id', '=', slot.id)
      .execute();
    expect(await expireHolds(t.c)).toBeGreaterThanOrEqual(1);

    const s = await t.c.db.writer
      .selectFrom('availability_slots')
      .select('status')
      .where('id', '=', slot.id)
      .executeTakeFirstOrThrow();
    const c = await t.c.db.writer
      .selectFrom('consultations')
      .select(['status', 'cancel_reason'])
      .where('id', '=', booked.consultation.id)
      .executeTakeFirstOrThrow();
    const p = await t.c.db.writer
      .selectFrom('payments')
      .select('status')
      .where('id', '=', booked.payment.id)
      .executeTakeFirstOrThrow();
    expect(s.status).toBe('available');
    expect(c).toEqual({ status: 'cancelled', cancel_reason: 'payment_timeout' });
    expect(p.status).toBe('expired');

    // The provider still captures afterwards: we must not keep the money.
    expect((await payViaWebhook(t, booked.payment.id, 'success')).json()).toEqual({
      outcome: 'late_capture_refund',
    });
    expect(await t.c.payments.processRefund(booked.payment.id)).toBe('refunded');
    const after = await t.c.db.writer
      .selectFrom('payments')
      .select(['status', 'provider_refund_id'])
      .where('id', '=', booked.payment.id)
      .executeTakeFirstOrThrow();
    expect(after.status).toBe('refunded');
    expect(after.provider_refund_id).toMatch(/^rfnd_/);
  });

  it('caps the number of simultaneous unpaid holds per patient (anti-hoarding)', async () => {
    const doctor = await createDoctor(t.c);
    const patient = await createUser(t.c, 'patient');
    const slots = await Promise.all([340, 360, 380, 400].map((m) => createSlot(t.c, doctor.id, m)));
    const results = [];
    for (const s of slots) results.push((await book(t, patient.auth, s.id)).statusCode);
    expect(results).toEqual([201, 201, 201, 409]);
  });

  it('does not allow booking an unverified doctor', async () => {
    const doctor = await createDoctor(t.c, { verified: false });
    const slot = await createSlot(t.c, doctor.id, 420);
    const patient = await createUser(t.c, 'patient');
    expect((await book(t, patient.auth, slot.id)).statusCode).toBe(404);
  });
});

describe('booking saga compensation when the payment provider is down', () => {
  let t: TestCtx;
  const down: PaymentGateway = {
    name: 'mockpay',
    createOrder: async () => {
      throw new GatewayError('provider down', true);
    },
    refund: async () => {
      throw new GatewayError('provider down', true);
    },
  };
  beforeAll(async () => {
    t = await setupApp({ overrides: { gateway: down } });
  });
  afterAll(() => t.close());

  it('returns 503, releases the slot and lets the client retry the same key', async () => {
    const doctor = await createDoctor(t.c);
    const slot = await createSlot(t.c, doctor.id, 440);
    const patient = await createUser(t.c, 'patient');
    const key = idemKey();
    const res = await book(t, patient.auth, slot.id, key);
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('PAYMENT_GATEWAY_UNAVAILABLE');
    expect(res.headers['retry-after']).toBeDefined();

    const s = await t.c.db.writer
      .selectFrom('availability_slots')
      .select('status')
      .where('id', '=', slot.id)
      .executeTakeFirstOrThrow();
    expect(s.status).toBe('available');
    // 5xx released the idempotency key, so a retry is executed again (not replayed).
    const again = await book(t, patient.auth, slot.id, key);
    expect(again.headers['idempotent-replayed']).toBeUndefined();
  });
});
