-- Fix demo seed org that was hardcoded to UTC.
-- Only touches the known seed row — real customer orgs are left to update
-- their own timezone via Settings → General.
UPDATE organisations
   SET timezone = 'Asia/Karachi'
 WHERE id = 'demo-org-001'
   AND timezone = 'UTC';
