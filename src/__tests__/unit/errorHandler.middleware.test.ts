import { Request, Response, NextFunction } from 'express';
import { errorHandler, notFound } from '../../middleware/errorHandler';
import { AppError, NotFoundError, ValidationError, UnauthorizedError, ForbiddenError } from '../../utils/response';

function mockRes() {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json   = jest.fn().mockReturnValue(res);
  res.send   = jest.fn().mockReturnValue(res);
  return res as Response;
}

function mockReq(): Request {
  return {} as Request;
}

const next: NextFunction = jest.fn();

describe('Error Handler Middleware', () => {
  beforeEach(() => jest.clearAllMocks());

  it('handles AppError with correct status and body', () => {
    const res = mockRes();
    const err = new AppError('Bad input', 400, 'BAD_INPUT');
    errorHandler(err, mockReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Bad input', code: 'BAD_INPUT' });
  });

  it('handles NotFoundError (404)', () => {
    const res = mockRes();
    errorHandler(new NotFoundError('User'), mockReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('handles ValidationError (422)', () => {
    const res = mockRes();
    errorHandler(new ValidationError('Field required'), mockReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(422);
  });

  it('handles UnauthorizedError (401)', () => {
    const res = mockRes();
    errorHandler(new UnauthorizedError(), mockReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('handles ForbiddenError (403)', () => {
    const res = mockRes();
    errorHandler(new ForbiddenError(), mockReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('handles Prisma P2002 unique constraint as 409', () => {
    const res = mockRes();
    const err = Object.assign(new Error('Unique constraint'), { code: 'P2002' });
    errorHandler(err, mockReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CONFLICT' }));
  });

  it('handles Prisma P2025 not found as 404', () => {
    const res = mockRes();
    const err = Object.assign(new Error('Not found'), { code: 'P2025' });
    errorHandler(err, mockReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('handles unknown error as 500', () => {
    process.env.NODE_ENV = 'test';
    const res = mockRes();
    errorHandler(new Error('Unexpected'), mockReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INTERNAL_ERROR' }));
  });
});

describe('Not Found Middleware', () => {
  it('returns 404 with route not found message', () => {
    const res = mockRes();
    notFound(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Route not found' }));
  });
});
