// @ts-nocheck
import QRCode from 'qrcode';
import { uploadBuffer, S3Keys, isS3Configured } from './s3';
import prisma from '../utils/prisma';
import { createHmac } from 'crypto';

const QR_SECRET = process.env.JWT_SECRET || 'qr-dev-secret';

// ─── Generate a signed QR payload ────────────────────
function generateQrPayload(orgId: string): string {
  const ts        = Math.floor(Date.now() / 1000);
  const expiresAt = ts + 86400; // 24 hours
  const data      = `attenda:${orgId}:${expiresAt}`;
  const sig       = createHmac('sha256', QR_SECRET).update(data).digest('hex').substring(0, 16);
  return `${data}:${sig}`;
}

// ─── Verify a scanned QR code ─────────────────────────
export function verifyQrCode(qrValue: string, orgId: string): { valid: boolean; reason?: string } {
  try {
    const parts = qrValue.split(':');
    if (parts.length !== 4 || parts[0] !== 'attenda') {
      return { valid: false, reason: 'Invalid QR code format' };
    }
    const [, qrOrgId, expiresAt, sig] = parts;
    if (qrOrgId !== orgId) {
      return { valid: false, reason: 'QR code belongs to a different organisation' };
    }
    if (parseInt(expiresAt) < Math.floor(Date.now() / 1000)) {
      return { valid: false, reason: 'QR code has expired' };
    }
    // Verify signature
    const data     = `attenda:${qrOrgId}:${expiresAt}`;
    const expected = createHmac('sha256', QR_SECRET).update(data).digest('hex').substring(0, 16);
    if (sig !== expected) {
      return { valid: false, reason: 'Invalid QR code signature' };
    }
    return { valid: true };
  } catch {
    return { valid: false, reason: 'Invalid QR code' };
  }
}

// ─── Generate and store QR code for an org ───────────
export async function generateOrgQrCode(orgId: string): Promise<{
  qr_data:        string;
  qr_code_url:    string | null;
  qr_code_base64: string | null;
  expires_at:     Date;
}> {
  const payload   = generateQrPayload(orgId);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  // Generate PNG buffer
  const pngBuffer: Buffer = await QRCode.toBuffer(payload, {
    type:              'png',
    width:             400,
    margin:            2,
    color:             { dark: '#0F172A', light: '#FFFFFF' },
    errorCorrectionLevel: 'H',
  });

  let url: string | null = null;
  let base64: string | null = null;

  if (isS3Configured()) {
    const key = `orgs/${orgId}/qr-code.png`;
    await uploadBuffer(key, pngBuffer, 'image/png');
    const { getSignedDownloadUrl } = await import('./s3');
    url = await getSignedDownloadUrl(key, 86400);
  } else {
    // No S3 — return base64 data URI so mobile can render directly
    base64 = `data:image/png;base64,${pngBuffer.toString('base64')}`;
  }

  return { qr_data: payload, qr_code_url: url, qr_code_base64: base64, expires_at: expiresAt };
}

// ─── Get or regenerate QR code ────────────────────────
export async function getOrCreateQrCode(orgId: string) {
  return generateOrgQrCode(orgId);
}
