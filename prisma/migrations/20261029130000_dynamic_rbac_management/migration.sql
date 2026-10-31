-- One-time bootstrap grants for administrators managing the new dynamic
-- permission editors. Runtime authorization continues to read persisted rows.
INSERT INTO permissions (key, module, description)
VALUES
  ('platform.roles.manage', 'platform', 'Manage platform roles and permissions'),
  ('org.roles.manage', 'org', 'Manage custom org roles'),
  ('org.permissions.grant', 'org', 'Grant per-user permission overrides')
ON CONFLICT (key) DO UPDATE
SET module = EXCLUDED.module, description = EXCLUDED.description;

INSERT INTO platform_role_permissions (platform_role_slug, permission_key)
SELECT r.slug, 'platform.roles.manage'
FROM platform_roles r
WHERE r.slug = 'platform_admin'
ON CONFLICT DO NOTHING;

INSERT INTO org_role_permissions (org_role_id, permission_key)
SELECT r.id, p.key
FROM org_roles r
CROSS JOIN permissions p
WHERE r.slug = 'super_admin'
  AND r.is_system = TRUE
  AND p.key IN ('org.roles.manage', 'org.permissions.grant')
ON CONFLICT DO NOTHING;
