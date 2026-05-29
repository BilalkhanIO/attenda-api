'use strict';
// Applies the initial migration using pg directly.
// Prisma Migrate (migrate deploy) doesn't work reliably with the
// PrismaPg driver-adapter in Prisma 7 — this script is the safe alternative.
const { Pool } = require('pg');
const fs       = require('fs');
const path     = require('path');

async function run() {
  if (!process.env.DATABASE_URL) {
    console.error('[migrate] DATABASE_URL is not set — cannot run migrations');
    process.exit(1);
  }

  const pool   = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    // If the organisations table exists the schema is already applied.
    const { rows } = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'organisations'
      ) AS ready
    `);

    if (rows[0].ready) {
      console.log('[migrate] Schema already applied — skipping');
      return;
    }

    console.log('[migrate] Applying initial migration …');
    const sql = fs.readFileSync(
      path.join(__dirname, '../prisma/migrations/20260101000000_init/migration.sql'),
      'utf8'
    );

    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log('[migrate] Done — all tables created');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[migrate] Failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
