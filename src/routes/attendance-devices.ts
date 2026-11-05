import { Router } from 'express';
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as verifySignature } from 'node:crypto';
import { authenticate, requireOrgFeature, requirePermission } from '../middleware/auth';
import { idempotency } from '../middleware/idempotency';
import { validate } from '../middleware/validate';
import { attendanceDeviceChallengeSchema, attendanceDeviceEnrollSchema, attendanceDeviceProofSchema, attendanceDeviceQueueSchema } from '../schemas/attendance-devices';
import prisma from '../utils/prisma';
import { AppError, created, NotFoundError, ok, ValidationError } from '../utils/response';
import { recordAudit } from '../services/audit';

const router = Router();
router.use(authenticate, requireOrgFeature('attendance'));

const publicDeviceSelect = {
  id: true, label: true, platform: true, fingerprint: true, status: true,
  key_proven_at: true, approved_at: true, revoked_at: true, last_used_at: true, created_at: true,
  approver: { select: { id: true, name: true } },
} as const;

function publicKeyFromBase64(encoded: string) {
  try {
    const der = Buffer.from(encoded, 'base64');
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('Unsupported key');
    return { key, der };
  } catch {
    throw new ValidationError('Attendance device key must be a valid P-256 public key.');
  }
}

router.get('/me', async (req, res, next) => {
  try {
    const devices = await prisma.attendanceDevice.findMany({ where: { user_id: req.user!.sub, org_id: req.user!.org_id }, select: publicDeviceSelect, orderBy: { created_at: 'desc' } });
    ok(res, devices);
  } catch (error) { next(error); }
});

router.post('/me/enroll/start', idempotency, validate({ body: attendanceDeviceEnrollSchema }), async (req, res, next) => {
  try {
    const { label, platform, public_key } = req.body as { label: string; platform: 'android'; public_key: string };
    const { der } = publicKeyFromBase64(public_key);
    const fingerprint = createHash('sha256').update(der).digest('hex');
    const activeCount = await prisma.attendanceDevice.count({ where: { user_id: req.user!.sub, status: { in: ['pending', 'approved'] } } });
    const exists = await prisma.attendanceDevice.findUnique({ where: { user_id_fingerprint: { user_id: req.user!.sub, fingerprint } }, select: { id: true } });
    if (!exists && activeCount >= 5) throw new AppError('You can enroll up to five attendance devices. Revoke one before adding another.', 409, 'DEVICE_LIMIT_REACHED');

    const challenge = randomBytes(32).toString('base64url');
    const challengeHash = createHash('sha256').update(challenge).digest('hex');
    const expires = new Date(Date.now() + 5 * 60_000);
    const device = await prisma.attendanceDevice.upsert({
      where: { user_id_fingerprint: { user_id: req.user!.sub, fingerprint } },
      create: { org_id: req.user!.org_id, user_id: req.user!.sub, label, platform, public_key, fingerprint, enrollment_challenge_hash: challengeHash, challenge_expires_at: expires },
      update: { org_id: req.user!.org_id, label, platform, public_key, status: 'pending', enrollment_challenge_hash: challengeHash, challenge_expires_at: expires, key_proven_at: null, approved_by: null, approved_at: null, revoked_at: null },
      select: { id: true, label: true, platform: true, fingerprint: true, status: true, created_at: true },
    });
    await prisma.attendanceDeviceChallenge.deleteMany({ where: { device_id: device.id } });
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'attendance.device.enrollment_started', entityType: 'attendance_device', entityId: device.id, after: { platform, fingerprint } });
    created(res, { device, challenge, challenge_expires_at: expires });
  } catch (error) { next(error); }
});

router.post('/me/:id/enroll/confirm', idempotency, validate({ body: attendanceDeviceProofSchema }), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const { challenge, signature } = req.body as { challenge: string; signature: string };
    const device = await prisma.attendanceDevice.findFirst({ where: { id, org_id: req.user!.org_id, user_id: req.user!.sub, status: 'pending' } });
    if (!device || !device.enrollment_challenge_hash || !device.challenge_expires_at || device.challenge_expires_at <= new Date()) throw new AppError('The enrollment challenge expired. Start enrollment again.', 409, 'DEVICE_CHALLENGE_EXPIRED');
    const suppliedHash = createHash('sha256').update(challenge).digest();
    const expectedHash = Buffer.from(device.enrollment_challenge_hash, 'hex');
    if (suppliedHash.length !== expectedHash.length || !timingSafeEqual(suppliedHash, expectedHash)) throw new AppError('Enrollment challenge does not match.', 409, 'DEVICE_CHALLENGE_INVALID');
    const { key } = publicKeyFromBase64(device.public_key);
    const signatureBytes = Buffer.from(signature, 'base64');
    if (!verifySignature('sha256', Buffer.from(challenge, 'utf8'), key, signatureBytes)) throw new AppError('The device signature could not be verified.', 403, 'DEVICE_PROOF_INVALID');
    const keyProvenAt = new Date();
    const updated = await prisma.attendanceDevice.updateMany({ where: { id, org_id: req.user!.org_id, user_id: req.user!.sub, status: 'pending', enrollment_challenge_hash: device.enrollment_challenge_hash, challenge_expires_at: { gt: keyProvenAt } }, data: { enrollment_challenge_hash: null, challenge_expires_at: null, key_proven_at: keyProvenAt } });
    if (!updated.count) throw new AppError('This enrollment challenge was already used. Start enrollment again.', 409, 'DEVICE_CHALLENGE_USED');
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'attendance.device.key_proven', entityType: 'attendance_device', entityId: id, after: { key_proven_at: keyProvenAt } });
    ok(res, { id, status: 'pending', key_proven_at: keyProvenAt, message: 'Key ownership verified. An organization administrator must approve this device.' });
  } catch (error) { next(error); }
});

