import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ENVELOPE = '__attenda_idempotency_response_v1';

function encryptionKey(): Buffer {
  const configured = process.env.IDEMPOTENCY_RESPONSE_ENCRYPTION_KEY;
  if (process.env.NODE_ENV === 'production' && (!configured || configured.length < 32)) {
    throw new Error('Production requires IDEMPOTENCY_RESPONSE_ENCRYPTION_KEY with at least 32 characters.');
  }
  const secret = configured || process.env.JWT_REFRESH_SECRET;
  if (!secret || secret.length < 16) throw new Error('Set IDEMPOTENCY_RESPONSE_ENCRYPTION_KEY (or a strong JWT_REFRESH_SECRET) to replay sensitive idempotent responses.');
  return createHash('sha256').update('attenda:idempotency-response:v1:').update(secret).digest();
}

export function encryptIdempotencyResponse(value: unknown): Record<string, string | number> {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    [ENVELOPE]: 1,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  };
}

export function decryptIdempotencyResponse(value: unknown): unknown {
  if (!value || typeof value !== 'object' || (value as Record<string, unknown>)[ENVELOPE] !== 1) return value;
  const envelope = value as Record<string, string | number>;
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(String(envelope.iv), 'base64url'));
  decipher.setAuthTag(Buffer.from(String(envelope.tag), 'base64url'));
  const cleartext = Buffer.concat([
    decipher.update(Buffer.from(String(envelope.ciphertext), 'base64url')),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(cleartext);
}
