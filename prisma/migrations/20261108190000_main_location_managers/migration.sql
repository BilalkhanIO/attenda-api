-- Seed each branch's Main office with the organization's location-view managers.
-- Permission assignments are resolved from the dynamic org-role relation.
INSERT INTO "location_managers" ("location_id", "user_id")
SELECT l."id", ur."user_id"
FROM "locations" l
JOIN "org_roles" r ON r."org_id" = l."org_id"
JOIN "user_org_roles" ur ON ur."org_role_id" = r."id"
JOIN "org_role_permissions" rp ON rp."org_role_id" = r."id" AND rp."permission_key" = 'org.locations.view'
WHERE l."is_main" = true
ON CONFLICT ("location_id", "user_id") DO NOTHING;
