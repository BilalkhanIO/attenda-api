-- Leave balances must hold fractional days: half-day approval increments
-- used_days by 0.5 and the monthly accrual writes days_per_year/12 rounded
-- to 2dp (e.g. 20/yr -> 1.67/mo). INT columns reject those writes.
ALTER TABLE leave_balances ALTER COLUMN total_days TYPE DECIMAL(6,2) USING total_days::DECIMAL(6,2);
ALTER TABLE leave_balances ALTER COLUMN used_days  TYPE DECIMAL(6,2) USING used_days::DECIMAL(6,2);
