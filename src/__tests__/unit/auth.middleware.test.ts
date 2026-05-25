import { requireRole } from '../../middleware/auth';
import { signAccessToken } from '../../utils/auth';
import { Request, Response, NextFunction } from 'express';
import { JwtPayload } from '../../utils/auth';

function makeReq(role: string): Request {
  const payload: JwtPayload = {
    sub: 'user-1', org_id: 'org-1', role, name: 'Test', email: 'test@test.com', jti: 'jti-1',
  };
  return { user: payload } as Request;
}

const res = {} as Response;

describe('requireRole middleware', () => {
  it('allows matching role', () => {
    const next = jest.fn();
    const req  = makeReq('manager');
    requireRole('manager')(req, res, next);
    expect(next).toHaveBeenCalledWith();
  });

  it('allows higher role (hr_admin accessing manager route)', () => {
    const next = jest.fn();
    const req  = makeReq('hr_admin');
    requireRole('manager')(req, res, next);
    expect(next).toHaveBeenCalledWith(); // hr_admin > manager
  });

  it('allows super_admin to access any route', () => {
    const next = jest.fn();
    const req  = makeReq('super_admin');
    requireRole('hr_admin')(req, res, next);
    expect(next).toHaveBeenCalledWith();
  });

  it('blocks lower role (employee accessing manager route)', () => {
    const next = jest.fn();
    const req  = makeReq('employee');
    requireRole('manager')(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });

  it('blocks employee from hr_admin route', () => {
    const next = jest.fn();
    const req  = makeReq('employee');
    requireRole('hr_admin')(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });

  it('blocks unauthenticated request', () => {
    const next = jest.fn();
    const req  = {} as Request; // no user
    requireRole('manager')(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });
});
