import { z } from 'zod';
import { validate, SchemaValidationError } from '../../middleware/validate';
import { loginSchema, leaveRequestSchema, createUserSchema } from '../../schemas';

function run(mw: ReturnType<typeof validate>, req: Record<string, unknown>) {
  let captured: unknown = 'not called';
  mw(req as never, {} as never, (err?: unknown) => { captured = err; });
  return captured;
}

describe('validate middleware', () => {
  it('passes valid bodies through and replaces with parsed values', () => {
    const req: Record<string, unknown> = { body: { email: 'a@b.co', password: 'x' } };
    const err = run(validate({ body: loginSchema }), req);
    expect(err).toBeUndefined();
    expect(req.body).toEqual({ email: 'a@b.co', password: 'x' });
  });

  it('rejects invalid bodies with structured 422 issues', () => {
    const req = { body: { email: 'not-an-email' } };
    const err = run(validate({ body: loginSchema }), req) as SchemaValidationError;
    expect(err).toBeInstanceOf(SchemaValidationError);
    expect(err.statusCode).toBe(422);
    const paths = err.issues.map(i => i.path);
    expect(paths).toContain('email');
    expect(paths).toContain('password');
  });

  it('coerces declared coercible fields', () => {
    const schema = z.object({ days: z.coerce.number().int().min(1) });
    const req: Record<string, unknown> = { body: { days: '30' } };
    run(validate({ body: schema }), req);
    expect(req.body).toEqual({ days: 30 });
  });
});

describe('wave-1 schemas', () => {
  it('leaveRequestSchema enforces date ordering and time format', () => {
    expect(leaveRequestSchema.safeParse({
      leave_type: 'annual', start_date: '2026-06-15', end_date: '2026-06-14',
    }).success).toBe(false);

    expect(leaveRequestSchema.safeParse({
      leave_type: 'annual', start_date: '2026-06-15', end_date: '2026-06-16',
      leave_start_time: '9am',
    }).success).toBe(false);

    expect(leaveRequestSchema.safeParse({
      leave_type: 'custom_type', start_date: '2026-06-15', end_date: '2026-06-16',
      is_half_day: true, half_day_period: 'morning',
    }).success).toBe(true);
  });

  it('createUserSchema rejects unknown roles and bad rates', () => {
    const base = { name: 'Jo Smith', email: 'jo@x.co' };
    expect(createUserSchema.safeParse({ ...base, role: 'root' }).success).toBe(false);
    expect(createUserSchema.safeParse({ ...base, role: 'employee', hourly_rate: -5 }).success).toBe(false);
    expect(createUserSchema.safeParse({ ...base, role: 'employee', hourly_rate: '25' }).success).toBe(true);
  });
});
