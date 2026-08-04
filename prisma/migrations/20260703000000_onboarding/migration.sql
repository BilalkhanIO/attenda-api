CREATE TABLE IF NOT EXISTS "onboarding_templates" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "is_default" BOOLEAN NOT NULL DEFAULT false,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at" TIMESTAMP(3),
  CONSTRAINT "onboarding_templates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "onboarding_templates_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "onboarding_templates_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "onboarding_templates_org_id_idx" ON "onboarding_templates"("org_id");

CREATE TABLE IF NOT EXISTS "onboarding_template_items" (
  "id" TEXT NOT NULL,
  "template_id" TEXT NOT NULL,
  "title" VARCHAR(200) NOT NULL,
  "description" TEXT,
  "due_days" INTEGER,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "assignee_role" VARCHAR(20) NOT NULL DEFAULT 'employee',
  CONSTRAINT "onboarding_template_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "onboarding_template_items_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "onboarding_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "onboarding_tasks" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "item_title" VARCHAR(200) NOT NULL,
  "item_description" TEXT,
  "assignee_id" TEXT NOT NULL,
  "due_date" DATE,
  "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
  "completed_at" TIMESTAMP(3),
  "completed_by" TEXT,
  "template_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "onboarding_tasks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "onboarding_tasks_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "onboarding_tasks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "onboarding_tasks_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "onboarding_tasks_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "onboarding_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "onboarding_tasks_org_id_user_id_idx" ON "onboarding_tasks"("org_id", "user_id");
CREATE INDEX IF NOT EXISTS "onboarding_tasks_assignee_id_status_idx" ON "onboarding_tasks"("assignee_id", "status");
