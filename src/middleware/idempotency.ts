import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import prisma from '../utils/prisma';
import { AppError } from '../utils/response';
import { decryptIdempotencyResponse, encryptIdempotencyResponse } from '../utils/idempotencyResponse';

const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_RESPONSE_BYTES = 256 * 1024;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

function payloadHash(req: Request): string {
  // `offline` changes only the trust/reconciliation path; the same mobile
  // action can first be attempted online and then replayed from its offline
  // outbox with identical action data and key.
  const body = req.body && typeof req.body === 'object'
    ? Object.fromEntries(Object.entries(req.body).filter(([key]) => key !== 'offline' && key !== 'idempotency_key'))
    : req.body ?? null;
  const url = new URL(req.originalUrl, 'http://attenda.invalid');
  const query = [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
    leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
  const upload = (req as Request & { file?: { originalname: string; mimetype: string; size: number; buffer?: Buffer } }).file;
  const fileEvidence = upload?.buffer ? {
    name: upload.originalname,
    mime_type: upload.mimetype,
    size: upload.size,
    sha256: createHash('sha256').update(upload.buffer).digest('hex'),
  } : null;
  const canonicalRequest = stableValue({ method: req.method, path: url.pathname, query, body, file: fileEvidence });
  return createHash('sha256').update(JSON.stringify(canonicalRequest)).digest('hex');
}

/** Optional Idempotency-Key support for authenticated state-changing routes. */
async function applyIdempotency(
  req: Request,
  res: Response,
  next: NextFunction,
  encryptResponse = false,
  anonymousActor?: (req: Request) => string,
): Promise<void> {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const headerKey = req.get('Idempotency-Key')?.trim();
  const bodyKey = typeof req.body?.idempotency_key === 'string' ? req.body.idempotency_key.trim() : undefined;
  if (headerKey && bodyKey && headerKey !== bodyKey) {
    return next(new AppError('The Idempotency-Key header and request body key must match.', 400, 'IDEMPOTENCY_KEY_MISMATCH'));
  }
  const rawKey = headerKey ?? bodyKey;
  if (!rawKey) return next();
  const key = rawKey.trim();
  if (key.length < 8 || key.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    return next(new AppError('Idempotency-Key must be 8–128 letters, numbers, dots, underscores, colons, or hyphens.', 400, 'INVALID_IDEMPOTENCY_KEY'));
  }
  const actor = req.user?.sub ? null : anonymousActor?.(req).trim();
  if (actor === '') return next(new AppError('A stable actor identifier is required for this idempotent request.', 400, 'IDEMPOTENCY_ACTOR_REQUIRED'));
  const orgId = req.user?.org_id || (actor ? 'AUTH_PUBLIC' : null);
  const userId = req.user?.sub || (actor ? `anon_${createHash('sha256').update(actor).digest('hex')}` : null);
  if (!orgId || !userId) return next(new AppError('Authentication is required for idempotent requests.', 401, 'UNAUTHENTICATED'));
  const hash = payloadHash(req);
  if (encryptResponse) {
    try { encryptIdempotencyResponse(null); }
    catch (error) { return next(new AppError((error as Error).message, 503, 'IDEMPOTENCY_ENCRYPTION_UNAVAILABLE')); }
  }
  const expiresAt = new Date(Date.now() + RETENTION_MS);
  let record = await prisma.idempotencyRecord.findUnique({ where: { org_id_user_id_key: { org_id: orgId, user_id: userId, key } } });

  if (record?.expires_at && record.expires_at <= new Date()) {
    await prisma.idempotencyRecord.delete({ where: { id: record.id } });
    record = null;
  }
  if (record?.state === 'processing' && record.updated_at.getTime() < Date.now() - 5 * 60_000) {
    await prisma.idempotencyRecord.updateMany({
      where: { id: record.id, state: 'processing', updated_at: record.updated_at },
      data: { state: 'unknown' },
    });
    record = await prisma.idempotencyRecord.findUnique({ where: { org_id_user_id_key: { org_id: orgId, user_id: userId, key } } });
  }
  if (record) {
    if (record.request_hash !== hash) return next(new AppError('This Idempotency-Key was already used with a different request.', 409, 'IDEMPOTENCY_KEY_REUSED'));
    if (record.state === 'unknown') return next(new AppError('The original request may have completed, but its response was not recorded. Check the affected record before retrying with a new key.', 409, 'IDEMPOTENCY_OUTCOME_UNKNOWN'));
    if (record.state !== 'completed' || !record.status_code) return next(new AppError('A request with this Idempotency-Key is still processing.', 409, 'IDEMPOTENCY_REQUEST_IN_PROGRESS'));
    res.setHeader('Idempotency-Replayed', 'true');
    try { res.status(record.status_code).json(decryptIdempotencyResponse(record.response_body ?? null)); }
    catch { return next(new AppError('The encrypted idempotent response cannot be recovered. Contact an administrator before retrying this operation.', 503, 'IDEMPOTENCY_RESPONSE_UNAVAILABLE')); }
    return;
  }

  try {
    record = await prisma.idempotencyRecord.create({ data: { org_id: orgId, user_id: userId, key, request_hash: hash, state: 'processing', expires_at: expiresAt } });
  } catch (error) {
    if ((error as { code?: string }).code !== 'P2002') throw error;
    const concurrent = await prisma.idempotencyRecord.findUnique({ where: { org_id_user_id_key: { org_id: orgId, user_id: userId, key } } });
    if (!concurrent) throw error;
    if (concurrent.request_hash !== hash) return next(new AppError('This Idempotency-Key was already used with a different request.', 409, 'IDEMPOTENCY_KEY_REUSED'));
    if (concurrent.state === 'unknown') return next(new AppError('The original request may have completed, but its response was not recorded. Check the affected record before retrying with a new key.', 409, 'IDEMPOTENCY_OUTCOME_UNKNOWN'));
    if (concurrent.state === 'completed' && concurrent.status_code) {
      res.setHeader('Idempotency-Replayed', 'true');
      try { res.status(concurrent.status_code).json(decryptIdempotencyResponse(concurrent.response_body ?? null)); }
      catch { return next(new AppError('The encrypted idempotent response cannot be recovered. Contact an administrator before retrying this operation.', 503, 'IDEMPOTENCY_RESPONSE_UNAVAILABLE')); }
      return;
    }
    return next(new AppError('A request with this Idempotency-Key is still processing.', 409, 'IDEMPOTENCY_REQUEST_IN_PROGRESS'));
  }

  // Express res.json delegates to res.send, as do 204/no-content helpers.
  // Capture send so successful empty responses are marked completed too.
  const currentSend = res.send.bind(res);
  res.send = ((body?: unknown) => {
    const status = res.statusCode;
    if (status < 200 || status >= 300) {
      const clear = status < 500
        ? prisma.idempotencyRecord.deleteMany({ where: { id: record!.id, state: 'processing' } })
        : prisma.idempotencyRecord.updateMany({ where: { id: record!.id, state: 'processing' }, data: { state: 'unknown' } });
      void clear.then(() => currentSend(body)).catch(() => currentSend(body));
      return res;
    }
    let replayBody: unknown = body === undefined ? null : body;
    if (typeof body === 'string' && String(res.getHeader('content-type') ?? '').includes('application/json')) {
      try { replayBody = JSON.parse(body); } catch { replayBody = body; }
    }
    if (encryptResponse) {
      try { replayBody = encryptIdempotencyResponse(replayBody); }
      catch {
        void prisma.idempotencyRecord.updateMany({ where: { id: record!.id, state: 'processing' }, data: { state: 'unknown' } })
          .then(() => currentSend(body)).catch(() => currentSend(body));
        return res;
      }
    }
    const serialized = JSON.stringify(replayBody);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_RESPONSE_BYTES) {
      void prisma.idempotencyRecord.updateMany({ where: { id: record!.id, state: 'processing' }, data: { state: 'unknown' } })
        .then(() => currentSend(body)).catch(() => currentSend(body));
      return res;
    }
    void prisma.idempotencyRecord.update({
      where: { id: record!.id },
      data: { state: 'completed', status_code: status, response_body: JSON.parse(serialized), expires_at: expiresAt },
    }).then(() => currentSend(body)).catch(() => {
      // Keep the claim. The handler may already have committed its mutation;
      // stale processing claims become `unknown` on the next retry.
      void prisma.idempotencyRecord.updateMany({ where: { id: record!.id, state: 'processing' }, data: { state: 'unknown' } })
        .then(() => currentSend(body), () => currentSend(body));
    });
    return res;
    }) as Response['send'];
  next();
}

export const idempotency = (req: Request, res: Response, next: NextFunction) => applyIdempotency(req, res, next);
export const sensitiveResponseIdempotency = (req: Request, res: Response, next: NextFunction) => applyIdempotency(req, res, next, true);
export const publicIdempotency = (actor: (req: Request) => string) =>
  (req: Request, res: Response, next: NextFunction) => applyIdempotency(req, res, next, false, actor);
export const publicSensitiveIdempotency = (actor: (req: Request) => string) =>
  (req: Request, res: Response, next: NextFunction) => applyIdempotency(req, res, next, true, actor);
