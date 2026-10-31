import 'dotenv/config';
import app from './app';
import prisma from './utils/prisma';
import { startAllJobs } from './jobs/scheduler';
import { registerWebhookFanout } from './services/webhookDelivery';
import { startOrgEventBus, stopOrgEventBus } from './services/notifications';
import { logger } from './utils/logger';

const PORT = parseInt(process.env.PORT || '5000');

async function main() {
  try {
    // Test DB connection
    await prisma.$connect();
    console.log('✅ Database connected');

    if (process.env.NODE_ENV !== 'test') {
      // Complete safe, non-destructive RBAC bootstrap before accepting traffic.
      // Permission checks are DB-driven; requests must not race role seeding.
      const { seedAllRbac } = await import('./utils/rbac-seed');
      await seedAllRbac();
      logger.info('RBAC catalog, role defaults, and missing assignments verified');
      await startOrgEventBus();
    }

    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Attenda API running on http://0.0.0.0:${PORT}`);
      console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`   API Base:    /api/v1`);
    });

    // Start background jobs
    if (process.env.NODE_ENV !== 'test') {
      startAllJobs();
      registerWebhookFanout();
    }

    // ─── Graceful shutdown ─────────────────────────────
    const shutdown = async (signal: string) => {
      console.log(`\n${signal} received. Shutting down gracefully...`);
      server.close(async () => {
        await stopOrgEventBus();
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
