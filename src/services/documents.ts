import { randomUUID } from 'node:crypto';
import { S3Keys } from './s3';
import prisma from '../utils/prisma';
import { jobLogger } from '../utils/logger';

/**
 * Employee document vault helpers. Upload flow: client asks
 * POST /documents/upload-url for a presigned S3 PUT, uploads directly,
 * then registers the file via POST /documents. The key prefix binds each
 * object to one org + owner so registration can verify the client did not
 * swap in someone else's key.
 */

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024; // 20 MB

export const ALLOWED_DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/msword',                                                        // .doc
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',  // .docx
  'application/vnd.ms-excel',                                                  // .xls
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',         // .xlsx
] as const;

export function isAllowedDocumentMime(mime: string): boolean {
  return (ALLOWED_DOCUMENT_MIME_TYPES as readonly string[]).includes(mime);
}

/** Every document object for (org, user) lives under this S3 prefix. */
export function documentKeyPrefix(orgId: string, userId: string): string {
  return `documents/${orgId}/${userId}/`;
}

/** Collapse anything outside [A-Za-z0-9._-] so the S3 key stays URL-safe. */
export function sanitizeFileName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return (safe || 'file').slice(-120); // keep the extension end of long names
}

export function buildDocumentKey(
  orgId: string,
  userId: string,
  fileName: string,
  unique: string = randomUUID(),
): string {
  return S3Keys.document(orgId, userId, unique, sanitizeFileName(fileName));
}

// ─── Expiry reminders ─────────────────────────────────
// Daily scan (03:00 UTC): documents whose expires_at falls exactly 30 or 7
// days out notify the owner + uploader once per window, deduped through the
// notifications table like the late-pattern scan.

export const DOCUMENT_EXPIRY_WINDOWS = [30, 7] as const;
const EXPIRY_DEDUP_DAYS = 3; // windows are 23 days apart, so 3 days only kills same-window repeats

/** Whole days from `now` to `expiresAt`, both truncated to UTC dates —
 *  time-of-day (and the job's run hour) never shifts the result. */
export function daysUntilExpiry(expiresAt: Date, now: Date): number {
  const a = Date.UTC(expiresAt.getUTCFullYear(), expiresAt.getUTCMonth(), expiresAt.getUTCDate());
  const b = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((a - b) / 86_400_000);
}

/** The reminder window (30 or 7) this document matches today, else null. */
export function expiryWindowFor(expiresAt: Date | null | undefined, now: Date): number | null {
  if (!expiresAt) return null;
  const days = daysUntilExpiry(expiresAt, now);
  return (DOCUMENT_EXPIRY_WINDOWS as readonly number[]).includes(days) ? days : null;
}

export async function runDocumentExpiryScan(
  now = new Date(),
): Promise<{ scanned: number; notified: number }> {
  // expires_at is a DATE column — match the two exact target dates.
  const targetDates = DOCUMENT_EXPIRY_WINDOWS.map(days =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days)));

  const docs = await prisma.employeeDocument.findMany({
    where: { deleted_at: null, expires_at: { in: targetDates } },
    select: {
      id: true, org_id: true, user_id: true, uploaded_by: true,
      title: true, category: true, expires_at: true,
    },
  });

  let notified = 0;
  const { createNotification } = await import('./notifications');
  const dedupSince = new Date(now.getTime() - EXPIRY_DEDUP_DAYS * 24 * 60 * 60 * 1000);

  for (const doc of docs) {
    const days = expiryWindowFor(doc.expires_at, now);
    if (days === null) continue;

    const already = await prisma.inAppNotification.findFirst({
      where: {
        org_id: doc.org_id,
        type: 'document_expiring',
        action_id: doc.id,
        created_at: { gte: dedupSince },
      },
      select: { id: true },
    });
    if (already) continue;

    const dateStr = doc.expires_at!.toISOString().slice(0, 10);
    const recipients = new Set([doc.user_id, doc.uploaded_by]);
    for (const userId of recipients) {
      await createNotification({
        userId, orgId: doc.org_id,
        type: 'document_expiring',
        title: 'Document expiring soon',
        body: `"${doc.title}" (${doc.category}) expires in ${days} days — on ${dateStr}`,
        actionType: 'employee_document', actionId: doc.id,
      }).catch(() => {});
      notified++;
    }
  }

  jobLogger.info({ scanned: docs.length, notified }, 'document expiry scan complete');
  return { scanned: docs.length, notified };
}
