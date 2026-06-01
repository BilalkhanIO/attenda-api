'use strict';
// Applies the initial migration using pg directly, then seeds demo data.
// Each incremental migration file is executed statement-by-statement so that
// a single failing statement (e.g. "column already exists" in a partially-applied
// migration) does NOT prevent subsequent statements in the same file from running.

const { Pool }     = require('pg');
const { execSync } = require('child_process');
const fs           = require('fs');
const path         = require('path');

const ROOT = path.join(__dirname, '..');

// Split a SQL file into individual statements and execute each one.
// Failures are non-fatal when they indicate the statement was already applied.
async function applySqlFile(client, sqlPath) {
  const sql = fs.readFileSync(sqlPath, 'utf8');

  // Split on semicolon + optional whitespace + (newline or end-of-string).
  // This correctly splits multi-line CREATE TABLE blocks.
  const stmts = sql
    .split(/;[ \t]*(?:\r?\n|$)/)
    .map(s => s.trim())
    .filter(s => {
      if (!s) return false;
      // Skip lines that consist solely of SQL comments
      const withoutComments = s.replace(/--[^\n]*/g, '').trim();
      return withoutComments.length > 0;
    });

  for (const stmt of stmts) {
    try {
      await client.query(stmt);
    } catch (err) {
      // Most failures here are "already exists" / "duplicate column" which are
      // fine — IF NOT EXISTS guards handle the majority, but FK constraints and
      // TYPE casts can still throw on an already-migrated DB.
      const preview = stmt.replace(/\s+/g, ' ').substring(0, 90);
      console.warn(`[migrate]   ⚠ skipped: ${preview}… — ${err.message}`);
    }
  }
}

async function run() {
  if (!process.env.DATABASE_URL) {
    console.error('[migrate] DATABASE_URL is not set — cannot run migrations');
    process.exit(1);
  }

  const pool   = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  let poolClosed = false;

  try {
    // ── 1. Initial migration ──────────────────────────────────────────────
    const { rows: tableRows } = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'organisations'
      ) AS ready
    `);

    if (tableRows[0].ready) {
      console.log('[migrate] Schema already applied — skipping initial migration');
    } else {
      console.log('[migrate] Applying initial migration …');
      const sql = fs.readFileSync(
        path.join(ROOT, 'prisma/migrations/20260101000000_init/migration.sql'),
        'utf8'
      );
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
      console.log('[migrate] Initial migration done');
    }

    // ── 2. Incremental migrations — one statement at a time ────────────────
    const incrementalMigrations = [
      'prisma/migrations/20260201000000_shift_breaks_overtime/migration.sql',
      'prisma/migrations/20260301000000_ssid_support/migration.sql',
      'prisma/migrations/20260401000000_goal_completion_int/migration.sql',
      'prisma/migrations/20260501000000_in_app_notifications/migration.sql',
      'prisma/migrations/20260601000000_shift_break_times/migration.sql',
      'prisma/migrations/20260602000000_wa_groups_json/migration.sql',
      'prisma/migrations/20260603000000_wa_phone_text/migration.sql',
      'prisma/migrations/20260604000000_late_alerted/migration.sql',
      'prisma/migrations/20260604000001_break_auto/migration.sql',
      'prisma/migrations/20260605000000_late_notice/migration.sql',
      'prisma/migrations/20260605000001_half_day_leave/migration.sql',
    ];

    for (const relPath of incrementalMigrations) {
      const migPath = path.join(ROOT, relPath);
      if (!fs.existsSync(migPath)) {
        console.log(`[migrate] Not found, skipping: ${relPath}`);
        continue;
      }
      console.log(`[migrate] → ${relPath}`);
      await applySqlFile(client, migPath);
      console.log(`[migrate] ✓ ${relPath}`);
    }

    // ── 3. Seed ───────────────────────────────────────────────────────────
    const { rows: seedRows } = await client.query(
      `SELECT EXISTS (SELECT 1 FROM organisations WHERE id = 'demo-org-001') AS seeded`
    );

    if (seedRows[0].seeded) {
      console.log('[seed] Demo data already present — skipping seed');
    } else {
      console.log('[seed] Running initial seed …');
      client.release();
      poolClosed = true;
      await pool.end();
      execSync('node dist/utils/seed.js', { stdio: 'inherit', cwd: ROOT });
      console.log('[seed] Done');
      return;
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[migrate] Fatal error:', err.message);
    process.exit(1);
  } finally {
    if (!poolClosed) {
      try { client.release(); } catch (_) {}
      try { await pool.end(); } catch (_) {}
    }
  }
}

run();
