ALTER TABLE matches ADD COLUMN IF NOT EXISTS tournament_phase TEXT;
UPDATE matches SET tournament_phase='ranked'
WHERE tournament_id IS NOT NULL AND tournament_phase IS NULL;
ALTER TABLE matches DROP CONSTRAINT IF EXISTS matches_tournament_phase_check;
ALTER TABLE matches ADD CONSTRAINT matches_tournament_phase_check
  CHECK (tournament_phase IS NULL OR tournament_phase IN ('practice', 'ranked', 'group', 'knockout'));

ALTER TABLE tournament_entries DROP CONSTRAINT IF EXISTS tournament_entries_rank_stars_check;
ALTER TABLE tournament_entries ADD CONSTRAINT tournament_entries_rank_stars_check
  CHECK (rank_stars BETWEEN 0 AND 40);

CREATE TABLE IF NOT EXISTS tournament_sprint_standings (
  tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  sprint INTEGER NOT NULL CHECK (sprint > 0),
  player_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tier TEXT NOT NULL CHECK (tier IN ('Bronze','Silver','Gold','Master','Challenger')),
  rank_stars INTEGER NOT NULL CHECK (rank_stars BETWEEN 0 AND 40),
  season_points INTEGER NOT NULL DEFAULT 0 CHECK (season_points >= 0),
  matches_played INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  registered_at TIMESTAMPTZ NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tournament_id, sprint, player_id)
);

CREATE INDEX IF NOT EXISTS tournament_sprint_standings_rank_idx
  ON tournament_sprint_standings(tournament_id, sprint, tier, season_points DESC, rank_stars DESC);
