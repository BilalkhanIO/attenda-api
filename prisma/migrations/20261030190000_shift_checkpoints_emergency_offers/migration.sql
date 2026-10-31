CREATE TABLE "shift_checkpoints" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "shift_id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "instructions" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "minimum_interval_mins" INTEGER NOT NULL DEFAULT 0,
    "qr_token" VARCHAR(64) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "shift_checkpoints_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "shift_checkpoint_scans" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "checkpoint_id" TEXT NOT NULL,
    "assignment_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "scanned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "accuracy_m" DOUBLE PRECISION,
    CONSTRAINT "shift_checkpoint_scans_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "emergency_shift_offers" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "shift_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "note" VARCHAR(500),
    "status" VARCHAR(20) NOT NULL DEFAULT 'open',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "claimed_by" TEXT,
    "claimed_at" TIMESTAMP(3),
    "assignment_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "emergency_shift_offers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shift_checkpoints_qr_token_key" ON "shift_checkpoints"("qr_token");
CREATE INDEX "shift_checkpoints_org_id_shift_id_active_sort_order_idx" ON "shift_checkpoints"("org_id", "shift_id", "active", "sort_order");
CREATE INDEX "shift_checkpoint_scans_assignment_id_scanned_at_idx" ON "shift_checkpoint_scans"("assignment_id", "scanned_at");
CREATE INDEX "shift_checkpoint_scans_checkpoint_id_scanned_at_idx" ON "shift_checkpoint_scans"("checkpoint_id", "scanned_at");
CREATE INDEX "shift_checkpoint_scans_org_id_user_id_scanned_at_idx" ON "shift_checkpoint_scans"("org_id", "user_id", "scanned_at");
CREATE UNIQUE INDEX "emergency_shift_offers_assignment_id_key" ON "emergency_shift_offers"("assignment_id");
CREATE INDEX "emergency_shift_offers_org_id_status_expires_at_date_idx" ON "emergency_shift_offers"("org_id", "status", "expires_at", "date");
CREATE INDEX "emergency_shift_offers_shift_id_date_idx" ON "emergency_shift_offers"("shift_id", "date");

ALTER TABLE "shift_checkpoints" ADD CONSTRAINT "shift_checkpoints_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shift_checkpoints" ADD CONSTRAINT "shift_checkpoints_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shift_checkpoint_scans" ADD CONSTRAINT "shift_checkpoint_scans_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shift_checkpoint_scans" ADD CONSTRAINT "shift_checkpoint_scans_checkpoint_id_fkey" FOREIGN KEY ("checkpoint_id") REFERENCES "shift_checkpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shift_checkpoint_scans" ADD CONSTRAINT "shift_checkpoint_scans_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "shift_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shift_checkpoint_scans" ADD CONSTRAINT "shift_checkpoint_scans_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "emergency_shift_offers" ADD CONSTRAINT "emergency_shift_offers_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "emergency_shift_offers" ADD CONSTRAINT "emergency_shift_offers_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "emergency_shift_offers" ADD CONSTRAINT "emergency_shift_offers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "emergency_shift_offers" ADD CONSTRAINT "emergency_shift_offers_claimed_by_fkey" FOREIGN KEY ("claimed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "emergency_shift_offers" ADD CONSTRAINT "emergency_shift_offers_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "shift_assignments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
