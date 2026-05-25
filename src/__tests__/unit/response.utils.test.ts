import { AppError, NotFoundError, UnauthorizedError, ForbiddenError, ValidationError, ConflictError } from '../../utils/response';

describe('Response Utilities - Error Classes', () => {
  describe('AppError', () => {
    it('creates with correct properties', () => {
      const err = new AppError('Something broke', 400, 'BAD_REQUEST');
      expect(err.message).toBe('Something broke');
      expect(err.statusCode).toBe(400);
      expect(err.code).toBe('BAD_REQUEST');
      expect(err instanceof Error).toBe(true);
    });

    it('uses default statusCode 400', () => {
      const err = new AppError('Oops');
      expect(err.statusCode).toBe(400);
    });
  });

  describe('NotFoundError', () => {
    it('produces a 404 with NOT_FOUND code', () => {
      const err = new NotFoundError('User');
      expect(err.statusCode).toBe(404);
      expect(err.code).toBe('NOT_FOUND');
      expect(err.message).toBe('User not found');
    });

    it('uses default resource name', () => {
      const err = new NotFoundError();
      expect(err.message).toBe('Resource not found');
    });
  });

  describe('UnauthorizedError', () => {
    it('produces a 401 with UNAUTHORIZED code', () => {
      const err = new UnauthorizedError();
      expect(err.statusCode).toBe(401);
      expect(err.code).toBe('UNAUTHORIZED');
    });

    it('accepts custom message', () => {
      const err = new UnauthorizedError('Token expired');
      expect(err.message).toBe('Token expired');
    });
  });

  describe('ForbiddenError', () => {
    it('produces a 403 with FORBIDDEN code', () => {
      const err = new ForbiddenError();
      expect(err.statusCode).toBe(403);
      expect(err.code).toBe('FORBIDDEN');
    });
  });

  describe('ValidationError', () => {
    it('produces a 422 with VALIDATION_ERROR code', () => {
      const err = new ValidationError('Field is required');
      expect(err.statusCode).toBe(422);
      expect(err.code).toBe('VALIDATION_ERROR');
      expect(err.message).toBe('Field is required');
    });
  });

  describe('ConflictError', () => {
    it('produces a 409 with CONFLICT code', () => {
      const err = new ConflictError('Email already taken');
      expect(err.statusCode).toBe(409);
      expect(err.code).toBe('CONFLICT');
    });
  });
});
