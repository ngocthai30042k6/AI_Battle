CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  elo INTEGER NOT NULL DEFAULT 1200 CHECK (elo BETWEEN 100 AND 10000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS matches (
  id UUID PRIMARY KEY,
  seed INTEGER NOT NULL,
  player1_id UUID NOT NULL REFERENCES users(id),
  player2_id UUID NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'completed', 'disputed', 'abandoned')),
  player1_key JSONB,
  player2_key JSONB,
  winner_id UUID REFERENCES users(id),
  final_state_hash CHAR(64),
  replay_key TEXT,
  replay_sha256 CHAR(64),
  replay_json JSONB,
  player1_proof JSONB,
  player2_proof JSONB,
  disconnected_player_id UUID REFERENCES users(id),
  disconnected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CHECK (player1_id <> player2_id)
);

CREATE TABLE IF NOT EXISTS match_results (
  match_id UUID PRIMARY KEY REFERENCES matches(id),
  player1_elo_before INTEGER NOT NULL,
  player2_elo_before INTEGER NOT NULL,
  player1_elo_after INTEGER NOT NULL,
  player2_elo_after INTEGER NOT NULL,
  result_player1 NUMERIC(3,2) NOT NULL CHECK (result_player1 IN (0, 0.5, 1)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS matches_player1_created_idx ON matches(player1_id, created_at DESC);
CREATE INDEX IF NOT EXISTS matches_player2_created_idx ON matches(player2_id, created_at DESC);

CREATE TABLE IF NOT EXISTS disconnect_claims (
  id BIGSERIAL PRIMARY KEY,
  match_id UUID NOT NULL REFERENCES matches(id),
  claimant_id UUID NOT NULL REFERENCES users(id),
  disconnected_id UUID NOT NULL REFERENCES users(id),
  proof JSONB NOT NULL,
  signature TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'needs-review' CHECK (status IN ('needs-review', 'accepted', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(match_id, claimant_id)
);

CREATE TABLE IF NOT EXISTS teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  captain_id UUID NOT NULL REFERENCES users(id),
  invite_code TEXT NOT NULL UNIQUE,
  active_bot_version INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('captain', 'member')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(team_id, user_id)
);

CREATE TABLE IF NOT EXISTS team_bot_versions (
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  code TEXT NOT NULL,
  code_sha256 CHAR(64) NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(team_id, version)
);

CREATE TABLE IF NOT EXISTS tournaments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'ranked_weekly' CHECK (format IN ('ranked_weekly')),
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'registration' CHECK (status IN ('registration', 'qualifying', 'completed')),
  registration_closes_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  max_teams INTEGER NOT NULL DEFAULT 64 CHECK (max_teams > 1),
  current_week INTEGER NOT NULL DEFAULT 0,
  week_started_at TIMESTAMPTZ,
  rules_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > registration_closes_at)
);

CREATE TABLE IF NOT EXISTS tournament_entries (
  tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  matches_played INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  points INTEGER NOT NULL DEFAULT 0,
  tier TEXT NOT NULL DEFAULT 'Bronze' CHECK (tier IN ('Bronze','Silver','Gold','Master','Challenger')),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(tournament_id, team_id)
);

ALTER TABLE matches ADD COLUMN IF NOT EXISTS tournament_id UUID REFERENCES tournaments(id);
ALTER TABLE matches ADD COLUMN IF NOT EXISTS player1_team_id UUID REFERENCES teams(id);
ALTER TABLE matches ADD COLUMN IF NOT EXISTS player2_team_id UUID REFERENCES teams(id);
ALTER TABLE matches ADD COLUMN IF NOT EXISTS player1_bot_version INTEGER;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS player2_bot_version INTEGER;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS tournament_rules JSONB;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS current_week INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS week_started_at TIMESTAMPTZ;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS rules_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS format TEXT NOT NULL DEFAULT 'ranked_weekly';
UPDATE tournaments SET format='ranked_weekly' WHERE format IS NULL;
ALTER TABLE tournaments DROP CONSTRAINT IF EXISTS tournaments_format_check;
ALTER TABLE tournaments ADD CONSTRAINT tournaments_format_check CHECK (format IN ('ranked_weekly', 'group_knockout'));
ALTER TABLE tournaments DROP COLUMN IF EXISTS min_matches;
ALTER TABLE tournaments DROP COLUMN IF EXISTS max_qualifiers;
ALTER TABLE tournaments DROP COLUMN IF EXISTS division;
ALTER TABLE tournament_entries ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'Bronze';
ALTER TABLE tournament_entries DROP CONSTRAINT IF EXISTS tournament_entries_tier_check;
ALTER TABLE tournament_entries ADD CONSTRAINT tournament_entries_tier_check CHECK (tier IN ('Bronze','Silver','Gold','Master','Challenger'));
CREATE INDEX IF NOT EXISTS tournament_entries_rank_idx ON tournament_entries(tournament_id, points DESC);
CREATE INDEX IF NOT EXISTS tournament_matches_idx ON matches(tournament_id, completed_at DESC);
