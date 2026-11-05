import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/response';
import { logger } from '../utils/logger';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  if (err instanceof AppError) {
    const issues = (err as { issues?: Array<{ path: string; message: string }> }).issues;
    return res.status(err.statusCode).json({
      success: false,
      error: err.message,
      code: err.code,
      ...(issues ? { details: issues } : {}),
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

  // Attendance period guard raised by the PostgreSQL trigger. Keep the user
  // facing recovery action clear while retaining the database guard as the
  // final protection for background and import writes.
  const prismaMeta = (err as { meta?: Record<string, unknown> }).meta;
  const errorDetails = `${err.message} ${JSON.stringify(prismaMeta ?? {})}`;
  if ((err as { code?: string }).code === 'P2004' && /attendance_processed_payroll_locked|processed payroll period must be recalled/i.test(errorDetails)) {
    return res.status(409).json({
      success: false,
      error: 'This attendance period is already in processed payroll. Recall the payroll run before changing attendance.',
      code: 'ATTENDANCE_PERIOD_PAYROLL_PROCESSED',
    });
  }

  logger.error({ err, method: req.method, path: req.originalUrl, userId: req.user?.sub }, 'Unhandled API error');

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
