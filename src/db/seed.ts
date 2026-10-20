import { sql } from 'kysely';
import { loadConfig } from '../config/env.js';
import { blindIndex, FieldCipher } from '../infra/crypto.js';
import { createDb } from '../infra/db.js';
import { PasswordHasher } from '../infra/passwords.js';
import { CONSENT_VERSION } from '../modules/auth/auth.service.js';

/**
 * Demo data: 1 admin, 12 verified doctors (+1 pending verification), 5 patients, and a
 * week of 15-minute slots per doctor (10:00-13:00 IST). Idempotent: does nothing if
 * the admin already exists.
 *
 * DEMO credentials (local only):
 *   admin@amrutam.local / Admin@Amrutam2026      (MFA, TOTP secret below)
 *   dr.<n>@amrutam.local / Doctor@Amrutam2026     (MFA, TOTP secret below)
 *   patient<n>@amrutam.local / Patient@Amrutam2026
 */
export const DEMO_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

const DOCTORS = [
  ['Dr. Ananya Sharma', ['general-ayurveda', 'digestive-health'], ['english', 'hindi'], 'Delhi', 49900, 12, 4.8],
  ['Dr. Rohan Iyer', ['panchakarma', 'joint-pain'], ['english', 'tamil'], 'Chennai', 79900, 18, 4.6],
  ['Dr. Meera Kulkarni', ['skin-hair', 'womens-health'], ['english', 'marathi', 'hindi'], 'Pune', 59900, 9, 4.9],
  ['Dr. Arjun Nair', ['mental-wellness', 'sleep'], ['english', 'malayalam'], 'Kochi', 69900, 15, 4.7],
  ['Dr. Kavya Reddy', ['womens-health', 'fertility'], ['english', 'telugu'], 'Hyderabad', 89900, 20, 4.9],
  ['Dr. Vikram Singh', ['joint-pain', 'general-ayurveda'], ['hindi', 'punjabi'], 'Chandigarh', 39900, 7, 4.3],
  ['Dr. Priya Menon', ['digestive-health', 'weight-management'], ['english', 'malayalam'], 'Bengaluru', 54900, 11, 4.5],
  ['Dr. Sanjay Gupta', ['diabetes-care', 'general-ayurveda'], ['hindi', 'english'], 'Delhi', 44900, 22, 4.4],
  ['Dr. Nisha Patel', ['skin-hair'], ['gujarati', 'hindi', 'english'], 'Ahmedabad', 49900, 6, 4.2],
  ['Dr. Aditya Rao', ['sleep', 'mental-wellness'], ['kannada', 'english'], 'Bengaluru', 64900, 13, 4.6],
  ['Dr. Farah Khan', ['respiratory-health', 'general-ayurveda'], ['urdu', 'hindi', 'english'], 'Mumbai', 59900, 10, 4.7],
  ['Dr. Devika Bose', ['womens-health', 'digestive-health'], ['bengali', 'english'], 'Kolkata', 54900, 14, 4.8],
] as const;

