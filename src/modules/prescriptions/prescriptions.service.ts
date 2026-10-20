import PDFDocument from 'pdfkit';
import type { Actor, RequestCtx } from '../../domain/context.js';
import { Errors } from '../../domain/errors.js';
import type { Prescription } from '../../db/types.js';
import { canonicalJson, sha256Hex, type FieldCipher } from '../../infra/crypto.js';
import { withTransaction, type DbHandles } from '../../infra/db.js';
import { publishEvent } from '../../infra/outbox.js';
import type { ObjectStorage } from '../../infra/storage.js';
import type { AuditService } from '../audit/audit.service.js';
import { iso } from '../common/schemas.js';
import type { CreatePrescriptionInput, PrescriptionItemDto } from './prescriptions.schemas.js';

const AAD = { items: 'prescriptions.items', advice: 'prescriptions.advice' } as const;

interface Deps {
  db: DbHandles;
  cipher: FieldCipher;
  audit: AuditService;
  storage: ObjectStorage;
}

export class PrescriptionsService {
  constructor(private readonly d: Deps) {}

  private toDto(p: Prescription) {
    return {
      id: p.id,
      consultationId: p.consultation_id,
      doctorId: p.doctor_id,
      patientId: p.patient_id,
      items: this.d.cipher.decryptJson<PrescriptionItemDto[]>(p.items_enc, AAD.items),
      advice: this.d.cipher.decryptNullable(p.advice_enc, AAD.advice),
      followUpDate: p.follow_up_date,
      contentHash: p.content_hash,
      pdfStatus: p.pdf_status,
      createdAt: iso(p.created_at)!,
    };
  }

  /** Only the treating doctor, only during/after the consultation. One per consultation. */
  async create(actor: Actor, consultationId: string, input: CreatePrescriptionInput, ctx: RequestCtx) {
    const created = await withTransaction(this.d.db.writer, async (tx) => {
      const c = await tx
        .selectFrom('consultations')
        .selectAll()
        .where('id', '=', consultationId)
        .forShare()
        .executeTakeFirst();
      if (!c || c.doctor_id !== actor.id) throw Errors.notFound('Consultation');
      if (c.status !== 'in_progress' && c.status !== 'completed') {
        throw Errors.conflict(
          'INVALID_STATE',
          'Prescriptions can only be issued for an in-progress or completed consultation',
        );
      }
      const contentHash = sha256Hex(
        canonicalJson({
          consultationId,
          doctorId: c.doctor_id,
          patientId: c.patient_id,
          items: input.items,
          advice: input.advice ?? null,
          followUpDate: input.followUpDate ?? null,
        }),
      );
      const p = await tx
        .insertInto('prescriptions')
        .values({
          consultation_id: consultationId,
          doctor_id: c.doctor_id,
          patient_id: c.patient_id,
          items_enc: this.d.cipher.encryptJson(input.items, AAD.items),
          advice_enc: this.d.cipher.encryptNullable(input.advice, AAD.advice),
          follow_up_date: input.followUpDate ?? null,
          content_hash: contentHash,
          pdf_object_key: null,
        })
        .onConflict((oc) => oc.column('consultation_id').doNothing())
        .returningAll()
        .executeTakeFirst();
      if (!p)
        throw Errors.conflict(
          'PRESCRIPTION_EXISTS',
          'A prescription was already issued for this consultation',
        );
      await publishEvent(
        tx,
        { type: 'prescription', id: p.id },
        { type: 'prescription.created', prescriptionId: p.id },
      );
      await this.d.audit.record(
        ctx,
        {
          action: 'prescription.created',
          resourceType: 'prescription',
          resourceId: p.id,
          metadata: { consultationId, items: input.items.length },
        },
        tx,
      );
      return p;
    });
    return this.toDto(created);
  }

  async getForConsultation(actor: Actor, consultationId: string, ctx: RequestCtx) {
    const p = await this.d.db.writer
      .selectFrom('prescriptions')
      .selectAll()
      .where('consultation_id', '=', consultationId)
      .executeTakeFirst();
    if (!p || (p.patient_id !== actor.id && p.doctor_id !== actor.id)) {
      await this.d.audit.recordSafe(ctx, {
        action: 'prescription.read',
        resourceType: 'consultation',
        resourceId: consultationId,
        outcome: p ? 'denied' : 'failure',
      });
      throw Errors.notFound('Prescription');
    }
    await this.d.audit.recordSafe(ctx, {
      action: 'prescription.read',
      resourceType: 'prescription',
      resourceId: p.id,
    });
    return this.toDto(p);
  }

