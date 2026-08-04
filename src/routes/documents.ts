import { Router } from 'express';
import { authenticate, requirePermission } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { documentUploadUrlSchema, documentCreateSchema } from '../schemas';
import { ok, created, NotFoundError, ValidationError, ForbiddenError, AppError } from '../utils/response';
import prisma from '../utils/prisma';
import { recordAudit } from '../services/audit';
import { createNotification } from '../services/notifications';
import { resolveUserPermissions } from '../services/authorization';
import { getSignedDownloadUrl, getSignedUploadUrl, isS3Configured } from '../services/s3';
import {
  MAX_DOCUMENT_BYTES,
  ALLOWED_DOCUMENT_MIME_TYPES,
  isAllowedDocumentMime,
  documentKeyPrefix,
  buildDocumentKey,
} from '../services/documents';

/**
 * Employee document vault (contracts, IDs, visas, certificates): presigned
 * S3 upload → register → list/download/soft-delete. Everyone may manage
 * their own documents; documents.view_team reads a team member's list,
 * documents.manage uploads/deletes on behalf of others. Rows never expose
 * file_key — downloads go through short-lived presigned GET urls.
 * Mounted at /documents.
 */

const router = Router();
router.use(authenticate);

// Everything the API returns about a document — deliberately excludes file_key.
const DOCUMENT_SELECT = {
  id: true, user_id: true, org_id: true,
  title: true, category: true,
  file_name: true, file_size: true, mime_type: true,
  expires_at: true, uploaded_by: true, created_at: true,
  owner:    { select: { id: true, name: true, avatar_url: true, department: true } },
  uploader: { select: { id: true, name: true } },
} as const;

/** Resolve the target user of an upload; enforces documents.manage when it
 *  is someone else, and that the target belongs to the caller's org. */
async function resolveUploadTarget(
  req: { user?: { sub: string; org_id: string } },
  bodyUserId: string | undefined,
): Promise<string> {
  const self = req.user!.sub;
  const target = bodyUserId || self;

  if (target !== self) {
    const perms = await resolveUserPermissions(self, req.user!.org_id);
    if (!perms.has('documents.manage')) {
      throw new ForbiddenError('documents.manage is required to upload for another user');
    }
    const targetUser = await prisma.user.findFirst({
      where: { id: target, org_id: req.user!.org_id, deleted_at: null },
      select: { id: true },
    });
    if (!targetUser) throw new NotFoundError('User');
  }
  return target;
}

function assertUploadable(mimeType: string, fileSize: number): void {
  if (fileSize > MAX_DOCUMENT_BYTES) {
    throw new ValidationError(`file_size exceeds the ${MAX_DOCUMENT_BYTES / (1024 * 1024)}MB limit`);
  }
  if (!isAllowedDocumentMime(mimeType)) {
    throw new ValidationError(`mime_type must be one of: ${ALLOWED_DOCUMENT_MIME_TYPES.join(', ')}`);
  }
}

// ─── POST /documents/upload-url ────────────────────────
// Presigned S3 PUT for a new document. Self-upload is open to all authed
// users; uploading for someone else requires documents.manage.
router.post('/upload-url', validate({ body: documentUploadUrlSchema }), async (req, res, next) => {
  try {
    const { user_id, file_name, mime_type, file_size } = req.body;
    assertUploadable(mime_type, Number(file_size));
    const target = await resolveUploadTarget(req, user_id);

    if (!isS3Configured()) {
      throw new AppError('File storage is not configured', 503, 'S3_NOT_CONFIGURED');
    }

    const fileKey = buildDocumentKey(req.user!.org_id, target, file_name);
    const uploadUrl = await getSignedUploadUrl(fileKey, mime_type, 900);

    ok(res, {
      upload_url: uploadUrl,
      file_key:   fileKey,
      expires_in: 900,
      // The PUT must carry exactly the headers that were presigned.
      headers: { 'Content-Type': mime_type },
    });
  } catch (e) { next(e); }
});

