import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { logger, requestContext } from './logger';

// Queries slower than this are logged with duration + model/operation so
// production slowness is visible without extra tooling. Override per-env.
const SLOW_QUERY_MS = Number(process.env.SLOW_QUERY_MS) || 500;

const createPrismaClient = () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  const client = new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });

  return client.$extends({
    query: {
      $allOperations({ model, operation, args, query }) {
        const start = Date.now();
        return query(args).finally(() => {
          const ms = Date.now() - start;
          if (ms >= SLOW_QUERY_MS) {
            logger.warn(
              { model, operation, ms, request_id: requestContext.getStore()?.requestId },
              'slow prisma query',
            );
          }
        });
      },
    },
  }) as unknown as PrismaClient;
};

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export default prisma;