  async getPdf(actor: Actor, consultationId: string, ctx: RequestCtx): Promise<Buffer> {
    const p = await this.d.db.writer
      .selectFrom('prescriptions')
      .selectAll()
      .where('consultation_id', '=', consultationId)
      .executeTakeFirst();
    if (!p || (p.patient_id !== actor.id && p.doctor_id !== actor.id)) throw Errors.notFound('Prescription');
    if (p.pdf_status !== 'ready' || !p.pdf_object_key) {
      throw Errors.conflict('PDF_NOT_READY', `Prescription PDF is ${p.pdf_status}; try again shortly`);
    }
    await this.d.audit.recordSafe(ctx, {
      action: 'prescription.pdf_downloaded',
      resourceType: 'prescription',
      resourceId: p.id,
    });
    return this.d.storage.get(p.pdf_object_key);
  }

  /** Worker (async heavy task): render + store the PDF. Idempotent: skips if already ready. */
  async renderPdf(prescriptionId: string): Promise<'rendered' | 'skipped'> {
    const row = await this.d.db.writer
      .selectFrom('prescriptions as p')
      .innerJoin('doctors as d', 'd.user_id', 'p.doctor_id')
      .innerJoin('profiles as pr', 'pr.user_id', 'p.patient_id')
      .innerJoin('consultations as c', 'c.id', 'p.consultation_id')
      .selectAll('p')
      .select([
        'd.display_name',
        'd.registration_number',
        'd.qualifications',
        'pr.full_name as patient_name',
        'c.scheduled_at',
      ])
      .where('p.id', '=', prescriptionId)
      .executeTakeFirst();
    if (!row) return 'skipped';
    if (row.pdf_status === 'ready') return 'skipped';
    const dto = this.toDto(row);

    const pdf = await renderPrescriptionPdf({
      doctorName: row.display_name,
      registration: row.registration_number,
      qualifications: row.qualifications.join(', '),
      patientName: row.patient_name,
      date: new Date(row.scheduled_at).toISOString().slice(0, 10),
      items: dto.items,
      advice: dto.advice,
      followUpDate: dto.followUpDate,
      contentHash: row.content_hash,
      id: row.id,
    });
    const key = `prescriptions/${row.patient_id}/${row.id}.pdf`;
    await this.d.storage.put(key, pdf, 'application/pdf');
    await this.d.db.writer
      .updateTable('prescriptions')
      .set({ pdf_status: 'ready', pdf_object_key: key })
      .where('id', '=', row.id)
      .execute();
    await withTransaction(this.d.db.writer, (tx) =>
      publishEvent(
        tx,
        { type: 'prescription', id: row.id },
        { type: 'prescription.pdf_ready', prescriptionId: row.id },
      ),
    );
    return 'rendered';
  }

  async markPdfFailed(prescriptionId: string) {
    await this.d.db.writer
      .updateTable('prescriptions')
      .set({ pdf_status: 'failed' })
      .where('id', '=', prescriptionId)
      .where('pdf_status', '=', 'pending')
      .execute();
  }
}

function renderPrescriptionPdf(p: {
  doctorName: string;
  registration: string;
  qualifications: string;
  patientName: string;
  date: string;
  items: PrescriptionItemDto[];
  advice: string | null;
  followUpDate: string | null;
  contentHash: string;
  id: string;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      info: { Title: 'Prescription', Author: 'Amrutam' },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).text('Amrutam Teleconsultation — Prescription', { align: 'center' }).moveDown();
    doc.fontSize(11).text(`Dr. ${p.doctorName}${p.qualifications ? ` (${p.qualifications})` : ''}`);
    doc.text(`Registration No: ${p.registration}`);
    doc.text(`Patient: ${p.patientName}`);
    doc.text(`Date: ${p.date}`).moveDown();
    doc.fontSize(13).text('Rx').moveDown(0.5);
    p.items.forEach((it, i) => {
      doc
        .fontSize(11)
        .text(`${i + 1}. ${it.medicine} — ${it.dosage}, ${it.frequency}, ${it.durationDays} day(s)`);
      if (it.instructions)
        doc.fontSize(10).fillColor('#444').text(`   ${it.instructions}`).fillColor('black');
    });
    if (p.advice) doc.moveDown().fontSize(12).text('Advice').fontSize(11).text(p.advice);
    if (p.followUpDate) doc.moveDown().text(`Follow-up: ${p.followUpDate}`);
    doc
      .moveDown(2)
      .fontSize(8)
      .fillColor('#666')
      .text(`Prescription ID ${p.id} · integrity SHA-256 ${p.contentHash}`);
    doc.end();
  });
}
