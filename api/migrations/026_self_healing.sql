-- Migration 026: Self-healing system improvements
-- Add columns if not exists
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS agent_enabled BOOLEAN DEFAULT false;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS agent_enabled BOOLEAN DEFAULT false;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;

-- Trigger function to validate job owner BEFORE INSERT
CREATE OR REPLACE FUNCTION validate_job_owner()
RETURNS TRIGGER AS $$
DECLARE
  expected_owner UUID;
  acc_id UUID;
BEGIN
  -- We only validate jobs that are bound to a specific account
  IF NEW.payload IS NOT NULL AND NEW.payload->>'account_id' IS NOT NULL THEN
    -- Try parsing account_id from payload
    BEGIN
      acc_id := (NEW.payload->>'account_id')::UUID;
    EXCEPTION WHEN OTHERS THEN
      -- Ignore if not a valid UUID string
      RETURN NEW;
    END;

    -- Lookup expected owner
    SELECT owner_id INTO expected_owner FROM accounts WHERE id = acc_id;
    
    IF expected_owner IS NOT NULL THEN
      -- Automatically populate created_by if NULL
      IF NEW.created_by IS NULL THEN
        NEW.created_by := expected_owner;
      -- Fail validation if mismatched
      ELSIF NEW.created_by != expected_owner THEN
        RAISE EXCEPTION 'Mismatched owner ID for job: account_id=%, attempted_owner_id=%, expected_owner_id=%',
          acc_id, NEW.created_by, expected_owner;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Bind the trigger BEFORE INSERT on jobs table
DROP TRIGGER IF EXISTS trg_validate_job_owner ON jobs;
CREATE TRIGGER trg_validate_job_owner
BEFORE INSERT ON jobs
FOR EACH ROW
EXECUTE FUNCTION validate_job_owner();
