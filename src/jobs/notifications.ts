import type { Container } from '../container.js';
import type { DomainEvent } from '../infra/outbox.js';

/**
 * Email notifications (Mailpit locally). Content is deliberately PHI-free: no reasons,
 * notes or medicines — just "log in to view". Duplicate deliveries are harmless.
 */
export async function sendNotification(c: Container, event: DomainEvent): Promise<void> {
  const tz = c.config.APP_TIMEZONE;
  const when = (d: Date) => new Date(d).toLocaleString('en-IN', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' });

  const consultationFor = async (id: string) =>
    c.db.writer
      .selectFrom('consultations as c')
      .innerJoin('users as pu', 'pu.id', 'c.patient_id')
      .innerJoin('users as du', 'du.id', 'c.doctor_id')
      .innerJoin('doctors as d', 'd.user_id', 'c.doctor_id')
      .select(['c.id', 'c.scheduled_at', 'pu.email as patient_email', 'du.email as doctor_email', 'd.display_name'])
      .where('c.id', '=', id)
      .executeTakeFirst();

  switch (event.type) {
    case 'booking.confirmed': {
      const x = await consultationFor(event.consultationId);
      if (!x) return;
      await c.mailer.send({ to: x.patient_email, subject: 'Your consultation is confirmed', text: `Your consultation with Dr. ${x.display_name} on ${when(x.scheduled_at)} is confirmed. Booking ref: ${x.id}` });
      await c.mailer.send({ to: x.doctor_email, subject: 'New consultation booked', text: `A consultation was booked for ${when(x.scheduled_at)}. Booking ref: ${x.id}` });
      return;
    }
    case 'consultation.cancelled': {
      const x = await consultationFor(event.consultationId);
      if (!x) return;
      const refund = event.refund ? ' A full refund has been initiated.' : '';
      await c.mailer.send({ to: x.patient_email, subject: 'Consultation cancelled', text: `Your consultation on ${when(x.scheduled_at)} was cancelled.${refund} Ref: ${x.id}` });
      return;
    }
    case 'consultation.completed': {
      const x = await consultationFor(event.consultationId);
      if (!x) return;
      await c.mailer.send({ to: x.patient_email, subject: 'Consultation summary available', text: `Your consultation with Dr. ${x.display_name} is complete. Log in to view notes. Ref: ${x.id}` });
      return;
    }
    case 'prescription.pdf_ready': {
      const p = await c.db.writer
        .selectFrom('prescriptions as p')
        .innerJoin('users as u', 'u.id', 'p.patient_id')
        .select(['u.email', 'p.consultation_id'])
        .where('p.id', '=', event.prescriptionId)
        .executeTakeFirst();
      if (!p) return;
      await c.mailer.send({ to: p.email, subject: 'Your prescription is ready', text: `Your prescription is ready to download in the app. Ref: ${p.consultation_id}` });
      return;
    }
    default:
      return;
  }
}
