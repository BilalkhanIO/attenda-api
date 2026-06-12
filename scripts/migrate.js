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
      'prisma/migrations/20260609000000_org_onboarding/migration.sql',
      'prisma/migrations/20260610000000_saas_management/migration.sql',
      'prisma/migrations/20260611000000_fix_org_timezone/migration.sql',
      'prisma/migrations/20260612000000_absent_alerted/migration.sql',
      'prisma/migrations/20260613000000_shift_is_org_wide/migration.sql',
      'prisma/migrations/20260614000000_attendance_extra_minutes/migration.sql',
      'prisma/migrations/20260613000000_mid_shift_leave_times/migration.sql',
      'prisma/migrations/20260614000000_dynamic_rbac/migration.sql',
      'prisma/migrations/20260615000000_shift_break_policies/migration.sql',
      'prisma/migrations/20260616000000_shift_is_default/migration.sql',
      'prisma/migrations/20260617000000_break_late_return/migration.sql',
      'prisma/migrations/20260618000000_shift_break_auto_start/migration.sql',
      'prisma/migrations/20260619000000_totp_required/migration.sql',
      'prisma/migrations/20260620000000_departments_user_org_details/migration.sql',
      'prisma/migrations/20260621000000_heartbeat_grace/migration.sql',
      'prisma/migrations/20260622000000_refresh_token_rotation/migration.sql',
      'prisma/migrations/20260623000000_audit_logs/migration.sql',
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
        VALUES ('platform-org-001', 'Attenda Platform', 'Asia/Karachi', 'USD', 'enterprise', NOW())
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

    // ── 5. Default plan definitions ───────────────────────────────────────
    const { rows: planRows } = await client.query(
      `SELECT EXISTS (SELECT 1 FROM plan_definitions WHERE id = 'starter') AS seeded`
    );

    if (!planRows[0].seeded) {
      console.log('[seed] Seeding default plan definitions …');
      const plans = [
        {
          id: 'starter',
          display_name: 'Starter',
          price_monthly: 0,
          price_annual: 0,
          max_employees: 10,
          trial_days: 14,
          description: 'Perfect for small teams getting started with attendance management.',
          highlight: false,
          is_active: true,
          sort_order: 1,
          features: {
            attendance: true,
            leave_management: true,
            shifts: false,
            payroll: false,
            whatsapp: false,
            performance_reviews: false,
            remote_work: false,
            api_access: false,
            advanced_reports: false,
            multi_location: false,
          },
        },
        {
          id: 'growth',
          display_name: 'Growth',
          price_monthly: 29,
          price_annual: 290,
          max_employees: 50,
          trial_days: 14,
          description: 'For growing businesses that need more power and flexibility.',
          highlight: true,
          is_active: true,
          sort_order: 2,
          features: {
            attendance: true,
            leave_management: true,
            shifts: true,
            payroll: true,
            whatsapp: false,
            performance_reviews: false,
            remote_work: true,
            api_access: false,
            advanced_reports: true,
            multi_location: false,
          },
        },
        {
          id: 'business',
          display_name: 'Business',
          price_monthly: 79,
          price_annual: 790,
          max_employees: 200,
          trial_days: 14,
          description: 'Everything you need to run a mid-size workforce smoothly.',
          highlight: false,
          is_active: true,
          sort_order: 3,
          features: {
            attendance: true,
            leave_management: true,
            shifts: true,
            payroll: true,
            whatsapp: true,
            performance_reviews: true,
            remote_work: true,
            api_access: false,
            advanced_reports: true,
            multi_location: true,
          },
        },
        {
          id: 'enterprise',
          display_name: 'Enterprise',
          price_monthly: 0,
          price_annual: 0,
          max_employees: 0,
          trial_days: 30,
          description: 'Custom pricing and unlimited scale for large organisations.',
          highlight: false,
          is_active: true,
          sort_order: 4,
          features: {
            attendance: true,
            leave_management: true,
            shifts: true,
            payroll: true,
            whatsapp: true,
            performance_reviews: true,
            remote_work: true,
            api_access: true,
            advanced_reports: true,
            multi_location: true,
          },
        },
      ];

      for (const p of plans) {
        await client.query(
          `INSERT INTO plan_definitions
             (id, display_name, price_monthly, price_annual, max_employees, trial_days,
              features, description, highlight, is_active, sort_order, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
           ON CONFLICT (id) DO NOTHING`,
          [p.id, p.display_name, p.price_monthly, p.price_annual, p.max_employees,
           p.trial_days, JSON.stringify(p.features), p.description, p.highlight,
           p.is_active, p.sort_order]
        );
      }
      console.log('[seed] Default plans seeded');
    } else {
      console.log('[seed] Plans already present — skipping');
    }

    // ── 6. Sample blog posts ──────────────────────────────────────────────
    const { rows: blogRows } = await client.query(
      `SELECT EXISTS (SELECT 1 FROM blog_posts WHERE slug = 'what-is-attendance-management') AS seeded`
    );

    if (!blogRows[0].seeded) {
      console.log('[seed] Seeding sample blog posts …');
      const posts = [
        {
          slug: 'what-is-attendance-management',
          title: 'What Is Attendance Management and Why Does It Matter in 2026?',
          excerpt: 'Discover how modern attendance management systems save businesses time, reduce payroll errors, and keep employees accountable — all from one dashboard.',
          content: `## The Hidden Cost of Manual Attendance Tracking

Every minute your HR team spends manually cross-referencing timesheets is a minute not spent on strategic work. Studies show that companies with more than 50 employees lose an average of $50,000 per year to time-theft and manual data-entry errors alone.

## What Is Attendance Management?

Attendance management is the systematic process of tracking when employees start and end their working day, managing leaves, and ensuring compliance with labour laws. Modern systems automate this entirely — replacing paper registers and spreadsheets with real-time digital records.

## Key Features of a Modern Attendance System

- **Automated check-in / check-out** via GPS, WiFi, or biometrics
- **Leave management** integrated with attendance data
- **Shift scheduling** that syncs directly with attendance
- **Payroll integration** that calculates hours automatically
- **Real-time dashboards** for managers

## Why Attenda?

Attenda was built for teams that need reliability without complexity. Whether you have 5 employees or 500, Attenda scales with you — and our 14-day free trial means you can try it risk-free.`,
          author_name: 'Attenda Team',
          tags: ['attendance', 'HR', 'productivity', 'workforce management'],
          meta_title: 'What Is Attendance Management? Complete Guide 2026 | Attenda',
          meta_description: 'Learn what attendance management is, why it matters, and how modern software like Attenda saves businesses thousands of dollars per year.',
          is_published: true,
          read_time_mins: 5,
        },
        {
          slug: 'reduce-absenteeism-small-business',
          title: '7 Proven Ways to Reduce Absenteeism in Small Businesses',
          excerpt: 'Unplanned absences cost small businesses more than large ones. Here are 7 evidence-backed strategies to improve attendance without micromanaging your team.',
          content: `## Why Absenteeism Hits Small Businesses Harder

When a single employee is absent in a team of 10, you lose 10% of your capacity overnight. For large companies, one absence barely registers. For small businesses, it can delay customer deliverables and create stress across the entire team.

## 7 Strategies That Work

### 1. Make Attendance Visible
When employees can see their own attendance record at a glance — including late arrivals and early check-outs — behaviour changes. Transparency is a powerful motivator.

### 2. Track Patterns, Not Just Incidents
Chronic absenteeism often follows patterns (Monday mornings, certain shifts). Use data to spot these before they become a problem.

### 3. Flexible Scheduling
Rigidity causes absenteeism. Where the role allows, offer shift flexibility so employees don't choose "sick day" as their only option.

### 4. Early Notification System
Attenda sends managers instant notifications when an employee is late or absent. Early awareness means you can act before the whole day is disrupted.

### 5. Leave Management That's Fair
When employees trust that leave requests are handled fairly and quickly, they're more likely to use official leave rather than going absent without notice.

### 6. Return-to-Work Conversations
Brief, non-punitive conversations after absences signal that you noticed and you care — without being intimidating.

### 7. Reward Good Attendance
Recognition matters. A simple monthly acknowledgement of perfect attendance costs nothing and builds a culture of reliability.

## Start Today

Attenda's dashboard shows you live attendance, patterns, and alerts — all in one place. Start your 14-day free trial now.`,
          author_name: 'Attenda Team',
          tags: ['absenteeism', 'HR strategy', 'small business', 'employee management'],
          meta_title: '7 Ways to Reduce Absenteeism in Small Businesses | Attenda',
          meta_description: 'Practical, evidence-based strategies to reduce employee absenteeism in small businesses — plus how attendance software makes it effortless.',
          is_published: true,
          read_time_mins: 6,
        },
        {
          slug: 'shift-scheduling-best-practices',
          title: 'Shift Scheduling Best Practices: A Manager\'s Complete Guide',
          excerpt: 'Good shift scheduling increases employee satisfaction, reduces overtime costs, and keeps operations running smoothly. Here\'s everything you need to know.',
          content: `## Why Shift Scheduling Matters More Than You Think

Bad scheduling is one of the top reasons employees quit. Unpredictable hours, last-minute changes, and unfair distribution of weekend shifts create resentment that no pay rise can fix.

## Core Principles of Effective Scheduling

### Balance Is Everything
Distribute desirable and undesirable shifts fairly. Rotating weekends, holiday coverage, and overnight shifts reduces the feeling that certain employees are always treated differently.

### Give Advance Notice
Publishing schedules at least two weeks in advance allows employees to plan their lives — and dramatically reduces last-minute call-outs.

### Match Skills to Shifts
Not every shift has the same demands. Senior staff on closing shifts, experienced leads on the busiest periods — smart scheduling maximises your talent.

### Account for Rest Periods
Back-to-back closing and opening shifts (the "clopening") destroy morale and impair performance. Build minimum rest periods into your scheduling logic.

## How Attenda Helps

Attenda's shift management module lets you:
- Build shift templates and reuse them weekly
- Assign employees to shifts with conflict detection
- Receive automatic alerts when someone is late for their shift
- View attendance against scheduled hours in real time

## Getting Started

Schedule a demo or start your free trial to see Attenda's shift management in action.`,
          author_name: 'Attenda Team',
          tags: ['shift scheduling', 'workforce management', 'HR', 'operations'],
          meta_title: 'Shift Scheduling Best Practices: Manager\'s Guide 2026 | Attenda',
          meta_description: 'Learn the best practices for shift scheduling that improve employee satisfaction, reduce overtime, and keep your operations running smoothly.',
          is_published: true,
          read_time_mins: 7,
        },
      ];

      for (const post of posts) {
        await client.query(
          `INSERT INTO blog_posts
             (slug, title, excerpt, content, author_name, tags, meta_title,
              meta_description, is_published, read_time_mins, published_at, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW(),NOW())
           ON CONFLICT (slug) DO NOTHING`,
          [post.slug, post.title, post.excerpt, post.content, post.author_name,
           post.tags, post.meta_title, post.meta_description, post.is_published,
           post.read_time_mins]
        );
      }
      console.log('[seed] Sample blog posts seeded');
    } else {
      console.log('[seed] Blog posts already present — skipping');
    }

    // ── 7. Platform RBAC core (idempotent) ────────────────────────────────
    // Production never runs the demo seed, so without this the platform
    // roles/permissions tables stay empty and every permission-gated /admin
    // route 403s for legitimate platform admins. The API also self-heals at
    // boot; this covers the window between migrate and first boot.
    console.log('[seed] Ensuring platform RBAC core …');
    const platformPerms = [
      ['platform.orgs.view',    'View organisations'],
      ['platform.orgs.manage',  'Manage organisation subscriptions'],
      ['platform.orgs.approve', 'Approve pending organisations'],
      ['platform.plans.manage', 'Manage plan definitions'],
      ['platform.blog.manage',  'Manage blog posts'],
      ['platform.users.manage', 'Manage platform admin users'],
    ];
    for (const [key, description] of platformPerms) {
      await client.query(
        `INSERT INTO permissions (key, module, description) VALUES ($1, 'platform', $2)
         ON CONFLICT (key) DO NOTHING`,
        [key, description]
      );
    }
    await client.query(
      `INSERT INTO platform_roles (slug, name, description) VALUES
         ('platform_admin', 'Platform Admin', 'Full platform SaaS console access'),
         ('platform_assistant', 'Platform Assistant', 'Limited platform access (orgs view, blog)')
       ON CONFLICT (slug) DO NOTHING`
    );
    for (const [key] of platformPerms) {
      await client.query(
        `INSERT INTO platform_role_permissions (platform_role_slug, permission_key)
         VALUES ('platform_admin', $1) ON CONFLICT DO NOTHING`,
        [key]
      );
    }
    for (const key of ['platform.orgs.view', 'platform.blog.manage']) {
      await client.query(
        `INSERT INTO platform_role_permissions (platform_role_slug, permission_key)
         VALUES ('platform_assistant', $1) ON CONFLICT DO NOTHING`,
        [key]
      );
    }
    // Link every legacy platform admin (role column) to the platform_admin role
    await client.query(
      `INSERT INTO platform_user_roles (user_id, platform_role_slug)
       SELECT u.id, 'platform_admin' FROM users u
       WHERE u.role = 'platform_admin' AND u.deleted_at IS NULL
       ON CONFLICT DO NOTHING`
    );
    console.log('[seed] Platform RBAC core ensured');

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
