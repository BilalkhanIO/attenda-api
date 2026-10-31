ALTER TABLE "shift_assignments"
ADD COLUMN "is_published" BOOLEAN NOT NULL DEFAULT false;

UPDATE "shift_assignments" AS assignment
SET "is_published" = shift."is_published"
FROM "shifts" AS shift
WHERE shift."id" = assignment."shift_id";
