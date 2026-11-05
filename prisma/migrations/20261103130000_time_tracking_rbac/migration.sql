INSERT INTO "permissions" ("key", "module", "description") VALUES
  ('time.view', 'time', 'View and manage own project time entries'),
  ('time.view_team', 'time', 'View team project time and reports'),
  ('time.approve', 'time', 'Review and lock submitted timesheets')
ON CONFLICT ("key") DO NOTHING;

-- Only add newly introduced capabilities to the built-in org roles. Existing
-- custom role grants and unrelated administrator edits are left untouched.
INSERT INTO "org_role_permissions" ("org_role_id", "permission_key")
SELECT r."id", 'time.view' FROM "org_roles" r
WHERE r."slug" IN ('employee', 'manager', 'hr_admin', 'super_admin')
ON CONFLICT DO NOTHING;

INSERT INTO "org_role_permissions" ("org_role_id", "permission_key")
SELECT r."id", 'time.view_team' FROM "org_roles" r
WHERE r."slug" IN ('manager', 'hr_admin', 'super_admin')
ON CONFLICT DO NOTHING;

INSERT INTO "org_role_permissions" ("org_role_id", "permission_key")
SELECT r."id", 'time.approve' FROM "org_roles" r
WHERE r."slug" IN ('manager', 'hr_admin', 'super_admin')
ON CONFLICT DO NOTHING;
