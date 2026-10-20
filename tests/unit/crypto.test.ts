import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { blindIndex, canonicalJson, FieldCipher } from '../../src/infra/crypto.js';

const k = () => randomBytes(32);

describe('FieldCipher (AES-256-GCM envelope)', () => {
  const keys = new Map([['k1', k()]]);
  const cipher = new FieldCipher(keys, 'k1');

  it('round-trips and produces a fresh IV every time', () => {
    const a = cipher.encrypt('sensitive', 'consultations.notes');
    const b = cipher.encrypt('sensitive', 'consultations.notes');
    expect(a).not.toBe(b);
    expect(a.startsWith('enc:k1:')).toBe(true);
    expect(cipher.decrypt(a, 'consultations.notes')).toBe('sensitive');
  });

  it('fails authentication when moved to another column (AAD) or tampered', () => {
    const ct = cipher.encrypt('sensitive', 'consultations.notes');
    expect(() => cipher.decrypt(ct, 'profiles.phone')).toThrow();
    const tampered = ct.slice(0, -2) + (ct.endsWith('A') ? 'BB' : 'AA');
    expect(() => cipher.decrypt(tampered, 'consultations.notes')).toThrow();
  });

  it('supports key rotation: old ciphertexts stay readable and can be re-encrypted', () => {
    const k1 = k();
    const old = new FieldCipher(new Map([['k1', k1]]), 'k1');
    const ct = old.encrypt('phi', 'x');
    const rotated = new FieldCipher(
      new Map([
        ['k1', k1],
        ['k2', k()],
      ]),
      'k2',
    );
    expect(rotated.decrypt(ct, 'x')).toBe('phi');
    const re = rotated.rotate(ct, 'x')!;
    expect(FieldCipher.keyIdOf(re)).toBe('k2');
    expect(rotated.rotate(re, 'x')).toBeNull();
    expect(() => new FieldCipher(new Map([['k2', k()]]), 'k2').decrypt(ct, 'x')).toThrow(
      /unknown encryption key/,
    );
  });

  it('blind index is deterministic, normalised and keyed', () => {
    expect(blindIndex('key-a', ' +91 98 ')).toBe(blindIndex('key-a', '+91 98'));
    expect(blindIndex('key-a', 'x')).not.toBe(blindIndex('key-b', 'x'));
  });

  it('canonical JSON is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }),
    );
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});
