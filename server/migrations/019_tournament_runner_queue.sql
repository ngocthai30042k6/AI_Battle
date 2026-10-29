CREATE INDEX IF NOT EXISTS tournament_fixtures_runner_queue_idx
  ON tournament_fixtures(tournament_id,phase,round_number,match_number,leg)
  WHERE status='pending';
