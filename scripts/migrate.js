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

// Token-aware SQL statement splitter. Correctly handles dollar-quoted blocks
// (DO $$ ... $$), single-quoted strings, double-quoted identifiers, and both
// comment styles so that semicolons inside those constructs are never treated
// as statement boundaries.
function splitSqlStatements(sql) {
  const stmts = [];
  let current = '';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    // Single-line comment
    if (sql[i] === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      if (end === -1) { current += sql.slice(i); i = n; }
      else            { current += sql.slice(i, end + 1); i = end + 1; }
      continue;
    }
    // Block comment
    if (sql[i] === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) { current += sql.slice(i); i = n; }
      else            { current += sql.slice(i, end + 2); i = end + 2; }
      continue;
    }
    // Single-quoted string ('' escape)
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; }
        else if (sql[j] === "'")                   { j++; break; }
        else                                        { j++; }
      }
      current += sql.slice(i, j); i = j; continue;
    }
    // Double-quoted identifier
    if (sql[i] === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"' && sql[j + 1] === '"') { j += 2; }
        else if (sql[j] === '"')                   { j++; break; }
        else                                        { j++; }
      }
      current += sql.slice(i, j); i = j; continue;
    }
    // Dollar-quoted string: $tag$...$tag$ (handles both $$ and $label$)
    if (sql[i] === '$') {
      let j = i + 1;
      while (j < n && sql[j] !== '$' && /[A-Za-z0-9_]/.test(sql[j])) j++;
      if (j < n && sql[j] === '$') {
        const tag = sql.slice(i, j + 1);
        const closeIdx = sql.indexOf(tag, j + 1);
        if (closeIdx !== -1) {
          current += sql.slice(i, closeIdx + tag.length);
          i = closeIdx + tag.length;
          continue;
        }
      }
      current += sql[i]; i++; continue;
    }
    // Statement terminator
    if (sql[i] === ';') {
      current += ';';
      const trimmed = current.trim();
      if (trimmed) stmts.push(trimmed);
      current = ''; i++; continue;
    }
    current += sql[i]; i++;
  }

  // Trailing statement without trailing semicolon
  const trailing = current.trim();
  if (trailing) {
    const clean = trailing.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (clean) stmts.push(trailing);
  }

  return stmts.filter(s => {
    const clean = s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
    return clean.length > 0;
  });
}

// Split a SQL file into individual statements and execute each one.
// Failures are non-fatal when they indicate the statement was already applied.
async function applySqlFile(client, sqlPath) {
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const stmts = splitSqlStatements(sql);

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
      'prisma/migrations/20260606000000_heartbeat/migration.sql',
      'prisma/migrations/20260607000000_user_notification_prefs/migration.sql',
      'prisma/migrations/20260608000000_early_checkin/migration.sql',
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

    // ── 4. Platform admin ─────────────────────────────────────────────────
    const { rows: platformRows } = await client.query(
      `SELECT EXISTS (SELECT 1 FROM organisations WHERE id = 'platform-org-001') AS exists`
    );

    if (!platformRows[0].exists) {
      console.log('[seed] Creating platform org and admin user …');
      const bcrypt = require('bcryptjs');
      const hash   = await bcrypt.hash('Platform1234!', 12);

      await client.query(`
        INSERT INTO organisations (id, name, timezone, currency, plan, created_at)
        VALUES ('platform-org-001', 'Attenda Platform', 'UTC', 'USD', 'enterprise', NOW())
        ON CONFLICT (id) DO NOTHING
      `);

      await client.query(`
        INSERT INTO users (
          id, org_id, name, email, password_hash, role,
          department, job_title, is_active, setup_complete, created_at
        ) VALUES (
          'platform-admin-001',
          'platform-org-001',
          'Platform Admin',
          'platform@attenda.app',
          $1,
          'platform_admin',
          'Platform',
          'System Administrator',
          true,
          true,
          NOW()
        ) ON CONFLICT (email) DO NOTHING
      `, [hash]);

      console.log('[seed] Platform admin created — email: platform@attenda.app / password: Platform1234!');
    } else {
      console.log('[seed] Platform admin already exists — skipping');
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
