import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { relayOutbox } from '../../src/jobs/outbox-relay.js';
import { rollupAnalytics } from '../../src/jobs/maintenance.js';
import { sendNotification } from '../../src/jobs/notifications.js';
import {
  book,
  createDoctor,
  createSlot,
  createUser,
  idemKey,
  payViaWebhook,
  setupApp,
  uniq,
  type TestCtx,
} from './helpers.js';

describe('doctor discovery', () => {
  let t: TestCtx;
  const tag = `spec-${uniq()}`;
  beforeAll(async () => {
    t = await setupApp();
    for (const [i, fee] of [30_000, 45_000, 60_000, 75_000, 90_000].entries()) {
      const d = await createDoctor(t.c, {
        specialties: [tag],
        feePaise: fee,
        rating: 3 + i * 0.4,
        city: i % 2 ? 'Pune' : 'Mumbai',
        name: `Dr. Search ${i} ${tag}`,
      });
      if (i === 0) await createSlot(t.c, d.id, 24 * 60);
    }
    await createDoctor(t.c, { specialties: [tag], verified: false, name: `Dr. Hidden ${tag}` });
  });
  afterAll(() => t.close());

  const search = (qs: string) =>
    t.app.inject({ url: `/v1/doctors?specialty=${tag}&${qs}` }).then((r) => r.json());

  it('filters by specialty, fee range and city, and hides unverified doctors', async () => {
    const all = await search('limit=50');
    expect(all.items).toHaveLength(5);
    expect(all.items.every((d: { verified: boolean }) => d.verified)).toBe(true);
    expect((await search('minFee=40000&maxFee=80000')).items).toHaveLength(3);
    expect((await search('city=pune')).items).toHaveLength(2);
  });

  it('paginates with stable keyset cursors in sort order', async () => {
    const page1 = await search('sort=fee&limit=2');
    const page2 = await search(`sort=fee&limit=2&cursor=${page1.nextCursor}`);
    const page3 = await search(`sort=fee&limit=2&cursor=${page2.nextCursor}`);
    const fees = [...page1.items, ...page2.items, ...page3.items].map(
      (d: { feePaise: number }) => d.feePaise,
    );
    expect(fees).toEqual([30_000, 45_000, 60_000, 75_000, 90_000]);
    expect(page3.nextCursor).toBeNull();
    expect((await t.app.inject({ url: `/v1/doctors?cursor=garbage` })).statusCode).toBe(400);
  });

  it('supports free-text search and availability-date filtering', async () => {
    const byName = await t.app
      .inject({ url: `/v1/doctors?q=${encodeURIComponent(`Search 3 ${tag}`)}&limit=5` })
      .then((r) => r.json());
    expect(byName.items[0].displayName).toContain('Search 3');
    const tomorrow = new Date(Date.now() + 24 * 3600_000).toLocaleDateString('en-CA', {
      timeZone: 'Asia/Kolkata',
    });
    const available = await search(`availableOn=${tomorrow}`);
    expect(available.items).toHaveLength(1);
    expect(available.items[0].nextAvailableAt).not.toBeNull();
  });
});

describe('admin: verification, analytics, notifications', () => {
  let t: TestCtx;
  beforeAll(async () => {
    t = await setupApp();
  });
  afterAll(() => t.close());

  it('verifies a pending doctor (admin with MFA only)', async () => {
    const pending = await createDoctor(t.c, { verified: false });
    const adminNoMfa = await createUser(t.c, 'admin', { amr: ['pwd'] });
    const admin = await createUser(t.c, 'admin');
    const verify = (auth: Record<string, string>) =>
      t.app.inject({
        method: 'POST',
        url: `/v1/admin/doctors/${pending.id}/verify`,
        headers: { ...auth, 'idempotency-key': idemKey() },
      });
    expect((await verify(adminNoMfa.auth)).json().code).toBe('MFA_REQUIRED');
    expect((await verify(admin.auth)).json()).toEqual({ id: pending.id, verified: true });
    expect((await verify(admin.auth)).statusCode).toBe(409);
  });

  it('rolls up daily KPIs and serves them to admins; sends PHI-free notifications', async () => {
    const doctor = await createDoctor(t.c, { specialties: ['panchakarma'] });
    const slot = await createSlot(t.c, doctor.id, 30);
    const patient = await createUser(t.c, 'patient');
    const booked = (await book(t, patient.auth, slot.id)).json();
    await payViaWebhook(t, booked.payment.id);

    const day = new Date(slot.starts_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    await rollupAnalytics(t.c, day, day);
    const admin = await createUser(t.c, 'admin');
    const overview = (
      await t.app.inject({ url: `/v1/admin/analytics/overview?from=${day}&to=${day}`, headers: admin.auth })
    ).json();
    expect(overview.totals.consultations).toBeGreaterThanOrEqual(1);
    expect(overview.totals.revenuePaise).toBeGreaterThanOrEqual(50_000);
    expect(overview.topSpecialties.map((s: { specialty: string }) => s.specialty)).toContain('panchakarma');

    await relayOutbox(t.c);
    await sendNotification(t.c, { type: 'booking.confirmed', consultationId: booked.consultation.id });
    const mail = t.mailer.sent.find((m) => m.subject === 'Your consultation is confirmed');
    expect(mail).toBeDefined();
    expect(mail!.text).not.toContain('Headache'); // no PHI in email
  });

  it('exports the caller’s data (DPDP right of access) and audits it', async () => {
    const patient = await createUser(t.c, 'patient');
    const res = await t.app.inject({ url: '/v1/me/export', headers: patient.auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().account.id).toBe(patient.id);
    const audit = await t.c.db.writer
      .selectFrom('audit_logs')
      .select('action')
      .where('actor_id', '=', patient.id)
      .execute();
    expect(audit.map((a) => a.action)).toContain('data.exported');
  });
});