router.post('/me/:id/checkin-challenge', idempotency, validate({ body: attendanceDeviceChallengeSchema }), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const device = await prisma.attendanceDevice.findFirst({
      where: { id, org_id: req.user!.org_id, user_id: req.user!.sub, status: 'approved' },
      select: { id: true },
    });
    if (!device) throw new NotFoundError('Approved attendance device');
    const challenge = randomBytes(32).toString('base64url');
    const signingPrefix = ['attenda-checkin-v2', req.user!.org_id, req.user!.sub, id, challenge, ''].join('\n');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 12 * 60 * 60_000);
    await prisma.attendanceDeviceChallenge.deleteMany({
      where: { device_id: id, OR: [{ expires_at: { lte: now } }, { consumed_at: { not: null } }] },
    });
    const pendingChallenges = await prisma.attendanceDeviceChallenge.count({ where: { device_id: id, consumed_at: null, expires_at: { gt: now } } });
    if (pendingChallenges >= 20) throw new AppError('Too many offline attendance events are waiting to sync. Connect the app before creating another check-in.', 429, 'DEVICE_CHALLENGE_LIMIT');
    await prisma.attendanceDeviceChallenge.create({
      data: { org_id: req.user!.org_id, user_id: req.user!.sub, device_id: id, challenge_hash: createHash('sha256').update(challenge).digest('hex'), expires_at: expiresAt },
    });
    ok(res, { device_id: id, challenge, signing_prefix: signingPrefix, expires_at: expiresAt });
  } catch (error) { next(error); }
});

router.delete('/me/:id', idempotency, async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const device = await prisma.attendanceDevice.findFirst({ where: { id, org_id: req.user!.org_id, user_id: req.user!.sub, status: { not: 'revoked' } }, select: { id: true, status: true } });
    if (!device) throw new NotFoundError('Attendance device');
    const revokedAt = new Date();
    await prisma.attendanceDeviceChallenge.deleteMany({ where: { device_id: id } });
    await prisma.attendanceDevice.updateMany({ where: { id, user_id: req.user!.sub, org_id: req.user!.org_id, status: { not: 'revoked' } }, data: { status: 'revoked', revoked_at: revokedAt, enrollment_challenge_hash: null, challenge_expires_at: null } });
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'attendance.device.self_revoked', entityType: 'attendance_device', entityId: id, before: { status: device.status }, after: { status: 'revoked' } });
    ok(res, { revoked: true });
  } catch (error) { next(error); }
});

router.get('/', requirePermission('attendance.devices.manage'), validate({ query: attendanceDeviceQueueSchema }), async (req, res, next) => {
  try {
    const status = String(req.query.status ?? 'pending');
    const devices = await prisma.attendanceDevice.findMany({
      where: { org_id: req.user!.org_id, status },
      include: { user: { select: { id: true, name: true, email: true, department: true } }, approver: { select: { id: true, name: true } } },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 200,
    });
    ok(res, devices.map(({ public_key: _publicKey, enrollment_challenge_hash: _challenge, ...device }) => device));
  } catch (error) { next(error); }
});

router.put('/:id/approve', requirePermission('attendance.devices.manage'), idempotency, async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const device = await prisma.attendanceDevice.findFirst({ where: { id, org_id: req.user!.org_id, status: 'pending', key_proven_at: { not: null } }, select: { id: true, user_id: true, fingerprint: true } });
    if (!device) throw new NotFoundError('Verified pending attendance device');
    const approvedAt = new Date();
    const updated = await prisma.attendanceDevice.updateMany({ where: { id, org_id: req.user!.org_id, status: 'pending', key_proven_at: { not: null } }, data: { status: 'approved', approved_by: req.user!.sub, approved_at: approvedAt } });
    if (!updated.count) throw new AppError('This device was already reviewed. Refresh the queue.', 409, 'DEVICE_REVIEW_STALE');
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'attendance.device.approved', entityType: 'attendance_device', entityId: id, after: { user_id: device.user_id, fingerprint: device.fingerprint } });
    const approved = await prisma.attendanceDevice.findUnique({ where: { id }, select: publicDeviceSelect });
    ok(res, approved);
  } catch (error) { next(error); }
});

router.delete('/:id', requirePermission('attendance.devices.manage'), idempotency, async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const device = await prisma.attendanceDevice.findFirst({ where: { id, org_id: req.user!.org_id, status: { not: 'revoked' } }, select: { id: true, user_id: true, status: true, fingerprint: true } });
    if (!device) throw new NotFoundError('Attendance device');
    const revokedAt = new Date();
    await prisma.attendanceDeviceChallenge.deleteMany({ where: { device_id: id, org_id: req.user!.org_id } });
    await prisma.attendanceDevice.updateMany({ where: { id, org_id: req.user!.org_id, status: { not: 'revoked' } }, data: { status: 'revoked', revoked_at: revokedAt, enrollment_challenge_hash: null, challenge_expires_at: null } });
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'attendance.device.revoked', entityType: 'attendance_device', entityId: id, before: { status: device.status, user_id: device.user_id }, after: { status: 'revoked' } });
    ok(res, { revoked: true });
  } catch (error) { next(error); }
});

export default router;
