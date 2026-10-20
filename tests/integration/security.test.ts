import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

describe('authorization, compliance & hardening', () => {
  let t: TestCtx;
  beforeAll(async () => {
    t = await setupApp();
  });
  afterAll(() => t.close());

  it('denies by default: unauthenticated, wrong role, tampered token', async () => {
    const patient = await createUser(t.c, 'patient');
    expect((await t.app.inject({ url: '/v1/consultations' })).statusCode).toBe(401);
    expect((await t.app.inject({ url: '/v1/admin/audit-logs', headers: patient.auth })).statusCode).toBe(403);
    const tampered = patient.token.slice(0, -4) + 'AAAA';
    expect(
      (await t.app.inject({ url: '/v1/me', headers: { authorization: `Bearer ${tampered}` } })).statusCode,
    ).toBe(401);
  });

  it('prevents IDOR: another patient cannot read a consultation or its prescription (404 + audited)', async () => {
    const doctor = await createDoctor(t.c);
    const slot = await createSlot(t.c, doctor.id, 500);
    const owner = await createUser(t.c, 'patient');
    const intruder = await createUser(t.c, 'patient');
    const booked = (await book(t, owner.auth, slot.id)).json();
    const id = booked.consultation.id;

    const own = await t.app.inject({ url: `/v1/consultations/${id}`, headers: owner.auth });
    expect(own.statusCode).toBe(200);
    expect(own.headers['cache-control']).toBe('no-store');
    expect((await t.app.inject({ url: `/v1/consultations/${id}`, headers: intruder.auth })).statusCode).toBe(
      404,
    );
    expect(
      (await t.app.inject({ url: `/v1/consultations/${id}/prescription`, headers: intruder.auth }))
        .statusCode,
    ).toBe(404);

    const denied = await t.c.db.writer
      .selectFrom('audit_logs')
      .select(['actor_id', 'outcome'])
      .where('resource_id', '=', id)
      .where('outcome', '=', 'denied')
      .execute();
    expect(denied.some((d) => d.actor_id === intruder.id)).toBe(true);
  });

  it('only the treating doctor can conduct and prescribe; PHI is ciphertext in the database', async () => {
    const doctor = await createDoctor(t.c);
    const other = await createDoctor(t.c);
    const slot = await createSlot(t.c, doctor.id, 6); // starts soon so it can be started
    const patient = await createUser(t.c, 'patient');
    const booked = (await book(t, patient.auth, slot.id)).json();
    await payViaWebhook(t, booked.payment.id);
    const id = booked.consultation.id;
    const post = (who: { auth: Record<string, string> }, path: string, payload: object) =>
      t.app.inject({
        method: 'POST',
        url: `/v1/consultations/${id}${path}`,
        headers: { ...who.auth, 'idempotency-key': idemKey() },
        payload,
      });

    expect((await post(other, '/start', {})).statusCode).toBe(404);
    expect((await post(patient, '/start', {})).statusCode).toBe(403); // patients lack consultations:conduct
    expect((await post(doctor, '/start', {})).statusCode).toBe(200);

    const rx = {
      items: [{ medicine: 'Ashwagandha', dosage: '500 mg', frequency: 'twice daily', durationDays: 30 }],
      advice: 'Sleep by 10pm',
    };
    expect((await post(other, '/prescription', rx)).statusCode).toBe(404);
    const created = await post(doctor, '/prescription', rx);
    expect(created.statusCode).toBe(201);
    expect((await post(doctor, '/prescription', rx)).json().code).toBe('PRESCRIPTION_EXISTS');

    const raw = await t.c.db.writer
      .selectFrom('prescriptions')
      .select(['items_enc', 'advice_enc'])
      .where('consultation_id', '=', id)
      .executeTakeFirstOrThrow();
    expect(raw.items_enc).toMatch(/^enc:/);
    expect(raw.items_enc).not.toContain('Ashwagandha');
    const c = await t.c.db.writer
      .selectFrom('consultations')
      .select('reason_enc')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(c.reason_enc).not.toContain('Headache');

    // Async PDF job (worker) renders and stores the document.
    expect(await t.c.prescriptions.renderPdf(created.json().id)).toBe('rendered');
    const pdf = await t.app.inject({
      url: `/v1/consultations/${id}/prescription/pdf`,
      headers: patient.auth,
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('enforces the consultation state machine and optimistic locking', async () => {
    const doctor = await createDoctor(t.c);
    const slot = await createSlot(t.c, doctor.id, 7);
    const patient = await createUser(t.c, 'patient');
    const booked = (await book(t, patient.auth, slot.id)).json();
    const id = booked.consultation.id;
    const post = (path: string, payload: object) =>
      t.app.inject({
        method: 'POST',
        url: `/v1/consultations/${id}${path}`,
        headers: { ...doctor.auth, 'idempotency-key': idemKey() },
        payload,
      });

    const early = await post('/complete', { notes: 'x' }); // pending_payment -> completed is illegal
    expect(early.statusCode).toBe(409);
    expect(early.json().code).toBe('INVALID_STATE_TRANSITION');
    await payViaWebhook(t, booked.payment.id);
    expect((await post('/start', { expectedVersion: 0 })).json().code).toBe('VERSION_CONFLICT');
    const started = await post('/start', {});
    expect(started.json().status).toBe('in_progress');
  });

  it('keeps the audit trail append-only and detects tampering via the hash chain', async () => {
    await t.c.audit.record(
      { requestId: 'test', ip: null, userAgent: null, traceId: null, actor: null },
      { action: 'test.event', resourceType: 'test' },
    );
    await expect(sql`UPDATE audit_logs SET action = 'forged'`.execute(t.c.db.writer)).rejects.toThrow(
      /append-only/,
    );
    await expect(sql`DELETE FROM audit_logs`.execute(t.c.db.writer)).rejects.toThrow(/append-only/);
    expect((await t.c.audit.verifyChain()).valid).toBe(true);

    // Simulate a privileged attacker bypassing the trigger and editing history.
    const victim = await t.c.db.writer
      .selectFrom('audit_logs')
      .select('chain_seq')
      .orderBy('chain_seq')
      .limit(1)
      .offset(1)
      .executeTakeFirstOrThrow();
    await sql`ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_update`.execute(t.c.db.writer);
    try {
      await sql`UPDATE audit_logs SET outcome = 'failure' WHERE chain_seq = ${victim.chain_seq}`.execute(
        t.c.db.writer,
      );
    } finally {
      await sql`ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_no_update`.execute(t.c.db.writer);
    }
    const result = await t.c.audit.verifyChain();
    expect(result).toMatchObject({
      valid: false,
      firstInvalidSeq: victim.chain_seq,
      reason: 'hash_mismatch',
    });
    // Restore so later checks in this database stay meaningful.
    await sql`ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_update`.execute(t.c.db.writer);
    await sql`UPDATE audit_logs SET outcome = 'success' WHERE chain_seq = ${victim.chain_seq}`.execute(
      t.c.db.writer,
    );
    await sql`ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_no_update`.execute(t.c.db.writer);
  });

  it('returns RFC 7807 errors without leaking internals and sets security headers', async () => {
    const res = await t.app.inject({ url: '/v1/doctors/not-a-uuid' });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', requestId: expect.any(String) });
    expect(res.body).not.toMatch(/stack|node_modules|SELECT/i);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toContain('max-age=');
    expect(res.headers['x-request-id']).toBeDefined();
  });
});

describe('rate limiting', () => {
  let t: TestCtx;
  beforeAll(async () => {
    t = await setupApp({ env: { AUTH_RATE_LIMIT_MAX: '3' } });
  });
  afterAll(() => t.close());

  it('throttles brute-force attempts on auth endpoints with 429', async () => {
    const attempt = () =>
      t.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'x@test.local', password: 'whatever-password' },
      });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await attempt()).statusCode);
    expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
    expect(codes.slice(3)).toEqual([429, 429]);
  });
});
