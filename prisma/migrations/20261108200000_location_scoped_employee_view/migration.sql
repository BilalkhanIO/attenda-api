INSERT INTO "permissions" ("key", "module", "description")
VALUES ('employees.view_location', 'employees', 'View employees assigned to managed locations')
ON CONFLICT ("key") DO UPDATE SET "module" = EXCLUDED."module", "description" = EXCLUDED."description";

INSERT INTO "org_role_permissions" ("org_role_id", "permission_key")
SELECT r."id", 'employees.view_location'
FROM "org_roles" r
WHERE r."slug" IN ('manager', 'hr_admin', 'super_admin')
ON CONFLICT DO NOTHING;
