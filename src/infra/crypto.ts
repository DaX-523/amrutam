import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Application-level envelope for PHI fields (AES-256-GCM, authenticated).
 *
 * Wire format: `enc:<keyId>:<base64url(iv | tag | ciphertext)>`
 *  - keyId enables rotation: new writes use the active key, old rows stay readable
 *    until the key-rotation job re-encrypts them, after which the old key is retired.
 *  - AAD binds a ciphertext to its column (e.g. "consultations.notes") so a value
 *    copied into another column/table fails authentication instead of decrypting.
 */
const PREFIX = 'enc';
const IV_LEN = 12;
const TAG_LEN = 16;

export class FieldCipher {
  constructor(
    private readonly keys: ReadonlyMap<string, Buffer>,
    private readonly activeKeyId: string,
  ) {
    if (!keys.has(activeKeyId)) throw new Error('active encryption key missing from keyring');
  }

  get activeKey(): string {
    return this.activeKeyId;
  }

  encrypt(plaintext: string, aad: string): string {
    const key = this.keys.get(this.activeKeyId)!;
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const payload = Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url');
    return `${PREFIX}:${this.activeKeyId}:${payload}`;
  }

  decrypt(envelope: string, aad: string): string {
    const [prefix, keyId, payload] = envelope.split(':');
    if (prefix !== PREFIX || !keyId || !payload) throw new Error('malformed ciphertext envelope');
    const key = this.keys.get(keyId);
    if (!key) throw new Error(`unknown encryption key id "${keyId}"`);
    const buf = Buffer.from(payload, 'base64url');
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }

  encryptNullable(value: string | null | undefined, aad: string): string | null {
    return value === null || value === undefined ? null : this.encrypt(value, aad);
  }

  decryptNullable(value: string | null | undefined, aad: string): string | null {
    return value === null || value === undefined ? null : this.decrypt(value, aad);
  }

  encryptJson(value: unknown, aad: string): string {
    return this.encrypt(JSON.stringify(value), aad);
  }

  decryptJson<T>(envelope: string, aad: string): T {
    return JSON.parse(this.decrypt(envelope, aad)) as T;
  }

  /** Key id embedded in an envelope; used by the rotation job to find stale rows. */
  static keyIdOf(envelope: string): string | undefined {
    return envelope.split(':')[1];
  }

  /** Re-encrypts under the active key if needed. Returns null when already current. */
  rotate(envelope: string, aad: string): string | null {
    if (FieldCipher.keyIdOf(envelope) === this.activeKeyId) return null;
    return this.encrypt(this.decrypt(envelope, aad), aad);
  }
}

/**
 * Blind index: deterministic keyed hash that allows equality lookups (e.g. "find patient
 * by phone") on an encrypted column without decrypting or storing plaintext.
 */
export function blindIndex(key: string, value: string): string {
  return createHmac('sha256', key).update(value.trim().toLowerCase()).digest('hex');
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hmacSha256Hex(secret: string, value: string | Buffer): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Deterministic JSON (sorted keys) for request hashing and content signatures. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
