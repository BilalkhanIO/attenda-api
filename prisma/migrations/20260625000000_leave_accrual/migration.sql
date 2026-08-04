-- Org-level leave accrual policy. Shape (per leave type):
--   {"annual": {"days_per_year": 20, "carry_over_max": 5}, "sick": {...}}
-- NULL = accrual disabled (balances stay manually managed).
ALTER TABLE "organisations" ADD COLUMN IF NOT EXISTS "leave_accrual" JSONB;
