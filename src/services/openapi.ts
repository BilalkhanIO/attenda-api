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

const envelopeResponses = (dataSchema: Record<string, unknown> = {}) => ({
  '200': {
    description: 'Success envelope',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            success: { type: 'boolean', const: true },
            data: dataSchema,
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
});

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

type OpenApiMetadata = {
  auth?: 'required' | 'optional';
  permissions?: string[];
  features?: string[];
  roles?: string[];
};
type TaggedHandler = {
  __validationSchemas?: ValidationSchemas;
  __openapiResponseSchema?: ZodType;
  __openapi?: OpenApiMetadata;
};
interface RouteLayer {
  handle?: TaggedHandler;
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
    // Router.use() middleware applies to every route in that router. Route
    // middleware is then merged in below for routes with per-operation guards.
    const routerMetadata = stack
      .filter(layer => !layer.route)
      .map(layer => layer.handle?.__openapi)
      .filter((metadata): metadata is OpenApiMetadata => !!metadata);

    for (const layer of stack) {
      if (!layer.route) continue;
      const { path, params } = expressPathToOpenApi(`${prefix}${layer.route.path === '/' ? '' : layer.route.path}`);
      const routeMetadata = layer.route.stack.flatMap(item => {
        const metadata = item.handle.__openapi;
        return metadata ? [metadata] : [];
      });
      const metadata = [...routerMetadata, ...routeMetadata];
      const requiresAuth = metadata.some(item => item.auth === 'required');
      const allowsOptionalAuth = metadata.some(item => item.auth === 'optional') && !requiresAuth;
      const permissions = [...new Set(metadata.flatMap(item => item.permissions ?? []))].sort();
      const features = [...new Set(metadata.flatMap(item => item.features ?? []))].sort();
      const roles = [...new Set(metadata.flatMap(item => item.roles ?? []))].sort();
      const schemas = layer.route.stack
        .map(s => s.handle.__validationSchemas)
        .find(Boolean);
      const responseSchema = layer.route.stack
        .map(s => s.handle.__openapiResponseSchema)
        .find(Boolean);

      for (const method of Object.keys(layer.route.methods)) {
        if (method === '_all') continue;
        const op: OperationObject = {
          summary: `${method.toUpperCase()} ${path}`,
          tags: [tag],
          responses: envelopeResponses(responseSchema ? toJsonSchema(responseSchema) : {}),
        };
        if (requiresAuth) op.security = [{ bearerAuth: [] }];
        else if (allowsOptionalAuth) op.security = [{}, { bearerAuth: [] }];
        if (permissions.length) {
          (op as OperationObject & Record<string, unknown>)['x-required-permissions'] = permissions;
          (op as OperationObject & Record<string, unknown>)['x-permission-match'] = 'any';
        }
        if (features.length) {
          (op as OperationObject & Record<string, unknown>)['x-required-features'] = features;
          (op as OperationObject & Record<string, unknown>)['x-feature-match'] = 'all';
        }
        if (roles.length) (op as OperationObject & Record<string, unknown>)['x-required-roles'] = roles;
        if (params.length) {
          op.parameters = params.map(name => ({
            name, in: 'path', required: true, schema: { type: 'string' },
          }));
        }
        if (schemas?.query) {
          const querySchema = toJsonSchema(schemas.query);
          const properties = querySchema.properties as Record<string, Record<string, unknown>> | undefined;
          const required = new Set(Array.isArray(querySchema.required) ? querySchema.required as string[] : []);
          const queryParameters = Object.entries(properties ?? {}).map(([name, schema]) => ({
            name,
            in: 'query',
            required: required.has(name),
            schema,
          }));
          op.parameters = [...(op.parameters ?? []), ...queryParameters];
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
