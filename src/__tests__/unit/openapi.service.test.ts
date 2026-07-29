import express from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate';
import { buildOpenApiDoc } from '../../services/openapi';

describe('buildOpenApiDoc', () => {
  const router = express.Router();
  router.get('/', (_req, res) => { res.end(); });
  router.post('/', validate({ body: z.object({ name: z.string().min(1) }) }), (_req, res) => { res.end(); });
  router.put('/:id/approve', (_req, res) => { res.end(); });

  const doc = buildOpenApiDoc([['/api/v1/widgets', router]]) as {
    openapi: string;
    paths: Record<string, Record<string, {
      tags: string[];
      parameters?: Array<{ name: string; in: string }>;
      requestBody?: { content: { 'application/json': { schema: { properties?: Record<string, unknown>; required?: string[] } } } };
    }>>;
  };

  it('emits an OpenAPI 3.1 document with every route', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths).sort()).toEqual([
      '/api/v1/widgets',
      '/api/v1/widgets/{id}/approve',
    ]);
    expect(Object.keys(doc.paths['/api/v1/widgets']).sort()).toEqual(['get', 'post']);
  });

  it('converts :params to path parameters', () => {
    const op = doc.paths['/api/v1/widgets/{id}/approve'].put;
    expect(op.parameters).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
    ]);
  });

  it('attaches the zod body schema from validate() middleware', () => {
    const body = doc.paths['/api/v1/widgets'].post.requestBody!;
    const schema = body.content['application/json'].schema;
    expect(schema.properties).toHaveProperty('name');
    expect(schema.required).toContain('name');
  });

  it('tags operations with the mount segment', () => {
    expect(doc.paths['/api/v1/widgets'].get.tags).toEqual(['widgets']);
  });
});
