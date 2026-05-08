-- 025_account_last_error_and_dead_status.sql (2026-05-08)
--
-- Reason: checkAccountStatus + validateCookie write last_error + use status
-- values ('dead', 'banned', 'at_risk') the existing CHECK constraint
-- rejected, causing every blocked-state DB update to fail silently. The
-- modal then polled forever waiting for a status update that never landed.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_error TEXT;

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_status_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_status_check
  CHECK (status = ANY (ARRAY[
    'healthy'::text,
    'checkpoint'::text,
    'expired'::text,
    'disabled'::text,
    'unknown'::text,
    'at_risk'::text,
    'banned'::text,
    'dead'::text
  ]));
