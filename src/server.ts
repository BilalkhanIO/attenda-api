import 'dotenv/config';
import app from './app';
import prisma from './utils/prisma';
import { startAllJobs } from './jobs/scheduler';
import { logger } from './utils/logger';

const PORT = parseInt(process.env.PORT || '5000');

async function main() {
  try {
    // Test DB connection
    await prisma.$connect();
    console.log('✅ Database connected');

    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Attenda API running on http://0.0.0.0:${PORT}`);
      console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`   API Base:    /api/v1`);
    });

    // Start background jobs
    if (process.env.NODE_ENV !== 'test') {
      startAllJobs();

      // Self-heal RBAC seed data. Production deployments run SQL migrations
      // only (scripts/migrate.js) and never the demo seed, so the permission
      // catalog, platform roles, and platform-admin role assignments can be
      // missing — which makes every permission-gated /admin route 403 for
      // legitimate platform admins. All three seeders are idempotent upserts.
      (async () => {
        const { seedRbacCatalog, seedPlatformUserRoles } = await import('./utils/rbac-seed');
        await seedRbacCatalog();
        await seedPlatformUserRoles();
        logger.info('RBAC catalog + platform role assignments verified');
      })().catch(err => logger.error({ err }, 'RBAC self-heal failed'));
    }

    // ─── Graceful shutdown ─────────────────────────────
    const shutdown = async (signal: string) => {
      console.log(`\n${signal} received. Shutting down gracefully...`);
      server.close(async () => {
        await prisma.$disconnect();
        console.log('Database disconnected. Server closed.');
        process.exit(0);
      });
      // Force shutdown after 10s
      setTimeout(() => process.exit(1), 10_000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));

    process.on('unhandledRejection', (reason) => {
      console.error('Unhandled Rejection:', reason);
    });

  } catch (err) {
    console.error('❌ Failed to start server:', err);
    await prisma.$disconnect();
    process.exit(1);
  }
}

main();
