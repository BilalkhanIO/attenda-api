CREATE TABLE IF NOT EXISTS "projects" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "owner_id" TEXT NOT NULL,
  "name" VARCHAR(180) NOT NULL,
  "description" TEXT,
  "status" VARCHAR(30) NOT NULL DEFAULT 'planning',
  "priority" VARCHAR(20) NOT NULL DEFAULT 'medium',
  "start_date" DATE,
  "due_date" DATE,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "project_members" (
  "project_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "role" VARCHAR(30) NOT NULL DEFAULT 'member',
  "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_members_pkey" PRIMARY KEY ("project_id", "user_id")
);

CREATE TABLE IF NOT EXISTS "project_tasks" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "assignee_id" TEXT,
  "created_by" TEXT NOT NULL,
  "title" VARCHAR(220) NOT NULL,
  "description" TEXT,
  "status" VARCHAR(30) NOT NULL DEFAULT 'todo',
  "priority" VARCHAR(20) NOT NULL DEFAULT 'medium',
  "due_date" DATE,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_tasks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "projects_org_id_status_idx" ON "projects"("org_id", "status");
CREATE INDEX IF NOT EXISTS "project_members_user_id_idx" ON "project_members"("user_id");
CREATE INDEX IF NOT EXISTS "project_tasks_project_id_status_idx" ON "project_tasks"("project_id", "status");
CREATE INDEX IF NOT EXISTS "project_tasks_assignee_id_status_idx" ON "project_tasks"("assignee_id", "status");

ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