async function main() {
  const config = loadConfig();
  const db = createDb({ url: config.DATABASE_URL, poolMax: 4, statementTimeoutMs: 60_000, appName: 'seed' });
  const cipher = new FieldCipher(config.ENCRYPTION_KEYS, config.ENCRYPTION_ACTIVE_KEY_ID);
  const hasher = new PasswordHasher();
  const w = db.writer;

  if (await w.selectFrom('users').select('id').where('email', '=', 'admin@amrutam.local').executeTakeFirst()) {
    process.stdout.write('seed: already applied, skipping\n');
    await db.close();
    return;
  }

  const [adminPw, doctorPw, patientPw] = await Promise.all([
    hasher.hash('Admin@Amrutam2026'),
    hasher.hash('Doctor@Amrutam2026'),
    hasher.hash('Patient@Amrutam2026'),
  ]);
  const mfaSecret = cipher.encrypt(DEMO_TOTP_SECRET, 'users.mfa_secret');

  await w.transaction().execute(async (tx) => {
    const mkUser = async (email: string, role: 'admin' | 'doctor' | 'patient', fullName: string, mfa: boolean, phone?: string) => {
      const u = await tx
        .insertInto('users')
        .values({ email, role, password_hash: role === 'admin' ? adminPw : role === 'doctor' ? doctorPw : patientPw, mfa_enabled: mfa, mfa_secret_enc: mfa ? mfaSecret : null })
        .returning('id')
        .executeTakeFirstOrThrow();
      await tx
        .insertInto('profiles')
        .values({
          user_id: u.id,
          full_name: fullName,
          phone_enc: phone ? cipher.encrypt(phone, 'profiles.phone') : null,
          phone_bidx: phone ? blindIndex(config.BLIND_INDEX_KEY, phone) : null,
          dob_enc: null,
          gender: null,
          city: null,
          consent_version: CONSENT_VERSION,
          consent_given_at: new Date(),
        })
        .execute();
      return u.id;
    };

    const adminId = await mkUser('admin@amrutam.local', 'admin', 'Platform Admin', true);

    for (const [i, [name, specialties, languages, city, fee, years, rating]] of DOCTORS.entries()) {
      const id = await mkUser(`dr.${i + 1}@amrutam.local`, 'doctor', name, true);
      await tx
        .insertInto('doctors')
        .values({
          user_id: id,
          display_name: name,
          registration_number: `AYUSH-${100200 + i}`,
          specialties: [...specialties],
          languages: [...languages],
          qualifications: ['BAMS', ...(years > 12 ? ['MD (Ayurveda)'] : [])],
          years_experience: years,
          fee_paise: fee,
          city,
          bio: `${name} practises ${specialties.join(' and ').replaceAll('-', ' ')} with ${years} years of experience.`,
          rating,
          rating_count: 20 + i * 7,
          verified_at: new Date(),
          verified_by: adminId,
        })
        .execute();
      // A week of morning slots (10:00-13:00 IST) starting tomorrow.
      await sql`
        INSERT INTO availability_slots (doctor_id, starts_at, ends_at)
        SELECT ${id}, t, t + interval '15 minutes'
        FROM generate_series(1, 7) AS day,
             generate_series(
               ((current_date + day)::timestamp + time '10:00') AT TIME ZONE ${config.APP_TIMEZONE},
               ((current_date + day)::timestamp + time '12:45') AT TIME ZONE ${config.APP_TIMEZONE},
               interval '15 minutes') AS t
      `.execute(tx);
    }

    const pendingId = await mkUser('dr.pending@amrutam.local', 'doctor', 'Dr. Pending Verification', false);
    await tx
      .insertInto('doctors')
      .values({ user_id: pendingId, display_name: 'Dr. Pending Verification', registration_number: 'AYUSH-999999', specialties: ['general-ayurveda'], languages: ['english'], qualifications: ['BAMS'], years_experience: 2, fee_paise: 29900, city: 'Jaipur', bio: null, verified_at: null, verified_by: null })
      .execute();

    for (let i = 1; i <= 5; i++) {
      await mkUser(`patient${i}@amrutam.local`, 'patient', `Patient ${i}`, false, `+9198765432${String(i).padStart(2, '0')}`);
    }
  });

  const slots = await w.selectFrom('availability_slots').select(sql<string>`count(*)`.as('n')).executeTakeFirstOrThrow();
  process.stdout.write(
    `seed: 1 admin, ${DOCTORS.length + 1} doctors, 5 patients, ${slots.n} slots\n` +
      `      admin@amrutam.local / Admin@Amrutam2026, dr.1@amrutam.local / Doctor@Amrutam2026, patient1@amrutam.local / Patient@Amrutam2026\n` +
      `      demo TOTP secret: ${DEMO_TOTP_SECRET}  (npm run totp)\n`,
  );
  await db.close();
}

void main().catch((err: unknown) => {
  process.stderr.write(`seed failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
