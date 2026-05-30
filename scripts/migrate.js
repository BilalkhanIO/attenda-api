'use strict';
// Applies the initial migration using pg directly, then seeds demo data.
// Prisma Migrate (migrate deploy) doesn't work reliably with the
// PrismaPg driver-adapter in Prisma 7 — this script is the safe alternative.
const { Pool }     = require('pg');
const { execSync } = require('child_process');
const fs           = require('fs');
const path         = require('path');

const ROOT = path.join(__dirname, '..');

async function run() {
  if (!process.env.DATABASE_URL) {
    console.error('[migrate] DATABASE_URL is not set — cannot run migrations');
    process.exit(1);
  }

  const pool   = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    // ── 1. Migration ──────────────────────────────────────────────────────────
    const { rows: tableRows } = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'organisations'
      ) AS ready
    `);

    if (tableRows[0].ready) {
      console.log('[migrate] Schema already applied — skipping migration');
    } else {
      console.log('[migrate] Applying initial migration …');
      const sql = fs.readFileSync(
        path.join(ROOT, 'prisma/migrations/20260101000000_init/migration.sql'),
        'utf8'
      );

      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
      console.log('[migrate] Done — all tables created');
    }

    // ── 2. Seed ───────────────────────────────────────────────────────────────
    // Run seed whenever demo org is missing, regardless of whether migration
    // just ran (tables may have been created by an earlier deploy without seed).
    const { rows: seedRows } = await client.query(
      `SELECT EXISTS (SELECT 1 FROM organisations WHERE id = 'demo-org-001') AS seeded`
    );

    if (seedRows[0].seeded) {
      console.log('[seed] Demo data already present — skipping seed');
    } else {
      console.log('[seed] Running initial seed …');
      client.release();
      await pool.end();
      execSync('node dist/utils/seed.js', { stdio: 'inherit', cwd: ROOT });
      console.log('[seed] Done');
      return; // pool already closed above
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[migrate] Failed:', err.message);
    process.exit(1);
  } finally {
    try { client.release(); } catch (_) {}
    try { await pool.end(); } catch (_) {}
  }
}

run();
