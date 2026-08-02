import { randomUUID } from 'node:crypto';
import { S3Keys } from './s3';

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
