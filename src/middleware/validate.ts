import { Request, Response, NextFunction } from 'express';
import { ZodType, ZodError } from 'zod';
import { AppError } from '../utils/response';

/** 422 with structured per-field issues, still inside the standard envelope. */
export class SchemaValidationError extends AppError {
  constructor(
    message: string,
    public issues: Array<{ path: string; message: string }>,
  ) {
    super(message, 422, 'VALIDATION_ERROR');
  }
}

function formatIssues(err: ZodError): Array<{ path: string; message: string }> {
  return err.issues.map(i => ({
    path: i.path.join('.') || '(root)',
    message: i.message,
  }));
}

/**
 * Declarative request validation. Parsed (and coerced/defaulted) values
 * replace the originals, so handlers downstream read clean, typed data:
 *
 *   router.post('/login', validate({ body: loginSchema }), handler)
 *
 * Express 5 query/params objects are getter-backed; we re-assign via
 * Object.defineProperty to keep replacement reliable across versions.
 */
export function validate(schemas: {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schemas.body) {
        req.body = schemas.body.parse(req.body ?? {});
      }
      if (schemas.query) {
        const parsed = schemas.query.parse(req.query ?? {});
        Object.defineProperty(req, 'query', { value: parsed, writable: true });
      }
      if (schemas.params) {
        const parsed = schemas.params.parse(req.params ?? {});
        Object.defineProperty(req, 'params', { value: parsed, writable: true });
      }
      next();
    } catch (e) {
      if (e instanceof ZodError) {
        const issues = formatIssues(e);
        const summary = issues.map(i => `${i.path}: ${i.message}`).join('; ');
        return next(new SchemaValidationError(summary, issues));
      }
      next(e);
    }
  };
}
