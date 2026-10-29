ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS execution_paused_at timestamptz;
