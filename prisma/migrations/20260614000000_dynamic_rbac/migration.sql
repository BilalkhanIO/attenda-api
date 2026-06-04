-- Dynamic RBAC: permission catalog, org roles, grants, platform roles

CREATE TABLE IF NOT EXISTS permissions (
  key         VARCHAR(100) PRIMARY KEY,
  module      VARCHAR(50)  NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS org_roles (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name       VARCHAR(100) NOT NULL,
  slug       VARCHAR(50)  NOT NULL,
  is_system  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, slug)
);

CREATE TABLE IF NOT EXISTS org_role_permissions (
  org_role_id    UUID NOT NULL REFERENCES org_roles(id) ON DELETE CASCADE,
  permission_key VARCHAR(100) NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (org_role_id, permission_key)
);

CREATE TABLE IF NOT EXISTS user_org_roles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  org_role_id UUID NOT NULL REFERENCES org_roles(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_permission_grants (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id         UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  permission_key VARCHAR(100) NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  effect         VARCHAR(10) NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, permission_key)
);

CREATE TABLE IF NOT EXISTS platform_roles (
  slug        VARCHAR(50) PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS platform_role_permissions (
  platform_role_slug VARCHAR(50) NOT NULL REFERENCES platform_roles(slug) ON DELETE CASCADE,
  permission_key     VARCHAR(100) NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (platform_role_slug, permission_key)
);

CREATE TABLE IF NOT EXISTS platform_user_roles (
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform_role_slug VARCHAR(50) NOT NULL REFERENCES platform_roles(slug) ON DELETE CASCADE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, platform_role_slug)
);

CREATE INDEX IF NOT EXISTS idx_org_roles_org_id ON org_roles(org_id);
CREATE INDEX IF NOT EXISTS idx_user_permission_grants_org_id ON user_permission_grants(org_id);
