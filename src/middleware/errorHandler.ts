import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/response';

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: err.message,
      code: err.code,
    });
  }

  // Prisma unique constraint
  if ((err as { code?: string }).code === 'P2002') {
    return res.status(409).json({
      success: false,
      error: 'A record with this value already exists',
      code: 'CONFLICT',
    });
  }

  // Prisma not found
  if ((err as { code?: string }).code === 'P2025') {
    return res.status(404).json({
      success: false,
      error: 'Record not found',
      code: 'NOT_FOUND',
    });
  }

  console.error('[ERROR]', err);

  res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
    code: 'INTERNAL_ERROR',
  });
}

// 404 handler
export function notFound(_req: Request, res: Response) {
  res.status(404).json({ success: false, error: 'Route not found', code: 'NOT_FOUND' });
}
