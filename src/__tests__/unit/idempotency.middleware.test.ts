jest.mock('../../utils/prisma', () => ({
  __esModule: true,
  default: { idempotencyRecord: {
    findUnique: jest.fn(),
    delete: jest.fn(),
    updateMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  } },
}));

import express from 'express';
import request from 'supertest';
import prisma from '../../utils/prisma';
import { idempotency, publicSensitiveIdempotency, sensitiveResponseIdempotency } from '../../middleware/idempotency';

type StoredRecord = {
  id: string; org_id: string; user_id: string; key: string; request_hash: string;
  state: string; status_code: number | null; response_body: unknown; expires_at: Date; updated_at: Date;
};

describe('idempotency middleware', () => {
  let stored: StoredRecord | null;
  let handlerCalls: number;
  let app: express.Express;

  beforeEach(() => {
    stored = null;
    handlerCalls = 0;
    jest.clearAllMocks();
    (prisma.idempotencyRecord.findUnique as jest.Mock).mockImplementation(async () => stored);
    (prisma.idempotencyRecord.create as jest.Mock).mockImplementation(async ({ data }) => {
      stored = { id: 'record-1', ...data, status_code: null, response_body: null, updated_at: new Date() };
      return stored;
    });
    (prisma.idempotencyRecord.update as jest.Mock).mockImplementation(async ({ data }) => {
      stored = { ...stored!, ...data, updated_at: new Date() };
      return stored;
    });
    (prisma.idempotencyRecord.updateMany as jest.Mock).mockImplementation(async ({ data }) => {
      if (stored) stored = { ...stored, ...data, updated_at: new Date() };
      return { count: stored ? 1 : 0 };
    });

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as typeof req & { user: { org_id: string; sub: string; role: string; name: string; email: string; jti: string } }).user = {
        org_id: 'org-1', sub: 'user-1', role: 'admin', name: 'Tester', email: 'test@example.com', jti: 'session-1',
      };
      next();
    });
    app.post('/write', idempotency, (req, res) => {
      handlerCalls += 1;
      res.status(201).json({ saved: true, value: req.body.value });
    });
    app.post('/credential', sensitiveResponseIdempotency, (_req, res) => {
      handlerCalls += 1;
      res.status(201).json({ success: true, data: { token: 'attenda_secret_once' } });
    });
    app.post('/public-credential', (req, _res, next) => { delete req.user; next(); }, publicSensitiveIdempotency(req => `email:${String(req.body.email).toLowerCase()}`), (_req, res) => {
      handlerCalls += 1;
      res.status(201).json({ secret: 'public-flow-secret' });
    });
    app.use((error: { statusCode?: number; code?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error.statusCode ?? 500).json({ code: error.code ?? 'INTERNAL_ERROR' });
    });
  });

  it('replays a completed response and does not execute the mutation twice', async () => {
    const first = await request(app).post('/write').set('Idempotency-Key', 'retry-key-0001').send({ value: 'same' });
    const retry = await request(app).post('/write').set('Idempotency-Key', 'retry-key-0001').send({ value: 'same' });

    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotency-replayed']).toBe('true');
    expect(retry.body).toEqual(first.body);
    expect(handlerCalls).toBe(1);
  });

  it('rejects reuse of a key when the canonical request payload changes', async () => {
    await request(app).post('/write').set('Idempotency-Key', 'retry-key-0002').send({ value: 'first' });
    const collision = await request(app).post('/write').set('Idempotency-Key', 'retry-key-0002').send({ value: 'changed' });

    expect(collision).toMatchObject({ status: 409 });
    expect(collision.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(handlerCalls).toBe(1);
  });

  it('canonicalizes object key order before comparing request hashes', async () => {
    await request(app).post('/write').set('Idempotency-Key', 'retry-key-0003').send({ value: { a: 1, b: 2 } });
    const replay = await request(app).post('/write').set('Idempotency-Key', 'retry-key-0003').send({ value: { b: 2, a: 1 } });

    expect(replay.status).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(handlerCalls).toBe(1);
  });

  it('encrypts one-time credentials at rest and returns the same credential on replay', async () => {
    const previousRefreshSecret = process.env.JWT_REFRESH_SECRET;
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-that-is-long-enough';
    const first = await request(app).post('/credential').set('Idempotency-Key', 'credential-retry-001').send({});
    const storedBody = JSON.stringify(stored?.response_body);
    const replay = await request(app).post('/credential').set('Idempotency-Key', 'credential-retry-001').send({});

    expect(first.status).toBe(201);
    expect(storedBody).not.toContain('attenda_secret_once');
    expect(storedBody).toContain('__attenda_idempotency_response_v1');
    expect(replay.body).toEqual(first.body);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(handlerCalls).toBe(1);
    if (previousRefreshSecret === undefined) delete process.env.JWT_REFRESH_SECRET;
    else process.env.JWT_REFRESH_SECRET = previousRefreshSecret;
  });

  it('supports encrypted pre-auth replay scoped to a hashed actor identity', async () => {
    const previousRefreshSecret = process.env.JWT_REFRESH_SECRET;
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-that-is-long-enough';
    const first = await request(app).post('/public-credential').set('Idempotency-Key', 'public-retry-0001').send({ email: 'Tester@Example.com' });
    const storedBody = JSON.stringify(stored);
    const replay = await request(app).post('/public-credential').set('Idempotency-Key', 'public-retry-0001').send({ email: 'Tester@Example.com' });

    expect(first.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(stored?.org_id).toBe('AUTH_PUBLIC');
    expect(stored?.user_id).toMatch(/^anon_[a-f0-9]{64}$/);
    expect(storedBody).not.toContain('Tester@Example.com');
    expect(storedBody).not.toContain('public-flow-secret');
    if (previousRefreshSecret === undefined) delete process.env.JWT_REFRESH_SECRET;
    else process.env.JWT_REFRESH_SECRET = previousRefreshSecret;
  });
});
