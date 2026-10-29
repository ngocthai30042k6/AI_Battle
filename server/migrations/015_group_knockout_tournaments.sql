ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS registration_opens_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tournament_starts_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS group_count INTEGER;

ALTER TABLE tournaments DROP CONSTRAINT IF EXISTS tournaments_format_check;
ALTER TABLE tournaments ADD CONSTRAINT tournaments_format_check
  CHECK (format IN ('ranked_weekly', 'group_knockout'));

ALTER TABLE tournaments DROP CONSTRAINT IF EXISTS tournaments_status_check;
ALTER TABLE tournaments ADD CONSTRAINT tournaments_status_check
  CHECK (status IN (
    'scheduled', 'registration', 'grouping', 'group_stage', 'group_running', 'group_complete', 'knockout',
    'qualifying', 'completed', 'cancelled'
  ));

ALTER TABLE tournaments DROP CONSTRAINT IF EXISTS tournaments_group_count_check;
ALTER TABLE tournaments ADD CONSTRAINT tournaments_group_count_check
  CHECK (group_count IS NULL OR group_count IN (8, 16, 32));

ALTER TABLE tournament_entries
  ADD COLUMN IF NOT EXISTS group_number INTEGER;

ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS final_step_count INTEGER;

ALTER TABLE matches DROP CONSTRAINT IF EXISTS matches_tournament_phase_check;
ALTER TABLE matches ADD CONSTRAINT matches_tournament_phase_check
  CHECK (tournament_phase IS NULL OR tournament_phase IN ('practice', 'ranked', 'group', 'knockout'));

CREATE TABLE IF NOT EXISTS tournament_fixtures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  phase TEXT NOT NULL CHECK (phase IN ('group', 'knockout')),
  group_number INTEGER,
  round_number INTEGER NOT NULL CHECK (round_number > 0),
  match_number INTEGER NOT NULL CHECK (match_number > 0),
  leg INTEGER NOT NULL DEFAULT 1 CHECK (leg > 0),
  player1_id UUID NOT NULL REFERENCES users(id),
  player2_id UUID NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'completed')),
  winner_id UUID REFERENCES users(id),
  move_count INTEGER,
  player1_ready_at TIMESTAMPTZ,
  player2_ready_at TIMESTAMPTZ,
  match_id UUID REFERENCES matches(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (player1_id <> player2_id),
  CHECK (winner_id IS NULL OR winner_id IN (player1_id, player2_id)),
  CHECK ((phase = 'group' AND group_number IS NOT NULL) OR
         (phase = 'knockout' AND group_number IS NULL))
);

ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS tournament_fixture_id UUID
    REFERENCES tournament_fixtures(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS tournament_fixtures_pending_idx
  ON tournament_fixtures(tournament_id, phase, group_number, round_number, match_number)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS tournament_fixtures_player_idx
  ON tournament_fixtures(tournament_id, player1_id, player2_id, status);
