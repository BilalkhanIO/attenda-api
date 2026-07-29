import type { Router } from 'express';
import { z, ZodType } from 'zod';
import type { ValidationSchemas } from '../middleware/validate';

/**
 * OpenAPI 3.1 document generated from the live route table. Paths and
 * methods come from walking each mounted router's stack, and request-body
 * schemas come from the zod schemas the validate() middleware was built
 * with — nothing here is hand-maintained per endpoint.
 */

interface OperationObject {
  summary: string;
  tags: string[];
  parameters?: Array<Record<string, unknown>>;
  requestBody?: Record<string, unknown>;
  responses: Record<string, unknown>;
  security?: Array<Record<string, string[]>>;
}

const ENVELOPE_RESPONSES = {
  '200': {
    description: 'Success envelope',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            success: { type: 'boolean', const: true },
            data: {},
            pagination: {
              type: 'object',
              properties: {
                page: { type: 'integer' }, limit: { type: 'integer' },
                total: { type: 'integer' }, pages: { type: 'integer' },
              },
            },
          },
          required: ['success', 'data'],
        },
      },
    },
  },
  '4XX': { $ref: '#/components/responses/Error' },
  '5XX': { $ref: '#/components/responses/Error' },
};

function toJsonSchema(schema: ZodType): Record<string, unknown> {
  try {
    // io:'input' documents what callers send (before coercion/defaults).
    const out = z.toJSONSchema(schema, { io: 'input', target: 'draft-2020-12' }) as Record<string, unknown>;
    delete out.$schema;
    return out;
  } catch {
    return { type: 'object', description: 'See source zod schema (not representable as JSON Schema)' };
  }
}

/** `/users/:id/roles` → `/users/{id}/roles` plus its parameter objects. */
function expressPathToOpenApi(path: string): { path: string; params: string[] } {
  const params: string[] = [];
  const converted = path.replace(/:([A-Za-z0-9_]+)/g, (_, name: string) => {
    params.push(name);
    return `{${name}}`;
  });
  return { path: converted, params };
}

type TaggedHandler = { __validationSchemas?: ValidationSchemas };
interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: TaggedHandler }>;
  };
}

export function buildOpenApiDoc(mounts: Array<[string, Router]>): Record<string, unknown> {
  const paths: Record<string, Record<string, OperationObject>> = {};

  for (const [prefix, router] of mounts) {
    const tag = prefix.split('/').filter(Boolean).pop() || 'root';
    const stack = (router as unknown as { stack: RouteLayer[] }).stack ?? [];

    for (const layer of stack) {
      if (!layer.route) continue;
      const { path, params } = expressPathToOpenApi(`${prefix}${layer.route.path === '/' ? '' : layer.route.path}`);
      const schemas = layer.route.stack
        .map(s => s.handle.__validationSchemas)
        .find(Boolean);

      for (const method of Object.keys(layer.route.methods)) {
        if (method === '_all') continue;
        const op: OperationObject = {
          summary: `${method.toUpperCase()} ${path}`,
          tags: [tag],
          responses: ENVELOPE_RESPONSES,
          security: [{ bearerAuth: [] }],
        };
        if (params.length) {
          op.parameters = params.map(name => ({
            name, in: 'path', required: true, schema: { type: 'string' },
          }));
        }
        if (schemas?.body && ['post', 'put', 'patch'].includes(method)) {
          op.requestBody = {
            required: true,
            content: { 'application/json': { schema: toJsonSchema(schemas.body) } },
          };
        }
        (paths[path] ??= {})[method] = op;
      }
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Attenda API',
      version: '1.0.0',
      description:
        'Generated from the live Express route table and zod validation schemas. ' +
        'All payloads are wrapped in a `{ success, data }` envelope; errors are ' +
        '`{ success: false, error, code, details? }`.',
    },
    servers: [{ url: '/', description: 'This deployment' }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      responses: {
        Error: {
          description: 'Error envelope',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', const: false },
                  error: { type: 'string' },
                  code: { type: 'string' },
                  details: {},
                },
                required: ['success', 'error'],
              },
            },
          },
        },
      },
    },
    paths,
  };
}
