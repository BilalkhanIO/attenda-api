// @ts-nocheck
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream, readFileSync } from 'fs';
import { basename } from 'path';

const BUCKET = process.env.AWS_S3_BUCKET || 'attenda-files';
const REGION = process.env.AWS_REGION    || 'us-east-1';

const s3 = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID     || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
});

// ─── Upload a file buffer ─────────────────────────────
export async function uploadBuffer(
  key:         string,
  buffer:      Buffer,
  contentType: string,
): Promise<string> {
  await s3.send(new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         key,
    Body:        buffer,
    ContentType: contentType,
    ServerSideEncryption: 'AES256',
  }));
  return key;
}

// ─── Get a signed URL (15 min expiry for payslips) ───
export async function getSignedDownloadUrl(
  key:        string,
  expiresIn = 900, // 15 minutes
): Promise<string> {
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(s3, command, { expiresIn });
}

// ─── Delete an object ─────────────────────────────────
export async function deleteFile(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

// ─── Key builders ─────────────────────────────────────
export const S3Keys = {
  payslip:   (orgId: string, userId: string, year: number, month: number) =>
    `orgs/${orgId}/payslips/${year}/${String(month).padStart(2,'0')}/${userId}.pdf`,
  report:    (orgId: string, type: string, timestamp: number) =>
    `orgs/${orgId}/reports/${type}-${timestamp}.pdf`,
  reportCsv: (orgId: string, type: string, timestamp: number) =>
    `orgs/${orgId}/reports/${type}-${timestamp}.csv`,
  logo:      (orgId: string, ext: string) =>
    `orgs/${orgId}/logo.${ext}`,
  avatar:    (orgId: string, userId: string, ext: string) =>
    `orgs/${orgId}/avatars/${userId}.${ext}`,
};

// ─── Check if S3 is configured ───────────────────────
export function isS3Configured(): boolean {
  return !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
}
