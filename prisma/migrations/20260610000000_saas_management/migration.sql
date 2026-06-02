-- Subscription management fields on organisations
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(30) NOT NULL DEFAULT 'active';
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMPTZ;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS seats_limit INT;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS features_override JSONB;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS admin_notes TEXT;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS billing_email VARCHAR(255);

-- Plan definitions — editable by platform admin
CREATE TABLE IF NOT EXISTS plan_definitions (
  id              VARCHAR(50)  PRIMARY KEY,
  display_name    VARCHAR(100) NOT NULL,
  price_monthly   DECIMAL(10,2) NOT NULL DEFAULT 0,
  price_annual    DECIMAL(10,2) NOT NULL DEFAULT 0,
  max_employees   INT NOT NULL DEFAULT 0,
  trial_days      INT NOT NULL DEFAULT 14,
  features        JSONB NOT NULL DEFAULT '{}',
  description     TEXT,
  highlight       BOOLEAN NOT NULL DEFAULT FALSE,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order      INT NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Blog posts
CREATE TABLE IF NOT EXISTS blog_posts (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  slug             VARCHAR(255) UNIQUE NOT NULL,
  title            VARCHAR(500) NOT NULL,
  excerpt          TEXT,
  content          TEXT NOT NULL DEFAULT '',
  author_name      VARCHAR(255) NOT NULL DEFAULT 'Attenda Team',
  author_avatar    VARCHAR(500),
  cover_image      VARCHAR(500),
  tags             TEXT[] DEFAULT '{}',
  meta_title       VARCHAR(500),
  meta_description TEXT,
  og_image         VARCHAR(500),
  is_published     BOOLEAN NOT NULL DEFAULT FALSE,
  published_at     TIMESTAMPTZ,
  read_time_mins   INT,
  views            INT NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
