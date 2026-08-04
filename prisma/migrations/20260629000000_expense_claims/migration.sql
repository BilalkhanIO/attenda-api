CREATE TABLE IF NOT EXISTS "expense_claims" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "currency" VARCHAR(10) NOT NULL,
  "category" VARCHAR(50) NOT NULL,
  "description" TEXT NOT NULL,
  "expense_date" DATE NOT NULL,
  "receipt_url" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "reviewed_by" TEXT,
  "review_note" TEXT,
  "reviewed_at" TIMESTAMP(3),
  "reimbursed_in_payroll_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "expense_claims_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "expense_claims_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "expense_claims_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "expense_claims_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "expense_claims_reimbursed_in_payroll_id_fkey" FOREIGN KEY ("reimbursed_in_payroll_id") REFERENCES "payroll_records"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "expense_claims_org_id_status_idx" ON "expense_claims"("org_id", "status");
