ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'browser';
ALTER TABLE tournament_entries ADD COLUMN IF NOT EXISTS bot_code_snapshot TEXT;
ALTER TABLE tournament_entries ADD COLUMN IF NOT EXISTS bot_sha256_snapshot CHAR(64);
ALTER TABLE matches ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'browser';
