CREATE TABLE IF NOT EXISTS "employee_documents" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "title" VARCHAR(200) NOT NULL,
  "category" VARCHAR(50) NOT NULL,
  "file_key" TEXT NOT NULL,
  "file_name" TEXT NOT NULL,
  "file_size" INTEGER NOT NULL,
  "mime_type" VARCHAR(100) NOT NULL,
  "expires_at" DATE,
  "uploaded_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at" TIMESTAMP(3),
  CONSTRAINT "employee_documents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "employee_documents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "employee_documents_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "employee_documents_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "employee_documents_org_id_user_id_idx" ON "employee_documents"("org_id", "user_id");