// ─── POST /documents ───────────────────────────────────
// Register a document after the S3 upload succeeded.
router.post('/', validate({ body: documentCreateSchema }), async (req, res, next) => {
  try {
    const { user_id, title, category, file_key, file_name, file_size, mime_type, expires_at } = req.body;
    assertUploadable(mime_type, Number(file_size));
    const target = await resolveUploadTarget(req, user_id);

    // The key must sit under the target user's prefix — a client cannot
    // register someone else's object (or a foreign org's) as this user's doc.
    if (!file_key.startsWith(documentKeyPrefix(req.user!.org_id, target))) {
      throw new ValidationError('file_key does not match the target user');
    }

    let expiresAt: Date | null = null;
    if (expires_at) {
      expiresAt = new Date(`${expires_at}T00:00:00.000Z`);
      if (isNaN(expiresAt.getTime())) throw new ValidationError('Invalid expires_at');
    }

    const doc = await prisma.employeeDocument.create({
      data: {
        user_id: target, org_id: req.user!.org_id,
        title, category,
        file_key, file_name, file_size: Number(file_size), mime_type,
        expires_at: expiresAt,
        uploaded_by: req.user!.sub,
      },
      select: DOCUMENT_SELECT,
    });

    recordAudit({
      orgId: req.user!.org_id, actorId: req.user!.sub,
      action: 'document.add', entityType: 'employee_document', entityId: doc.id,
      after: { user_id: target, title, category, file_name, file_size: Number(file_size), expires_at },
    });

    if (target !== req.user!.sub) {
      const uploader = await prisma.user.findUnique({
        where: { id: req.user!.sub }, select: { name: true },
      });
      createNotification({
        userId: target, orgId: req.user!.org_id,
        type: 'document_added',
        title: 'Document added to your profile',
        body: `${uploader?.name ?? 'HR'} added "${title}" (${category}) to your documents`,
        actionType: 'employee_document', actionId: doc.id,
      }).catch(() => {});
    }

    created(res, doc);
  } catch (e) { next(e); }
});

// ─── GET /documents/me ─────────────────────────────────
router.get('/me', async (req, res, next) => {
  try {
    const docs = await prisma.employeeDocument.findMany({
      where: { user_id: req.user!.sub, deleted_at: null },
      select: DOCUMENT_SELECT,
      orderBy: { created_at: 'desc' },
      take: 100,
    });
    ok(res, docs);
  } catch (e) { next(e); }
});

// ─── GET /documents/user/:userId ───────────────────────
router.get('/user/:userId', requirePermission('documents.view_team'), async (req, res, next) => {
  try {
    const userId = String(req.params.userId);
    const target = await prisma.user.findFirst({
      where: { id: userId, org_id: req.user!.org_id },
      select: { id: true },
    });
    if (!target) throw new NotFoundError('User');

    const docs = await prisma.employeeDocument.findMany({
      where: { user_id: userId, org_id: req.user!.org_id, deleted_at: null },
      select: DOCUMENT_SELECT,
      orderBy: { created_at: 'desc' },
      take: 100,
    });
    ok(res, docs);
  } catch (e) { next(e); }
});

// ─── GET /documents/:id/download ───────────────────────
// Owner or documents.view_team → 15-minute presigned GET url.
router.get('/:id/download', async (req, res, next) => {
  try {
    const doc = await prisma.employeeDocument.findFirst({
      where: { id: String(req.params.id), org_id: req.user!.org_id, deleted_at: null },
    });
    if (!doc) throw new NotFoundError('Document');

    if (doc.user_id !== req.user!.sub) {
      const perms = await resolveUserPermissions(req.user!.sub, req.user!.org_id);
      if (!perms.has('documents.view_team')) throw new ForbiddenError();
    }

    const url = await getSignedDownloadUrl(doc.file_key, 900);
    ok(res, {
      download_url: url,
      file_name:    doc.file_name,
      mime_type:    doc.mime_type,
      expires_in:   900,
    });
  } catch (e) { next(e); }
});

// ─── DELETE /documents/:id ─────────────────────────────
// Owner may delete documents they uploaded themselves; anything else
// requires documents.manage. Soft delete — the S3 object stays.
router.delete('/:id', async (req, res, next) => {
  try {
    const doc = await prisma.employeeDocument.findFirst({
      where: { id: String(req.params.id), org_id: req.user!.org_id, deleted_at: null },
    });
    if (!doc) throw new NotFoundError('Document');

    const isSelfUploaded = doc.user_id === req.user!.sub && doc.uploaded_by === req.user!.sub;
    if (!isSelfUploaded) {
      const perms = await resolveUserPermissions(req.user!.sub, req.user!.org_id);
      if (!perms.has('documents.manage')) throw new ForbiddenError();
    }

    await prisma.employeeDocument.update({
      where: { id: doc.id },
      data: { deleted_at: new Date() },
    });

    recordAudit({
      orgId: req.user!.org_id, actorId: req.user!.sub,
      action: 'document.delete', entityType: 'employee_document', entityId: doc.id,
      before: { user_id: doc.user_id, title: doc.title, category: doc.category, file_name: doc.file_name },
      after: { deleted_at: new Date().toISOString() },
    });

    ok(res, { id: doc.id, deleted: true });
  } catch (e) { next(e); }
});

export default router;
